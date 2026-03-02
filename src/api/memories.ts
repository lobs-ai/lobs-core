import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody, parseQuery } from "./index.js";

// Memories are stored as files in lobs-control, not in the DB.
// Stub responses that don't crash MC.

export async function handleMemoriesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts: string[] = [],
): Promise<void> {
  const sub = id; // /api/memories/:sub

  if (sub === "search") {
    const q = parseQuery(req.url ?? "");
    // Stub: no full-text search on memories in DB
    return json(res, { results: [], query: q.q ?? "" });
  }

  if (sub === "agents") {
    return json(res, { agents: [] });
  }

  if (sub === "capture" && req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    // Stub: acknowledge without persisting
    return json(res, { captured: true, id: `mem_${Date.now()}`, content: body.content ?? null });
  }

  if (sub) {
    return json(res, { id: sub, content: null });
  }

  if (req.method === "GET") {
    return json(res, []);
  }

  return error(res, "Method not allowed", 405);
}
