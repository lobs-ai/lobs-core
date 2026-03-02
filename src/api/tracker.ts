import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "./index.js";

export async function handleTrackerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[] = [],
): Promise<void> {
  const sub = parts.slice(1);

  // /api/tracker/entries[/:id]
  if (sub[0] === "entries") {
    if (sub[1]) {
      if (req.method === "DELETE") return json(res, { deleted: true });
      return json(res, { id: sub[1], type: "note", rawText: "", duration: null, category: null, dueDate: null, estimatedMinutes: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    return json(res, []);
  }

  // /api/tracker/summary
  if (sub[0] === "summary") {
    return json(res, {
      totalEntries: 0,
      workSessionsCount: 0,
      totalMinutesLogged: 0,
      deadlinesCount: 0,
      upcomingDeadlines: 0,
      notesCount: 0,
      categories: {},
      last7DaysMinutes: 0,
    });
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
  if (sub[1] === "items") {
    if (sub[2]) {
      if (req.method === "DELETE") return json(res, { deleted: true });
      return json(res, { id: sub[2], projectId: sub[0], title: "", status: "open", difficulty: null, tags: [], notes: null, links: [] });
    }
    return json(res, []);
  }

  // /api/tracker/:projectId/requests[/:requestId]
  if (sub[1] === "requests") {
    if (sub[2]) {
      if (req.method === "DELETE") return json(res, { deleted: true });
      return json(res, { id: sub[2], projectId: sub[0], title: "", status: "pending", query: "" });
    }
    return json(res, []);
  }

  return json(res, []);
}
