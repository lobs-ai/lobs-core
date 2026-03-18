import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb, getRawDb } from "../db/connection.js";
import { researchMemos, agentInitiatives } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { initResearchQueueService } from "../services/research-queue.js";

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
