import type { IncomingMessage, ServerResponse } from "node:http";
import { json, parseQuery } from "./index.js";

export async function handleKnowledgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string | undefined,
  parts: string[],
): Promise<void> {
  const q = parseQuery(req.url ?? "");

  // GET /api/knowledge/feed
  if (sub === "feed") {
    return json(res, { entries: [], total: 0 });
  }

  // GET /api/knowledge/content?path=...
  if (sub === "content") {
    const path = q.path ?? "";
    return json(res, { path, content: "" });
  }

  // POST /api/knowledge/sync
  if (sub === "sync" && req.method === "POST") {
    return json(res, { synced: 0 });
  }

  // GET /api/knowledge?search=...  or  GET /api/knowledge (browse)
  return json(res, { entries: [], path: q.path ?? null, total: 0 });
}
