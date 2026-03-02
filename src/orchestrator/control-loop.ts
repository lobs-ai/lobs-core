/**
 * Orchestrator control loop — main scan/dispatch service.
 * Port of lobs-server/app/orchestrator/control_loop.py
 *
 * On each tick:
 * 1. Advance active workflow runs (one step per run)
 * 2. Process workflow events (event-triggered workflows)
 * 3. Process schedule triggers (cron-triggered workflows)
 * 4. Scan for new ready tasks → match to workflows → start runs
 * 5. Health check active workers (detect stale)
 */

import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { log } from "../util/logger.js";
import { WorkflowExecutor } from "../workflow/engine.js";
import { findReadyTasks } from "./scanner.js";
import {
  hasCapacity,
  projectHasActiveWorker,
  detectStaleWorkers,
  forceTerminateWorker,
} from "./worker-manager.js";
import { chooseModel, resolveTaskTier } from "./model-chooser.js";

let timer: ReturnType<typeof setInterval> | null = null;
let executor: WorkflowExecutor | null = null;

export function startControlLoop(ctx: OpenClawPluginServiceContext, intervalMs: number): void {
  log().info(`orchestrator: starting control loop (interval=${intervalMs}ms)`);

  executor = new WorkflowExecutor();

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

        // Domain lock: one worker per project
        if (task.projectId && projectHasActiveWorker(task.projectId)) {
          log().debug?.(`orchestrator: project ${task.projectId.slice(0, 8)} already has active worker — skipping task ${task.id.slice(0, 8)}`);
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
