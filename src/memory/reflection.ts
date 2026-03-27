/**
 * Reflection runner — orchestrates the full memory extraction pipeline.
 *
 * Entry point for all reflection triggers (session_end, daily, manual).
 * Runs asynchronously via setImmediate — never blocks the agent.
 */

import { randomUUID } from "node:crypto";
import { getMemoryDb } from "./db.js";
import { clusterEvents } from "./clustering.js";
import { extractMemories, getTotalTokensUsed, resetTokenCounter } from "./extractor.js";
import { reconcile } from "./reconciler.js";
import { log } from "../util/logger.js";
import type { MemoryEvent } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum events in scope before we bother reflecting */
const MIN_EVENTS_TO_REFLECT = 10;

/** Default daily cap on new memories across all reflection runs */
const DEFAULT_DAILY_MAX_MEMORIES = 50;

/** Minimum signal score to be considered "high-signal" */
const HIGH_SIGNAL_THRESHOLD = 0.7;

// ── Public types ─────────────────────────────────────────────────────────────

export interface ReflectionResult {
  runId: string;
  clustersProcessed: number;
  memoriesCreated: number;
  memoriesReinforced: number;
  conflictsDetected: number;
  tokensUsed: number;
  skipped: boolean;
  skipReason?: string;
}

// ── Skip condition helpers ────────────────────────────────────────────────────

function countTodayReflections(): number {
  const db = getMemoryDb();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM reflection_runs
       WHERE started_at >= ? AND status = 'completed'`,
    )
    .get(`${today}T00:00:00`) as { count: number };
  return row.count;
}

function countTodayCreatedMemories(): number {
  const db = getMemoryDb();
  const today = new Date().toISOString().slice(0, 10);

  // Sum memories_created across completed reflection runs today
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(memories_created), 0) as total FROM reflection_runs
       WHERE started_at >= ? AND status = 'completed'`,
    )
    .get(`${today}T00:00:00`) as { total: number };
  return row.total;
}

// ── Event gathering ──────────────────────────────────────────────────────────

/**
 * Gather events that haven't been linked to any memory via evidence yet,
 * filtered by optional session / time range.
 */
function gatherUnreflectedEvents(opts: {
  sessionId?: string;
  since?: string;
  until?: string;
}): MemoryEvent[] {
  const db = getMemoryDb();

  // Events not yet referenced in evidence table
  const conditions: string[] = [
    `e.id NOT IN (SELECT DISTINCT event_id FROM evidence WHERE event_id IS NOT NULL)`,
  ];
  const params: (string | number)[] = [];

  if (opts.sessionId) {
    conditions.push(`e.session_id = ?`);
    params.push(opts.sessionId);
  }
  if (opts.since) {
    conditions.push(`e.timestamp >= ?`);
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push(`e.timestamp <= ?`);
    params.push(opts.until);
  }

  const sql = `
    SELECT * FROM events e
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.timestamp ASC
    LIMIT 2000
  `;

  return db.prepare(sql).all(...params) as MemoryEvent[];
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function runReflection(opts: {
  trigger: "session_end" | "daily" | "manual";
  sessionId?: string;
  eventRange?: { since: string; until: string };
  maxMemories?: number;
}): Promise<ReflectionResult> {
  const runId = randomUUID();
  const maxMemories = opts.maxMemories ?? DEFAULT_DAILY_MAX_MEMORIES;

  const skipped = (reason: string): ReflectionResult => ({
    runId,
    clustersProcessed: 0,
    memoriesCreated: 0,
    memoriesReinforced: 0,
    conflictsDetected: 0,
    tokensUsed: 0,
    skipped: true,
    skipReason: reason,
  });

  // ── Gather events ──────────────────────────────────────────────────────────

  const events = gatherUnreflectedEvents({
    sessionId: opts.sessionId,
    since: opts.eventRange?.since,
    until: opts.eventRange?.until,
  });

  // ── Skip conditions ────────────────────────────────────────────────────────

  if (events.length < MIN_EVENTS_TO_REFLECT) {
    return skipped(`only ${events.length} events in scope (min ${MIN_EVENTS_TO_REFLECT})`);
  }

  const hasHighSignal = events.some((e) => e.signal_score > HIGH_SIGNAL_THRESHOLD);
  if (!hasHighSignal) {
    return skipped("no high-signal events (signal_score > 0.7)");
  }

  const hasInterestingEvents = events.some((e) =>
    ["error", "decision", "user_input"].includes(e.event_type),
  );
  if (!hasInterestingEvents) {
    return skipped("no errors, decisions, or user_input events");
  }

  // Daily budget check
  const memoriesCreatedToday = countTodayCreatedMemories();
  if (memoriesCreatedToday >= maxMemories) {
    return skipped(`daily memory budget exhausted (${memoriesCreatedToday}/${maxMemories})`);
  }

  // ── Start reflection run ────────────────────────────────────────────────────

  const db = getMemoryDb();
  const startedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO reflection_runs (id, trigger, started_at, tier, status)
     VALUES (?, ?, ?, 'local', 'running')`,
  ).run(runId, opts.trigger, startedAt);

  resetTokenCounter();

  let clustersProcessed = 0;
  let memoriesCreated = 0;
  let memoriesReinforced = 0;
  let conflictsDetected = 0;

  try {
    // ── Cluster events ──────────────────────────────────────────────────────

    const clusters = clusterEvents(events);

    // Sort: high priority first, then medium, skip last
    const priorityOrder = { high: 0, medium: 1, skip: 2 };
    clusters.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // ── Process clusters ────────────────────────────────────────────────────

    const remainingBudget = maxMemories - memoriesCreatedToday;
    let budgetRemaining = remainingBudget;

    for (const cluster of clusters) {
      if (budgetRemaining <= 0) break;

      // Skip low-priority clusters
      if (cluster.priority === "skip") continue;

      let candidates = await extractMemories(cluster);
      if (candidates.length === 0) continue;

      // Enforce remaining daily budget on candidates
      if (candidates.length > budgetRemaining) {
        candidates = candidates.slice(0, budgetRemaining);
      }

      const reconciled = await reconcile(candidates, runId);

      memoriesCreated += reconciled.newMemories.length;
      memoriesReinforced += reconciled.reinforcedMemories.length;
      conflictsDetected += reconciled.conflicts.length;
      budgetRemaining -= reconciled.newMemories.length;

      clustersProcessed++;
    }

    const tokensUsed = getTotalTokensUsed();
    const completedAt = new Date().toISOString();

    // ── Update reflection run record ────────────────────────────────────────

    db.prepare(
      `UPDATE reflection_runs SET
         completed_at = ?,
         clusters_processed = ?,
         memories_created = ?,
         memories_reinforced = ?,
         conflicts_detected = ?,
         tokens_used = ?,
         status = 'completed'
       WHERE id = ?`,
    ).run(
      completedAt,
      clustersProcessed,
      memoriesCreated,
      memoriesReinforced,
      conflictsDetected,
      tokensUsed,
      runId,
    );

    log().info(
      `[reflection] Run ${runId} complete: ${clustersProcessed} clusters, ` +
        `${memoriesCreated} new, ${memoriesReinforced} reinforced, ${conflictsDetected} conflicts, ` +
        `${tokensUsed} tokens`,
    );

    return {
      runId,
      clustersProcessed,
      memoriesCreated,
      memoriesReinforced,
      conflictsDetected,
      tokensUsed,
      skipped: false,
    };
  } catch (err) {
    log().error(`[reflection] Run ${runId} failed: ${String(err)}`);

    // Mark as failed
    try {
      db.prepare(
        `UPDATE reflection_runs SET completed_at = ?, status = 'failed' WHERE id = ?`,
      ).run(new Date().toISOString(), runId);
    } catch {
      // ignore
    }

    return {
      runId,
      clustersProcessed,
      memoriesCreated,
      memoriesReinforced,
      conflictsDetected,
      tokensUsed: getTotalTokensUsed(),
      skipped: false,
    };
  }
}
