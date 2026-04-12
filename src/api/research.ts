import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb, getRawDb } from "../db/connection.js";
import { researchMemos, agentInitiatives } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { initResearchQueueService } from "../services/research-queue.js";
import { runLiteratureReview, lookupPaper } from "../services/literature-review.js";
import { findAndPopulateGaps } from "../services/research-gap-finder.js";
import { chaseCitations } from "../services/citation-chaser.js";

const RESEARCH_BASE = join(homedir(), "lobs-control", "state", "research");

export async function handleResearchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  projectId?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();
  const queue = initResearchQueueService(getRawDb());
  const sub = parts[2]; // e.g. "doc", "sources", "requests", "deliverables"
  const subId = parts[3];

  if (projectId === "queue") {
    if (!subId && req.method === "GET") {
      const url = new URL(req.url ?? "/api/research/queue", "http://localhost");
      const statusParam = url.searchParams.get("status");
      const limitParam = parseInt(url.searchParams.get("limit") ?? "100", 10);
      const status = statusParam === "queued" || statusParam === "processing" || statusParam === "completed" || statusParam === "failed"
        ? statusParam
        : undefined;
      return json(res, {
        items: queue.listQueue({ status, limit: Number.isFinite(limitParam) ? limitParam : 100 }),
        stats: queue.getStats(),
      });
    }

    if (!subId && req.method === "POST") {
      try {
        const body = await parseBody(req) as Record<string, unknown>;
        const item = queue.enqueue({
          title: String(body.title ?? ""),
          sourceType: body.sourceType === "text" ? "text" : "url",
          sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
          sourceText: typeof body.sourceText === "string" ? body.sourceText : undefined,
          topic: typeof body.topic === "string" ? body.topic : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map((tag) => String(tag)) : undefined,
          priority: typeof body.priority === "number" ? body.priority : undefined,
          projectId: typeof body.projectId === "string" ? body.projectId : undefined,
        });
        return json(res, { item }, 201);
      } catch (err) {
        return error(res, `Failed to enqueue research item: ${String(err)}`, 400);
      }
    }

    if (subId === "process" && req.method === "POST") {
      const body = await parseBody(req) as Record<string, unknown>;
      const itemId = typeof body.id === "string" ? body.id : undefined;
      const result = itemId ? await queue.processItem(itemId) : await queue.processNext();
      return json(res, result, result.error && !result.processed ? 404 : 200);
    }

    if (subId && req.method === "GET") {
      const item = queue.getQueueItem(subId);
      if (!item) return error(res, "Not found", 404);
      return json(res, { item, briefs: queue.listBriefsForItem(subId) });
    }
  }

  if (projectId === "briefs") {
    if (!sub && req.method === "GET") {
      const url = new URL(req.url ?? "/api/research/briefs", "http://localhost");
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      return json(res, { briefs: queue.listBriefs(limit) });
    }

    if (sub && req.method === "GET") {
      const brief = queue.getBrief(sub);
      if (!brief) return error(res, "Not found", 404);
      return json(res, { brief });
    }
  }

  // Citation chaser: POST /api/research/cite
  if (projectId === "cite" && req.method === "POST") {
    const rawBody = await parseBody(req) as Record<string, unknown> | null;
    const body = rawBody ?? {};
    const claim = typeof body.claim === "string" ? body.claim.trim() : "";
    if (!claim) return error(res, "Missing required field: claim", 400);

    try {
      const result = await chaseCitations({
        claim,
        paperContext: typeof body.paperContext === "string" ? body.paperContext : undefined,
        maxResults: typeof body.maxResults === "number" ? body.maxResults : undefined,
        ssApiKey: typeof body.ssApiKey === "string" ? body.ssApiKey : undefined,
      });
      return json(res, result);
    } catch (err) {
      return error(res, `Citation chase failed: ${(err as Error).message}`, 500);
    }
  }

  // Literature review: POST /api/research/literature-review
  //                    GET  /api/research/literature-review/list
  if (projectId === "literature-review") {
    // List saved reviews
    if (req.method === "GET" && sub === "list") {
      const outDir = join(RESEARCH_BASE, "literature-reviews");
      if (!existsSync(outDir)) return json(res, { reviews: [] });
      try {
        const files = readdirSync(outDir)
          .filter(f => f.endsWith(".md"))
          .sort()
          .reverse();
        const reviews = files.map(filename => {
          const raw = readFileSync(join(outDir, filename), "utf-8");
          // Extract question from first H1 line (# Literature Review: <question>)
          const h1Match = raw.match(/^#\s+Literature Review:\s*(.+)$/m);
          const question = h1Match ? h1Match[1].trim() : filename.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "").replace(/-/g, " ");
          // Extract date from filename prefix
          const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
          const date = dateMatch ? dateMatch[1] : null;
          // Count papers: look for "## Paper" or "papers analyzed" in content
          const paperCountMatch = raw.match(/Papers Analyzed[:\s]*(\d+)/i);
          const papersAnalyzed = paperCountMatch ? parseInt(paperCountMatch[1], 10) : null;
          // First 300 chars of content after the header as preview
          const preview = raw.replace(/^#[^\n]*\n/, "").replace(/^#+[^\n]*\n/gm, "").trim().slice(0, 300);
          return { filename, question, date, papersAnalyzed, preview, size: raw.length };
        });
        return json(res, { reviews });
      } catch (err) {
        return error(res, `Failed to list reviews: ${String(err)}`, 500);
      }
    }

    // Read a single saved review
    if (req.method === "GET" && sub && sub !== "list") {
      const outDir = join(RESEARCH_BASE, "literature-reviews");
      const filePath = join(outDir, sub);
      if (!existsSync(filePath)) return error(res, "Not found", 404);
      const content = readFileSync(filePath, "utf-8");
      return json(res, { filename: sub, content });
    }

    if (req.method === "POST") {
      const rawBody = await parseBody(req) as Record<string, unknown> | null;
      const body = rawBody ?? {};
      const question = typeof body.question === "string" ? body.question : "";
      if (!question) return error(res, "Missing required field: question", 400);

      try {
        const outputFormat = ["markdown", "latex", "both"].includes(body.outputFormat as string)
          ? (body.outputFormat as "markdown" | "latex" | "both")
          : "markdown";

        const review = await runLiteratureReview({
          question,
          seedCount: typeof body.seedCount === "number" ? body.seedCount : undefined,
          expansionDepth: typeof body.expansionDepth === "number" ? body.expansionDepth : undefined,
          relatedPerPaper: typeof body.relatedPerPaper === "number" ? body.relatedPerPaper : undefined,
          maxPapers: typeof body.maxPapers === "number" ? body.maxPapers : undefined,
          tier: ["micro", "small", "standard", "strong"].includes(body.tier as string)
            ? (body.tier as "micro" | "small" | "standard" | "strong")
            : undefined,
          ssApiKey: typeof body.ssApiKey === "string" ? body.ssApiKey : undefined,
          outputFormat,
        });

        // Save output files
        const outDir = join(RESEARCH_BASE, "literature-reviews");
        mkdirSync(outDir, { recursive: true });
        const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
        const datePrefix = new Date().toISOString().split("T")[0];
        const mdFilename = `${datePrefix}-${slug}.md`;
        writeFileSync(join(outDir, mdFilename), review.markdown, "utf-8");

        const savedFiles: string[] = [join(outDir, mdFilename)];

        if (review.latex) {
          const texFilename = `${datePrefix}-${slug}.tex`;
          writeFileSync(join(outDir, texFilename), review.latex, "utf-8");
          savedFiles.push(join(outDir, texFilename));
        }

        // Fire-and-forget: auto-populate Research Radar with gaps from this review
        findAndPopulateGaps(review).catch((err) => {
          console.error("[research] gap-finder error:", err);
        });

        return json(res, { ...review, savedTo: savedFiles[0], savedFiles });
      } catch (err) {
        return error(res, `Literature review failed: ${(err as Error).message}`, 500);
      }
    }

    if (req.method === "GET") {
      const url = new URL(req.url ?? "/", "http://localhost");
      const q = url.searchParams.get("q");
      if (!q) return error(res, "Missing query param: q", 400);
      const papers = await lookupPaper(q);
      return json(res, { papers });
    }

    return error(res, "Method not allowed", 405);
  }

  // If no projectId, return empty results gracefully
  if (!projectId) {
    const memos = db.select().from(researchMemos).orderBy(desc(researchMemos.createdAt)).all();
    return json(res, { memos, queue: queue.getStats() });
  }

  if (!sub || sub === undefined) {
    // GET /api/research/:projectId — overview
    const memos = db.select().from(researchMemos).orderBy(desc(researchMemos.createdAt)).all();
    const filtered = memos; // In real impl filter by projectId if stored
    return json(res, { project_id: projectId, memos: filtered });
  }

  if (sub === "doc") {
    const docPath = join(RESEARCH_BASE, projectId, "research.md");
    if (existsSync(docPath)) {
      return json(res, { content: readFileSync(docPath, "utf-8") });
    }
    return json(res, { content: null });
  }

  if (sub === "sources") {
    if (req.method === "POST") {
      const body = await parseBody(req) as Record<string, unknown>;
      // Stub: acknowledge
      return json(res, { id: randomUUID(), project_id: projectId, ...body }, 201);
    }
    return json(res, { sources: [] });
  }

  if (sub === "requests") {
    if (req.method === "POST") {
      const body = await parseBody(req) as Record<string, unknown>;
      return json(res, { id: randomUUID(), project_id: projectId, ...body }, 201);
    }
    return json(res, { requests: [] });
  }

  if (sub === "deliverables") {
    const delivDir = join(RESEARCH_BASE, projectId);
    if (subId) {
      const filePath = join(delivDir, subId);
      if (existsSync(filePath)) {
        return json(res, { filename: subId, content: readFileSync(filePath, "utf-8") });
      }
      return error(res, "Not found", 404);
    }
    if (existsSync(delivDir)) {
      const files = readdirSync(delivDir).filter(f => f.endsWith(".md") || f.endsWith(".txt"));
      return json(res, { deliverables: files });
    }
    return json(res, { deliverables: [] });
  }

  return error(res, "Unknown research endpoint", 404);
}
