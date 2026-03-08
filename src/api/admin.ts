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

  // GET /api/admin/tasks/deadlocks[?dry_run=true]  — detect circular blocked_by cycles
  if (sub === "tasks" && action === "deadlocks" && req.method === "GET") {
    return handleDetectDeadlocks(req, res);
  }

  // POST /api/admin/tasks/deadlocks/break[?dry_run=true]  — clear blocked_by on all deadlocked tasks
  if (sub === "tasks" && action === "deadlocks" && parts[3] === "break" && req.method === "POST") {
    return handleBreakDeadlocks(req, res);
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
 * GET /api/admin/tasks/deadlocks
 *
 * Detect all circular blocked_by cycles across active tasks.
 * Returns the set of task IDs involved in cycles (each cycle listed separately).
 *
 * Uses Kahn's algorithm (topological sort) to find nodes that remain after
 * processing the DAG — those are part of a cycle.
 */
async function handleDetectDeadlocks(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const db = getDb();

  // Fetch all tasks that have blocked_by set
  const allTasks = db.select({
    id: tasks.id,
    title: tasks.title,
    agent: tasks.agent,
    blockedBy: tasks.blockedBy,
    status: tasks.status,
  }).from(tasks).all();

  // Build adjacency: blocked → blocker (i.e. edge from task to its blockers)
  // For cycle detection, we treat blocked_by as directed edges: task → blockers it depends on
  // A cycle exists when following these edges leads back to the starting node.

  // Build in-degree map and adjacency for Kahn's algorithm
  const taskIds = new Set(allTasks.map(t => t.id));
  const inDegree = new Map<string, number>();
  const dependsOn = new Map<string, string[]>(); // task → [blockers it depends on that exist]

  for (const t of allTasks) {
    if (!inDegree.has(t.id)) inDegree.set(t.id, 0);
    const blockers: string[] = Array.isArray(t.blockedBy)
      ? (t.blockedBy as string[]).filter(b => taskIds.has(b))
      : [];
    dependsOn.set(t.id, blockers);
    for (const b of blockers) {
      inDegree.set(b, (inDegree.get(b) ?? 0)); // ensure blocker is in map
    }
  }

  // Compute in-degree as "how many tasks depend on me"
  // For Kahn's: we want to find nodes with no dependents first (leaf tasks)
  // Re-derive: in-degree = number of tasks that list me as a blocker
  const dependedOnBy = new Map<string, Set<string>>(); // blocker → tasks that depend on it
  for (const [taskId, blockers] of dependsOn) {
    for (const b of blockers) {
      if (!dependedOnBy.has(b)) dependedOnBy.set(b, new Set());
      dependedOnBy.get(b)!.add(taskId);
    }
  }

  // Kahn's: start with tasks that have no blockers (in-degree=0 in blocked_by graph)
  const blockerCount = new Map<string, number>();
  for (const t of allTasks) {
    blockerCount.set(t.id, dependsOn.get(t.id)?.length ?? 0);
  }

  const queue: string[] = [];
  for (const [id, cnt] of blockerCount) {
    if (cnt === 0) queue.push(id);
  }

  const processed = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed.add(current);
    // For all tasks that depend on current (i.e. current is their blocker):
    for (const dependent of (dependedOnBy.get(current) ?? [])) {
      const newCount = (blockerCount.get(dependent) ?? 1) - 1;
      blockerCount.set(dependent, newCount);
      if (newCount === 0) queue.push(dependent);
    }
  }

  // Any task not processed is in a cycle
  const cycleIds = allTasks.filter(t => !processed.has(t.id));

  if (cycleIds.length === 0) {
    return json(res, { deadlocks: [], count: 0, message: "No circular dependencies detected" });
  }

  // Group into cycles using DFS on the subset of cyclic nodes
  const cycleSet = new Set(cycleIds.map(t => t.id));
  const visitState = new Map<string, "unvisited" | "visiting" | "visited">();
  const cycles: string[][] = [];

  function dfs(nodeId: string, path: string[]): void {
    const state = visitState.get(nodeId) ?? "unvisited";
    if (state === "visited") return;
    if (state === "visiting") {
      // Found a cycle — extract the cycle portion from path
      const cycleStart = path.indexOf(nodeId);
      if (cycleStart !== -1) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    visitState.set(nodeId, "visiting");
    for (const blocker of (dependsOn.get(nodeId) ?? [])) {
      if (cycleSet.has(blocker)) {
        dfs(blocker, [...path, nodeId]);
      }
    }
    visitState.set(nodeId, "visited");
  }

  for (const t of cycleIds) {
    if ((visitState.get(t.id) ?? "unvisited") === "unvisited") {
      dfs(t.id, []);
    }
  }

  const taskById = new Map(allTasks.map(t => [t.id, t]));

  return json(res, {
    deadlocks: cycles.map(cycle => cycle.map(id => ({
      id,
      title: taskById.get(id)?.title ?? "(unknown)",
      agent: taskById.get(id)?.agent ?? null,
      status: taskById.get(id)?.status ?? null,
    }))),
    count: cycles.length,
    affected_task_ids: cycleIds.map(t => t.id),
  });
}

/**
 * POST /api/admin/tasks/deadlocks/break[?dry_run=true]
 *
 * Clears blocked_by on all tasks involved in circular dependency cycles.
 * This breaks the deadlock by removing all blocker references from cyclic tasks.
 *
 * Use ?dry_run=true to preview which tasks would be affected.
 */
async function handleBreakDeadlocks(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const query = parseQuery(req.url ?? "");
  const dryRun = query.dry_run === "true" || query.dry_run === "1";
  const db = getDb();

  // Reuse deadlock detection logic inline
  const allTasks = db.select({
    id: tasks.id,
    title: tasks.title,
    agent: tasks.agent,
    blockedBy: tasks.blockedBy,
    status: tasks.status,
  }).from(tasks).all();

  const taskIds = new Set(allTasks.map(t => t.id));
  const dependsOn = new Map<string, string[]>();
  const dependedOnBy = new Map<string, Set<string>>();

  for (const t of allTasks) {
    const blockers: string[] = Array.isArray(t.blockedBy)
      ? (t.blockedBy as string[]).filter(b => taskIds.has(b))
      : [];
    dependsOn.set(t.id, blockers);
  }

  for (const [taskId, blockers] of dependsOn) {
    for (const b of blockers) {
      if (!dependedOnBy.has(b)) dependedOnBy.set(b, new Set());
      dependedOnBy.get(b)!.add(taskId);
    }
  }

  const blockerCount = new Map<string, number>();
  for (const t of allTasks) {
    blockerCount.set(t.id, dependsOn.get(t.id)?.length ?? 0);
  }

  const queue: string[] = [];
  for (const [id, cnt] of blockerCount) {
    if (cnt === 0) queue.push(id);
  }

  const processed = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed.add(current);
    for (const dependent of (dependedOnBy.get(current) ?? [])) {
      const newCount = (blockerCount.get(dependent) ?? 1) - 1;
      blockerCount.set(dependent, newCount);
      if (newCount === 0) queue.push(dependent);
    }
  }

  const cycleIds = allTasks.filter(t => !processed.has(t.id));

  if (cycleIds.length === 0) {
    return json(res, { broken: 0, message: "No circular dependencies found — nothing to break", dry_run: dryRun });
  }

  if (dryRun) {
    return json(res, {
      dry_run: true,
      would_clear_blocked_by: cycleIds.map(t => ({
        id: t.id,
        title: t.title,
        agent: t.agent,
        blocked_by: t.blockedBy,
      })),
      count: cycleIds.length,
    });
  }

  const now = new Date().toISOString();
  for (const t of cycleIds) {
    db.update(tasks).set({ blockedBy: null, updatedAt: now }).where(eq(tasks.id, t.id)).run();
    logger.info(`[admin] break-deadlock: cleared blocked_by on id=${t.id} title="${t.title}"`);
  }

  return json(res, {
    dry_run: false,
    broken: cycleIds.length,
    cleared: cycleIds.map(t => ({ id: t.id, title: t.title, agent: t.agent ?? null })),
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
