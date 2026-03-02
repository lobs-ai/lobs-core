/**
 * before_prompt_build hook — inject task/project context into worker prompts.
 *
 * When a PAW-managed worker session starts, this hook injects:
 * - Task title, notes, and requirements
 * - Project context (repo path, type)
 * - Agent-specific instructions
 */

import { eq, and, isNull } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workerRuns, tasks, projects } from "../db/schema.js";
import { log } from "../util/logger.js";

export function registerPromptBuildHook(api: OpenClawPluginApi): void {
  api.on("before_prompt_build", async (_event, ctx) => {
    const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
    if (!sessionKey) return {};

    // Check if this is a PAW-managed worker
    const db = getDb();
    const run = db.select().from(workerRuns)
      .where(and(
        eq(workerRuns.workerId, sessionKey),
        isNull(workerRuns.endedAt),
      ))
      .get();

    if (!run || !run.taskId) return {};

    const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
    if (!task) return {};

    let project = null;
    if (task.projectId) {
      project = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    }

    // Build context injection
    const lines: string[] = [
      `<paw-task-context>`,
      `Task: ${task.title}`,
    ];
    if (task.notes) lines.push(`Notes: ${task.notes}`);
    if (task.agent) lines.push(`Agent Role: ${task.agent}`);
    if (project) {
      lines.push(`Project: ${project.title}`);
      if (project.repoPath) lines.push(`Repo: ${project.repoPath}`);
    }
    lines.push(`</paw-task-context>`);

    log().debug?.(`[PAW] Injecting task context for session ${sessionKey}`);

    return {
      prependContext: lines.join("\n"),
    };
  });
}
