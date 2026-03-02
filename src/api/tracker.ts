import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error } from "./index.js";

export async function handleTrackerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[] = [],
): Promise<void> {
  // parts[0] = "tracker", parts[1..] = sub-path
  const sub = parts.slice(1);

  // /api/tracker/entries
  if (sub[0] === "entries") {
    if (sub[1]) {
      // GET/PUT/DELETE /api/tracker/entries/:id
      if (req.method === "DELETE") return json(res, { deleted: true });
      return json(res, { id: sub[1], date: new Date().toISOString(), hours: 0, description: "", projectId: null });
    }
    // GET /api/tracker/entries or POST
    return json(res, []);
  }

  // /api/tracker/summary
  if (sub[0] === "summary") {
    return json(res, { totalHours: 0, weeklyHours: 0, projects: [], recentEntries: [] });
  }

  // /api/tracker/deadlines
  if (sub[0] === "deadlines") {
    return json(res, []);
  }

  // /api/tracker/analysis/latest
  if (sub[0] === "analysis") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("null");
    return;
  }

  // /api/tracker/:projectId/items[/:itemId]
  // /api/tracker/:projectId/requests[/:requestId]
  const projectId = sub[0];
  const resource = sub[1]; // "items" or "requests"

  if (resource === "items") {
    if (sub[2]) {
      // single item
      if (req.method === "DELETE") return json(res, { deleted: true });
      return json(res, { id: sub[2], projectId, title: "", status: "open", difficulty: null, tags: [], notes: null, links: [] });
    }
    return json(res, []);
  }

  if (resource === "requests") {
    if (sub[2]) {
      if (req.method === "DELETE") return json(res, { deleted: true });
      return json(res, { id: sub[2], projectId, title: "", status: "pending", query: "" });
    }
    return json(res, []);
  }

  return json(res, []);
}
