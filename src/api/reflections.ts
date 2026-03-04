import { desc, eq } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { agentReflections } from "../db/schema.js";
import { error, json, parseQuery } from "./index.js";

type ReflectionPayload = {
  inefficiencies?: unknown;
  systemRisks?: unknown;
  missedOpportunities?: unknown;
  identityAdjustments?: unknown;
  concreteSuggestions?: unknown;
  summary?: unknown;
};

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function parseResult(result: unknown): ReflectionPayload {
  if (!result) return {};
  if (typeof result === "object") return result as ReflectionPayload;
  if (typeof result !== "string") return {};
  try {
    const parsed = JSON.parse(result);
    return typeof parsed === "object" && parsed ? (parsed as ReflectionPayload) : {};
  } catch {
    return {};
  }
}

function shape(row: typeof agentReflections.$inferSelect) {
  const parsed = parseResult(row.result);
  return {
    ...row,
    inefficiencies: asStringArray(parsed.inefficiencies ?? row.inefficiencies),
    systemRisks: asStringArray(parsed.systemRisks ?? row.systemRisks),
    missedOpportunities: asStringArray(parsed.missedOpportunities ?? row.missedOpportunities),
    identityAdjustments: asStringArray(parsed.identityAdjustments ?? row.identityAdjustments),
    concreteSuggestions: asStringArray(parsed.concreteSuggestions),
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
  };
}

export async function handleReflectionsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
): Promise<void> {
  const db = getDb();

  if (id) {
    if (req.method !== "GET") return error(res, "Method not allowed", 405);
    const row = db.select().from(agentReflections).where(eq(agentReflections.id, id)).get();
    if (!row) return error(res, "Not found", 404);
    return json(res, shape(row));
  }

  if (req.method !== "GET") return error(res, "Method not allowed", 405);

  const query = parseQuery(req.url ?? "");
  const rows = query.agent
    ? db.select().from(agentReflections)
      .where(eq(agentReflections.agentType, query.agent))
      .orderBy(desc(agentReflections.createdAt))
      .all()
    : db.select().from(agentReflections).orderBy(desc(agentReflections.createdAt)).all();

  return json(res, rows.map(shape));
}
