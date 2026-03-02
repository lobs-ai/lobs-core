import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { inboxItems } from "../db/schema.js";
import { json, error, parseQuery } from "./index.js";

export async function handleDocumentsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id: string | undefined,
  parts: string[],
): Promise<void> {
  const db = getDb();

  if (id === "search") {
    return json(res, []);
  }

  if (id && parts[2] === "archive" && req.method === "POST") {
    db.delete(inboxItems).where(eq(inboxItems.id, id)).run();
    return json(res, { archived: true });
  }

  if (id) {
    const row = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
    if (!row) return error(res, "Not found", 404);
    return json(res, mapToDocument(row));
  }

  // GET /api/documents
  const rows = db.select().from(inboxItems).orderBy(desc(inboxItems.modifiedAt)).all();
  return json(res, rows.map(mapToDocument));
}

function mapToDocument(row: any) {
  const filename = row.filename || row.title || "untitled";
  return {
    id: row.id,
    title: row.title ?? "Untitled",
    filename,
    relativePath: row.relativePath || `documents/${filename}`,
    content: row.content ?? "",
    contentIsTruncated: false,
    source: "writer",
    status: row.isRead ? "approved" : "pending",
    topic: null,
    topicId: null,
    projectId: null,
    taskId: null,
    date: row.modifiedAt ?? new Date().toISOString(),
    isRead: row.isRead ?? false,
    isStarred: false,
    summary: row.summary ?? null,
  };
}
