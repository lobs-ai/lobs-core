import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { learningPlans, learningLessons } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";

// "Topics" map to learning plans
export async function handleTopicsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();
  const sub = parts[2]; // e.g. "lessons"

  if (id) {
    if (sub === "lessons") {
      const lessons = db.select().from(learningLessons).where(eq(learningLessons.planId, id)).orderBy(learningLessons.dayNumber).all();
      return json(res, lessons);
    }
    if (req.method === "GET") {
      const row = db.select().from(learningPlans).where(eq(learningPlans.id, id)).get();
      return row ? json(res, row) : error(res, "Not found", 404);
    }
    if (req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if ("topic" in body) update.topic = body.topic;
      if ("status" in body) update.status = body.status;
      if ("goal" in body) update.goal = body.goal;
      db.update(learningPlans).set(update).where(eq(learningPlans.id, id)).run();
      return json(res, db.select().from(learningPlans).where(eq(learningPlans.id, id)).get());
    }
    if (req.method === "DELETE") {
      db.delete(learningPlans).where(eq(learningPlans.id, id)).run();
      return json(res, { deleted: true });
    }
  }

  if (req.method === "GET") {
    return json(res, db.select().from(learningPlans).orderBy(desc(learningPlans.createdAt)).all());
  }
  if (req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.topic) return error(res, "topic required");
    const pid = randomUUID();
    const now = new Date().toISOString();
    db.insert(learningPlans).values({
      id: pid,
      topic: body.topic as string,
      goal: (body.goal as string) ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    return json(res, db.select().from(learningPlans).where(eq(learningPlans.id, pid)).get(), 201);
  }
  return error(res, "Method not allowed", 405);
}
