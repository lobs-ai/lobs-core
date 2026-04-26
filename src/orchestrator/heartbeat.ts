/**
 * System heartbeat — periodic health check.
 *
 * Runs on a cron schedule (every 5 minutes, ADR-008) to check:
 * 1. lobs-core process health
 * 2. lobs-memory server availability
 * 3. LM Studio availability (local model)
 * 4. Task health (failed, blocked, stuck tasks)
 * 5. Recent worker completions
 * 6. Inbox items
 *
 * ADR-008 (Unlimited Operations): Also monitors backlog depth and worker idle
 * capacity to trigger continuous dispatch when tasks pile up.
 *
 * Returns a health report with any alerts.
 */

import { getRawDb } from "../db/connection.js";
import { log } from "../util/logger.js";
import { getNextTasks, getSchedulerConfig } from "./scheduler.js";
import { ToolName } from "../runner/types.js";
import { runAgent } from "../runner/index.js";
import { getModelForTier } from "../config/models.js";
import { recordWorkerStart } from "./worker-manager.js";

export interface SpawnedWorker {
  taskId: string;
  agent: string;
  model: string;
}

export interface HeartbeatResult {
  timestamp: Date;
  status: "healthy" | "degraded" | "unhealthy";
  alerts: string[];
  spawnedWorkers: SpawnedWorker[];
  checks: {
    lobsCore: CheckResult;
    memoryServer: CheckResult;
    lmStudio: CheckResult;
    tasks: TaskHealthResult;
    workers: WorkerHealthResult;
    inbox: InboxHealthResult;
    schedulerQueueDepth: CheckResult;
    memoryPressure: CheckResult;
    heartbeatLiveness: CheckResult;
    costAudit: CheckResult;
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
  } catch {
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
  
  // Count failed tasks (completed but with failure) — only within last 7 days to avoid stale alerts
  const failedResult = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed' AND failure_reason IS NOT NULL AND updated_at > datetime('now', '-7 days')").get() as { count: number };
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
 * Check scheduler queue depth (ADR-008).
 * Error when: pending > 50 AND pending > 3 * active
 */
async function checkSchedulerQueueDepth(): Promise<CheckResult> {
  const db = getRawDb();
  
  const pendingResult = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'active')").get() as { count: number };
  const pending = pendingResult.count;
  
  const activeResult = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'active'").get() as { count: number };
  const active = activeResult.count;
  
  if (pending > 50 && pending > 3 * active) {
    return {
      status: "error",
      message: `Scheduler backlog critical: ${pending} pending (${active} active) — worker capacity insufficient`,
    };
  }
  
  return {
    status: "ok",
    message: `Scheduler queue OK: ${pending} pending, ${active} active`,
  };
}

/**
 * Check memory pressure (ADR-008).
 * Warning when: heap > 70%
 * Error when: RSS > 1GB
 */
async function checkMemoryPressure(): Promise<CheckResult> {
  const memUsage = process.memoryUsage();
  const heapUsedPct = (memUsage.heapUsed / memUsage.heapTotal) * 100;
  const rssMB = memUsage.rss / 1024 / 1024;
  
  if (rssMB > 1024) {
    return {
      status: "error",
      message: `Memory pressure critical: RSS ${rssMB.toFixed(0)}MB (${heapUsedPct.toFixed(0)}% heap)`,
    };
  }
  
  if (heapUsedPct > 70) {
    return {
      status: "warning",
      message: `Memory pressure elevated: ${heapUsedPct.toFixed(0)}% heap used (RSS ${rssMB.toFixed(0)}MB)`,
    };
  }
  
  return {
    status: "ok",
    message: `Memory OK: ${heapUsedPct.toFixed(0)}% heap, RSS ${rssMB.toFixed(0)}MB`,
  };
}

/**
 * Check heartbeat liveness (ADR-008).
 * Error when: last heartbeat > 3 minutes ago.
 * Uses the orchestrator_settings table to track last heartbeat time.
 */
async function checkHeartbeatLiveness(): Promise<CheckResult> {
  const db = getRawDb();
  
  // value is stored as JSON string in the DB
  const lastHeartbeatRow = db.prepare("SELECT value FROM orchestrator_settings WHERE key = 'last_heartbeat_at'").get() as { value: string } | undefined;
  
  if (!lastHeartbeatRow) {
    return {
      status: "error",
      message: "No heartbeat recorded — orchestrator may be stalled",
    };
  }
  
  // value is JSON-encoded string
  const lastHeartbeatStr = typeof lastHeartbeatRow.value === "string" ? JSON.parse(lastHeartbeatRow.value) : lastHeartbeatRow.value;
  const lastHeartbeat = new Date(lastHeartbeatStr as string);
  const now = new Date();
  const diffMinutes = (now.getTime() - lastHeartbeat.getTime()) / 1000 / 60;
  
  if (diffMinutes > 3) {
    return {
      status: "error",
      message: `Heartbeat stalled: last run ${diffMinutes.toFixed(1)} minutes ago`,
    };
  }
  
  return {
    status: "ok",
    message: `Heartbeat OK: ${diffMinutes.toFixed(1)} minutes since last run`,
  };
}

/**
 * Check cost audit status (ADR-008).
 * Weekly digest alert if last audit > 7 days ago.
 */
async function checkCostAudit(): Promise<CheckResult> {
  const db = getRawDb();
  
  // value is stored as JSON string in the DB
  const lastAuditRow = db.prepare("SELECT value FROM orchestrator_settings WHERE key = 'last_cost_audit_at'").get() as { value: string } | undefined;
  
  if (!lastAuditRow) {
    return {
      status: "warning",
      message: "No cost audit recorded yet",
    };
  }
  
  // value is JSON-encoded string
  const lastAuditStr = typeof lastAuditRow.value === "string" ? JSON.parse(lastAuditRow.value) : lastAuditRow.value;
  const lastAudit = new Date(lastAuditStr as string);
  const now = new Date();
  const diffDays = (now.getTime() - lastAudit.getTime()) / 1000 / 60 / 60 / 24;
  
  if (diffDays > 7) {
    return {
      status: "warning",
      message: `Cost audit overdue: ${diffDays.toFixed(0)} days since last audit`,
    };
  }
  
  return {
    status: "ok",
    message: `Cost audit OK: ${diffDays.toFixed(0)} days since last audit`,
  };
}

/**
 * Check inbox health (ADR-008).
 * Warning when: pending > 30
 * Error when: pending > 100
 */
async function checkInboxHealth(): Promise<InboxHealthResult> {
  const db = getRawDb();
  
  // Count items that actually need attention: unread AND still pending action
  // Exclude intel_insight — those are batch-generated feed items, not actionable inbox items
  // NULL action_status means the item was inserted before the action_status column existed — treat as pending
  // 5-minute grace period: exclude freshly-inserted items to avoid alerting during bulk inserts (race condition with inbox writer)
  const result = db.prepare("SELECT COUNT(*) as count FROM inbox_items WHERE is_read = 0 AND type != 'intel_insight' AND (action_status = 'pending' OR action_status IS NULL) AND (modified_at IS NULL OR modified_at < datetime('now', '-5 minutes'))").get() as { count: number };
  const unreadItems = result.count;
  
  let status: "ok" | "warning" | "error" = "ok";
  let message = `${unreadItems} unread items`;
  
  if (unreadItems > 100) {
    status = "error";
    message = `Inbox critical: ${unreadItems} unread items`;
  } else if (unreadItems > 30) {
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
    schedulerQueueDepth: await checkSchedulerQueueDepth(),
    memoryPressure: await checkMemoryPressure(),
    heartbeatLiveness: await checkHeartbeatLiveness(),
    costAudit: await checkCostAudit(),
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
  
  // ─── Worker spawning (ADR-008: continuous dispatch) ───────────────────────
  const spawnedWorkers: SpawnedWorker[] = [];

  try {
    const config = await getSchedulerConfig();
    if (config.maxConcurrentWorkers > 0) {
      const tasks = await getNextTasks(config);

      if (tasks.length === 0) {
        log().info("[heartbeat] ✓ All healthy, no pending tasks");
      } else {
        for (const task of tasks) {
          if (spawnedWorkers.length >= config.maxConcurrentWorkers) break;
          // ADR-008: Auto-escalate to strong tier after 2+ failures on same task
          const taskAny = task as unknown as Record<string, unknown>;
          const tier = ((taskAny["escalationTier"] as number) ?? 0) > 0 || ((taskAny["retryCount"] as number) ?? 0) >= 2
            ? "strong"
            : ((taskAny["modelTier"] as string) ?? "standard");
          const model = getModelForTier(tier);
          const workerId = `heartbeat-${task.id}-${Date.now()}`;
          log().info(`[heartbeat] Spawning worker taskId=${task.id} agent=${task.agent || "programmer"} model=${model} tier=${tier}`);
          // Fire and forget — let the worker run independently
          runAgent({
            task: task.title,
            agent: task.agent || "programmer",
            model,
            cwd: process.cwd(),
            tools: ["read", "write", "edit", "bash", "glob", "grep", "task_create", "task_update", "task_list"] as ToolName[],
            timeout: 7200000, // 2 hours default
            context: { taskId: task.id },
          }).catch((err) => log().error(`[heartbeat] Worker spawn failed taskId=${task.id}: ${String(err)}`));
          // ADR-008: track worker runs so stuck worker detection works
          recordWorkerStart({ workerId, agentType: task.agent || "programmer", taskId: task.id, model });
          spawnedWorkers.push({ taskId: task.id, agent: task.agent || "programmer", model });
        }
      }
    }
  } catch (err) {
    log().error("[heartbeat] Worker spawning error: " + String(err));
    alerts.push("worker_spawn: error");
  }

  // ─── Stuck Worker Detection (ADR-008) ─────────────────────────────────────
  // Log warning for workers running >45 minutes without completion
  try {
    const db = getRawDb();
    const stuckResult = db.prepare(`
      SELECT id, task_id, started_at, strftime('%s', 'now') - strftime('%s', started_at) as running_seconds
      FROM worker_runs
      WHERE finished_at IS NULL
      AND started_at <= datetime('now', '-45 minutes')
      ORDER BY started_at ASC
      LIMIT 5
    `).all() as { id: string; task_id: string; started_at: string; running_seconds: number }[];

    for (const worker of stuckResult) {
      const durationMin = Math.floor(worker.running_seconds / 60);
      log().warn(`[heartbeat] Worker ${worker.id} may be stuck (task=${worker.task_id}, duration=${durationMin}m)`);
      alerts.push(`stuck_worker: ${worker.id} (task=${worker.task_id}, ${durationMin}m)`);
    }
  } catch (err) {
    log().warn("[heartbeat] Stuck worker detection error: " + String(err));
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
    spawnedWorkers,
    checks,
  };
  
  // Log summary
  if (status === "healthy") {
    log().info(`[heartbeat] ✓ System healthy`);
  } else {
    log().info(`[heartbeat] ⚠ System ${status}: ${alerts.join("; ")}`);
  }

  // Record last heartbeat time in orchestrator_settings (ADR-008: heartbeat liveness check)
  try {
    const db = getRawDb();
    const timestamp = new Date().toISOString();
    // upsert — value is stored as JSON
    const existing = db.prepare("SELECT key FROM orchestrator_settings WHERE key = 'last_heartbeat_at'").get();
    if (existing) {
      db.prepare("UPDATE orchestrator_settings SET value = ?, updated_at = datetime('now') WHERE key = 'last_heartbeat_at'").run(JSON.stringify(timestamp));
    } else {
      db.prepare("INSERT INTO orchestrator_settings (key, value) VALUES ('last_heartbeat_at', ?)").run(JSON.stringify(timestamp));
    }
  } catch (err) {
    log().warn(`[heartbeat] Failed to record last_heartbeat_at: ${String(err)}`);
  }

  return result;
}
