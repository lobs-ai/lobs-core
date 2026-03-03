/**
 * subagent_spawning / subagent_ended hooks — WorkerManager integration.
 */

import { eq, and, isNull } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workerRuns, tasks, workflowRuns } from "../db/schema.js";
import { recordWorkerStart, recordWorkerEnd } from "../orchestrator/worker-manager.js";
import { log } from "../util/logger.js";

export function registerSubagentHooks(api: OpenClawPluginApi): void {

  api.on("subagent_spawned", async (event) => {
    const meta = (event as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
    if (!meta?.pawManaged) return;

    const sessionKey = (event as Record<string, unknown>).childSessionKey as string;
    const agentType = (meta.agentType as string) ?? "unknown";
    const taskId = meta.taskId as string | undefined;
    const projectId = meta.projectId as string | undefined;
    const model = meta.model as string | undefined;

    log().info(`[PAW] Worker spawned: session=${sessionKey} agent=${agentType} task=${taskId ?? "none"}`);
    recordWorkerStart({ workerId: sessionKey, agentType, taskId, projectId, model });
  });

  api.on("subagent_ended", async (event) => {
    const ev = event as Record<string, unknown>;
    const sessionKey = (ev.targetSessionKey ?? ev.childSessionKey) as string;
    if (!sessionKey) return;

    const reason = ev.reason as string | undefined;
    const succeeded = reason !== "error" && reason !== "timeout";

    log().info(`[PAW] subagent_ended: session=${sessionKey} reason=${reason} succeeded=${succeeded}`);

    const db = getDb();

    // Strategy 1: Match via worker_runs table
    const workerRun = db.select().from(workerRuns)
      .where(and(eq(workerRuns.workerId, sessionKey), isNull(workerRuns.endedAt)))
      .get();

    if (workerRun) {
      const startedAt = workerRun.startedAt ? new Date(workerRun.startedAt).getTime() : Date.now();
      recordWorkerEnd({
        workerId: sessionKey,
        agentType: workerRun.agentType ?? "unknown",
        succeeded,
        taskId: workerRun.taskId ?? undefined,
        durationSeconds: (Date.now() - startedAt) / 1000,
      });

      if (workerRun.taskId) {
        updateTaskFromEnd(workerRun.taskId, succeeded, reason);
      }
    }

    // Always: update workflow run nodeStates so _checkSpawnAgent can advance
    updateWorkflowRunForSession(sessionKey, succeeded, reason);
  });
}

/**
 * Find the workflow run that spawned this session and write spawn_result
 * so the engine's _checkSpawnAgent can advance the node.
 */
function updateWorkflowRunForSession(sessionKey: string, succeeded: boolean, reason?: string): void {
  const db = getDb();
  const runningRuns = db.select().from(workflowRuns)
    .where(eq(workflowRuns.status, "running"))
    .all();

  for (const run of runningRuns) {
    const nodeStates = (run.nodeStates as Record<string, Record<string, unknown>>) ?? {};
    for (const [nodeId, ns] of Object.entries(nodeStates)) {
      if (ns.childSessionKey === sessionKey && ns.status === "running") {
        log().info(`[PAW] Writing spawn_result for run ${run.id.slice(0, 8)} node=${nodeId} succeeded=${succeeded}`);

        ns.spawn_result = {
          status: succeeded ? "completed" : "failed",
          error: succeeded ? undefined : (reason ?? "Agent ended without success"),
        };
        nodeStates[nodeId] = ns;

        db.update(workflowRuns).set({
          nodeStates,
          updatedAt: new Date().toISOString(),
        }).where(eq(workflowRuns.id, run.id)).run();

        return;
      }
    }
  }

  log().debug?.(`[PAW] No running workflow run found for session=${sessionKey}`);
}

function updateTaskFromEnd(taskId: string, succeeded: boolean, reason?: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  if (succeeded) {
    db.update(tasks).set({
      workState: "done",
      status: "completed",
      finishedAt: now,
      updatedAt: now,
    }).where(eq(tasks.id, taskId)).run();
    log().info(`[PAW] Task ${taskId.slice(0, 8)} marked completed`);
  } else {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    db.update(tasks).set({
      workState: "failed",
      failureReason: reason ?? "Worker ended without success",
      retryCount: (task?.retryCount ?? 0) + 1,
      updatedAt: now,
    }).where(eq(tasks.id, taskId)).run();
    log().info(`[PAW] Task ${taskId.slice(0, 8)} marked failed: ${reason}`);
  }
}
