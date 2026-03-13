/**
 * before_compaction / after_compaction hooks — preserve task context across compaction.
 *
 * When a PAW-managed worker session is compacted, the task assignment (title, notes,
 * acceptance criteria) could get lost in the compaction summary. These hooks:
 *
 * 1. before_compaction: persist the current task context to a sidecar JSON file
 *    so the prompt-build hook can re-inject it on the next turn.
 * 2. after_compaction: log compaction stats for observability.
 */

import { eq, and, isNull } from "drizzle-orm";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workerRuns, tasks, projects } from "../db/schema.js";
import { log } from "../util/logger.js";

const SIDECAR_DIR = join(process.env.HOME || "/Users/lobs", ".openclaw/plugins/lobs");

function sidecarPath(taskId: string): string {
  return join(SIDECAR_DIR, `task-context-${taskId}.json`);
}

export function registerCompactionHooks(api: OpenClawPluginApi): void {

  api.on("before_compaction", async (_event, ctx) => {
    const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
    if (!sessionKey) return;

    const db = getDb();
    const run = db.select().from(workerRuns)
      .where(and(
        eq(workerRuns.workerId, sessionKey),
        isNull(workerRuns.endedAt),
      ))
      .get();

    if (!run?.taskId) return;

    const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
    if (!task) return;

    let project = null;
    if (task.projectId) {
      project = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    }

    const context = {
      taskId: task.id,
      title: task.title,
      notes: task.notes,
      agent: task.agent,
      modelTier: task.modelTier,
      projectTitle: project?.title,
      repoPath: project?.repoPath,
      savedAt: new Date().toISOString(),
      sessionKey,
    };

    try {
      writeFileSync(sidecarPath(task.id), JSON.stringify(context, null, 2));
      log().info(
        `[PAW] before_compaction: persisted task context for ${task.id.slice(0, 8)} ` +
        `(${task.title.slice(0, 50)}) — session ${sessionKey.slice(0, 30)}`,
      );
    } catch (e) {
      log().warn(`[PAW] before_compaction: failed to persist task context: ${e}`);
    }
  });

  api.on("after_compaction", async (event, ctx) => {
    const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
    if (!sessionKey) return;

    const ev = event as Record<string, unknown>;

    const db = getDb();
    const run = db.select().from(workerRuns)
      .where(and(
        eq(workerRuns.workerId, sessionKey),
        isNull(workerRuns.endedAt),
      ))
      .get();

    if (!run?.taskId) return;

    log().info(
      `[PAW] after_compaction: task ${run.taskId.slice(0, 8)} — ` +
      `messages=${ev.messageCount ?? "?"}, compacted=${ev.compactedCount ?? "?"}, ` +
      `tokens=${ev.tokenCount ?? "?"} — session ${sessionKey.slice(0, 30)}`,
    );

    // Sidecar file stays on disk — prompt-build will re-inject task context on next turn.
    // Sidecar is cleaned up in agent-end when the worker finishes.
  });
}

/**
 * Clean up the sidecar file when a task completes.
 * Called from subagent ended or externally.
 */
export function cleanupTaskSidecar(taskId: string): void {
  try {
    unlinkSync(sidecarPath(taskId));
  } catch {
    // File may not exist — that's fine
  }
}
