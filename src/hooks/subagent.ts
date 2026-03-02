/**
 * subagent_spawning / subagent_ended hooks — WorkerManager integration.
 *
 * Tracks worker lifecycle:
 * - On spawn: register active worker, enforce project locks, record run
 * - On end: update task status, record results, trigger post-task actions
 *
 * Replaces: lobs-server/app/orchestrator/worker_manager.py
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { log } from "../util/logger.js";

export function registerSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_spawned", async (event, ctx) => {
    log().info(`worker spawned: session=${event.childSessionKey} agent=${event.agentId}`);
    // Phase 2: Track in worker_runs table, update agent_status
  });

  api.on("subagent_ended", async (event, ctx) => {
    log().info(`worker ended: session=${event.targetSessionKey} reason=${event.reason}`);
    // Phase 2: Complete worker run, update task status, trigger reflection
  });
}
