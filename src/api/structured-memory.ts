/**
 * Structured Memory API — serves data from the memory DB (~/.lobs/memory.db).
 *
 * Routes:
 *   GET /api/structured-memory/stats      — aggregate stats
 *   GET /api/structured-memory/memories   — paginated memory list (filterable)
 *   GET /api/structured-memory/conflicts  — conflict pairs
 *   GET /api/structured-memory/gc-log     — recent GC activity
 *   GET /api/structured-memory/events     — recent events
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseQuery } from "./index.js";
import { getMemoryDb } from "../memory/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryDb() {
  try {
    return getMemoryDb();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route: GET /api/structured-memory/stats
// ---------------------------------------------------------------------------

function handleStats(res: ServerResponse): void {
  const db = tryDb();
  if (!db) {
    json(res, {
      totalMemories: 0,
      byType: {},
      byStatus: {},
      totalEvents: 0,
      recentEvents: 0,
      totalConflicts: 0,
      unresolvedConflicts: 0,
      gcRuns: 0,
      avgConfidence: 0,
      lastReflection: null,
      lastGcRun: null,
    });
    return;
  }

  const totalMemories = (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;

  const byTypeRows = db
    .prepare("SELECT memory_type, COUNT(*) AS c FROM memories GROUP BY memory_type")
    .all() as { memory_type: string; c: number }[];
  const byType: Record<string, number> = {};
  for (const r of byTypeRows) byType[r.memory_type] = r.c;

  const byStatusRows = db
    .prepare("SELECT status, COUNT(*) AS c FROM memories GROUP BY status")
    .all() as { status: string; c: number }[];
  const byStatus: Record<string, number> = {};
  for (const r of byStatusRows) byStatus[r.status] = r.c;

  const totalEvents = (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;

  const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentEvents = (
    db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE created_at >= ?")
      .get(recentCutoff) as { c: number }
  ).c;

  const totalConflicts = (
    db.prepare("SELECT COUNT(*) AS c FROM conflicts").get() as { c: number }
  ).c;

  // Unresolved = resolved_at IS NULL
  const unresolvedConflicts = (
    db
      .prepare("SELECT COUNT(*) AS c FROM conflicts WHERE resolved_at IS NULL")
      .get() as { c: number }
  ).c;

  // Count distinct GC run timestamps (rounded to the second)
  const gcRuns = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT strftime('%Y-%m-%dT%H:%M:%S', created_at)) AS c FROM gc_log",
      )
      .get() as { c: number }
  ).c;

  const avgRow = db
    .prepare("SELECT AVG(confidence) AS a FROM memories WHERE status = 'active'")
    .get() as { a: number | null };
  const avgConfidence = avgRow.a != null ? Math.round(avgRow.a * 100) / 100 : 0;

  const reflectionRow = db
    .prepare("SELECT MAX(started_at) AS t FROM reflection_runs")
    .get() as { t: string | null };
  const lastReflection = reflectionRow?.t ?? null;

  const gcRow = db
    .prepare("SELECT MAX(created_at) AS t FROM gc_log")
    .get() as { t: string | null };
  const lastGcRun = gcRow?.t ?? null;

  json(res, {
    totalMemories,
    byType,
    byStatus,
    totalEvents,
    recentEvents,
    totalConflicts,
    unresolvedConflicts,
    gcRuns,
    avgConfidence,
    lastReflection,
    lastGcRun,
  });
}

// ---------------------------------------------------------------------------
// Route: GET /api/structured-memory/memories
// ---------------------------------------------------------------------------

function handleMemories(res: ServerResponse, query: Record<string, string>): void {
  const db = tryDb();
  if (!db) {
    json(res, { memories: [], total: 0, limit: 50, offset: 0 });
    return;
  }

  const limit = Math.min(parseInt(query.limit ?? "50", 10) || 50, 200);
  const offset = parseInt(query.offset ?? "0", 10) || 0;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.status) {
    conditions.push("m.status = ?");
    params.push(query.status);
  }
  if (query.type) {
    conditions.push("m.memory_type = ?");
    params.push(query.type);
  }
  if (query.scope) {
    conditions.push("m.scope = ?");
    params.push(query.scope);
  }
  if (query.search) {
    conditions.push("m.content LIKE ?");
    params.push(`%${query.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db
    .prepare(`SELECT COUNT(*) AS c FROM memories m ${where}`)
    .get(...(params as [])) as { c: number };
  const total = countRow.c;

  const memories = db
    .prepare(
      `SELECT
        m.id,
        m.memory_type,
        m.content,
        m.confidence,
        m.scope,
        m.status,
        m.source_authority,
        m.access_count,
        m.created_at,
        m.derived_at,
        m.last_accessed,
        COUNT(e.id) AS evidence_count
      FROM memories m
      LEFT JOIN evidence e ON e.memory_id = m.id
      ${where}
      GROUP BY m.id
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?`,
    )
    .all(...(params as []), limit, offset);

  json(res, { memories, total, limit, offset });
}

// ---------------------------------------------------------------------------
// Route: GET /api/structured-memory/conflicts
// ---------------------------------------------------------------------------

function handleConflicts(res: ServerResponse, query: Record<string, string>): void {
  const db = tryDb();
  if (!db) {
    json(res, { conflicts: [] });
    return;
  }

  // Schema: conflicts(id, memory_a, memory_b, description, resolution, resolved_at, created_at)
  // We normalise column names for the frontend using AS aliases.
  const statusParam = query.status;

  let whereClause = "";
  if (statusParam === "open" || statusParam === undefined || statusParam === "") {
    whereClause = "WHERE c.resolved_at IS NULL";
  } else if (statusParam === "resolved") {
    whereClause = "WHERE c.resolved_at IS NOT NULL";
  }
  // Otherwise (e.g. "all") — no filter

  const sql = `
    SELECT
      c.id,
      c.memory_a AS memory_a_id,
      c.memory_b AS memory_b_id,
      ma.content   AS memory_a_content,
      mb.content   AS memory_b_content,
      ma.confidence AS memory_a_confidence,
      mb.confidence AS memory_b_confidence,
      c.description AS conflict_type,
      CASE WHEN c.resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS status,
      c.resolution,
      c.resolved_at,
      c.created_at AS detected_at
    FROM conflicts c
    LEFT JOIN memories ma ON ma.id = c.memory_a
    LEFT JOIN memories mb ON mb.id = c.memory_b
    ${whereClause}
    ORDER BY c.created_at DESC`;

  const conflicts = db.prepare(sql).all();
  json(res, { conflicts });
}

// ---------------------------------------------------------------------------
// Route: GET /api/structured-memory/gc-log
// ---------------------------------------------------------------------------

function handleGcLog(res: ServerResponse, query: Record<string, string>): void {
  const db = tryDb();
  if (!db) {
    json(res, { entries: [] });
    return;
  }

  const limit = Math.min(parseInt(query.limit ?? "20", 10) || 20, 100);

  const entries = db
    .prepare(
      `SELECT id, memory_id, from_status, to_status, reason, created_at AS run_at
       FROM gc_log
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit);

  json(res, { entries });
}

// ---------------------------------------------------------------------------
// Route: GET /api/structured-memory/events
// ---------------------------------------------------------------------------

function handleEvents(res: ServerResponse, query: Record<string, string>): void {
  const db = tryDb();
  if (!db) {
    json(res, { events: [] });
    return;
  }

  const limit = Math.min(parseInt(query.limit ?? "20", 10) || 20, 100);

  const events = db
    .prepare(
      `SELECT id, timestamp, agent_type, event_type, content, signal_score, created_at
       FROM events
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit);

  json(res, { events });
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleStructuredMemoryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string | undefined,
): Promise<void> {
  if (req.method !== "GET") {
    error(res, "Method not allowed", 405);
    return;
  }

  const query = parseQuery(req.url ?? "");
  const route = (sub ?? "").split("?")[0];

  switch (route) {
    case "stats":
      handleStats(res);
      break;
    case "memories":
      handleMemories(res, query);
      break;
    case "conflicts":
      handleConflicts(res, query);
      break;
    case "gc-log":
      handleGcLog(res, query);
      break;
    case "events":
      handleEvents(res, query);
      break;
    default:
      error(res, `Unknown structured-memory route: ${route}`, 404);
  }
}
