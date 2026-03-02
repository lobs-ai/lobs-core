/**
 * agent_end hook — post-task actions.
 *
 * When a PAW-managed agent finishes:
 * - Update the workflow run node status (signals workflow engine to advance)
 * - Capture work summary from session history if available
 * - Emit workflow event for downstream processing
 */

import { eq, and, isNull } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workerRuns, workflowEvents } from "../db/schema.js";
import { randomUUID } from "node:crypto";
import { log } from "../util/logger.js";

export function registerAgentEndHook(api: OpenClawPluginApi): void {
  api.on("agent_end", async (event) => {
    const sessionKey = (event as Record<string, unknown>).sessionKey as string | undefined;
    if (!sessionKey) return;

    // Check if this is a PAW-managed worker
    const db = getDb();
    const run = db.select().from(workerRuns)
      .where(and(
        eq(workerRuns.workerId, sessionKey),
        isNull(workerRuns.endedAt),
      ))
      .get();

    if (!run) return;

    const success = (event as Record<string, unknown>).success as boolean;

    log().info(`[PAW] Agent end: session=${sessionKey} success=${success} task=${run.taskId?.slice(0, 8) ?? "none"}`);

    // Emit workflow event so the workflow engine can advance
    db.insert(workflowEvents).values({
      id: randomUUID(),
      eventType: success ? "agent.completed" : "agent.failed",
      payload: JSON.stringify({
        sessionKey,
        taskId: run.taskId,
        agentType: run.agentType,
        success,
      }),
      source: "agent_end_hook",
    }).run();
  });
}
