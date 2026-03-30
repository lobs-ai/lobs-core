/**
 * System heartbeat — periodic health check.
 *
 * Runs on a cron schedule (every 30 minutes) to check:
 * 1. lobs-core process health
 * 2. lobs-memory server availability
 * 3. LM Studio availability (local model)
 * 4. Task health (failed, blocked, stuck tasks)
 * 5. Recent worker completions
 * 6. Inbox items
 *
 * Returns a health report with any alerts.
 */

import { getRawDb } from "../db/connection.js";
import { log } from "../util/logger.js";

export interface HeartbeatResult {
  timestamp: Date;
  status: "healthy" | "degraded" | "unhealthy";
  alerts: string[];
  checks: {
    lobsCore: CheckResult;
    memoryServer: CheckResult;
    lmStudio: CheckResult;
    tasks: TaskHealthResult;
    workers: WorkerHealthResult;
    inbox: InboxHealthResult;
  };
}

interface CheckResult {
  status: "ok" | "warning" | "error";
  message: string;
}

interface TaskHealthResult extends CheckResult {
  activeTasks: number;
  failedTasks: number;
  blockedTasks: number;
}

interface WorkerHealthResult extends CheckResult {
  recentCompletions: number;
  recentFailures: number;
}

interface InboxHealthResult extends CheckResult {
  unreadItems: number;
}

/**
 * Check if the unified memory DB is ready.
 */
async function checkMemoryServer(): Promise<CheckResult> {
  try {
    const { getMemoryDb } = await import("../memory/db.js");
    getMemoryDb();
    return { status: "ok", message: "Memory service ready (unified DB)" };
  } catch (err) {
    return {
      status: "error",
      message: `Memory service error: ${err}`,
    };
  }
}

/**
 * Check if LM Studio is running and responding.
 */
async function checkLMStudio(): Promise<CheckResult> {
  const baseUrl = process.env.LM_STUDIO_URL ?? "http://localhost:1234";
  
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    
    if (response.ok) {
      const data = await response.json() as { data?: unknown[] };
      const models = data.data ?? [];
      
      if (models.length === 0) {
        return { status: "warning", message: "LM Studio running but no models loaded" };
      }
      
      return { status: "ok", message: `LM Studio OK (${models.length} models loaded)` };
    } else {
      return { status: "warning", message: `LM Studio returned ${response.status}` };
    }
  } catch (error) {
    return {
      status: "warning",
      message: "LM Studio not responding (local model unavailable)",
    };
  }
}

/**
 * Check task health in the database.
 */
async function checkTaskHealth(): Promise<TaskHealthResult> {
  const db = getRawDb();
  
  // Count active tasks
  const activeResult = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'active'").get() as { count: number };
  const activeTasks = activeResult.count;
  
  // Count failed tasks (completed but with failure)
  const failedResult = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed' AND failure_reason IS NOT NULL").get() as { count: number };
  const failedTasks = failedResult.count;
  
  // Count blocked tasks
  const blockedResult = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'waiting_on' OR blocked_by IS NOT NULL").get() as { count: number };
  const blockedTasks = blockedResult.count;
  
  let status: "ok" | "warning" | "error" = "ok";
  let message = `${activeTasks} active, ${failedTasks} failed, ${blockedTasks} blocked`;
  
  if (failedTasks > 5) {
    status = "warning";
    message = `High failure count: ${failedTasks} failed tasks`;
  }
  
  if (blockedTasks > 10) {
    status = "warning";
    message += ` | ${blockedTasks} blocked tasks`;
  }
  
  return {
    status,
    message,
    activeTasks,
    failedTasks,
    blockedTasks,
  };
}

/**
 * Check recent worker run health.
 */
async function checkWorkerHealth(): Promise<WorkerHealthResult> {
  const db = getRawDb();
  
  // Count completions in last hour
  const completionsResult = db.prepare(`
    SELECT COUNT(*) as count 
    FROM worker_runs 
    WHERE started_at >= datetime('now', '-1 hour')
    AND succeeded = 1
  `).get() as { count: number };
  const recentCompletions = completionsResult.count;
  
  // Count failures in last hour (exclude orphaned-on-restart — those are expected during deploys)
  const failuresResult = db.prepare(`
    SELECT COUNT(*) as count 
    FROM worker_runs 
    WHERE started_at >= datetime('now', '-1 hour')
    AND succeeded = 0
    AND (timeout_reason IS NULL OR timeout_reason != 'orphaned on restart')
  `).get() as { count: number };
  const recentFailures = failuresResult.count;
  
  let status: "ok" | "warning" | "error" = "ok";
  let message = `${recentCompletions} completions, ${recentFailures} failures (last hour)`;
  
  // High failure rate = problem
  if (recentFailures > 0 && recentCompletions > 0) {
    const failureRate = recentFailures / (recentCompletions + recentFailures);
    if (failureRate > 0.5) {
      status = "warning";
      message = `High failure rate: ${(failureRate * 100).toFixed(1)}%`;
    }
  }
  
  return {
    status,
    message,
    recentCompletions,
    recentFailures,
  };
}

/**
 * Check inbox health.
 */
async function checkInboxHealth(): Promise<InboxHealthResult> {
  const db = getRawDb();
  
  const result = db.prepare("SELECT COUNT(*) as count FROM inbox_items WHERE is_read = 0").get() as { count: number };
  const unreadItems = result.count;
  
  let status: "ok" | "warning" | "error" = "ok";
  let message = `${unreadItems} unread items`;
  
  if (unreadItems > 20) {
    status = "warning";
    message = `Inbox backing up: ${unreadItems} unread items`;
  }
  
  return {
    status,
    message,
    unreadItems,
  };
}

/**
 * Run the heartbeat check.
 */
export async function runHeartbeat(): Promise<HeartbeatResult> {
  log().info("[heartbeat] Running system health check");
  
  const checks = {
    lobsCore: { status: "ok" as const, message: "Process running" },
    memoryServer: await checkMemoryServer(),
    lmStudio: await checkLMStudio(),
    tasks: await checkTaskHealth(),
    workers: await checkWorkerHealth(),
    inbox: await checkInboxHealth(),
  };
  
  // Collect alerts
  const alerts: string[] = [];
  
  for (const [name, check] of Object.entries(checks)) {
    if (check.status === "error") {
      alerts.push(`${name}: ${check.message}`);
    } else if (check.status === "warning") {
      alerts.push(`${name}: ${check.message}`);
    }
  }
  
  // Overall status
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";
  
  if (alerts.some((a) => a.includes("error"))) {
    status = "unhealthy";
  } else if (alerts.length > 0) {
    status = "degraded";
  }
  
  const result: HeartbeatResult = {
    timestamp: new Date(),
    status,
    alerts,
    checks,
  };
  
  // Log summary
  if (status === "healthy") {
    log().info(`[heartbeat] ✓ System healthy`);
  } else {
    log().info(`[heartbeat] ⚠ System ${status}: ${alerts.join("; ")}`);
  }
  
  return result;
}
