import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody } from "./index.js";

// In-memory stub — templates don't have a DB table yet
const templates: Map<string, Record<string, unknown>> = new Map();

export async function handleTemplatesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
): Promise<void> {
  if (id) {
    if (req.method === "GET") {
      const t = templates.get(id);
      return t ? json(res, t) : error(res, "Not found", 404);
    }
    if (req.method === "DELETE") {
      templates.delete(id);
      return json(res, { deleted: true });
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      const body = await parseBody(req) as Record<string, unknown>;
      templates.set(id, { ...templates.get(id), ...body, id });
      return json(res, templates.get(id));
    }
  }

  if (req.method === "GET") return json(res, Array.from(templates.values()));
  if (req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    const tid = (body.id as string) ?? randomUUID();
    templates.set(tid, { ...body, id: tid, created_at: new Date().toISOString() });
    return json(res, templates.get(tid), 201);
  }
  return error(res, "Method not allowed", 405);
}
