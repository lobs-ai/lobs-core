/**
 * Reflection runner — orchestrates the full memory extraction pipeline.
 *
 * Philosophy: no artificial caps or timeouts. If something is important, it gets
 * a memory. We process every cluster, retrying on errors with backoff. The only
 * filter is importance — routine tool calls and low-signal noise get skipped,
 * but everything meaningful gets through.
 */

import { randomUUID } from "node:crypto";
import { getMemoryDb } from "./db.js";
import { clusterEvents } from "./clustering.js";
import { extractMemories, getTotalTokensUsed, resetTokenCounter } from "./extractor.js";
import { reconcile } from "./reconciler.js";
import { autoResolveConflicts, checkCrossTypeConflicts } from "./conflicts.js";
import { log } from "../util/logger.js";
import type { MemoryEvent } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum events in scope before we bother reflecting */
const MIN_EVENTS_TO_REFLECT = 5;

/** Maximum new memories we'll create from a single cluster */
const MAX_NEW_MEMORIES_PER_CLUSTER = 5;

/** Runs stuck in "running" longer than this are abandoned on startup (ms) */
const STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/** Retry backoff config for LLM errors */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000; // 2s, 4s, 8s

/** Prevent concurrent duplicate runs over the same session / event range. */
const activeReflectionKeys = new Set<string>();

/** Hard limits so reflection can't burn through API budget during spikes. */
const SESSION_END_COOLDOWN_MS = 5 * 60 * 1000;
const HOURLY_TOKEN_BUDGET = 120_000;
const MAX_CLUSTERS_PER_SESSION_RUN = 3;
const MAX_CLUSTERS_PER_DAILY_RUN = 20;
const MAX_TOKENS_PER_SESSION_RUN = 12_000;
const MAX_TOKENS_PER_DAILY_RUN = 80_000;

// ── Public types ─────────────────────────────────────────────────────────────

export interface ReflectionResult {
  runId: string;
  clustersProcessed: number;
  clustersSkipped: number;
  clustersErrored: number;
  eventsProcessed: number;
  memoriesCreated: number;
  memoriesReinforced: number;
  conflictsDetected: number;
  tokensUsed: number;
  skipped: boolean;
  skipReason?: string;
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

  const conditions: string[] = [
    `e.reflected_at IS NULL`,
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

  // No hard limit — get everything unreflected
  const sql = `
    SELECT * FROM events e
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.timestamp ASC
  `;

  return db.prepare(sql).all(...params) as MemoryEvent[];
}

function buildReflectionKey(opts: {
  trigger: "session_end" | "daily" | "manual";
  sessionId?: string;
  eventRange?: { since: string; until: string };
}): string | null {
  if (opts.sessionId) return `${opts.trigger}:session:${opts.sessionId}`;
  if (opts.eventRange) return `${opts.trigger}:range:${opts.eventRange.since}:${opts.eventRange.until}`;
  if (opts.trigger === "session_end") return null;
  return `${opts.trigger}:global`;
}

function markEventsReflected(eventIds: number[], runId: string): void {
  if (eventIds.length === 0) return;
  const db = getMemoryDb();
  const now = new Date().toISOString();
  const placeholders = eventIds.map(() => "?").join(", ");
  db.prepare(
    `UPDATE events
     SET reflected_at = ?, reflection_run_id = ?
     WHERE id IN (${placeholders})`,
  ).run(now, runId, ...eventIds);
}

function getRecentReflectionStartedAt(trigger: "session_end" | "daily" | "manual"): string | null {
  const db = getMemoryDb();
  const row = db.prepare(
    `SELECT started_at
     FROM reflection_runs
     WHERE trigger = ?
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(trigger) as { started_at: string } | undefined;
  return row?.started_at ?? null;
}

function getRecentReflectionTokenUsage(windowMs: number): number {
  const db = getMemoryDb();
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db.prepare(
    `SELECT COALESCE(SUM(tokens_used), 0) AS total
     FROM reflection_runs
     WHERE started_at >= ?
       AND status = 'completed'`,
  ).get(since) as { total: number | null } | undefined;
  return Number(row?.total ?? 0);
}

function getClusterLimit(trigger: "session_end" | "daily" | "manual"): number {
  if (trigger === "daily") return MAX_CLUSTERS_PER_DAILY_RUN;
  if (trigger === "session_end") return MAX_CLUSTERS_PER_SESSION_RUN;
  return MAX_CLUSTERS_PER_DAILY_RUN;
}

function getRunTokenLimit(trigger: "session_end" | "daily" | "manual"): number {
  if (trigger === "daily") return MAX_TOKENS_PER_DAILY_RUN;
  if (trigger === "session_end") return MAX_TOKENS_PER_SESSION_RUN;
  return MAX_TOKENS_PER_DAILY_RUN;
}

// ── Skipped run recording ────────────────────────────────────────────────────

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
    log().warn(`[reflection] Failed to record skipped run ${runId}: ${String(err)}`);
  }
}

// ── Stale run cleanup ────────────────────────────────────────────────────────

export function cleanupStaleRuns(): number {
  const db = getMemoryDb();
  const cutoff = new Date(Date.now() - STALE_RUN_THRESHOLD_MS).toISOString();

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

// ── Retry helper ─────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<{ result: T; ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      return { result, ok: true };
    } catch (err) {
      const errMsg = String(err);
      if (attempt < MAX_RETRIES) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        log().warn(
          `[reflection] ${label} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), ` +
            `retrying in ${backoff}ms: ${errMsg}`,
        );
        await sleep(backoff);
      } else {
        log().error(
          `[reflection] ${label} failed after ${MAX_RETRIES + 1} attempts: ${errMsg}`,
        );
        return { ok: false, error: errMsg };
      }
    }
  }
  // Unreachable, but TS needs it
  return { ok: false, error: "exhausted retries" };
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function runReflection(opts: {
  trigger: "session_end" | "daily" | "manual";
  sessionId?: string;
  eventRange?: { since: string; until: string };
}): Promise<ReflectionResult> {
  const runId = randomUUID();
  const reflectionKey = buildReflectionKey(opts);

  const skipped = (reason: string): ReflectionResult => {
    recordSkippedRun(runId, opts.trigger, reason);
    log().debug?.(`[reflection] Run ${runId} skipped: ${reason}`);
    return {
      runId,
      clustersProcessed: 0,
      clustersSkipped: 0,
      clustersErrored: 0,
      eventsProcessed: 0,
      memoriesCreated: 0,
      memoriesReinforced: 0,
      conflictsDetected: 0,
      tokensUsed: 0,
      skipped: true,
      skipReason: reason,
    };
  };

  if (opts.trigger === "session_end" && !opts.sessionId) {
    return skipped("session_end reflection requires a sessionId");
  }

  if (opts.trigger === "session_end") {
    const lastStartedAt = getRecentReflectionStartedAt("session_end");
    if (lastStartedAt) {
      const msSinceLastRun = Date.now() - new Date(lastStartedAt).getTime();
      if (msSinceLastRun < SESSION_END_COOLDOWN_MS) {
        return skipped(
          `session_end reflection cooldown active (${Math.ceil((SESSION_END_COOLDOWN_MS - msSinceLastRun) / 1000)}s remaining)`,
        );
      }
    }
  }

  const recentTokenUsage = getRecentReflectionTokenUsage(60 * 60 * 1000);
  if (recentTokenUsage >= HOURLY_TOKEN_BUDGET) {
    return skipped(`hourly reflection token budget exhausted (${recentTokenUsage}/${HOURLY_TOKEN_BUDGET})`);
  }

  if (reflectionKey && activeReflectionKeys.has(reflectionKey)) {
    return skipped(`reflection already running for ${reflectionKey}`);
  }

  if (reflectionKey) activeReflectionKeys.add(reflectionKey);

  let events: MemoryEvent[] = [];
  let db = getMemoryDb();
  let clustersProcessed = 0;
  let clustersSkipped = 0;
  let clustersErrored = 0;
  let memoriesCreated = 0;
  let memoriesReinforced = 0;
  let conflictsDetected = 0;

  try {
    // ── Gather events ────────────────────────────────────────────────────────

    events = gatherUnreflectedEvents({
      sessionId: opts.sessionId,
      since: opts.eventRange?.since,
      until: opts.eventRange?.until,
    });

    if (events.length < MIN_EVENTS_TO_REFLECT) {
      return skipped(`only ${events.length} events in scope (min ${MIN_EVENTS_TO_REFLECT})`);
    }

    // ── Start reflection run ────────────────────────────────────────────────

    db = getMemoryDb();
    const startedAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO reflection_runs
         (id, trigger, started_at, tier, status,
          events_processed, clusters_processed, memories_created, memories_reinforced,
          conflicts_detected, tokens_used)
       VALUES (?, ?, ?, 'local', 'running', ?, 0, 0, 0, 0, 0)`,
    ).run(runId, opts.trigger, startedAt, events.length);

    resetTokenCounter();

    // ── Cluster events ──────────────────────────────────────────────────────

    const clusters = clusterEvents(events);
    const clusterLimit = getClusterLimit(opts.trigger);
    const runTokenLimit = getRunTokenLimit(opts.trigger);

    // Sort: high priority first, then medium, skip last
    const priorityOrder = { high: 0, medium: 1, skip: 2 };
    clusters.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    log().info(
      `[reflection] Run ${runId}: ${events.length} events → ${clusters.length} clusters ` +
        `(${clusters.filter((c) => c.priority === "high").length} high, ` +
        `${clusters.filter((c) => c.priority === "medium").length} medium, ` +
        `${clusters.filter((c) => c.priority === "skip").length} skip)`,
    );

    // ── Process every non-skip cluster ──────────────────────────────────────

    for (const cluster of clusters) {
      if (clustersProcessed + clustersSkipped >= clusterLimit) {
        log().info(
          `[reflection] Run ${runId} reached cluster cap (${clusterLimit}) for ${opts.trigger}; deferring remaining clusters`,
        );
        break;
      }

      if (getTotalTokensUsed() >= runTokenLimit) {
        log().info(
          `[reflection] Run ${runId} reached token cap (${getTotalTokensUsed()}/${runTokenLimit}) for ${opts.trigger}; deferring remaining clusters`,
        );
        break;
      }

      // Skip low-priority clusters (all events below 0.5 signal)
      if (cluster.priority === "skip") {
        markEventsReflected(cluster.events.map((e) => e.id), runId);
        clustersSkipped++;
        continue;
      }

      // Extract with retry+backoff
      const extractResult = await withRetry(
        () => extractMemories(cluster),
        `cluster ${cluster.id} extraction`,
      );

      if (!extractResult.ok) {
        clustersErrored++;
        continue;
      }

      let candidates = extractResult.result;
      if (candidates.length === 0) {
        markEventsReflected(cluster.events.map((e) => e.id), runId);
        clustersProcessed++;
        continue;
      }

      // Per-cluster cap to prevent a single cluster from dominating
      if (candidates.length > MAX_NEW_MEMORIES_PER_CLUSTER) {
        candidates = candidates.slice(0, MAX_NEW_MEMORIES_PER_CLUSTER);
      }

      // Reconcile with retry+backoff
      const reconcileResult = await withRetry(
        () => reconcile(candidates, runId),
        `cluster ${cluster.id} reconciliation`,
      );

      if (!reconcileResult.ok) {
        clustersErrored++;
        continue;
      }

      const reconciled = reconcileResult.result;
      memoriesCreated += reconciled.newMemories.length;
      memoriesReinforced += reconciled.reinforcedMemories.length;
      conflictsDetected += reconciled.conflicts.length;
      markEventsReflected(cluster.events.map((e) => e.id), runId);

      // Cross-type conflict detection for high-confidence new memories
      if (reconciled.newMemories.length > 0) {
        const highConfIds = reconciled.newMemories
          .filter((m) => m.confidence > 0.7)
          .map((m) => m.id);
        if (highConfIds.length > 0) {
          try {
            const crossConflicts = await checkCrossTypeConflicts(highConfIds);
            if (crossConflicts > 0) {
              conflictsDetected += crossConflicts;
              log().info(
                `[reflection] Found ${crossConflicts} cross-type conflict(s) for ${highConfIds.length} new memories`,
              );
            }
          } catch (err) {
            log().warn(`[reflection] Cross-type conflict check failed: ${String(err)}`);
          }
        }
      }

      clustersProcessed++;
    }

    // ── Auto-resolve conflicts created during this run ──────────────────────
    try {
      const resolved = await autoResolveConflicts();
      if (resolved.resolved > 0) {
        log().info(
          `[reflection] Auto-resolved ${resolved.resolved} conflicts ` +
            `(${resolved.escalated} escalated, ${resolved.dismissed} dismissed)`,
        );
      }
    } catch (err) {
      log().warn(`[reflection] autoResolveConflicts failed: ${String(err)}`);
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
      `[reflection] Run ${runId} complete: ${events.length} events, ` +
        `${clustersProcessed} processed / ${clustersSkipped} skipped / ${clustersErrored} errored, ` +
        `${memoriesCreated} new, ${memoriesReinforced} reinforced, ` +
        `${conflictsDetected} conflicts, ${tokensUsed} tokens`,
    );

    return {
      runId,
      clustersProcessed,
      clustersSkipped,
      clustersErrored,
      eventsProcessed: events.length,
      memoriesCreated,
      memoriesReinforced,
      conflictsDetected,
      tokensUsed,
      skipped: false,
    };
  } catch (err) {
    log().error(`[reflection] Run ${runId} failed: ${String(err)}`);

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
      // ignore
    }

    return {
      runId,
      clustersProcessed,
      clustersSkipped,
      clustersErrored,
      eventsProcessed: events.length,
      memoriesCreated,
      memoriesReinforced,
      conflictsDetected,
      tokensUsed: getTotalTokensUsed(),
      skipped: false,
    };
  } finally {
    if (reflectionKey) activeReflectionKeys.delete(reflectionKey);
  }
}
