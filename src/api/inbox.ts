import { inferProjectId } from "../util/project-inference.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { inboxItems, inboxThreads, inboxMessages, tasks } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";

function normalizeTitle(title: string): string {
  const cleaned = title.replace(/^\s*[📋🔍⚡✅❌:\-\s]+/, "").trim();
  const colon = cleaned.indexOf(":");
  if (colon > 0) {
    const right = cleaned.slice(colon + 1).trim();
    if (right) return right;
  }
  return cleaned;
}

function findRelatedProposedTask(inboxTitle: string) {
  const db = getDb();
  const rawTitle = (inboxTitle || "").trim();
  const normalized = normalizeTitle(rawTitle);
  const candidates = [rawTitle, normalized].filter(Boolean);
  for (const title of candidates) {
    const task = db.select().from(tasks)
      .where(and(eq(tasks.title, title), like(tasks.notes, "%Proposed from%")))
      .get();
    if (task) return task;
  }
  return null;
}

async function addThreadMessage(itemId: string, text: string, author = "user") {
  const db = getDb();
  let thread = db.select().from(inboxThreads).where(eq(inboxThreads.docId, itemId)).get();
  const now = new Date().toISOString();
  if (!thread) {
    const tid = randomUUID();
    db.insert(inboxThreads).values({ id: tid, docId: itemId, createdAt: now, updatedAt: now }).run();
    thread = db.select().from(inboxThreads).where(eq(inboxThreads.id, tid)).get()!;
  }
  const mid = randomUUID();
  db.insert(inboxMessages).values({
    id: mid,
    threadId: thread.id,
    author,
    text,
    createdAt: now,
  }).run();
  db.update(inboxThreads).set({ updatedAt: now }).where(eq(inboxThreads.id, thread.id)).run();
  return db.select().from(inboxMessages).where(eq(inboxMessages.id, mid)).get();
}

export async function handleInboxRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();
  const sub = parts[2];
  const sub2 = parts[3];

  if (id === "read-state" && req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    const ids = (body.ids as string[]) ?? [];
    const is_read = (body.is_read as boolean) ?? true;
    for (const iid of ids) db.update(inboxItems).set({ isRead: is_read }).where(eq(inboxItems.id, iid)).run();
    return json(res, { updated: ids.length });
  }

  if (id) {
    if (sub === "read" && req.method === "POST") {
      db.update(inboxItems).set({ isRead: true }).where(eq(inboxItems.id, id)).run();
      return json(res, db.select().from(inboxItems).where(eq(inboxItems.id, id)).get());
    }

    if (sub === "approve" && req.method === "POST") {
      const item = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
      if (!item) return error(res, "Not found", 404);
      db.update(inboxItems).set({ actionStatus: "approved", isRead: true }).where(eq(inboxItems.id, id)).run();
      const related = findRelatedProposedTask(item.title);
      if (related) db.update(tasks).set({ status: "active", updatedAt: new Date().toISOString() }).where(eq(tasks.id, related.id)).run();
      return json(res, { ok: true, related_task_id: related?.id ?? null });
    }

    if (sub === "reject" && req.method === "POST") {
      const item = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
      if (!item) return error(res, "Not found", 404);
      db.update(inboxItems).set({ actionStatus: "rejected", isRead: true }).where(eq(inboxItems.id, id)).run();
      const related = findRelatedProposedTask(item.title);
      if (related) db.update(tasks).set({ status: "rejected", updatedAt: new Date().toISOString() }).where(eq(tasks.id, related.id)).run();
      return json(res, { ok: true, related_task_id: related?.id ?? null });
    }

    if (sub === "feedback" && req.method === "POST") {
      const body = await parseBody(req) as Record<string, unknown>;
      const text = String(body.text ?? "").trim();
      if (!text) return error(res, "text required");

      const item = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
      if (!item) return error(res, "Not found", 404);

      await addThreadMessage(id, text, "user");
      db.update(inboxItems).set({ actionStatus: "feedback_pending", isRead: true }).where(eq(inboxItems.id, id)).run();

      const taskId = randomUUID();
      const now = new Date().toISOString();
      const agent = item.sourceAgent || "reviewer";
      db.insert(tasks).values({
        id: taskId,
        title: `Respond to inbox feedback: ${item.title}`,
        status: "inbox",
        agent,
        modelTier: "standard",
        projectId: inferProjectId(`Respond to inbox feedback: ${item.title}`, text as string),
        notes: `Feedback for inbox item ${item.id}\n\n${text}`,
        createdAt: now,
        updatedAt: now,
      }).run();

      return json(res, { ok: true, task_id: taskId });
    }

    if (sub === "thread") {
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
      const msg = await addThreadMessage(id, String(body.text), String(body.author ?? "user"));
      return json(res, msg, 201);
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
    db.insert(inboxItems).values({
      id: iid,
      title: body.title as string,
      content: (body.content as string) ?? null,
      isRead: false,
      type: (body.type as string) ?? "notice",
      requiresAction: Boolean(body.requires_action ?? body.requiresAction ?? false),
      actionStatus: (body.action_status as string) ?? "pending",
      sourceAgent: (body.source_agent as string) ?? null,
      sourceReflectionId: (body.source_reflection_id as string) ?? null,
    }).run();
    return json(res, db.select().from(inboxItems).where(eq(inboxItems.id, iid)).get(), 201);
  }
  return error(res, "Method not allowed", 405);
}
