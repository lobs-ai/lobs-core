import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { researchMemos, agentInitiatives } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RESEARCH_BASE = join(homedir(), "lobs-control", "state", "research");

export async function handleResearchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  projectId?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();
  const sub = parts[2]; // e.g. "doc", "sources", "requests", "deliverables"
  const subId = parts[3];

  // If no projectId, return empty results gracefully
  if (!projectId) {
    const memos = db.select().from(researchMemos).orderBy(desc(researchMemos.createdAt)).all();
    return json(res, { memos });
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
