/**
 * PAW Admin API — operator-only maintenance endpoints.
 *
 * Routes:
 *   POST /api/admin/tasks/reset-crash-orphans[?dry_run=true]
 *
 * When to use reset-crash-orphans:
 *   Use this endpoint to recover tasks that were auto-blocked by the spawn guard
 *   due to INFRASTRUCTURE crashes (e.g. gateway TypeErrors, OOM kills) that occurred
 *   BEFORE crash_count tracking was implemented. These tasks have:
 *     - status = 'cancelled'
 *     - failure_reason LIKE '%Auto-blocked%'
 *     - crash_count = 0   (crash was never recorded, so effective_fail = spawn_count)
 *   The spawn guard misclassifies these as exhausted from real agent failures.
 *
 *   DO NOT use this to reset tasks that failed due to genuine repeated agent errors.
 *   Always use ?dry_run=true first to preview what will be reset.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { json, error, parseQuery } from "./index.js";
import { log } from "../util/logger.js";

// Convenience wrapper
const logger = { info: (msg: string) => log().info?.(msg) };

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
): Promise<void> {
  // parts[0] = "admin", parts[1] = sub-resource, parts[2] = action
  const sub = parts[1];
  const action = parts[2];

  // POST /api/admin/tasks/reset-crash-orphans[?dry_run=true]
  if (sub === "tasks" && action === "reset-crash-orphans" && req.method === "POST") {
    return handleResetCrashOrphans(req, res);
  }

  // POST /api/admin/tasks/:id/reset-spawn
  if (sub === "tasks" && action && parts[3] === "reset-spawn" && req.method === "POST") {
    return handleResetSpawnById(req, res, action /* action holds the task id here */);
  }

  return error(res, `Unknown admin route: ${sub}/${action}`, 404);
}

/**
 * POST /api/admin/tasks/reset-crash-orphans
 *
 * Finds all tasks that were auto-blocked due to infrastructure crashes
 * (spawn_count >= 1, crash_count = 0, status = 'cancelled', failure_reason contains 'Auto-blocked')
 * and resets them so they can be retried.
 *
 * Query params:
 *   dry_run=true   — list affected tasks without modifying anything (default: false)
 */
async function handleResetCrashOrphans(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const query = parseQuery(req.url ?? "");
  const dryRun = query.dry_run === "true" || query.dry_run === "1";

  const db = getDb();

  // Find crash-orphan tasks:
  // - status = 'cancelled' (set by spawn guard)
  // - failure_reason contains 'Auto-blocked' (set by spawn guard exhaustion path)
  // - crash_count = 0 (the infra crash was never recorded; these are NOT real agent failures)
  // - spawn_count >= 1 (actually had spawn attempts)
  const orphans = db.select({
    id: tasks.id,
    title: tasks.title,
    agent: tasks.agent,
    spawnCount: tasks.spawnCount,
    crashCount: tasks.crashCount,
    failureReason: tasks.failureReason,
    status: tasks.status,
    updatedAt: tasks.updatedAt,
  }).from(tasks)
    .where(
      and(
        eq(tasks.status, "cancelled"),
        eq(tasks.crashCount, 0),
      )
    )
    .all()
    // Post-filter: failure_reason must contain 'Auto-blocked' (SQLite LIKE is case-insensitive)
    .filter(t => t.failureReason?.includes("Auto-blocked"));

  if (dryRun) {
    return json(res, {
      dry_run: true,
      count: orphans.length,
      tasks: orphans.map(t => ({
        id: t.id,
        title: t.title,
        agent: t.agent,
        spawn_count: t.spawnCount,
        crash_count: t.crashCount,
        failure_reason: t.failureReason,
        would_reset_to: { status: "active", work_state: "not_started", spawn_count: 0, crash_count: 0, failure_reason: null },
      })),
    });
  }

  // Apply reset
  const now = new Date().toISOString();
  const reset: { id: string; title: string; agent: string | null }[] = [];

  for (const t of orphans) {
    db.update(tasks).set({
      status: "active",
      workState: "not_started",
      spawnCount: 0,
      crashCount: 0,
      failureReason: null,
      updatedAt: now,
    }).where(eq(tasks.id, t.id)).run();

    reset.push({ id: t.id, title: t.title, agent: t.agent ?? null });

    logger.info(`[admin] reset-crash-orphan: id=${t.id} title="${t.title}" agent=${t.agent} spawn_count_was=${t.spawnCount} → reactivated`);
  }

  return json(res, {
    dry_run: false,
    reset_count: reset.length,
    tasks: reset,
  });
}

/**
 * POST /api/admin/tasks/:id/reset-spawn
 *
 * Manually reset spawn_count + crash_count for a single task and reactivate it.
 * Use when you know a specific task was blocked by infra failures, not real agent errors.
 */
async function handleResetSpawnById(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
): Promise<void> {
  const db = getDb();
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return error(res, `Task not found: ${taskId}`, 404);

  const now = new Date().toISOString();
  db.update(tasks).set({
    status: "active",
    workState: "not_started",
    spawnCount: 0,
    crashCount: 0,
    failureReason: null,
    updatedAt: now,
  }).where(eq(tasks.id, taskId)).run();

  logger.info(`[admin] reset-spawn: id=${taskId} title="${task.title}" agent=${task.agent} spawn_count_was=${task.spawnCount} crash_count_was=${task.crashCount} → reactivated`);

  return json(res, {
    ok: true,
    id: taskId,
    title: task.title,
    previous: { status: task.status, spawn_count: task.spawnCount, crash_count: task.crashCount, failure_reason: task.failureReason },
    now: { status: "active", work_state: "not_started", spawn_count: 0, crash_count: 0, failure_reason: null },
  });
}
