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
 *
 * Spawns route through the "sink" agent session so completion announcements
 * don't pollute the main session.
 */

import { readFileSync } from "node:fs";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { eq, and } from "drizzle-orm";
import { log } from "../util/logger.js";
import { processPendingResumes } from "../index.js";
import { WorkflowExecutor } from "../workflow/engine.js";
import { popPendingSpawns, requeueSpawn, type SpawnRequest } from "../workflow/nodes.js";
import { getDb } from "../db/connection.js";
import { workflowRuns, tasks as tasksTable } from "../db/schema.js";
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
} from "./worker-manager.js";
import { chooseModel, resolveTaskTier, TIER_MODELS, buildFallbackChain } from "./model-chooser.js";
import { chooseHealthyModel, seedModelHealthFromHistory } from "./model-health.js";

let timer: ReturnType<typeof setInterval> | null = null;
let executor: WorkflowExecutor | null = null;
let gatewayPort: number = 18789;
let gatewayToken: string = "";

export function getGatewayConfig(): { port: number; token: string } {
  return { port: gatewayPort, token: gatewayToken };
}
let isFirstTick = true;


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
    const cfgPath = process.env.OPENCLAW_CONFIG ?? process.env.HOME + "/.openclaw/openclaw.json";
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const port = cfg?.gateway?.port ?? 18789;
    const token = cfg?.gateway?.auth?.token ?? "";

    const resp = await fetch("http://127.0.0.1:" + port + "/tools/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({
        tool: "sessions_list",
        sessionKey: "agent:sink:paw-orchestrator-v2",
        args: { activeMinutes: 120, limit: 100 },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return true; // assume alive if we can't check

    const data = (await resp.json()) as any;
    const respContent = data?.result?.content;
    let sessions: any[] = [];
    if (Array.isArray(respContent)) {
      for (const c of respContent) {
        if (c.type === "text" && c.text) {
          try { sessions = JSON.parse(c.text)?.sessions ?? []; } catch {}
        }
      }
    }

    const session = sessions.find((s: any) => s.key === sessionKey);
    if (!session) return false; // session doesn't exist at all

    // Check if session has been updated recently (within 5 min)
    const updatedAt = session.updatedAt as number;
    const ageMs = Date.now() - updatedAt;
    const STALE_THRESHOLD_MS = 5 * 60 * 1000;

    if (ageMs > STALE_THRESHOLD_MS) {
      log().debug?.("checkSessionAlive: session " + sessionKey.slice(0, 30) + " exists but stale (" + Math.round(ageMs / 60000) + "min since update)");
      return false;
    }

    return true; // session exists and recently active
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
        log().info(`orchestrator: project ${spawnProjectId.slice(0, 8)}:${req.agentType} locked — re-queuing spawn for run ${req.runId.slice(0, 8)}`);
        requeueSpawn(req);
        continue;
      }

      incrementPendingSpawns(spawnProjectId, req.agentType);
      processSpawnRequest(req).catch((err) => {
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
      for (const task of readyTasks) {
        if (!hasCapacity()) break;



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
    const { workerRuns: wrTable } = require("../db/schema.js");
    const { isNull } = require("drizzle-orm");
    const openWorkers = liveDb.select().from(wrTable).where(isNull(wrTable.endedAt)).all();
    for (const w of openWorkers) {
      const sessionKey = w.workerId;
      if (!sessionKey) continue;
      const runningMin = (Date.now() - new Date(w.startedAt).getTime()) / 60000;
      if (runningMin < 5) continue; // give new workers time

      checkSessionAlive(sessionKey).then((alive: boolean) => {
        if (!alive) {
          log().warn("orchestrator: worker " + w.id + " (" + w.agentType + ") session dead after " + Math.round(runningMin) + "min — marking failed");
          recordWorkerEnd({ workerId: sessionKey, agentType: w.agentType, succeeded: false, summary: "session dead — no progress" });
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
    const staleThreshold3  = new Date(Date.now() -  3 * 60 * 1000).toISOString();
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
              // Clean up dangling workerRuns row so capacity is freed and circuit breaker fires
              try {
                const { workerRuns: wrTable } = require("../db/schema.js");
                const wrRow = staleDb.select().from(wrTable).where(eq(wrTable.workerId, childKey)).get() as any;
                recordWorkerEnd({
                  workerId: childKey,
                  agentType: wrRow?.agentType ?? "unknown",
                  succeeded: false,
                  summary: `session_dead: stale after ${mins}min`,
                });
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
}

// ── Spawn processing ─────────────────────────────────────────────────────────

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

function spawnCountLimitForType(taskType: string | null | undefined): number {
  if (taskType && taskType in SPAWN_COUNT_LIMIT_BY_TYPE) {
    return SPAWN_COUNT_LIMIT_BY_TYPE[taskType];
  }
  return SPAWN_COUNT_LIMIT;
}

/**
 * Increment spawn_count for a task and check if it has exceeded the per-type limit.
 * Returns true if task was auto-blocked (spawn_count >= limit after increment).
 * The limit is determined by the task's task_type (falls back to SPAWN_COUNT_LIMIT=3).
 */
function incrementAndCheckSpawnCount(taskId: string): boolean {
  const db = getDb();
  try {
    const task = db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).get();
    if (!task) return false;

    const limit = spawnCountLimitForType(task.shape);
    const newCount = (task.spawnCount ?? 0) + 1;
    db.update(tasksTable).set({
      spawnCount: newCount,
      updatedAt: new Date().toISOString(),
    }).where(eq(tasksTable.id, taskId)).run();

    if (newCount >= limit) {
      // Auto-block the task to stop runaway spawning
      db.update(tasksTable).set({
        workState: "blocked",
        failureReason: `Auto-blocked: spawn_count reached ${newCount} (limit=${limit}, type=${task.shape ?? "other"}). Needs human review.`,
        updatedAt: new Date().toISOString(),
      }).where(eq(tasksTable.id, taskId)).run();

      log().warn(
        `[SPAWN_GUARD] Task ${taskId.slice(0, 8)} auto-blocked — spawn_count=${newCount} >= limit=${limit} (type=${task.shape ?? "other"})`
      );
      return true;
    }
    log().debug?.(`[SPAWN_GUARD] Task ${taskId.slice(0, 8)} spawn_count now ${newCount}/${limit} (type=${task.shape ?? "other"})`);
    return false;
  } catch (e) {
    log().error(`[SPAWN_GUARD] incrementAndCheckSpawnCount error: ${e}`);
    return false;
  }
}

async function processSpawnRequest(req: SpawnRequest): Promise<void> {
  if (!gatewayToken) {
    throw new Error("No gateway auth token configured — cannot spawn agents");
  }

  const taskCtx = (req.context?.task ?? {}) as Record<string, unknown>;
  const projectCtx = (req.context?.project ?? {}) as Record<string, unknown>;
  const taskTitle = (taskCtx["title"] as string) ?? "Workflow task";
  const taskNotes = (taskCtx["notes"] as string) ?? "";
  const taskPrompt = req.promptTemplate ?? `${taskTitle}\n\n${taskNotes}`.trim();
  const repoPath = (projectCtx["repo_path"] as string) || undefined;
  const gitReminder = (req.agentType === "programmer" || req.agentType === "architect") && repoPath
    ? `\n\n⚠️ IMPORTANT: When you are done, you MUST run: git add -A && git commit -m "agent(${req.agentType}): <brief summary>"\nDo NOT finish without committing your changes.`
    : "";
  const taskContext = buildTaskContext({ projectId: (taskCtx["project_id"] as string) ?? undefined, agentType: req.agentType });
  const finalPrompt = taskPrompt + gitReminder + taskContext;

  // ── Circuit-breaker-aware model selection ────────────────────────────────
  const modelChoice = req.modelTier
    ? chooseModel(req.modelTier, req.agentType)
    : chooseModel("standard", req.agentType);

  // Build fallback chain: uses AGENT_FALLBACK_CHAINS if available, else tier-level alternatives
  const primaryModel = modelChoice.model;
  const fallbackChain = buildFallbackChain(primaryModel, modelChoice.tier, req.agentType);

  const { model, degraded: circuitDegraded } = req.agentType
    ? chooseHealthyModel(fallbackChain, req.agentType)
    : { model: primaryModel, degraded: false };

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
        runTimeoutSeconds: 900,
        ...(repoPath ? { cwd: repoPath } : {}),
      },
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;

  if (!data.ok) {
    const err = (data.error as Record<string, unknown>)?.message ?? JSON.stringify(data.error);
    decrementPendingSpawns(undefined, req.agentType);
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
