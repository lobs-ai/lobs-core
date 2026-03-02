import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { inboxItems, inboxThreads, inboxMessages } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";

export async function handleInboxRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();
  const sub = parts[2];
  const sub2 = parts[3];

  // /api/inbox/read-state — batch read state
  if (id === "read-state" && req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    const ids = (body.ids as string[]) ?? [];
    const is_read = (body.is_read as boolean) ?? true;
    for (const iid of ids) {
      db.update(inboxItems).set({ isRead: is_read }).where(eq(inboxItems.id, iid)).run();
    }
    return json(res, { updated: ids.length });
  }

  if (id) {
    if (sub === "read" && req.method === "POST") {
      db.update(inboxItems).set({ isRead: true }).where(eq(inboxItems.id, id)).run();
      return json(res, db.select().from(inboxItems).where(eq(inboxItems.id, id)).get());
    }

    if (sub === "thread") {
      // GET /api/inbox/:id/thread — get thread
      if (sub2 === "messages" && req.method === "GET") {
        const thread = db.select().from(inboxThreads).where(eq(inboxThreads.docId, id)).get();
        if (!thread) return json(res, { messages: [] });
        const msgs = db.select().from(inboxMessages).where(eq(inboxMessages.threadId, thread.id)).orderBy(inboxMessages.createdAt).all();
        return json(res, { messages: msgs });
      }
      if (req.method === "GET") {
        const thread = db.select().from(inboxThreads).where(eq(inboxThreads.docId, id)).get();
        return json(res, thread ?? { id: null, doc_id: id, messages: [] });
      }
    }

    if (sub === "response" && req.method === "POST") {
      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.text) return error(res, "text required");
      // Find or create thread
      let thread = db.select().from(inboxThreads).where(eq(inboxThreads.docId, id)).get();
      if (!thread) {
        const tid = randomUUID();
        const now = new Date().toISOString();
        db.insert(inboxThreads).values({ id: tid, docId: id, createdAt: now, updatedAt: now }).run();
        thread = db.select().from(inboxThreads).where(eq(inboxThreads.id, tid)).get()!;
      }
      const mid = randomUUID();
      db.insert(inboxMessages).values({
        id: mid,
        threadId: thread.id,
        author: (body.author as string) ?? "user",
        text: body.text as string,
        createdAt: new Date().toISOString(),
      }).run();
      return json(res, db.select().from(inboxMessages).where(eq(inboxMessages.id, mid)).get(), 201);
    }

    if (req.method === "GET") {
      const row = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
      return row ? json(res, row) : error(res, "Not found", 404);
    }
    if (req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      if ("is_read" in body) db.update(inboxItems).set({ isRead: body.is_read as boolean }).where(eq(inboxItems.id, id)).run();
      return json(res, db.select().from(inboxItems).where(eq(inboxItems.id, id)).get());
    }
    if (req.method === "DELETE") {
      db.delete(inboxItems).where(eq(inboxItems.id, id)).run();
      return json(res, { deleted: true });
    }
    return error(res, "Method not allowed", 405);
  }

  if (req.method === "GET") return json(res, db.select().from(inboxItems).orderBy(desc(inboxItems.modifiedAt)).all());
  if (req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.title) return error(res, "title required");
    const iid = randomUUID();
    db.insert(inboxItems).values({ id: iid, title: body.title as string, content: (body.content as string) ?? null, isRead: false }).run();
    return json(res, db.select().from(inboxItems).where(eq(inboxItems.id, iid)).get(), 201);
  }
  return error(res, "Method not allowed", 405);
}
