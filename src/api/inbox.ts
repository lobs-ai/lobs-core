import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { inboxItems } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";

export async function handleInboxRequest(req: IncomingMessage, res: ServerResponse, id?: string): Promise<void> {
  const db = getDb();
  if (id) {
    if (req.method === "GET") { const row = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get(); return row ? json(res, row) : error(res, "Not found", 404); }
    if (req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      if ("is_read" in body) db.update(inboxItems).set({ isRead: body.is_read as boolean }).where(eq(inboxItems.id, id)).run();
      return json(res, db.select().from(inboxItems).where(eq(inboxItems.id, id)).get());
    }
    if (req.method === "DELETE") { db.delete(inboxItems).where(eq(inboxItems.id, id)).run(); return json(res, { deleted: true }); }
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
