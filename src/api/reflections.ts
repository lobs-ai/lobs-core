import { desc, eq } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb, getRawDb } from "../db/connection.js";
import { agentReflections } from "../db/schema.js";
import { error, json, parseBody, parseQuery } from "./index.js";

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

type RawRow = typeof agentReflections.$inferSelect & Record<string, unknown>;

function shape(row: RawRow) {
  const parsed = parseResult(row.result);
  return {
    ...row,
    inefficiencies: asStringArray(parsed.inefficiencies ?? row.inefficiencies),
    systemRisks: asStringArray(parsed.systemRisks ?? row.systemRisks),
    missedOpportunities: asStringArray(parsed.missedOpportunities ?? row.missedOpportunities),
    identityAdjustments: asStringArray(parsed.identityAdjustments ?? row.identityAdjustments),
    concreteSuggestions: asStringArray(parsed.concreteSuggestions ?? (row as Record<string, unknown>).concrete_suggestions),
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    approvedAt: row.approved_at ?? null,
    rejectedAt: row.rejected_at ?? null,
    rejectionReason: row.rejection_reason ?? null,
    feedbackEntries: (() => {
      const fe = row.feedback_entries;
      if (!fe) return [];
      try { return JSON.parse(fe as string); } catch { return []; }
    })(),
  };
}

/** Ensure extra columns exist (idempotent migration). */
function ensureColumns(): void {
  const raw = getRawDb();
  const existing = (raw.prepare("PRAGMA table_info(agent_reflections)").all() as Array<{ name: string }>).map(r => r.name);
  const toAdd: Array<[string, string]> = [
    ["approved_at", "TEXT"],
    ["rejected_at", "TEXT"],
    ["rejection_reason", "TEXT"],
    ["feedback_entries", "TEXT"],
  ];
  for (const [col, def] of toAdd) {
    if (!existing.includes(col)) {
      raw.exec(`ALTER TABLE agent_reflections ADD COLUMN ${col} ${def}`);
    }
  }
}

let _columnsEnsured = false;
function lazyEnsureColumns(): void {
  if (_columnsEnsured) return;
  ensureColumns();
  _columnsEnsured = true;
}

export async function handleReflectionsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts?: string[],
): Promise<void> {
  lazyEnsureColumns();
  const raw = getRawDb();

  // Sub-resource actions: /reflections/{id}/approve|reject|feedback
  const action = parts && parts.length >= 3 ? parts[2] : undefined;

  if (id && action) {
    if (req.method !== "POST") return error(res, "Method not allowed", 405);

    const existing = raw.prepare("SELECT * FROM agent_reflections WHERE id = ?").get(id) as RawRow | undefined;
    if (!existing) return error(res, "Reflection not found", 404);

    const now = new Date().toISOString();

    if (action === "approve") {
      raw.prepare(
        "UPDATE agent_reflections SET status = 'completed', approved_at = ?, rejected_at = NULL, rejection_reason = NULL WHERE id = ?"
      ).run(now, id);
      const updated = raw.prepare("SELECT * FROM agent_reflections WHERE id = ?").get(id) as RawRow;
      return json(res, shape(updated));
    }

    if (action === "reject") {
      const body = (await parseBody(req)) as Record<string, unknown>;
      const reason = typeof body.reason === "string" ? body.reason : null;
      raw.prepare(
        "UPDATE agent_reflections SET status = 'rejected', rejected_at = ?, rejection_reason = ?, approved_at = NULL WHERE id = ?"
      ).run(now, reason, id);
      const updated = raw.prepare("SELECT * FROM agent_reflections WHERE id = ?").get(id) as RawRow;
      return json(res, shape(updated));
    }

    if (action === "feedback") {
      const body = (await parseBody(req)) as Record<string, unknown>;
      let entries: unknown[] = [];
      try {
        const fe = existing.feedback_entries;
        entries = fe ? JSON.parse(fe as string) : [];
      } catch { entries = []; }

      const entry = {
        id: crypto.randomUUID(),
        state: body.state ?? "feedback",
        suggestion: body.suggestion ?? null,
        feedback: body.feedback ?? "",
        reviewer: body.reviewer ?? null,
        createdAt: now,
      };
      entries.push(entry);

      raw.prepare(
        "UPDATE agent_reflections SET feedback_entries = ? WHERE id = ?"
      ).run(JSON.stringify(entries), id);
      const updated = raw.prepare("SELECT * FROM agent_reflections WHERE id = ?").get(id) as RawRow;
      return json(res, shape(updated));
    }

    return error(res, `Unknown action: ${action}`, 404);
  }

  // Single reflection GET
  if (id) {
    if (req.method !== "GET") return error(res, "Method not allowed", 405);
    const row = raw.prepare("SELECT * FROM agent_reflections WHERE id = ?").get(id) as RawRow | undefined;
    if (!row) return error(res, "Not found", 404);
    return json(res, shape(row));
  }

  // List reflections GET
  if (req.method === "GET") {
    const query = parseQuery(req.url ?? "");
    const rawRows = query.agent
      ? (raw.prepare("SELECT * FROM agent_reflections WHERE agent_type = ? ORDER BY created_at DESC").all(query.agent) as RawRow[])
      : (raw.prepare("SELECT * FROM agent_reflections ORDER BY created_at DESC").all() as RawRow[]);
    return json(res, rawRows.map(shape));
  }

  // Create reflection POST
  if (req.method === "POST") {
    const body = (await parseBody(req)) as Record<string, unknown>;
    const newId = crypto.randomUUID();
    const now = new Date().toISOString();

    raw.prepare(`
      INSERT INTO agent_reflections (
        id, agent_type, reflection_type, status,
        window_start, window_end, context_packet, result,
        inefficiencies, system_risks, missed_opportunities, identity_adjustments,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId,
      String(body.agentType ?? body.agent_type ?? "unknown"),
      String(body.reflectionType ?? body.reflection_type ?? "general"),
      String(body.status ?? "pending"),
      body.windowStart ?? body.window_start ?? null,
      body.windowEnd ?? body.window_end ?? null,
      body.contextPacket ? JSON.stringify(body.contextPacket) : null,
      body.result ? JSON.stringify(body.result) : null,
      body.inefficiencies ? JSON.stringify(body.inefficiencies) : null,
      body.systemRisks ? JSON.stringify(body.systemRisks) : null,
      body.missedOpportunities ? JSON.stringify(body.missedOpportunities) : null,
      body.identityAdjustments ? JSON.stringify(body.identityAdjustments) : null,
      now,
      body.completedAt ?? body.completed_at ?? null,
    );

    const row = raw.prepare("SELECT * FROM agent_reflections WHERE id = ?").get(newId) as RawRow;
    return json(res, shape(row), 201);
  }

  return error(res, "Method not allowed", 405);
}
