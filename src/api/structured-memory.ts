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
import { json, error, parseQuery, parseBody } from "./index.js";
import { getMemoryDb } from "../memory/db.js";
import { log } from "../util/logger.js";
import { consolidateMemories } from "../memory/consolidation.js";
import { searchMemoriesFast, searchMemoriesFull } from "../memory/search.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryDb() {
  try {
    return getMemoryDb();
  } catch (e) {
    log().warn(`[structured-memory-api] Memory DB unavailable: ${e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route: GET /api/structured-memory/stats
// ---------------------------------------------------------------------------

function handleStats(res: ServerResponse): void {
  const db = tryDb();
  if (!db) {
    error(res, "Structured memory database not available", 503);
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
    error(res, "Structured memory database not available", 503);
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
    // Use FTS5 for fast full-text search, fall back to LIKE if FTS fails
    conditions.push("m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)");
    // FTS5 needs quotes around the query to handle special chars
    params.push(`"${query.search.replace(/"/g, '""')}"`);
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
        m.title,
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
    error(res, "Structured memory database not available", 503);
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
    error(res, "Structured memory database not available", 503);
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
    error(res, "Structured memory database not available", 503);
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
// Route: GET /api/structured-memory/search
// ---------------------------------------------------------------------------

async function handleSearch(res: ServerResponse, query: Record<string, string>): Promise<void> {
  const q = (query.q ?? "").trim();
  if (!q) {
    error(res, 'Missing required query param: q', 400);
    return;
  }

  const mode = query.mode === "full" ? "full" : "fast";
  const limit = Math.max(1, Math.min(parseInt(query.limit ?? "10", 10) || 10, 50));
  const minConfidence = query.minConfidence != null
    ? Math.max(0, Math.min(1, parseFloat(query.minConfidence) || 0.3))
    : 0.3;
  const includeSuperseded = query.includeSuperseded === "true";
  const scope = query.scope || undefined;

  const memoryTypes = query.types
    ? query.types.split(",").map(t => t.trim()).filter(Boolean)
    : undefined;

  const opts = {
    maxResults: limit,
    memoryTypes,
    scope,
    minConfidence,
    includeSuperseded,
  };

  const t0 = Date.now();

  let results;
  if (mode === "full") {
    results = await searchMemoriesFull(q, opts);
  } else {
    results = await searchMemoriesFast(q, opts);
  }

  const elapsed = Date.now() - t0;

  const formatted = results.map(r => ({
    id: r.memory.id,
    memory_type: r.memory.memory_type,
    title: r.memory.title,
    content: r.memory.content,
    confidence: r.memory.confidence,
    scope: r.memory.scope,
    status: r.memory.status,
    score: r.score,
    matchType: r.matchType,
    evidenceCount: r.evidenceCount,
    access_count: r.memory.access_count,
    created_at: r.memory.created_at,
    derived_at: r.memory.derived_at,
    last_accessed: r.memory.last_accessed,
  }));

  json(res, {
    results: formatted,
    query: q,
    mode,
    count: formatted.length,
    elapsedMs: elapsed,
  });
}

// ---------------------------------------------------------------------------
// Route: POST /api/structured-memory/conflicts/:id/resolve
// ---------------------------------------------------------------------------

async function handleResolveConflict(
  req: IncomingMessage,
  res: ServerResponse,
  conflictId: number,
): Promise<void> {
  const db = tryDb();
  if (!db) {
    error(res, "Memory DB not available", 503);
    return;
  }

  const body = (await parseBody(req)) as {
    winner?: "a" | "b" | "both";
    resolution?: string;
  };

  const winner = body?.winner;
  if (!winner || !["a", "b", "both"].includes(winner)) {
    error(res, 'Missing or invalid "winner" field. Must be "a", "b", or "both".', 400);
    return;
  }

  // Get the conflict
  const conflict = db
    .prepare("SELECT * FROM conflicts WHERE id = ?")
    .get(conflictId) as { id: number; memory_a: number; memory_b: number; resolved_at: string | null } | undefined;

  if (!conflict) {
    error(res, `Conflict #${conflictId} not found`, 404);
    return;
  }

  if (conflict.resolved_at) {
    error(res, `Conflict #${conflictId} already resolved`, 409);
    return;
  }

  const resolution = body.resolution ?? `Resolved via Nexus: kept ${winner}`;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // Mark conflict as resolved
    db.prepare(
      "UPDATE conflicts SET resolution = ?, resolved_at = ? WHERE id = ?",
    ).run(resolution, now, conflictId);

    // Archive the loser (if not "both")
    if (winner === "a") {
      db.prepare(
        "UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
      ).run(conflict.memory_a, now, conflict.memory_b);
    } else if (winner === "b") {
      db.prepare(
        "UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
      ).run(conflict.memory_b, now, conflict.memory_a);
    }
    // "both" — just resolve the conflict, don't archive anything
  });

  tx();

  json(res, { ok: true, conflictId, winner, resolution });
}

// ---------------------------------------------------------------------------
// POST /api/structured-memory/consolidate
// ---------------------------------------------------------------------------

async function handleConsolidate(res: ServerResponse): Promise<void> {
  const stats = await consolidateMemories();
  json(res, { ok: true, ...stats });
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleStructuredMemoryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string | undefined,
): Promise<void> {
  const query = parseQuery(req.url ?? "");
  const route = (sub ?? "").split("?")[0];

  // POST routes
  if (req.method === "POST") {
    // Match: conflicts/<id>/resolve
    const resolveMatch = route.match(/^conflicts\/(\d+)\/resolve$/);
    if (resolveMatch) {
      await handleResolveConflict(req, res, parseInt(resolveMatch[1], 10));
      return;
    }
    if (route === "consolidate") {
      await handleConsolidate(res);
      return;
    }
    error(res, "Not found", 404);
    return;
  }

  if (req.method !== "GET") {
    error(res, "Method not allowed", 405);
    return;
  }

  switch (route) {
    case "stats":
      handleStats(res);
      break;
    case "memories":
      handleMemories(res, query);
      break;
    case "search":
      await handleSearch(res, query);
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
