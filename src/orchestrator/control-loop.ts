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
import { eq } from "drizzle-orm";
import { log } from "../util/logger.js";
import { processPendingResumes } from "../index.js";
import { WorkflowExecutor } from "../workflow/engine.js";
import { popPendingSpawns, requeueSpawn, type SpawnRequest } from "../workflow/nodes.js";
import { getDb } from "../db/connection.js";
import { workflowRuns } from "../db/schema.js";
import { findReadyTasks } from "./scanner.js";
import {
  hasCapacity,
  projectHasActiveWorker,
  projectHasPendingSpawn,
  recordWorkerStart,
  incrementPendingSpawns,
  decrementPendingSpawns,
  detectStaleWorkers,
  forceTerminateWorker,
} from "./worker-manager.js";
import { chooseModel, resolveTaskTier } from "./model-chooser.js";

let timer: ReturnType<typeof setInterval> | null = null;
let executor: WorkflowExecutor | null = null;
let gatewayPort: number = 18789;
let gatewayToken: string = "";
let isFirstTick = true;


/** Session key for the sink agent — spawns route here to avoid polluting main */
const SINK_SESSION_KEY = "agent:sink:paw-orchestrator-v2";

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
      const didWork = executor.advance(run);
      if (didWork) advanced++;
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

      // Project lock: only one worker per project at a time
      if (spawnProjectId && (projectHasActiveWorker(spawnProjectId) || projectHasPendingSpawn(spawnProjectId))) {
        log().info(`orchestrator: project ${spawnProjectId.slice(0, 8)} locked — re-queuing spawn for run ${req.runId.slice(0, 8)}`);
        requeueSpawn(req);
        continue;
      }

      incrementPendingSpawns(spawnProjectId);
      processSpawnRequest(req).catch((err) => {
        log().error(`orchestrator: spawn failed for run ${req.runId.slice(0, 8)}: ${err}`);
        decrementPendingSpawns(spawnProjectId);
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
      const readyTasks = findReadyTasks(1);
      for (const task of readyTasks) {
        if (!hasCapacity()) break;

        if (task.projectId && (projectHasActiveWorker(task.projectId) || projectHasPendingSpawn(task.projectId))) {
          log().debug?.(`orchestrator: project ${task.projectId.slice(0, 8)} already has active/pending worker — skipping task ${task.id.slice(0, 8)}`);
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

  // ── 5. Worker health check (stale detection) ───────────────────────────────
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

  const modelChoice = req.modelTier
    ? chooseModel(req.modelTier, req.agentType)
    : chooseModel("standard", req.agentType);
  const model = modelChoice.model;

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
        task: taskPrompt,
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
    decrementPendingSpawns();
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

    decrementPendingSpawns(workerProjectId);
    writeSpawnResult(req.runId, req.nodeId, {
      childSessionKey,
    });
  } else {
    decrementPendingSpawns((taskCtx["projectId"] as string) ?? (taskCtx["project_id"] as string) ?? undefined);
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
