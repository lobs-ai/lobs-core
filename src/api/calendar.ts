import { randomUUID } from "node:crypto";
import { eq, gte, lte, and, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { scheduledEvents } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";

export async function handleCalendarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();

  // /api/calendar/events — CRUD
  if (sub === "events") {
    const eventId = parts[2];

    if (eventId && req.method === "DELETE") {
      db.delete(scheduledEvents).where(eq(scheduledEvents.id, eventId)).run();
      return json(res, { deleted: true });
    }

    if (req.method === "POST") {
      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.title || !body.scheduled_at) return error(res, "title and scheduled_at required");
      const id = randomUUID();
      const now = new Date().toISOString();
      db.insert(scheduledEvents).values({
        id,
        title: body.title as string,
        description: (body.description as string) ?? null,
        eventType: (body.event_type as string) ?? "manual",
        scheduledAt: body.scheduled_at as string,
        endAt: (body.end_at as string) ?? null,
        allDay: (body.all_day as boolean) ?? false,
        targetType: (body.target_type as string) ?? "calendar",
        status: (body.status as string) ?? "pending",
        createdAt: now,
        updatedAt: now,
      }).run();
      return json(res, db.select().from(scheduledEvents).where(eq(scheduledEvents.id, id)).get(), 201);
    }

    // GET /api/calendar/events
    const rows = db.select().from(scheduledEvents).orderBy(scheduledEvents.scheduledAt).all();
    return json(res, rows);
  }

  if (sub === "today") {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
    const rows = db.select().from(scheduledEvents)
      .where(and(gte(scheduledEvents.scheduledAt, start), lte(scheduledEvents.scheduledAt, end)))
      .orderBy(scheduledEvents.scheduledAt)
      .all();
    return json(res, rows);
  }

  if (sub === "upcoming") {
    const now = new Date().toISOString();
    const q = parseQuery(req.url ?? "");
    const limit = parseInt(q.limit ?? "20", 10);
    const rows = db.select().from(scheduledEvents)
      .where(gte(scheduledEvents.scheduledAt, now))
      .orderBy(scheduledEvents.scheduledAt)
      .limit(limit)
      .all();
    return json(res, rows);
  }

  if (sub === "range") {
    const q = parseQuery(req.url ?? "");
    const conditions = [];
    if (q.start) conditions.push(gte(scheduledEvents.scheduledAt, q.start));
    if (q.end) conditions.push(lte(scheduledEvents.scheduledAt, q.end));
    const rows = conditions.length > 0
      ? db.select().from(scheduledEvents).where(and(...conditions)).orderBy(scheduledEvents.scheduledAt).all()
      : db.select().from(scheduledEvents).orderBy(scheduledEvents.scheduledAt).all();
    return json(res, rows);
  }

  return error(res, "Unknown calendar endpoint", 404);
}
