/**
 * Orchestrator control loop — main scan/dispatch service.
 *
 * On each tick:
 * 1. Advance active workflow runs (one step per run)
 * 1b. Process pending spawn requests (drain queue → gateway /tools/invoke)
 * 2. Process workflow events (event-triggered workflows)
 * 3. Process schedule triggers (cron-triggered workflows)
 * 4. Scan for new ready tasks → match to workflows → start runs
 * 5. Health check active workers (detect stale)
 * 6. Worker health check (legacy)
 * 7. Auto-close active tasks whose every worker_run shows succeeded=true
 *
 * Spawns route through the "sink" agent session so completion announcements
 * don't pollute the main session.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { eq, and, isNull, isNotNull, inArray } from "drizzle-orm";
import { log } from "../util/logger.js";
import { processPendingResumes } from "../index.js";
import { WorkflowExecutor } from "../workflow/engine.js";
import { popPendingSpawns, requeueSpawn, type SpawnRequest } from "../workflow/nodes.js";
import { getDb, getRawDb } from "../db/connection.js";
import { inferProjectId } from "../util/project-inference.js";
import { workflowRuns, workerRuns as workerRunsTable, tasks as tasksTable } from "../db/schema.js";
import { maybeFlushTriageQueue } from "./triage.js";
import { buildTaskContext } from "../util/task-context.js";
import { findReadyTasks } from "./scanner.js";
import {
  hasCapacity,
  projectHasActiveWorker,
  projectHasPendingSpawn,
  recordWorkerStart,
  recordWorkerEnd,
  incrementPendingSpawns,
  decrementPendingSpawns,
  detectStaleWorkers,
  forceTerminateWorker,
  type FailureType,
} from "./worker-manager.js";
import { chooseModel, resolveTaskTier, TIER_MODELS, buildFallbackChain, escalationModel, type ModelTier } from "./model-chooser.js";
import { EscalationManager, ESCALATION_TIERS, type EscalationTier } from "./escalation.js";
import { chooseHealthyModel, seedModelHealthFromHistory } from "./model-health.js";
import { checkArtifacts } from "./artifact-check.js";
import { validatePostSuccessArtifacts } from "./post-success-validator.js";
import { LearningService, inferTaskCategory } from "../services/learning.js";
import { runAgent, assembleContext } from "../runner/index.js";
import type { AgentResult } from "../runner/index.js";

const learningSvc = new LearningService();

let timer: ReturnType<typeof setInterval> | null = null;
let executor: WorkflowExecutor | null = null;
let gatewayPort: number = 18789;
let gatewayToken: string = "";

export function getGatewayConfig(): { port: number; token: string } {
  return { port: gatewayPort, token: gatewayToken };
}
let isFirstTick = true;

// ── Native Runner Config ─────────────────────────────────────────────────────

/** Use our custom agent runner instead of OpenClaw sessions_spawn */
const USE_NATIVE_RUNNER = true; // Set to false to fall back to OpenClaw sessions_spawn


/** Session key for the sink agent — spawns route here to avoid polluting main */
const SINK_SESSION_KEY = "agent:sink:paw-orchestrator-v2";


/**
 * Check if a worker session is still alive and making progress.
 * Returns true if the session exists AND has been updated in the last 5 minutes.
 * This allows slow local models to run as long as they're making progress,
 * while detecting dead sessions that stopped advancing.
 */
async function checkSessionAlive(sessionKey: string): Promise<boolean> {
  try {
    // Strategy: check the transcript file directly instead of relying on sessions_list,
    // which can miss ephemeral subagent sessions after store cleanup.

    // Extract agent id from session key (e.g. "agent:programmer:subagent:UUID" → "programmer")
    const parts = sessionKey.split(":");
    const agentId = parts[1] ?? "main";
    // Extract session UUID — the last UUID-like segment
    const uuidMatch = sessionKey.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);

    // Try to find the session in the agent's session store
    const storePath = `${process.env.HOME}/.openclaw/agents/${agentId}/sessions/sessions.json`;
    try {
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      const entry = store[sessionKey];
      if (entry) {
        const updatedAt = entry.updatedAt as number;
        const ageMs = Date.now() - updatedAt;
        const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — matches runTimeoutSeconds
        if (ageMs <= STALE_THRESHOLD_MS) return true;
        // Entry exists but stale — check transcript file mtime as backup
      }
    } catch {}

    // Fallback: check if transcript file exists and was recently modified
    if (uuidMatch) {
      const transcriptDir = `${process.env.HOME}/.openclaw/agents/${agentId}/sessions`;
      const transcriptPath = `${transcriptDir}/${uuidMatch[1]}.jsonl`;
      try {
        // statSync imported at top level
        const stat = statSync(transcriptPath);
        const fileAgeMs = Date.now() - stat.mtimeMs;
        const FILE_STALE_MS = 30 * 60 * 1000; // 30 min — matches runTimeoutSeconds
        if (fileAgeMs <= FILE_STALE_MS) return true;
        log().debug?.("checkSessionAlive: transcript " + transcriptPath.slice(-50) + " stale (" + Math.round(fileAgeMs / 60000) + "min)");
        return false;
      } catch {
        // No transcript file — session truly doesn't exist
        return false;
      }
    }

    // Can't determine — assume alive
    return true;
  } catch {
    return true; // assume alive on error
  }
}

export function startControlLoop(ctx: OpenClawPluginServiceContext, intervalMs: number): void {
  log().info(`orchestrator: starting control loop (interval=${intervalMs}ms)`);

  executor = new WorkflowExecutor();

  // Read gateway config for spawn API calls
  try {
    const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    gatewayPort = cfg?.gateway?.port ?? 18789;
    gatewayToken = cfg?.gateway?.auth?.token ?? "";
    if (gatewayToken) {
      log().info(`orchestrator: gateway spawn API configured (port=${gatewayPort})`);
    } else {
      log().warn("orchestrator: no gateway auth token found — spawn_agent nodes will fail");
    }
  } catch (e) {
    log().warn(`orchestrator: could not read gateway config: ${e}`);
  }

  // Backfill model_health from recent worker_runs on startup (Phase 4)
  // Seeds total_runs/total_failures from last 24h so circuit breaker has
  // accurate history after restarts. Only touches rows that do not exist yet.
  seedModelHealthFromHistory(24);

  const tick = () => {
    try {
      runTick();
    } catch (err) {
      log().error(`orchestrator: tick failed: ${String(err)}`);
    }
  };

  void tick();
  timer = setInterval(tick, intervalMs);
}

export function stopControlLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log().info("orchestrator: control loop stopped");
  }
}

function runTick(): void {
  if (!executor) return;

  // On first tick, resume any in-flight workers from before restart
  if (isFirstTick) {
    isFirstTick = false;
    processPendingResumes().catch(e => log().warn(`paw: processPendingResumes error: ${e}`));
  }

  // ── 1. Advance active runs ─────────────────────────────────────────────────
  try {
    const activeRuns = executor.getActiveRuns(20);
    let advanced = 0;
    for (const run of activeRuns) {
      // Keep advancing until the run blocks (waiting for spawn, delay, etc.)
      let passes = 0;
      while (passes < 5) {
        const didWork = executor.advance(run);
        if (!didWork) break;
        passes++;
        advanced++;
        // Re-fetch run state for next iteration
        const updated = executor.getActiveRuns(1).find(r => r.id === run.id) ?? null;
        if (!updated || updated.status !== "running") break;
        Object.assign(run, updated);
      }
    }
    if (advanced > 0) {
      log().debug?.(`orchestrator: advanced ${advanced}/${activeRuns.length} runs`);
    }
  } catch (e) {
    log().error(`orchestrator: advance phase error: ${e}`);
  }

  // ── 1b. Process pending spawn requests ─────────────────────────────────────
  try {
    const spawns = popPendingSpawns();
    for (const req of spawns) {
      const spawnProjectId = (((req.context?.task ?? {}) as Record<string, unknown>)["project_id"] ?? ((req.context?.task ?? {}) as Record<string, unknown>)["projectId"] ?? ((req.context?.project ?? {}) as Record<string, unknown>)["id"]) as string | undefined;

      // Capacity gate: re-queue if at max workers
      if (!hasCapacity()) {
        log().info(`orchestrator: at capacity — re-queuing spawn for run ${req.runId.slice(0, 8)}`);
        requeueSpawn(req);
        continue;
      }

      // Project lock: one worker per project per agent type
      if (spawnProjectId && (projectHasActiveWorker(spawnProjectId, req.agentType) || projectHasPendingSpawn(spawnProjectId, req.agentType))) {
        log().debug?.(`orchestrator: project ${spawnProjectId.slice(0, 8)}:${req.agentType} locked — re-queuing spawn for run ${req.runId.slice(0, 8)}`);
        requeueSpawn(req);
        continue;
      }

      incrementPendingSpawns(spawnProjectId, req.agentType);
      
      // Route through native runner or OpenClaw sessions_spawn
      const spawnHandler = USE_NATIVE_RUNNER ? processSpawnWithRunner : processSpawnRequest;
      
      spawnHandler(req).catch((err) => {
        log().error(`orchestrator: spawn failed for run ${req.runId.slice(0, 8)}: ${err}`);
        decrementPendingSpawns(spawnProjectId, req.agentType);
        writeSpawnResult(req.runId, req.nodeId, {
          status: "failed",
          error: String(err),
        });
      });
    }
  } catch (e) {
    log().error(`orchestrator: spawn processing error: ${e}`);
  }

  // ── 2. Process workflow events ─────────────────────────────────────────────
  try {
    const started = executor.processEvents(10);
    if (started > 0) {
      log().info(`orchestrator: started ${started} event-triggered runs`);
    }
  } catch (e) {
    log().error(`orchestrator: processEvents error: ${e}`);
  }

  // ── 3. Process schedules ───────────────────────────────────────────────────
  try {
    const started = executor.processSchedules();
    if (started > 0) {
      log().info(`orchestrator: started ${started} schedule-triggered runs`);
    }
  } catch (e) {
    log().error(`orchestrator: processSchedules error: ${e}`);
  }

  // ── 4. Scan for ready tasks ────────────────────────────────────────────────
  try {
    if (hasCapacity()) {
      const readyTasks = findReadyTasks(5);
      for (let task of readyTasks) {
        if (!hasCapacity()) break;



        // Project gate: tasks without a project_id are assigned a default rather than dropped.
        if (!task.projectId) {
          const inferred = inferProjectId(task.title, task.notes);
          const fallback = inferred ?? "proj-paw";
          getRawDb().prepare(`UPDATE tasks SET project_id = ?, updated_at = datetime('now') WHERE id = ?`).run(fallback, task.id);
          task = { ...task, projectId: fallback };
          log().info(`orchestrator: task ${task.id.slice(0, 8)} had no project — assigned ${fallback} (inferred=${inferred ?? "none"})`);
        }

        if (task.projectId && task.agent && (projectHasActiveWorker(task.projectId, task.agent) || projectHasPendingSpawn(task.projectId, task.agent))) {
          log().debug?.(`orchestrator: project ${task.projectId.slice(0, 8)}:${task.agent} locked — skipping task ${task.id.slice(0, 8)}`);
          continue;
        }

        const taskObj = { ...task };
        const workflow = executor.matchWorkflow(taskObj);
        if (workflow) {
          executor.startRun(workflow, {
            task: taskObj,
            triggerType: "task_match",
          });
          log().info(`orchestrator: started workflow '${workflow.name}' for task ${task.id.slice(0, 8)} (${task.title.slice(0, 40)})`);
        } else {
          log().debug?.(`orchestrator: no workflow matched for task ${task.id.slice(0, 8)} (agent=${task.agent})`);
        }
      }
    }
  } catch (e) {
    log().error(`orchestrator: scan phase error: ${e}`);
  }

  // ── 5a. Worker liveness check (progress-based) ─────────────────────────────
  // Check worker_runs with no ended_at — if session is dead, mark failed.
  try {
    const liveDb = getDb();
    const wrTable = workerRunsTable;
    
    const openWorkers = liveDb.select().from(wrTable).where(isNull(wrTable.endedAt)).all();
    for (const w of openWorkers) {
      const sessionKey = w.workerId;
      if (!sessionKey) continue;
      const runningMin = (Date.now() - new Date(w.startedAt ?? Date.now()).getTime()) / 60000;
      if (runningMin < 12) continue; // give workers time — long model calls can take 5-10min

      checkSessionAlive(sessionKey).then((alive: boolean) => {
        if (!alive) {
          log().warn("orchestrator: worker " + w.id + " (" + (w.agentType ?? "unknown") + ") session dead after " + Math.round(runningMin) + "min — marking failed");
          // Session-dead is an INFRA failure — the session was killed externally,
          // not due to agent logic (e.g. OOM, gateway restart, system crash).
          recordWorkerEnd({ workerId: sessionKey, agentType: w.agentType ?? "unknown", succeeded: false, summary: "session dead — no progress", failureType: 'infra' });
        }
      }).catch(() => {});
    }
  } catch (e) {
    log().error("orchestrator: worker liveness error: " + String(e));
  }

  // ── 5b. Stale workflow run cleanup (progress-based) ────────────────────────
  // Cancel workflow runs stuck too long. Thresholds:
  //   - spawn nodes with NO session: 2 min (spawn takes seconds; silence = dropped)
  //   - spawn nodes WITH session but session is dead: 3 min (fast recovery after drain)
  //   - spawn nodes WITH session and session is alive: reset clock (worker may be slow but ok)
  //   - all other nodes: 10 min
  try {
    const staleDb = getDb();
    const staleThreshold10 = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const staleThreshold3  = new Date(Date.now() -  8 * 60 * 1000).toISOString();
    const staleThreshold2  = new Date(Date.now() -  2 * 60 * 1000).toISOString();
    const staleRuns = staleDb.select().from(workflowRuns)
      .where(and(eq(workflowRuns.status, "running")))
      .all()
      .filter((r: any) => r.updatedAt && r.updatedAt < staleThreshold2);

    for (const run of staleRuns) {
      const nodeStates = (run.nodeStates ?? {}) as Record<string, any>;
      const currentNs = nodeStates[run.currentNode ?? ""] ?? {};
      const childKey = currentNs["childSessionKey"] as string | undefined;
      const isSpawnNode = !!run.currentNode?.startsWith("spawn_");

      if (isSpawnNode && childKey) {
        // Spawn node with a session key recorded.
        // After 3 min: check if session is actually alive. If dead (e.g. killed during drain),
        // fail immediately and clean up the dangling workerRuns row to free capacity.
        // If alive, touch updatedAt so we don't re-check every tick.
        if (run.updatedAt < staleThreshold3) {
          checkSessionAlive(childKey).then((alive: boolean) => {
            if (alive) {
              // Session is live — reset staleness clock so we don't spam liveness checks
              staleDb.update(workflowRuns).set({ updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, run.id)).run();
            } else {
              // Session is dead — fail the workflow run and free the capacity slot
              staleDb.update(workflowRuns).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, run.id)).run();
              const mins = Math.round((Date.now() - new Date(run.updatedAt).getTime()) / 60000);
              log().warn("orchestrator: failed stale spawn run " + run.id.slice(0, 8) + " — worker session " + childKey.slice(0, 30) + " gone after " + mins + "min (possible drain)");
              // Clean up dangling workerRuns row so capacity is freed.
              // This is an INFRA failure (gateway drain/restart killed the session),
              // NOT an agent quality failure. Increment crash_count so the spawn guard
              // uses effective_fail = spawn_count - crash_count correctly.
              // Do NOT reset task to not_started here — let the ghost watchdog (step 8)
              // handle task cleanup via closeGhostRun which also increments crash_count.
              try {
                const wrTable = workerRunsTable;
                const wrRow = staleDb.select().from(wrTable).where(eq(wrTable.workerId, childKey)).get() as any;
                // Stale-run-watchdog is an INFRA failure — session was killed by
                // a gateway drain/restart, NOT a genuine agent quality failure.
                recordWorkerEnd({
                  workerId: childKey,
                  agentType: wrRow?.agentType ?? "unknown",
                  succeeded: false,
                  summary: `stale_run_watchdog: session_dead after ${mins}min`,
                  failureType: 'infra',
                });
                // Increment crash_count on the task — this is infra-failure, not agent failure
                if (wrRow?.task_id) {
                  const nowIso = new Date().toISOString();
                  getRawDb().prepare(
                    `UPDATE tasks SET crash_count = COALESCE(crash_count, 0) + 1, updated_at = ? WHERE id = ?`
                  ).run(nowIso, wrRow.task_id);
                  log().info(`[STALE_RUN_WATCHDOG] Incremented crash_count for task ${String(wrRow.task_id).slice(0, 8)} (infra failure: session_dead after ${mins}min)`);
                  maybeSendCrashAlert(
                    String(wrRow.task_id),
                    `stale_run_watchdog: session_dead after ${mins}min (worker=${childKey.slice(0, 30)})`
                  );
                }
              } catch {}
            }
          }).catch(() => {});
        }
      } else if (isSpawnNode && !childKey) {
        // Spawn node with NO session after 2 min — spawn was silently dropped (e.g. gateway drain)
        staleDb.update(workflowRuns).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, run.id)).run();
        const mins = Math.round((Date.now() - new Date(run.updatedAt).getTime()) / 60000);
        log().warn("orchestrator: failed stale spawn run " + run.id.slice(0, 8) + " (node=" + run.currentNode + ", no session, stuck " + mins + "min) — spawn was dropped");
      } else if (!isSpawnNode && run.updatedAt < staleThreshold10) {
        // Non-spawn node stuck >10 min — fail it
        staleDb.update(workflowRuns).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, run.id)).run();
        const mins = Math.round((Date.now() - new Date(run.updatedAt).getTime()) / 60000);
        log().warn("orchestrator: failed stale run " + run.id.slice(0, 8) + " (node=" + run.currentNode + ", stuck >" + mins + "min)");
      }
    }
  } catch (e) {
    log().error("orchestrator: stale workflow cleanup error: " + String(e));
  }

  // ── 5c. Triage queue flush ────────────────────────────────────────────────
  maybeFlushTriageQueue().catch(e => log().error(`orchestrator: triage flush error: ${e}`));

  // ── 5d. Stall watchdog ────────────────────────────────────────────────────
  // Kill sessions that have emitted no tool calls for longer than their per-agent-type
  // stall threshold. Distinct from the hard 900s timeout — this catches sessions that
  // are silently hanging (e.g. waiting for a model response that never arrives).
  try {
    runStallWatchdog();
  } catch (e) {
    log().error(`orchestrator: stall watchdog error: ${e}`);
  }

  // ── 6. Worker health check (legacy) ───────────────────────────────────────
  try {
    const staleWorkers = detectStaleWorkers(120);
    for (const workerId of staleWorkers) {
      log().warn(`orchestrator: force-terminating stale worker ${workerId}`);
      forceTerminateWorker(workerId, "orchestrator_timeout");
    }
  } catch (e) {
    log().error(`orchestrator: health check error: ${e}`);
  }

  // ── 7. Auto-close tasks where all worker_runs succeeded ────────────────────
  // Detects active tasks where every worker_run has succeeded=1 (at least one
  // run exists, no failed or in-flight runs). Marks them completed and logs an
  // audit event so the orchestrator stops re-queuing them.
  try {
    autoCloseSucceededTasks();
  } catch (e) {
    log().error(`orchestrator: auto-close succeeded tasks error: ${e}`);
  }

  // ── 8. Watchdog: close ghost worker_runs ────────────────────────────────────
  // Closes worker_runs where ended_at IS NULL and started_at < now - 5 min.
  // These are "ghost" runs left by sessions that died before writing ended_at.
  // The 5-min buffer is safe: real runs complete in <3min; anything older with
  // a dead session is a ghost inflating the capacity counter.
  try {
    runWatchdog();
  } catch (e) {
    log().error(`orchestrator: watchdog error: ${e}`);
  }

  // ── 9. Meeting analysis recovery ────────────────────────────────────────────
  // Pick up meetings stuck in 'pending' (e.g. after restart reset from processing).
  // Only processes one per tick to avoid blocking the loop.
  try {
    processPendingMeetings();
  } catch (e) {
    log().error(`orchestrator: meeting analysis recovery error: ${e}`);
  }
}

// ── Meeting analysis recovery ─────────────────────────────────────────────────

/**
 * Pick up one pending meeting per tick and re-trigger analysis.
 * Handles meetings that were reset from 'processing' → 'pending' on restart.
 */
function processPendingMeetings(): void {
  const raw = getRawDb();
  const pending = raw.prepare(
    `SELECT id FROM meetings WHERE analysis_status = 'pending' AND transcript IS NOT NULL ORDER BY created_at ASC LIMIT 1`
  ).get() as { id: string } | undefined;

  if (!pending) return;

  log().info(`orchestrator: re-triggering analysis for pending meeting ${pending.id.slice(0, 8)}`);

  // Fire-and-forget — MeetingAnalysisService handles its own status transitions
  import("../services/meeting-analysis.js").then(({ MeetingAnalysisService }) => {
    const svc = new MeetingAnalysisService();
    svc.analyze(pending.id).catch(e =>
      log().error(`orchestrator: meeting analysis failed for ${pending.id.slice(0, 8)}: ${e.message}`)
    );
  });
}

// ── Stall watchdog ────────────────────────────────────────────────────────────

// ── Crash alert helpers ───────────────────────────────────────────────────────

/**
 * Read the crash alert threshold from env var PAW_CRASH_ALERT_THRESHOLD,
 * then fall back to orchestrator_settings key 'crash_alert_threshold', then 5.
 */
function getCrashAlertThreshold(): number {
  const envVal = parseInt(process.env.PAW_CRASH_ALERT_THRESHOLD ?? "", 10);
  if (!isNaN(envVal) && envVal > 0) return envVal;
  try {
    const row = getRawDb().prepare(
      `SELECT value FROM orchestrator_settings WHERE key = 'crash_alert_threshold'`
    ).get() as { value: string } | undefined;
    if (row) {
      const val = parseInt(row.value, 10);
      if (!isNaN(val) && val > 0) return val;
    }
  } catch {}
  return 5;
}

/**
 * After a crash_count increment, check whether the task has crossed the alert
 * threshold. If so:
 *   - emit a [CRASH_ALERT] warning log (always)
 *   - create an inbox_items alert row (only when no pending alert already exists
 *     for this task, to avoid inbox flooding on subsequent ticks)
 *
 * Does NOT mutate task status — read/alert only.
 */
function maybeSendCrashAlert(taskId: string, lastFailureReason: string): void {
  try {
    const db = getRawDb();
    const threshold = getCrashAlertThreshold();

    const task = db.prepare(
      `SELECT id, title, crash_count, spawn_count FROM tasks WHERE id = ?`
    ).get(taskId) as {
      id: string;
      title: string;
      crash_count: number | null;
      spawn_count: number | null;
    } | undefined;

    if (!task) return;
    const crashCount = task.crash_count ?? 0;
    if (crashCount < threshold) return;

    // Always emit a warning log
    log().warn(
      `[CRASH_ALERT] ⚠️  Task ${taskId.slice(0, 8)} ("${(task.title ?? "").slice(0, 60)}") ` +
      `has crashed ${crashCount} times (spawn=${task.spawn_count ?? 0}, threshold=${threshold}). ` +
      `Last failure: ${lastFailureReason}`
    );

    // Avoid duplicate inbox items: skip if a pending alert already exists for this task
    const existing = db.prepare(
      `SELECT id FROM inbox_items ` +
      `WHERE title LIKE ? AND action_status = 'pending' LIMIT 1`
    ).get(`%${taskId.slice(0, 8)}%`) as { id: string } | undefined;

    if (existing) return; // already alerted, don't flood

    const alertTitle = `⚠️ Stuck task alert: ${(task.title ?? "").slice(0, 60)}`;
    const alertContent =
      `Task **${taskId.slice(0, 8)}** has failed **${crashCount}** times and may be permanently stuck.\n\n` +
      `- **Title:** ${task.title ?? "(unknown)"}\n` +
      `- **Task ID:** \`${taskId}\`\n` +
      `- **crash_count:** ${crashCount} (alert threshold: ${threshold})\n` +
      `- **spawn_count:** ${task.spawn_count ?? 0}\n` +
      `- **Last failure reason:** ${lastFailureReason}\n\n` +
      `Review the task, fix the root cause, then reset or close it manually. ` +
      `The orchestrator will NOT change task status automatically.`;

    db.prepare(
      `INSERT INTO inbox_items (id, title, content, type, requires_action, action_status, source_agent) ` +
      `VALUES (lower(hex(randomblob(16))), ?, ?, 'alert', 1, 'pending', 'orchestrator')`
    ).run(alertTitle, alertContent);

    log().warn(
      `[CRASH_ALERT] Inbox alert created for task ${taskId.slice(0, 8)} (crash_count=${crashCount})`
    );
  } catch (e) {
    log().error(`[CRASH_ALERT] Failed to send crash alert for task ${taskId}: ${e}`);
  }
}

/**
 * Load stall watchdog config from orchestrator_settings.
 * Returns { enabled, gracePeriodSeconds, timeouts: Record<agentType, seconds> }
 */
function loadStallConfig(): { enabled: boolean; gracePeriodSeconds: number; timeouts: Record<string, number> } {
  const db = getRawDb();
  const defaultConfig = { enabled: true, gracePeriodSeconds: 60, timeouts: {} as Record<string, number> };

  try {
    const watchdogRow = db.prepare(
      `SELECT value FROM orchestrator_settings WHERE key = 'stall_watchdog'`
    ).get() as { value: string } | undefined;

    if (watchdogRow) {
      const parsed = JSON.parse(watchdogRow.value) as Record<string, unknown>;
      defaultConfig.enabled = parsed.enabled !== false;
      defaultConfig.gracePeriodSeconds = typeof parsed.grace_period_seconds === "number"
        ? parsed.grace_period_seconds
        : 60;
    }

    // Load per-agent-type timeouts
    const timeoutRows = db.prepare(
      `SELECT key, value FROM orchestrator_settings WHERE key LIKE 'stall_timeout:%'`
    ).all() as Array<{ key: string; value: string }>;

    for (const row of timeoutRows) {
      const agentType = row.key.replace("stall_timeout:", "");
      const seconds = parseInt(row.value, 10);
      if (!isNaN(seconds)) {
        defaultConfig.timeouts[agentType] = seconds;
      }
    }
  } catch {}

  return defaultConfig;
}

/**
 * Scan for worker sessions that have gone silent (no tool calls) longer than
 * their per-agent-type stall threshold. Kill stalled sessions and mark them failed.
 *
 * Grace period: sessions started < grace_period_seconds ago are excluded.
 * Null last_tool_call_at: excluded if within grace period; checked against
 * started_at if outside grace period (may indicate the session never started a tool).
 */
function runStallWatchdog(): void {
  const config = loadStallConfig();
  if (!config.enabled) return;

  const db = getRawDb();
  const now = Date.now();
  const graceCutoff = new Date(now - config.gracePeriodSeconds * 1000).toISOString();

  // Find all open worker_runs that have passed the grace period
  const openRuns = db.prepare(`
    SELECT id, worker_id, task_id, agent_type, started_at, last_tool_call_at
    FROM worker_runs
    WHERE ended_at IS NULL
      AND started_at IS NOT NULL
      AND started_at < ?
  `).all(graceCutoff) as Array<{
    id: number;
    worker_id: string | null;
    task_id: string | null;
    agent_type: string | null;
    started_at: string;
    last_tool_call_at: string | null;
  }>;

  if (openRuns.length === 0) return;

  for (const wr of openRuns) {
    const agentType = wr.agent_type ?? "default";
    const stallThresholdSec = config.timeouts[agentType] ?? config.timeouts["default"] ?? 1800;

    // Determine the reference time for stall calculation:
    // - If last_tool_call_at is set, use it
    // - If null (no tools called yet), use started_at as the reference
    const referenceTime = wr.last_tool_call_at ?? wr.started_at;
    const silentSec = (now - new Date(referenceTime).getTime()) / 1000;

    if (silentSec < stallThresholdSec) continue;

    const silentMin = Math.round(silentSec / 60);
    const stallSource = wr.last_tool_call_at ? "last_tool_call" : "session_start";
    log().warn(
      `[STALL_WATCHDOG] Session ${wr.worker_id?.slice(0, 30) ?? "?"} (${agentType}) ` +
      `silent ${silentMin}min since ${stallSource} — threshold=${stallThresholdSec}s — marking stalled`
    );

    // Close the worker_run as stalled.
    // Stall-watchdog is an INFRA failure — the session hung (resource exhaustion,
    // model hang, infrastructure issue), NOT deliberate agent behaviour.
    const changed = db.prepare(`
      UPDATE worker_runs
      SET ended_at = ?,
          succeeded = 0,
          timeout_reason = 'stall_watchdog',
          failure_type = 'infra',
          summary = ?
      WHERE id = ? AND ended_at IS NULL
    `).run(
      new Date(now).toISOString(),
      `stall_watchdog: no tool calls for ${silentMin}min (threshold=${stallThresholdSec}s, ref=${stallSource})`,
      wr.id,
    ) as { changes: number };

    if (changed.changes === 0) continue; // already closed

    // Reset task to not_started so it can be retried.
    // Stall-watchdog is treated as an INFRA failure (a session hung, not a deliberate
    // agent decision), so increment crash_count. This keeps it out of the agent-quality
    // effective_fail_count = spawn_count - crash_count calculation, preventing the
    // spawn guard from auto-blocking tasks whose workers were silently killed by
    // resource exhaustion, model hangs, or infrastructure issues.
    if (wr.task_id) {
      db.prepare(`
        UPDATE tasks
        SET work_state = 'not_started',
            crash_count = COALESCE(crash_count, 0) + 1,
            updated_at = ?
        WHERE id = ? AND work_state = 'in_progress'
      `).run(new Date(now).toISOString(), wr.task_id);
      log().warn(
        `[STALL_WATCHDOG] Reset task ${wr.task_id.slice(0, 8)} to not_started after stall (${agentType}, ${silentMin}min silent) — crash_count++`
      );
      maybeSendCrashAlert(
        wr.task_id,
        `stall_watchdog: ${agentType} silent ${silentMin}min (threshold=${stallThresholdSec}s, ref=${stallSource})`
      );
    }

    // Fail any workflow_run stuck at a spawn node for this task
    if (wr.task_id) {
      try {
        const liveDb = getDb();
        const wrTable = workflowRuns;
        const stuckRuns = liveDb.select().from(wrTable)
          .where(and(eq(wrTable.status, "running"), eq(wrTable.taskId, wr.task_id)))
          .all()
          .filter((r: any) => r.currentNode?.startsWith("spawn_"));

        for (const run of stuckRuns) {
          liveDb.update(wrTable)
            .set({ status: "failed", updatedAt: new Date(now).toISOString() })
            .where(eq(wrTable.id, run.id))
            .run();
          log().warn(`[STALL_WATCHDOG] Failed workflow_run ${run.id.slice(0, 8)} (stalled task ${wr.task_id.slice(0, 8)})`);
        }
      } catch (e) {
        log().error(`[STALL_WATCHDOG] workflow_run cleanup error: ${e}`);
      }
    }
  }
}

// ── Watchdog: ghost worker_run cleanup ────────────────────────────────────────

/**
 * Scan for worker_runs with ended_at IS NULL and started_at older than 5 minutes.
 * For each, check if the session is still alive. If not (or if no session key),
 * close the run as a ghost, reset the task to not_started, and fail any workflow_run
 * stuck at a spawn node for that task.
 *
 * Safe on every tick (query is cheap and idempotent).
 */
function runWatchdog(): void {
  const db = getRawDb();
  // IMPORTANT: use toISOString() — not SQLite's datetime("now","-5 minutes").
  // stored started_at values are in ISO 8601 T/Z format (e.g. "2026-03-06T17:00:05.000Z").
  // SQLite datetime() returns space-separated format ("2026-03-06 17:00:05") which
  // sorts LESS than the stored T-format strings (space 0x20 < T 0x54), so a
  // datetime() cutoff would cause started_at < ? to always be FALSE — watchdog silent.
  // Both sides must use the same format for string comparison to work correctly.
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const ghostCandidates = db.prepare(`
    SELECT id, worker_id, task_id, agent_type, started_at
    FROM worker_runs
    WHERE ended_at IS NULL
      AND started_at IS NOT NULL
      AND started_at < ?
  `).all(cutoff) as Array<{
    id: number;
    worker_id: string | null;
    task_id: string | null;
    agent_type: string | null;
    started_at: string;
  }>;

  if (ghostCandidates.length === 0) return;

  const now = new Date().toISOString();
  log().debug?.(`[WATCHDOG] ${ghostCandidates.length} worker_run(s) >5min with null ended_at — checking liveness`);

  for (const wr of ghostCandidates) {
    const sessionKey = wr.worker_id;
    if (sessionKey) {
      checkSessionAlive(sessionKey).then((alive: boolean) => {
        if (alive) {
          log().debug?.(`[WATCHDOG] worker_run ${wr.id} session ${sessionKey.slice(0, 30)} still alive — skipping`);
          return;
        }
        closeGhostRun(wr, now);
      }).catch(() => {
        // On error checking session, close conservatively
        closeGhostRun(wr, now);
      });
    } else {
      // No session key recorded — definitely orphaned
      closeGhostRun(wr, now);
    }
  }
}

type GhostRunRow = {
  id: number;
  worker_id: string | null;
  task_id: string | null;
  agent_type: string | null;
  started_at: string;
};

function closeGhostRun(wr: GhostRunRow, now: string): void {
  const db = getRawDb();
  const staleMin = Math.round((Date.now() - new Date(wr.started_at).getTime()) / 60000);

  // 1. Close the worker_run.
  // Ghost-watchdog closures are INFRA failures — the session was killed by a
  // gateway crash and never wrote ended_at. Not an agent quality issue.
  const changed = db.prepare(`
    UPDATE worker_runs
    SET ended_at = ?, succeeded = 0, failure_type = 'infra',
        summary = 'ghost: watchdog closed stale run'
    WHERE id = ? AND ended_at IS NULL
  `).run(now, wr.id);

  if ((changed as { changes: number }).changes === 0) return; // already closed by another path

  log().warn(`[WATCHDOG] Closed ghost worker_run ${wr.id} (${wr.agent_type ?? "?"}) — stale ${staleMin}min, session=${wr.worker_id?.slice(0, 30) ?? "none"}`);

  // 2. Reset task to not_started if still in_progress.
  // Increment crash_count (not reset spawn_count) — this run was a crash-orphan,
  // not a genuine agent failure. The spawn guard uses effective_fail = spawn_count - crash_count.
  if (wr.task_id) {
    db.prepare(`
      UPDATE tasks
      SET work_state = 'not_started',
          crash_count = COALESCE(crash_count, 0) + 1,
          updated_at = ?
      WHERE id = ? AND work_state = 'in_progress'
    `).run(now, wr.task_id);
    log().info(`[WATCHDOG] Incremented crash_count for task ${wr.task_id.slice(0, 8)} (ghost-orphaned by crash)`);
    maybeSendCrashAlert(
      wr.task_id,
      `ghost_watchdog: session=${wr.worker_id?.slice(0, 30) ?? "none"}, stale ${staleMin}min (agent=${wr.agent_type ?? "?"})`
    );
  }

  // 3. Fail workflow_runs stuck at a spawn node for this task
  if (wr.task_id) {
    try {
      const liveDb = getDb();
      const stuckRuns = liveDb.select().from(workflowRuns)
        .where(and(eq(workflowRuns.status, "running"), eq(workflowRuns.taskId, wr.task_id)))
        .all()
        .filter((r: any) => r.currentNode?.startsWith("spawn_"));

      for (const run of stuckRuns) {
        liveDb.update(workflowRuns)
          .set({ status: "failed", updatedAt: now })
          .where(eq(workflowRuns.id, run.id))
          .run();
        log().warn(`[WATCHDOG] Failed workflow_run ${run.id.slice(0, 8)} stuck at ${run.currentNode} (ghost task ${wr.task_id.slice(0, 8)})`);
      }
    } catch (e) {
      log().error(`[WATCHDOG] workflow_run cleanup error for task ${wr.task_id}: ${e}`);
    }
  }
}

// ── Auto-close helper ─────────────────────────────────────────────────────────

/**
 * Close any active task whose worker_runs are ALL succeeded=1.
 *
 * Before closing, runs post-success artifact validation to detect phantom
 * completions (tasks that reported succeeded=true but produced no output).
 *
 * Outcomes:
 *   - valid:        task closed as completed (normal path)
 *   - suspicious:   task closed as completed + inbox warning (fast but has artifacts)
 *   - no_artifacts: task NOT closed — review_state='needs_review' + inbox warning
 *
 * Safe to call on every tick (query is cheap; idempotent).
 * Writes a control_loop_events row per closed task for audit trail.
 */
function autoCloseSucceededTasks(): void {
  const db = getRawDb();

  const candidates = db.prepare(`
    SELECT
        t.id,
        t.title,
        t.agent,
        t.project_id,
        p.repo_path,
        COUNT(wr.id)                                              AS run_count,
        MAX(wr.ended_at)                                          AS last_run_at,
        (
            SELECT wr2.started_at FROM worker_runs wr2
            WHERE wr2.task_id = t.id AND wr2.ended_at IS NOT NULL
            ORDER BY wr2.ended_at DESC LIMIT 1
        )                                                         AS last_started_at
    FROM tasks t
    JOIN worker_runs wr ON wr.task_id = t.id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.status = 'active'
    GROUP BY t.id
    HAVING
        run_count > 0
        AND SUM(CASE WHEN wr.ended_at IS NULL THEN 1 ELSE 0 END) = 0
        AND (
            SELECT wr2.succeeded FROM worker_runs wr2
            WHERE wr2.task_id = t.id AND wr2.ended_at IS NOT NULL
            ORDER BY wr2.ended_at DESC LIMIT 1
        ) = 1
    ORDER BY last_run_at ASC
  `).all() as Array<{
    id: string;
    title: string;
    agent: string;
    project_id: string | null;
    repo_path: string | null;
    run_count: number;
    last_run_at: string;
    last_started_at: string | null;
  }> as Array<{
    id: string;
    title: string;
    agent: string;
    project_id: string | null;
    repo_path: string | null;
    run_count: number;
    last_run_at: string;
    last_started_at: string | null;
    expected_artifacts?: string | null;
  }>;

  // Enrich candidates with expected_artifacts (not in the JOIN above to keep it simple)
  for (const candidate of candidates) {
    try {
      const row = db.prepare(`SELECT expected_artifacts FROM tasks WHERE id = ?`).get(candidate.id) as { expected_artifacts: string | null } | undefined;
      candidate.expected_artifacts = row?.expected_artifacts ?? null;
    } catch { /* ignore */ }
  }

  if (candidates.length === 0) return;

  const now = new Date().toISOString();

  const closeStmt = db.prepare(`
    UPDATE tasks
    SET status = 'completed',
        finished_at = ?,
        updated_at = ?
    WHERE id = ?
  `);

  const needsReviewStmt = db.prepare(`
    UPDATE tasks
    SET review_state = 'needs_review',
        updated_at = ?
    WHERE id = ?
  `);

  const eventStmt = db.prepare(`
    INSERT INTO control_loop_events (id, event_type, status, payload, created_at)
    VALUES (lower(hex(randomblob(16))), 'auto_close_succeeded', 'processed', json(?), ?)
  `);

  // Dedup: only insert inbox notice if no pending item exists with the same title
  const inboxDedupCheck = db.prepare(
    `SELECT COUNT(*) as cnt FROM inbox_items WHERE title = ? AND action_status = 'pending'`
  );
  const inboxInsertRaw = db.prepare(`
    INSERT INTO inbox_items (id, title, content, type, requires_action, action_status, source_agent)
    VALUES (lower(hex(randomblob(16))), ?, ?, 'notice', 1, 'pending', ?)
  `);
  const inboxStmt = {
    run: (title: string, content: string, agent: string) => {
      const { cnt } = inboxDedupCheck.get(title) as { cnt: number };
      if (cnt > 0) return; // already exists, skip
      inboxInsertRaw.run(title, content, agent);
    },
  };

  for (const task of candidates) {
    // Calculate duration of the last run
    const durationMs = (task.last_started_at && task.last_run_at)
      ? new Date(task.last_run_at).getTime() - new Date(task.last_started_at).getTime()
      : null;

    // ── Post-success artifact validation ──────────────────────────────────
    let expectedArtifacts: unknown = null;
    if (task.expected_artifacts) {
      try { expectedArtifacts = JSON.parse(task.expected_artifacts); } catch { /* ignore */ }
    }
    let validation: ReturnType<typeof validatePostSuccessArtifacts>;
    try {
      validation = validatePostSuccessArtifacts(task.agent, task.repo_path, durationMs, expectedArtifacts);
    } catch (e) {
      // Fail open: on error, close normally rather than blocking completions
      log().error(`[AUTO-CLOSE] Artifact validation error for task ${task.id.slice(0, 8)}: ${e}`);
      validation = { status: "valid" };
    }

    if (validation.status === "no_artifacts") {
      // Phantom completion detected — do NOT close; flag for human review
      needsReviewStmt.run(now, task.id);
      const warningTitle = `⚠️ Phantom completion: ${task.title.slice(0, 60)}`;
      const warningContent =
        `Task ${task.id.slice(0, 8)} (${task.agent}) reported succeeded=true but produced no output.\n\n` +
        `Reason: ${validation.reason}\n\n` +
        `Duration: ${durationMs != null ? Math.round(durationMs / 1000) + "s" : "unknown"}\n` +
        `Run count: ${task.run_count}\n` +
        `Last run at: ${task.last_run_at}\n\n` +
        `Task has been marked needs_review. Review and re-queue or close manually.`;
      inboxStmt.run(warningTitle, warningContent, task.agent ?? "orchestrator");
      eventStmt.run(
        JSON.stringify({
          task_id: task.id,
          title: task.title,
          agent: task.agent,
          run_count: task.run_count,
          last_run_at: task.last_run_at,
          duration_ms: durationMs,
          reason: "phantom_completion_no_artifacts",
          validation_detail: validation.reason,
          closed_at: null,
        }),
        now,
      );
      log().warn(
        `[AUTO-CLOSE] ⚠️  Phantom completion: task ${task.id.slice(0, 8)} (${task.agent}) — ` +
        `"${task.title.slice(0, 60)}" — set needs_review. ${validation.reason}`,
      );
      continue;
    }

    // Close the task
    closeStmt.run(now, now, task.id);
    eventStmt.run(
      JSON.stringify({
        task_id: task.id,
        title: task.title,
        agent: task.agent,
        run_count: task.run_count,
        last_run_at: task.last_run_at,
        duration_ms: durationMs,
        reason: "latest_worker_run_succeeded",
        validation_status: validation.status,
        closed_at: now,
      }),
      now,
    );

    // ── Record learning outcome ─────────────────────────────────────────────
    try {
      const taskCategory = inferTaskCategory(task.title ?? "");
      learningSvc.recordOutcome({
        taskId: task.id,
        agentType: task.agent ?? "programmer",
        success: true,
        taskCategory,
      });
    } catch (e) {
      log().warn(`[LEARNING] recordOutcome (success) failed for task ${task.id.slice(0, 8)}: ${e}`);
    }

    if (validation.status === "suspicious") {
      // Artifacts present but suspiciously fast — close AND warn
      const warningTitle = `⚡ Suspicious fast completion: ${task.title.slice(0, 60)}`;
      const warningContent =
        `Task ${task.id.slice(0, 8)} (${task.agent}) completed very quickly.\n\n` +
        `Reason: ${validation.reason}\n\n` +
        `Task was closed as completed but may need spot-check. Review artifacts manually.`;
      inboxStmt.run(warningTitle, warningContent, task.agent ?? "orchestrator");
      log().warn(
        `[AUTO-CLOSE] ⚡ Suspicious completion: task ${task.id.slice(0, 8)} (${task.agent}): ` +
        `"${task.title.slice(0, 60)}" — ${validation.reason}`,
      );
    } else {
      log().info(
        `[AUTO-CLOSE] Completed task ${task.id.slice(0, 8)} (${task.agent}): ` +
        `"${task.title.slice(0, 60)}" — ${task.run_count} run(s), ` +
        `duration=${durationMs != null ? Math.round(durationMs / 1000) + "s" : "?"}`,
      );
    }
  }
}

// ── Spawn processing ─────────────────────────────────────────────────────────

/** Model ID mapping: orchestrator → Anthropic OAuth endpoint format */
function mapModelForRunner(orchestratorModel: string): string {
  // Models accept non-dated aliases now (sonnet-4-6, opus-4-6)
  // Just pass through — the API resolves aliases
  const mappings: Record<string, string> = {};

  // If it's an LM Studio model, ensure lmstudio/ prefix
  if (orchestratorModel.includes("lmstudio") || orchestratorModel.startsWith("local/")) {
    return orchestratorModel.startsWith("lmstudio/") 
      ? orchestratorModel 
      : `lmstudio/${orchestratorModel.replace(/^local\//, "")}`;
  }

  return mappings[orchestratorModel] ?? orchestratorModel;
}

/**
 * Process a spawn request using our native agent runner.
 * Calls the Anthropic API directly instead of routing through OpenClaw sessions_spawn.
 */
async function processSpawnWithRunner(req: SpawnRequest): Promise<void> {
  const taskCtx = (req.context?.task ?? {}) as Record<string, unknown>;
  const projectCtx = (req.context?.project ?? {}) as Record<string, unknown>;
  const taskTitle = (taskCtx["title"] as string) ?? "Workflow task";
  const taskNotes = (taskCtx["notes"] as string) ?? "";
  const taskId = req.taskId ?? undefined;
  const projectId = (taskCtx["project_id"] as string) ?? (projectCtx["id"] as string) ?? undefined;
  let repoPath = (projectCtx["repo_path"] as string) ?? undefined;

  // Fallback: look up project in DB if repo_path not in context
  if (!repoPath && projectId) {
    try {
      const row = getRawDb().prepare("SELECT repo_path FROM projects WHERE id = ?").get(projectId) as { repo_path?: string } | undefined;
      if (row?.repo_path) repoPath = row.repo_path;
    } catch { /* ignore */ }
  }

  // Last resort: default to lobs-core
  if (!repoPath) {
    repoPath = `${process.env.HOME}/lobs/lobs-core`;
    log().warn(`orchestrator: no repo_path for task — defaulting to ${repoPath}`);
  }

  // Extract context_refs
  const contextRefs = (taskCtx["context_refs"] ?? taskCtx["contextRefs"] ?? []) as string[];

  // Choose model
  const modelChoice = req.modelTier
    ? chooseModel(req.modelTier, req.agentType)
    : chooseModel("standard", req.agentType);
  
  const orchestratorModel = modelChoice.model;
  const runnerModel = mapModelForRunner(orchestratorModel);

  log().info(
    `[NATIVE_RUNNER] Spawning ${req.agentType} for run ${req.runId.slice(0, 8)} ` +
    `(task=${taskId?.slice(0, 8) ?? "none"}, model=${runnerModel})`
  );

  // Assemble intelligent context
  const assembledContext = await assembleContext({
    task: `${taskTitle}\n\n${taskNotes}`,
    agentType: req.agentType,
    projectId,
    contextRefs,
  });

  // Build task prompt with context
  const taskPrompt = `${taskTitle}\n\n${taskNotes}`.trim();
  const fullPrompt = `${taskPrompt}\n\n${assembledContext.contextBlock}`;

  // Record worker start
  const workerId = `native:${req.agentType}:${Date.now()}`;
  recordWorkerStart({
    workerId,
    agentType: req.agentType,
    taskId,
    projectId,
    model: orchestratorModel,
  });

  try {
    // Run the agent
    const result: AgentResult = await runAgent({
      task: fullPrompt,
      agent: req.agentType,
      model: runnerModel,
      cwd: repoPath,
      tools: ["exec", "read", "write", "edit", "memory_search", "memory_read", "memory_write", "spawn_agent", "run_pipeline"],
      timeout: 900, // 15 minutes
      maxTurns: 200,
    });

    // Extract artifacts (files modified/created)
    const artifacts = result.artifacts ?? [];

    // Compact the conversation to extract learnings
    // Note: runAgent doesn't expose raw messages yet, so we'll use output as a proxy
    const summary = result.output.slice(0, 2000); // First 2K chars as summary
    
    // Record worker end
    recordWorkerEnd({
      workerId,
      agentType: req.agentType,
      succeeded: result.succeeded,
      summary,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalCostUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
      failureType: result.succeeded ? undefined : 'agent_quality',
    });

    // Update task status
    if (result.succeeded && taskId) {
      const db = getRawDb();
      db.prepare(`
        UPDATE tasks
        SET work_state = 'done',
            finished_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(taskId);
    }

    // Write spawn result
    decrementPendingSpawns(projectId, req.agentType);
    writeSpawnResult(req.runId, req.nodeId, {
      childSessionKey: workerId,
      status: result.succeeded ? "completed" : "failed",
      ...(result.error ? { error: result.error } : {}),
    });

    log().info(
      `[NATIVE_RUNNER] Completed ${req.agentType} run ${req.runId.slice(0, 8)} ` +
      `(success=${result.succeeded}, turns=${result.turns}, tokens=${result.usage.inputTokens + result.usage.outputTokens}, cost=$${result.costUsd.toFixed(4)})`
    );

  } catch (error) {
    // Record failure
    recordWorkerEnd({
      workerId,
      agentType: req.agentType,
      succeeded: false,
      summary: `Runner error: ${error instanceof Error ? error.message : String(error)}`,
      failureType: 'infra',
    });

    decrementPendingSpawns(projectId, req.agentType);
    throw error;
  }
}

const SPAWN_COUNT_LIMIT = 3;

/**
 * Per-task-type spawn count limits. Override the default (SPAWN_COUNT_LIMIT=3) for specific task types.
 * Task types not listed here fall back to SPAWN_COUNT_LIMIT.
 *
 * Rationale:
 *   "bug":     4  — bugs may need an extra retry after initial reproduction
 *   "feature": 5  — features can legitimately need multiple coding passes
 *   "spike":   2  — investigative tasks should resolve quickly
 *   "chore":   3  — default; maintenance tasks rarely need many retries
 *   "other":   3  — default fallback
 */
const SPAWN_COUNT_LIMIT_BY_TYPE: Record<string, number> = {
  bug: 4,
  feature: 5,
  spike: 2,
  chore: 3,
  other: 3,
};

/**
 * Per-agent-type spawn limits. These override task-type limits when defined.
 * Provides a tuning point per agent without schema changes.
 */
const SPAWN_LIMIT_BY_AGENT: Record<string, number> = {
  architect: 3,
  researcher: 3,
  programmer: 3,
  writer: 3,
  reviewer: 3,
};

function spawnCountLimitForType(taskType: string | null | undefined, agentType?: string | null): number {
  if (agentType && agentType in SPAWN_LIMIT_BY_AGENT) {
    return SPAWN_LIMIT_BY_AGENT[agentType];
  }
  if (taskType && taskType in SPAWN_COUNT_LIMIT_BY_TYPE) {
    return SPAWN_COUNT_LIMIT_BY_TYPE[taskType];
  }
  return SPAWN_COUNT_LIMIT;
}

/**
 * Increment spawn_count for a task and check if the effective fail count
 * has exceeded the per-type/per-agent limit.
 *
 * effective_fail_count = spawn_count - crash_count
 *
 * Gateway crash-orphaned runs increment crash_count (via restart hook and watchdog),
 * so they do NOT count as agent failures for the auto-block threshold.
 * Only genuine agent failures (succeeded=0, not crash-orphaned) accumulate effective_fail_count.
 *
 * Returns true if task was auto-blocked (effective_fail_count >= limit after increment).
 */
function incrementAndCheckSpawnCount(taskId: string): boolean {
  const db = getDb();
  try {
    const task = db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).get();
    if (!task) return false;

    const limit = spawnCountLimitForType(task.shape, task.agent);
    const newSpawnCount = (task.spawnCount ?? 0) + 1;
    const crashCount = task.crashCount ?? 0;
    const effectiveFailCount = newSpawnCount - crashCount;

    db.update(tasksTable).set({
      spawnCount: newSpawnCount,
      updatedAt: new Date().toISOString(),
    }).where(eq(tasksTable.id, taskId)).run();

    if (effectiveFailCount >= limit) {
      // Auto-block the task to stop runaway agent failures
      db.update(tasksTable).set({
        workState: "blocked",
        failureReason: `Auto-blocked: effective_fail_count=${effectiveFailCount} >= limit=${limit} (spawn=${newSpawnCount}, crash=${crashCount}, type=${task.shape ?? "other"}). Needs human review.`,
        updatedAt: new Date().toISOString(),
      }).where(eq(tasksTable.id, taskId)).run();

      log().warn(
        `[SPAWN_GUARD] Task ${taskId.slice(0, 8)} auto-blocked — effective_fail=${effectiveFailCount} >= limit=${limit} (spawn=${newSpawnCount}, crash=${crashCount}, type=${task.shape ?? "other"})`
      );

      // ── Record failure outcome for learning system ─────────────────────────
      try {
        const taskCategory = inferTaskCategory(task.title ?? "");
        learningSvc.recordOutcome({
          taskId,
          agentType: task.agent ?? "programmer",
          success: false,
          taskCategory,
        });
      } catch {}

      return true;
    }
    log().debug?.(`[SPAWN_GUARD] Task ${taskId.slice(0, 8)} spawn=${newSpawnCount}, crash=${crashCount}, effective_fail=${effectiveFailCount}/${limit}`);
    return false;
  } catch (e) {
    log().error(`[SPAWN_GUARD] incrementAndCheckSpawnCount error: ${e}`);
    return false;
  }
}

/**
 * Detect whether a reviewer task is "complex" and needs scope bounding.
 *
 * Triggers phased review when:
 * - 6+ distinct file paths mentioned in title or notes (>5 files)
 * - 2+ distinct repo paths (multiple repos)
 * - Simple/small reviews (CI, preflight, lint) are never flagged.
 *
 * Does NOT trigger for known simple review patterns even if notes are long.
 */
function detectComplexReview(taskTitle: string, taskNotes: string): boolean {
  const combined = `${taskTitle}\n${taskNotes}`;

  // Never trigger for explicitly simple review types
  const simplePatterns = [
    /\bCI\b.*check/i,
    /\bpreflight\b/i,
    /\blint\b/i,
    /\bformat\b.*check/i,
    /\btype.?check\b/i,
    /\bsmoke.?test\b/i,
  ];
  if (simplePatterns.some(p => p.test(taskTitle))) return false;

  // Count distinct file paths (lines or mentions matching /path/to/file.ext patterns)
  const filePathMatches = combined.match(/(?:^|\s|`|'|")((?:~|\/[\w./-]+|\.\/?[\w./-]+)[\w-]+\.\w{1,6})(?:\s|`|'|"|$)/gm) ?? [];
  const uniqueFiles = new Set(filePathMatches.map(m => m.trim()));
  if (uniqueFiles.size > 5) return true;

  // Count distinct repo paths (directories that look like repo roots)
  const repoPathMatches = combined.match(/(?:~\/[\w/-]+|\/Users\/\w+\/[\w/-]+)/g) ?? [];
  const uniqueRepos = new Set(
    repoPathMatches
      .map(p => p.replace(/\/[^/]+\.\w{1,6}$/, "").replace(/\/$/, "")) // strip filenames
      .filter(p => p.length > 5)
  );
  if (uniqueRepos.size >= 2) return true;

  // Long notes with code blocks (strong signal of multi-file scope)
  const codeBlockCount = (combined.match(/```/g) ?? []).length / 2;
  if (codeBlockCount >= 3 && taskNotes.length > 1500) return true;

  return false;
}

/**
 * Build phased review prompt injection for complex reviewer tasks.
 *
 * Instructs the reviewer to:
 * 1. Work in three bounded phases (core logic → security → tests)
 * 2. Write a partial checkpoint after each phase so value is preserved
 *    even if the session is killed by the watchdog before completing all phases.
 *
 * The checkpoint path is task-scoped so checkpoints from different tasks don't collide.
 */
function buildPhasedReviewInstructions(checkpointBasePath: string): string {
  return `

⚠️ SCOPE BOUNDING — PHASED REVIEW REQUIRED

This is a complex review spanning multiple files. To stay within the watchdog window,
work in EXACTLY THREE phases and checkpoint after each one:

**Phase 1 — Core Logic** (read only core implementation files, skip tests and security configs)
- Focus: correctness, data flow, error handling, business logic
- After reading 5 files OR completing Phase 1 analysis, write findings to:
  ${checkpointBasePath}-phase1.md
- Format: markdown with ## Phase 1: Core Logic header and findings list

**Phase 2 — Security** (read only security-sensitive files: auth, input validation, secrets handling)
- Focus: injection risks, auth bypass, secret exposure, IDOR
- After completing, append to or write: ${checkpointBasePath}-phase2.md
- Format: markdown with ## Phase 2: Security header and findings list

**Phase 3 — Tests** (read only test files)
- Focus: coverage gaps, assertion quality, edge cases not tested
- After completing, write: ${checkpointBasePath}-phase3.md
- Format: markdown with ## Phase 3: Tests header and findings list

**CHECKPOINT RULE**: After reading your FIRST 5 files (regardless of phase), immediately write
whatever findings you have so far to ${checkpointBasePath}-phase1.md — even if incomplete.
This ensures zero value is lost if the session is killed early.

**FINAL STEP**: Compile all phases into a single review in the standard output location.
If killed before the final step, the phase checkpoint files contain your partial work.

DO NOT try to read all files before writing — checkpoint early and often.
`;
}

async function processSpawnRequest(req: SpawnRequest): Promise<void> {
  if (!gatewayToken) {
    throw new Error("No gateway auth token configured — cannot spawn agents");
  }

  const taskCtx = (req.context?.task ?? {}) as Record<string, unknown>;
  const projectCtx = (req.context?.project ?? {}) as Record<string, unknown>;
  const taskTitle = (taskCtx["title"] as string) ?? "Workflow task";
  const taskNotes = (taskCtx["notes"] as string) ?? "";
  // Load context_refs files if specified
  const contextRefs = (taskCtx["context_refs"] ?? taskCtx["contextRefs"] ?? []) as string[];
  let contextBlock = "";
  if (Array.isArray(contextRefs) && contextRefs.length > 0) {
    const loaded: string[] = [];
    for (const ref of contextRefs) {
      const resolved = ref.replace(/^~/, process.env.HOME ?? "");
      if (existsSync(resolved)) {
        try {
          const content = readFileSync(resolved, "utf-8").trim();
          if (content.length > 0) {
            loaded.push(`### File: ${ref}\n${content.slice(0, 30000)}`);
          }
        } catch {}
      }
    }
    if (loaded.length > 0) {
      contextBlock = "\n\n---\n## Reference Context\n" + loaded.join("\n\n") + "\n---\n";
    }
  }
  const taskPrompt = req.promptTemplate ?? `${taskTitle}\n\n${taskNotes}`.trim();
  const repoPath = (projectCtx["repo_path"] as string) || undefined;
  const gitReminder = (req.agentType === "programmer" || req.agentType === "architect") && repoPath
    ? `\n\n⚠️ IMPORTANT: When you are done, you MUST run: git add -A && git commit -m "agent(${req.agentType}): <brief summary>"\nDo NOT finish without committing your changes.`
    : req.agentType === "writer"
      ? `\n\n⚠️ IMPORTANT: When you are done, you MUST commit and push all output files, then verify the push succeeded (see AGENTS.md Final Step). Push failure is a task failure — do NOT report success if the push failed or if the push verification shows a SHA mismatch.`
      : "";
  const architectReminder = req.agentType === "architect"
    ? `\n\n⚠️ SCOPE REMINDER: You are an architect agent. Your job is design-only. Produce a design doc or ADR. Do NOT write implementation code, do NOT create or modify source files beyond documentation. Stop as soon as you have a clear design artifact.`
    : "";
  if (req.agentType === "architect" && /design.{0,10}implement/i.test(taskTitle)) {
    log().warn(`[ORCHESTRATOR] Architect task title suggests implementation: "${taskTitle}". This is design-only scope — agent will be reminded. Consider splitting the task if implementation is also needed.`);
  }
  const taskContext = buildTaskContext({ projectId: (taskCtx["project_id"] as string) ?? undefined, agentType: req.agentType });

  // ── Reviewer scope bounding (phased review) ───────────────────────────────
  // When a reviewer task is "complex" (>5 file paths or spans multiple repos),
  // inject phased review instructions at spawn time so the session stays within
  // the watchdog window. The reviewer works in bounded phases and checkpoints
  // partial findings so value is preserved even if the session is killed early.
  // Simple reviews (CI, preflight, small diffs) are left untouched.
  let reviewerPhasedInjection = "";
  if (req.agentType === "reviewer") {
    const isComplexReview = detectComplexReview(taskTitle, taskNotes);
    if (isComplexReview) {
      const checkpointPath = `/Users/lobs/lobs-shared-memory/review-checkpoints/${req.taskId?.slice(0, 8) ?? "unknown"}`;
      reviewerPhasedInjection = buildPhasedReviewInstructions(checkpointPath);
      log().info(`[REVIEWER_SCOPE] Complex review detected for task ${req.taskId?.slice(0, 8) ?? "?"} — injecting phased review instructions (checkpoint=${checkpointPath})`);
    }
  }

  // ── Learning injection ─────────────────────────────────────────────────────
  // Inject relevant past learnings into the agent prompt before dispatch.
  // Per design doc: prefix-style, REMINDER framing, max 3 learnings.
  let learningInjection = "";
  try {
    const taskCategory = inferTaskCategory(taskTitle, taskNotes);
    learningInjection = learningSvc.buildPromptInjection(req.agentType, taskCategory);
    if (learningInjection) {
      log().debug?.(`[LEARNING] Injecting ${learningInjection.split("REMINDER:").length - 1} learnings for ${req.agentType} (category=${taskCategory})`);
    }
  } catch (e) {
    log().warn(`[LEARNING] Prompt injection failed: ${e}`);
  }

  const finalPrompt = taskPrompt + contextBlock + reviewerPhasedInjection + learningInjection + architectReminder + gitReminder + taskContext;

  // ── Artifact pre-flight check ──────────────────────────────────────────────
  // If the task declares expected_artifacts, check whether output files already
  // exist and are complete before spawning. Prevents redundant rewrites when a
  // worker crashed after writing but before marking the task done.
  // null/empty expected_artifacts = no-op (existing tasks are unaffected).
  // @see src/orchestrator/artifact-check.ts
  if (req.taskId) {
    try {
      const artifactProjectId = (taskCtx["project_id"] as string) ?? (taskCtx["projectId"] as string) ?? (projectCtx["id"] as string) ?? undefined;
      const artifactRaw = getRawDb()
        .prepare(`SELECT expected_artifacts FROM tasks WHERE id = ?`)
        .get(req.taskId) as { expected_artifacts: string | null } | undefined;

      if (artifactRaw?.expected_artifacts) {
        let specs: unknown;
        try { specs = JSON.parse(artifactRaw.expected_artifacts); } catch {}

        const checkResult = checkArtifacts(specs);

        if (checkResult.status === "skip_all_present") {
          log().info(
            `[ARTIFACT_CHECK] All artifacts present for task ${req.taskId.slice(0, 8)} — ` +
            `auto-closing without spawn`
          );
          getRawDb().prepare(
            `UPDATE tasks SET work_state = 'done', status = 'completed', ` +
            `finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
          ).run(req.taskId);
          decrementPendingSpawns(artifactProjectId, req.agentType);
          return;
        }

        if (checkResult.status === "skip_partial") {
          log().warn(
            `[ARTIFACT_CHECK] Partial artifacts for task ${req.taskId.slice(0, 8)} — ` +
            `marking done+needs_review. Missing: ${checkResult.missing.join(", ")}`
          );
          getRawDb().prepare(
            `UPDATE tasks SET work_state = 'done', status = 'completed', review_state = 'needs_review', ` +
            `finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
          ).run(req.taskId);
          getRawDb().prepare(
            `INSERT INTO inbox_items (id, title, content, type, requires_action, action_status, source_agent) ` +
            `VALUES (lower(hex(randomblob(16))), ?, ?, 'notice', 1, 'pending', ?)`
          ).run(
            `Partial artifacts: ${taskTitle}`,
            `Task auto-closed with partial artifacts. Missing:\n${(checkResult.missing as string[]).map(m => `- ${m}`).join("\n")}`,
            req.agentType,
          );
          decrementPendingSpawns(artifactProjectId, req.agentType);
          return;
        }
        // status === "proceed" → fall through to normal spawn
      }
    } catch (e) {
      // Fail open: on any error, log and proceed with normal spawn
      log().error(`[ARTIFACT_CHECK] check failed for task ${req.taskId.slice(0, 8)}: ${e}`);
    }
  }

  // ── blocked_by dependency gate ─────────────────────────────────────────────────
  // Defense-in-depth: skip spawning if any declared dependency is still unresolved.
  // Primary enforcement is in scanner.findReadyTasks (hasUnresolvedBlockers).
  // This catches edge cases where blocked_by was set after a workflow was already started
  // or where a task was re-queued after a crash while its blockers were re-activated.
  // NOTE: Logic must stay aligned with scanner.ts TERMINAL_STATUSES / TERMINAL_WORK_STATES.
  //   Terminal statuses: completed, closed, cancelled, rejected
  //   Terminal work_states: completed, done
  if (req.taskId) {
    try {
      const blockerRaw = getRawDb()
        .prepare(`SELECT blocked_by FROM tasks WHERE id = ?`)
        .get(req.taskId) as { blocked_by: string | null } | undefined;

      if (blockerRaw?.blocked_by) {
        let blockerIds: string[] = [];
        let parseOk = true;
        try { blockerIds = JSON.parse(blockerRaw.blocked_by); } catch {
          parseOk = false;
        }

        // Fail-safe: malformed blocked_by JSON → treat as blocked (requeue, don't spawn)
        if (!parseOk || !Array.isArray(blockerIds)) {
          log().error(
            `[BLOCKED_BY_GATE] Task ${req.taskId.slice(0, 8)} has corrupt blocked_by JSON ` +
            `(value: ${JSON.stringify(blockerRaw.blocked_by).slice(0, 80)}) — re-queuing without spawning`
          );
          const corruptProjectId = (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined;
          decrementPendingSpawns(corruptProjectId, req.agentType);
          requeueSpawn(req);
          return;
        }

        if (Array.isArray(blockerIds) && blockerIds.length > 0) {
          const placeholders = blockerIds.map(() => "?").join(", ");
          const activeBlockers = getRawDb()
            .prepare(
              `SELECT id FROM tasks WHERE id IN (${placeholders}) ` +
              `AND status NOT IN ('completed', 'closed', 'cancelled', 'rejected') ` +
              `AND (work_state IS NULL OR work_state NOT IN ('completed', 'done'))`
            )
            .all(...blockerIds) as Array<{ id: string }>;

          if (activeBlockers.length > 0) {
            const blockerStr = activeBlockers.map(b => b.id.slice(0, 8)).join(", ");
            log().debug?.(
              `[BLOCKED_BY_GATE] Task ${req.taskId.slice(0, 8)} spawn skipped — ` +
              `${activeBlockers.length} active blocker(s): ${blockerStr} — re-queuing`
            );
            const blockedWorkerProjectId = (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined;
            decrementPendingSpawns(blockedWorkerProjectId, req.agentType);
            requeueSpawn(req);
            return;
          }
        }
      }
    } catch (e) {
      // Fail-safe: DB query or other unexpected error → requeue, don't spawn.
      // Spawning on error would violate dependency ordering; better to retry later.
      log().error(`[BLOCKED_BY_GATE] Check failed for task ${req.taskId.slice(0, 8)}: ${e} — re-queuing without spawning`);
      const errorProjectId = (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined;
      decrementPendingSpawns(errorProjectId, req.agentType);
      requeueSpawn(req);
      return;
    }
  }

  // ── Compliance gate: enforce local-model-only for compliant projects and tasks ──
  // Hierarchy: project.compliance_required=1 cascades to ALL tasks in the project.
  // task.compliance_required=1 also forces compliance for that specific task,
  // even when the parent project is not marked compliant.
  const spawnProjectId = (taskCtx["project_id"] as string) ?? (taskCtx["projectId"] as string) ?? (projectCtx["id"] as string) ?? undefined;
  const spawnTaskId = req.taskId ?? undefined;
  let complianceOverrideModel: string | null = null;
  let complianceReason = "";
  try {
    const rawDb = getRawDb();

    // Check project-level compliance
    let projectCompliant = false;
    if (spawnProjectId) {
      const proj = rawDb.prepare(
        `SELECT compliance_required FROM projects WHERE id = ?`
      ).get(spawnProjectId) as { compliance_required: number | null } | undefined;
      projectCompliant = Boolean(proj?.compliance_required);
    }

    // Check task-level compliance (either explicit flag OR project cascade OR sensitivity classifier)
    let taskCompliant = projectCompliant; // inherit from project by default
    let sensitivityFlagged = false;
    if (!taskCompliant && spawnTaskId) {
      const taskRow = rawDb.prepare(
        `SELECT compliance_required, is_compliant FROM tasks WHERE id = ?`
      ).get(spawnTaskId) as { compliance_required: number | null; is_compliant: number | null } | undefined;
      taskCompliant = Boolean(taskRow?.compliance_required);
      // is_compliant=1 is set by sensitivity_classifier.py (synced from lobs-server).
      // A classified-sensitive task must never reach a cloud model tier — enforce here.
      if (!taskCompliant && Boolean(taskRow?.is_compliant)) {
        taskCompliant = true;
        sensitivityFlagged = true;
        log().info(
          `[COMPLIANCE] Task ${spawnTaskId?.slice(0, 8) ?? "?"} flagged sensitive by classifier ` +
          `(is_compliant=1) — enforcing local-model-only routing.`
        );
      }
    }

    if (taskCompliant) {
      complianceReason = projectCompliant
        ? `project ${spawnProjectId?.slice(0, 8) ?? "?"} compliance_required=1 (cascaded to task)`
        : sensitivityFlagged
          ? `task ${spawnTaskId?.slice(0, 8) ?? "?"} is_compliant=1 (sensitivity classifier — FERPA/HIPAA)`
          : `task ${spawnTaskId?.slice(0, 8) ?? "?"} compliance_required=1`;

      // Look up the configured local compliance model
      const cmRow = rawDb.prepare(
        `SELECT value FROM orchestrator_settings WHERE key = 'compliance_model'`
      ).get() as { value: string } | undefined;

      if (cmRow) {
        const parsed = JSON.parse(cmRow.value) as string;
        if (parsed && typeof parsed === "string") {
          complianceOverrideModel = parsed;
          log().info(
            `[COMPLIANCE] Forcing local model: ${complianceOverrideModel} for ` +
            `${req.agentType} task ${spawnTaskId?.slice(0, 8) ?? "?"} — reason: ${complianceReason}`
          );
        }
      }

      if (!complianceOverrideModel) {
        // compliance_model not configured — block dispatch to prevent accidental cloud use
        log().error(
          `[COMPLIANCE] Dispatch blocked — compliance required (${complianceReason}) but ` +
          `'compliance_model' orchestrator setting is not configured.`
        );
        decrementPendingSpawns(spawnProjectId, req.agentType);
        writeSpawnResult(req.runId, req.nodeId, {
          status: "failed",
          error: `compliance_model_not_configured: compliance required (${complianceReason}) but 'compliance_model' setting is missing. Set it via: UPDATE orchestrator_settings SET value = '"your/local-model"' WHERE key = 'compliance_model'`,
        });
        return;
      }
    }
  } catch (e) {
    log().error(`[COMPLIANCE] Failed to check compliance flags: ${e}`);
  }

  // ── Escalation: fire on repeated task failures ───────────────────────────
  // On each retry (effectiveFailCount > 0), escalate the task through tiers so
  // persistent failures surface alerts and eventually reach human review.
  // Runs BEFORE model selection so the updated escalationTier can influence
  // the model choice below.
  let taskEscalationTier = 0;
  if (req.taskId) {
    try {
      const escalTaskRow = getRawDb()
        .prepare(`SELECT spawn_count, crash_count, escalation_tier, project_id FROM tasks WHERE id = ?`)
        .get(req.taskId) as { spawn_count: number | null; crash_count: number | null; escalation_tier: number | null; project_id: string | null } | undefined;
      if (escalTaskRow) {
        const spawnCount = escalTaskRow.spawn_count ?? 0;
        const crashCount = escalTaskRow.crash_count ?? 0;
        const effectiveFailCount = spawnCount - crashCount;
        taskEscalationTier = escalTaskRow.escalation_tier ?? 0;
        // Only escalate when there are genuine prior failures (not first spawn, not crash-only)
        if (effectiveFailCount > 0) {
          const escalationMgr = new EscalationManager();
          const escalProjectId = escalTaskRow.project_id ?? spawnProjectId ?? "";
          const errorLog = `Task ${req.taskId.slice(0, 8)} has failed ${effectiveFailCount} time(s) (spawn=${spawnCount}, crash=${crashCount}, agent=${req.agentType}).`;
          const escalResult = escalationMgr.escalate(
            req.taskId,
            escalProjectId,
            errorLog,
            taskEscalationTier as EscalationTier,
          );
          taskEscalationTier = escalResult.tier;
          log().info(
            `[ESCALATION] Task ${req.taskId.slice(0, 8)} → tier ${escalResult.tier} ` +
            `(action=${escalResult.action}, agent=${req.agentType}, fail_count=${effectiveFailCount})`
          );
          // HUMAN tier: task is now waiting_on — abort spawn so human can intervene
          if (escalResult.tier === ESCALATION_TIERS.HUMAN) {
            log().warn(
              `[ESCALATION] Task ${req.taskId.slice(0, 8)} reached HUMAN tier — ` +
              `aborting spawn, status set to waiting_on`
            );
            decrementPendingSpawns(spawnProjectId, req.agentType);
            writeSpawnResult(req.runId, req.nodeId, {
              status: "failed",
              error: `Human escalation required: task ${req.taskId.slice(0, 8)} exhausted automated recovery. Status set to waiting_on.`,
            });
            return;
          }
        }
      }
    } catch (e) {
      log().warn(`[ESCALATION] escalate() failed for task ${req.taskId.slice(0, 8)}: ${e}`);
    }
  }

  // ── Circuit-breaker-aware model selection ────────────────────────────────
  let model: string;
  let circuitDegraded = false;

  if (complianceOverrideModel) {
    // Compliance mode: use only the local model, no fallback to cloud
    model = complianceOverrideModel;
    log().info(`[COMPLIANCE] Using local-only model: ${model} (no cloud fallback)`);
  } else {
    // If the task has been escalated, bump to next model tier so retries use a stronger model
    const modelChoice = taskEscalationTier > 0
      ? escalationModel(
          (req.modelTier as ModelTier | undefined) ?? resolveTaskTier({ agent: req.agentType }),
          req.agentType,
        )
      : req.modelTier
        ? chooseModel(req.modelTier, req.agentType)
        : chooseModel("standard", req.agentType);

    // Build fallback chain: uses AGENT_FALLBACK_CHAINS if available, else tier-level alternatives
    const primaryModel = modelChoice.model;
    const fallbackChain = buildFallbackChain(primaryModel, modelChoice.tier, req.agentType);

    const healthResult = req.agentType
      ? chooseHealthyModel(fallbackChain, req.agentType)
      : { model: primaryModel, degraded: false };
    model = healthResult.model;
    circuitDegraded = healthResult.degraded;

    if (circuitDegraded) {
      // Design doc: do NOT dispatch when all models are open — leave task queued so it retries
      // after the cooldown expires.
      log().error(
        `[SPAWN] ⚠️  All models circuit-open for ${req.agentType} ` +
        `(chain=${fallbackChain.join(", ")}). Blocking dispatch — task will requeue after cooldown.`
      );
      decrementPendingSpawns(
        (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined,
        req.agentType
      );
      writeSpawnResult(req.runId, req.nodeId, {
        status: "failed",
        error: `all_models_unhealthy: all circuit breakers open for ${req.agentType}. Task requeued — will retry after cooldown expires.`,
      });
      return;
    }
  }

  // ── Spawn count guard ────────────────────────────────────────────────────
  if (req.taskId) {
    const autoBlocked = incrementAndCheckSpawnCount(req.taskId);
    if (autoBlocked) {
      decrementPendingSpawns(
        (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined,
        req.agentType
      );
      writeSpawnResult(req.runId, req.nodeId, {
        status: "failed",
        error: `Task auto-blocked: spawn_count exceeded per-type limit (see task failure_reason for details)`,
      });
      return;
    }
  }

  log().info(
    `[SPAWN] Spawning ${req.agentType} for run ${req.runId.slice(0, 8)} ` +
    `(task=${req.taskId?.slice(0, 8) ?? "none"}, model=${model})`
  );

  // Route through sink session so completions don't pollute main
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify({
      tool: "sessions_spawn",
      sessionKey: SINK_SESSION_KEY,
      args: {
        task: finalPrompt,
        agentId: req.agentType,
        model,
        mode: "run",
        cleanup: "keep",
        runTimeoutSeconds: 1800,
        ...(repoPath ? { cwd: repoPath } : {}),
      },
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;

  if (!data.ok) {
    const err = (data.error as Record<string, unknown>)?.message ?? JSON.stringify(data.error);
    const workerProjectId = (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined;
    decrementPendingSpawns(workerProjectId, req.agentType);
    throw new Error(`Gateway spawn failed: ${err}`);
  }

  const details = (data.result as Record<string, unknown>)?.details as Record<string, unknown> | undefined;
  const childSessionKey = (details?.childSessionKey as string) ?? undefined;
  const status = (details?.status as string) ?? "unknown";

  if (status === "accepted" && childSessionKey) {
    log().info(`[SPAWN] Accepted: session=${childSessionKey} run=${req.runId.slice(0, 8)}`);

    const workerProjectId = (taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined;
    recordWorkerStart({
      workerId: childSessionKey,
      agentType: req.agentType,
      taskId: req.taskId,
      projectId: workerProjectId,
      model,
    });

    decrementPendingSpawns(workerProjectId, req.agentType);
    writeSpawnResult(req.runId, req.nodeId, {
      childSessionKey,
    });
  } else {
    decrementPendingSpawns((taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined, req.agentType);
    throw new Error(`Spawn returned status=${status}: ${JSON.stringify(details)}`);
  }
}

function writeSpawnResult(
  runId: string,
  nodeId: string,
  update: Record<string, unknown>,
): void {
  const db = getDb();
  const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  if (!run) {
    log().error(`[SPAWN] Cannot write result: run ${runId} not found`);
    return;
  }

  const nodeStates = (run.nodeStates as Record<string, Record<string, unknown>>) ?? {};
  const ns = nodeStates[nodeId] ?? {};

  if (update["childSessionKey"]) {
    ns["childSessionKey"] = update["childSessionKey"];
  }
  if (update["status"] === "failed") {
    ns["spawn_result"] = { status: "failed", error: update["error"] };
  }

  nodeStates[nodeId] = ns;
  db.update(workflowRuns).set({
    nodeStates,
    updatedAt: new Date().toISOString(),
  }).where(eq(workflowRuns.id, runId)).run();
}

// ── Task Decomposition Helpers ──────────────────────────────────────────────

/**
 * Check if a task should be decomposed before execution.
 *
 * Decompose if:
 * - Title mentions "design AND implement" (separate phases)
 * - Task has multiple distinct deliverables
 * - Notes are very long (>2000 chars) with multiple subsections
 */
async function shouldDecomposeTask(task: { title: string; notes?: string }): Promise<boolean> {
  const title = task.title.toLowerCase();
  const notes = task.notes ?? "";

  // Check for "design AND implement" pattern
  if (/design.{0,10}(and|&).{0,10}implement/i.test(title)) {
    return true;
  }

  // Check for multiple deliverables
  const deliverableKeywords = ["design", "implement", "test", "document", "deploy", "review"];
  const mentionedDeliverables = deliverableKeywords.filter((kw) =>
    title.includes(kw) || notes.includes(kw),
  );
  if (mentionedDeliverables.length >= 3) {
    return true;
  }

  // Check for very long notes with multiple subsections
  if (notes.length > 2000) {
    const subsectionCount = (notes.match(/^#{1,3}\s+/gm) ?? []).length;
    if (subsectionCount >= 3) {
      return true;
    }
  }

  return false;
}

/**
 * Get the pipeline ID for a task, if it uses one.
 *
 * Returns null if task doesn't use a pipeline.
 */
function getTaskPipeline(task: { title: string; notes?: string }): string | null {
  const db = getRawDb();

  // Check if task has a pipeline field set
  const row = db
    .prepare(`SELECT notes FROM tasks WHERE id = ?`)
    .get(task.title) as { notes: string | null } | undefined;

  if (row?.notes) {
    // Look for pipeline directive in notes
    const pipelineMatch = row.notes.match(/pipeline:\s*(\S+)/i);
    if (pipelineMatch) {
      return pipelineMatch[1];
    }
  }

  // Auto-detect based on patterns
  const title = task.title.toLowerCase();
  const notes = (task.notes ?? "").toLowerCase();

  if (title.includes("implement") && title.includes("review")) {
    return "implement-and-review";
  }

  if (title.includes("design") && title.includes("implement")) {
    return "design-and-implement";
  }

  if (title.includes("research") && title.includes("write")) {
    return "research-and-write";
  }

  return null;
}
