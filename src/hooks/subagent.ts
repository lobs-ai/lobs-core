/**
 * subagent_spawning / subagent_ended hooks — WorkerManager integration.
 *
 * Tracks worker lifecycle through OpenClaw's native sub-agent events:
 * - On spawn: record worker run, update agent status, enforce project locks
 * - On end: complete worker run, update task status, emit workflow events
 *
 * This replaces the old HTTP polling + bridge pattern entirely.
 */

import { eq, and, isNull } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workerRuns, tasks, agentStatus as agentStatusTable } from "../db/schema.js";
import { recordWorkerStart, recordWorkerEnd } from "../orchestrator/worker-manager.js";
import { log } from "../util/logger.js";

export function registerSubagentHooks(api: OpenClawPluginApi): void {

  api.on("subagent_spawned", async (event) => {
    // Only track spawns that came from our workflow engine (tagged with paw metadata)
    const meta = (event as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
    if (!meta?.pawManaged) return;

    const sessionKey = (event as Record<string, unknown>).childSessionKey as string;
    const agentType = (meta.agentType as string) ?? "unknown";
    const taskId = meta.taskId as string | undefined;
    const projectId = meta.projectId as string | undefined;
    const model = meta.model as string | undefined;

    log().info(`[PAW] Worker spawned: session=${sessionKey} agent=${agentType} task=${taskId ?? "none"}`);

    recordWorkerStart({
      workerId: sessionKey,
      agentType,
      taskId,
      projectId,
      model,
    });
  });

  api.on("subagent_ended", async (event) => {
    const sessionKey = (event as Record<string, unknown>).targetSessionKey as string;
    if (!sessionKey) return;

    // Check if this is one of our tracked workers
    const db = getDb();
    const run = db.select().from(workerRuns)
      .where(and(
        eq(workerRuns.workerId, sessionKey),
        isNull(workerRuns.endedAt),
      ))
      .get();

    if (!run) return; // Not our worker

    const reason = (event as Record<string, unknown>).reason as string | undefined;
    const succeeded = reason !== "error" && reason !== "timeout";

    log().info(`[PAW] Worker ended: session=${sessionKey} succeeded=${succeeded} reason=${reason}`);

    // Calculate duration
    const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : Date.now();
    const durationSeconds = (Date.now() - startedAt) / 1000;

    recordWorkerEnd({
      workerId: sessionKey,
      agentType: run.agentType ?? "unknown",
      succeeded,
      taskId: run.taskId ?? undefined,
      durationSeconds,
    });

    // Update linked task status
    if (run.taskId) {
      const now = new Date().toISOString();
      if (succeeded) {
        db.update(tasks).set({
          workState: "done",
          status: "completed",
          finishedAt: now,
          updatedAt: now,
        }).where(eq(tasks.id, run.taskId)).run();
      } else {
        db.update(tasks).set({
          workState: "failed",
          failureReason: reason ?? "Worker ended without success",
          retryCount: (db.select().from(tasks).where(eq(tasks.id, run.taskId)).get()?.retryCount ?? 0) + 1,
          updatedAt: now,
        }).where(eq(tasks.id, run.taskId)).run();
      }
    }
  });
}
