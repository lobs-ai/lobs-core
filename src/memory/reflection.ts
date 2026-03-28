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

/** Token budget per session reflection (prevents runaway LLM spend).
 *  Qwen 3.5 uses ~800-1200 tokens per call on chain-of-thought thinking,
 *  so a single cluster extraction is ~1500 tokens total. Budget for ~8 clusters. */
const SESSION_TOKEN_BUDGET = 12_000;

/** Minimum signal score to be considered "high-signal" */
const HIGH_SIGNAL_THRESHOLD = 0.7;

/** Maximum new memories we'll create from a single cluster */
const MAX_NEW_MEMORIES_PER_CLUSTER = 5;

/** Maximum wall-clock time for a single reflection run (ms) */
const MAX_REFLECTION_DURATION_MS = 2 * 60 * 1000; // 2 minutes

/** Runs stuck in "running" longer than this are abandoned on startup (ms) */
const STALE_RUN_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ── Public types ─────────────────────────────────────────────────────────────

export interface ReflectionResult {
  runId: string;
  clustersProcessed: number;
  eventsProcessed: number;
  memoriesCreated: number;
  memoriesReinforced: number;
  conflictsDetected: number;
  tokensUsed: number;
  skipped: boolean;
  skipReason?: string;
}

// ── Skip condition helpers ────────────────────────────────────────────────────

function _countTodayReflections(): number {
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

// ── Skipped run recording ────────────────────────────────────────────────────

/**
 * Write a 'skipped' row to reflection_runs for audit trail.
 * Skipped runs are first-class — they explain "why didn't reflection run?"
 */
function recordSkippedRun(
  runId: string,
  trigger: "session_end" | "daily" | "manual",
  skipReason: string,
): void {
  const db = getMemoryDb();
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO reflection_runs
         (id, trigger, started_at, completed_at, tier, status, skip_reason,
          events_processed, clusters_processed, memories_created, memories_reinforced,
          conflicts_detected, tokens_used)
       VALUES (?, ?, ?, ?, 'local', 'skipped', ?, 0, 0, 0, 0, 0, 0)`,
    ).run(runId, trigger, now, now, skipReason);
  } catch (err) {
    // Non-fatal — skipped run recording should never crash the caller
    log().warn(`[reflection] Failed to record skipped run ${runId}: ${String(err)}`);
  }
}

// ── Stale run cleanup ────────────────────────────────────────────────────────

/**
 * Mark any "running" reflection runs older than STALE_RUN_THRESHOLD_MS as "abandoned".
 * Call on startup to clean up zombies from previous process lifetimes.
 */
export function cleanupStaleRuns(): number {
  const db = getMemoryDb();
  const cutoff = new Date(Date.now() - STALE_RUN_THRESHOLD_MS).toISOString();

  // ISO 8601 strings sort lexicographically, so direct comparison works
  const result = db.prepare(
    `UPDATE reflection_runs
     SET status = 'abandoned',
         completed_at = datetime('now'),
         skip_reason = 'marked abandoned: exceeded max run time'
     WHERE status = 'running'
     AND started_at < ?`,
  ).run(cutoff);

  const cleaned = (result as { changes: number }).changes;
  if (cleaned > 0) {
    log().info(`[reflection] Cleaned up ${cleaned} stale 'running' reflection run(s)`);
  }
  return cleaned;
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

  const skipped = (reason: string): ReflectionResult => {
    recordSkippedRun(runId, opts.trigger, reason);
    log().debug?.(`[reflection] Run ${runId} skipped: ${reason}`);
    return {
      runId,
      clustersProcessed: 0,
      eventsProcessed: 0,
      memoriesCreated: 0,
      memoriesReinforced: 0,
      conflictsDetected: 0,
      tokensUsed: 0,
      skipped: true,
      skipReason: reason,
    };
  };

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
    `INSERT INTO reflection_runs
       (id, trigger, started_at, tier, status,
        events_processed, clusters_processed, memories_created, memories_reinforced,
        conflicts_detected, tokens_used)
     VALUES (?, ?, ?, 'local', 'running', ?, 0, 0, 0, 0, 0)`,
  ).run(runId, opts.trigger, startedAt, events.length);

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

      // Wall-clock timeout — hard stop to prevent zombie runs
      if (Date.now() - Date.parse(startedAt) > MAX_REFLECTION_DURATION_MS) {
        log().info(
          `[reflection] Run ${runId} — wall-clock timeout (${MAX_REFLECTION_DURATION_MS}ms), ` +
            `stopping after ${clustersProcessed} clusters`,
        );
        break;
      }

      // Enforce session token budget — stop processing more clusters if exceeded
      if (getTotalTokensUsed() >= SESSION_TOKEN_BUDGET) {
        log().info(
          `[reflection] Run ${runId} — token budget exhausted (${getTotalTokensUsed()} >= ${SESSION_TOKEN_BUDGET}), ` +
            `stopping after ${clustersProcessed} clusters`,
        );
        break;
      }

      // Skip low-priority clusters
      if (cluster.priority === "skip") continue;

      let candidates = await extractMemories(cluster);
      if (candidates.length === 0) continue;

      // Enforce per-cluster cap (prevents any single cluster from dominating)
      if (candidates.length > MAX_NEW_MEMORIES_PER_CLUSTER) {
        candidates = candidates.slice(0, MAX_NEW_MEMORIES_PER_CLUSTER);
      }

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
         events_processed = ?,
         clusters_processed = ?,
         memories_created = ?,
         memories_reinforced = ?,
         conflicts_detected = ?,
         tokens_used = ?,
         status = 'completed'
       WHERE id = ?`,
    ).run(
      completedAt,
      events.length,
      clustersProcessed,
      memoriesCreated,
      memoriesReinforced,
      conflictsDetected,
      tokensUsed,
      runId,
    );

    log().info(
      `[reflection] Run ${runId} complete: ${events.length} events, ${clustersProcessed} clusters, ` +
        `${memoriesCreated} new, ${memoriesReinforced} reinforced, ${conflictsDetected} conflicts, ` +
        `${tokensUsed} tokens`,
    );

    return {
      runId,
      clustersProcessed,
      eventsProcessed: events.length,
      memoriesCreated,
      memoriesReinforced,
      conflictsDetected,
      tokensUsed,
      skipped: false,
    };
  } catch (err) {
    log().error(`[reflection] Run ${runId} failed: ${String(err)}`);

    // Mark as failed with whatever partial stats we have
    try {
      db.prepare(
        `UPDATE reflection_runs SET
           completed_at = ?,
           events_processed = ?,
           clusters_processed = ?,
           memories_created = ?,
           memories_reinforced = ?,
           conflicts_detected = ?,
           tokens_used = ?,
           status = 'failed'
         WHERE id = ?`,
      ).run(
        new Date().toISOString(),
        events.length,
        clustersProcessed,
        memoriesCreated,
        memoriesReinforced,
        conflictsDetected,
        getTotalTokensUsed(),
        runId,
      );
    } catch {
      // ignore — the run record itself may be missing
    }

    return {
      runId,
      clustersProcessed,
      eventsProcessed: events.length,
      memoriesCreated,
      memoriesReinforced,
      conflictsDetected,
      tokensUsed: getTotalTokensUsed(),
      skipped: false,
    };
  }
}
