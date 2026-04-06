/**
 * DB Maintenance — periodic cleanup of old data to keep the SQLite DB lean.
 *
 * Runs daily. Prunes:
 * - Control loop events older than 7 days
 * - Main agent messages older than 14 days (compacted summaries preserve context)
 * - Chat messages older than 30 days
 * - Processed inbox items older than 14 days
 * - Worker logs older than 30 days
 *
 * After pruning, runs VACUUM to reclaim disk space.
 */

import { statSync } from "node:fs";
import { log } from "../util/logger.js";
import { getRawDb } from "../db/connection.js";
import { getLobsRoot } from "../config/lobs.js";

interface MaintenanceResult {
  pruned: Record<string, number>;
  vacuumed: boolean;
  durationMs: number;
  dbSizeBefore: number;
  dbSizeAfter: number;
}

export async function runDbMaintenance(): Promise<MaintenanceResult> {
  const start = Date.now();
  const db = getRawDb();
  const pruned: Record<string, number> = {};

  // Get DB size before
  const dbSizeBefore = getDbSizeBytes();

  // Prune control loop events > 7 days
  const cle = db.prepare(
    "DELETE FROM control_loop_events WHERE created_at < datetime('now', '-7 days')"
  ).run();
  pruned.control_loop_events = cle.changes;

  // Prune main agent messages > 14 days (compaction summaries preserve context)
  const mam = db.prepare(
    "DELETE FROM main_agent_messages WHERE created_at < datetime('now', '-14 days')"
  ).run();
  pruned.main_agent_messages = mam.changes;

  // Prune old chat messages > 30 days
  const cm = db.prepare(
    "DELETE FROM chat_messages WHERE created_at < datetime('now', '-30 days')"
  ).run();
  pruned.chat_messages = cm.changes;

  // Prune processed inbox items > 14 days (keep unread/pending)
  const ii = db.prepare(
    "DELETE FROM inbox_items WHERE is_read = 1 AND action_status != 'pending' AND modified_at < datetime('now', '-14 days')"
  ).run();
  pruned.inbox_items = ii.changes;

  // Prune worker logs > 30 days
  const wl = db.prepare(
    "DELETE FROM worker_logs WHERE created_at < datetime('now', '-30 days')"
  ).run();
  pruned.worker_logs = wl.changes;

  // Prune diagnostic trigger events > 7 days
  const dte = db.prepare(
    "DELETE FROM diagnostic_trigger_events WHERE created_at < datetime('now', '-7 days')"
  ).run();
  pruned.diagnostic_trigger_events = dte.changes;

  const totalPruned = Object.values(pruned).reduce((a, b) => a + b, 0);

  // VACUUM only if we actually deleted stuff (it's expensive)
  let vacuumed = false;
  if (totalPruned > 100) {
    try {
      db.exec("VACUUM");
      vacuumed = true;
    } catch (e) {
      log().error(`[db-maintenance] VACUUM failed: ${String(e)}`);
    }
  }

  const dbSizeAfter = getDbSizeBytes();
  const durationMs = Date.now() - start;

  if (totalPruned > 0) {
    const savedMB = ((dbSizeBefore - dbSizeAfter) / 1048576).toFixed(1);
    const entries = Object.entries(pruned)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    log().info(
      `[db-maintenance] Pruned ${totalPruned} rows (${entries}). ` +
      `DB: ${(dbSizeBefore / 1048576).toFixed(1)}MB → ${(dbSizeAfter / 1048576).toFixed(1)}MB ` +
      `(saved ${savedMB}MB). VACUUM: ${vacuumed}. Took ${durationMs}ms.`
    );
  } else {
    log().info(`[db-maintenance] No rows to prune. DB size: ${(dbSizeAfter / 1048576).toFixed(1)}MB.`);
  }

  return { pruned, vacuumed, durationMs, dbSizeBefore, dbSizeAfter };
}

function getDbSizeBytes(): number {
  try {
    const dbPath = process.env.LOBS_DB_PATH ?? `${getLobsRoot()}/lobs.db`;
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}
