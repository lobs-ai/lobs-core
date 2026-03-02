/**
 * Inbox API — /paw/api/inbox
 */

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { inboxItems } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";

export function registerInboxRoutes(api: OpenClawPluginApi): void {
  // GET /paw/api/inbox
  api.registerHttpRoute({
    path: "/paw/api/inbox",
    handler: async (req, res) => {
      if (req.method === "GET") {
        const db = getDb();
        const q = parseQuery(req.url ?? "");
        const unreadOnly = q.unread === "true";

        const rows = unreadOnly
          ? db.select().from(inboxItems)
              .where(eq(inboxItems.isRead, false))
              .orderBy(desc(inboxItems.modifiedAt))
              .all()
          : db.select().from(inboxItems)
              .orderBy(desc(inboxItems.modifiedAt))
              .all();

        json(res, rows);
      } else if (req.method === "POST") {
        const db = getDb();
        const body = await parseBody(req) as Record<string, unknown>;
        if (!body.title) return error(res, "title is required");

        const id = (body.id as string) ?? randomUUID();

        db.insert(inboxItems).values({
          id,
          title: body.title as string,
          content: body.content as string ?? null,
          filename: body.filename as string ?? null,
          relativePath: body.relative_path as string ?? null,
          isRead: false,
          modifiedAt: new Date().toISOString(),
        }).run();

        const created = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
        json(res, created, 201);
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });

  // GET/PATCH/DELETE /paw/api/inbox/:id
  api.registerHttpRoute({
    path: "/paw/api/inbox/",
    handler: async (req, res) => {
      const url = req.url ?? "";
      const match = url.match(/\/paw\/api\/inbox\/([^/?]+)/);
      if (!match) return error(res, "Inbox item ID required", 400);
      const itemId = match[1];

      const db = getDb();

      if (req.method === "GET") {
        const row = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get();
        if (!row) return error(res, "Not found", 404);
        json(res, row);
      } else if (req.method === "PATCH") {
        const body = await parseBody(req) as Record<string, unknown>;
        const update: Record<string, unknown> = { modifiedAt: new Date().toISOString() };

        if ("is_read" in body) update["isRead"] = body.is_read;
        if ("title" in body) update["title"] = body.title;
        if ("content" in body) update["content"] = body.content;
        if ("summary" in body) update["summary"] = body.summary;

        db.update(inboxItems).set(update).where(eq(inboxItems.id, itemId)).run();
        const updated = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get();
        if (!updated) return error(res, "Not found", 404);
        json(res, updated);
      } else if (req.method === "DELETE") {
        db.delete(inboxItems).where(eq(inboxItems.id, itemId)).run();
        json(res, { deleted: true });
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });

  // POST /paw/api/inbox/:id/read — mark as read
  api.registerHttpRoute({
    path: "/paw/api/inbox/read",
    handler: async (req, res) => {
      const url = req.url ?? "";
      const match = url.match(/\/paw\/api\/inbox\/([^/?]+)\/read/);
      if (!match) return error(res, "Inbox item ID required", 400);
      const itemId = match[1];

      if (req.method !== "POST") return error(res, "Method not allowed", 405);

      const db = getDb();
      db.update(inboxItems)
        .set({ isRead: true, modifiedAt: new Date().toISOString() })
        .where(eq(inboxItems.id, itemId))
        .run();
      json(res, { read: true });
    },
  });
}
