import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { textDumps } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";

export async function handleTextDumpsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
): Promise<void> {
  const db = getDb();

  if (id) {
    if (req.method === "GET") {
      const row = db.select().from(textDumps).where(eq(textDumps.id, id)).get();
      return row ? json(res, row) : error(res, "Not found", 404);
    }
    if (req.method === "DELETE") {
      db.delete(textDumps).where(eq(textDumps.id, id)).run();
      return json(res, { deleted: true });
    }
    if (req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if ("text" in body) update.text = body.text;
      if ("status" in body) update.status = body.status;
      if ("project_id" in body) update.projectId = body.project_id;
      db.update(textDumps).set(update).where(eq(textDumps.id, id)).run();
      return json(res, db.select().from(textDumps).where(eq(textDumps.id, id)).get());
    }
  }

  if (req.method === "GET") {
    return json(res, db.select().from(textDumps).orderBy(desc(textDumps.createdAt)).all());
  }
  if (req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.text) return error(res, "text required");
    const tid = randomUUID();
    const now = new Date().toISOString();
    db.insert(textDumps).values({
      id: tid,
      text: body.text as string,
      projectId: (body.project_id as string) ?? null,
      status: (body.status as string) ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return json(res, db.select().from(textDumps).where(eq(textDumps.id, tid)).get(), 201);
  }
  return error(res, "Method not allowed", 405);
}
