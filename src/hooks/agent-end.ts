/**
 * agent_end hook — post-task actions.
 *
 * Triggers after an agent run completes:
 * - Mini-reflection for learning
 * - Task status update
 * - Git commit if applicable
 *
 * Replaces: lobs-server/app/orchestrator/reflection_cycle.py (post-task part)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { log } from "../util/logger.js";

export function registerAgentEndHook(api: OpenClawPluginApi): void {
  api.on("agent_end", async (event, ctx) => {
    log().debug?.(`agent-end: success=${event.success} session=${ctx.sessionKey}`);
    // Phase 4: trigger mini-reflection, update task state
  });
}
