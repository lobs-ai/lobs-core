/**
 * before_tool_call hook — PolicyEngine / approval tier enforcement.
 *
 * Gates dangerous tool calls based on approval tier:
 * - Tier A (auto): allow immediately
 * - Tier B (lobs): allow but log
 * - Tier C (rafe): block and create inbox item for approval
 *
 * Replaces: lobs-server/app/orchestrator/policy_engine.py
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { log } from "../util/logger.js";

export function registerToolGateHook(api: OpenClawPluginApi): void {
  api.on("before_tool_call", async (event, ctx) => {
    // Phase 4: implement approval tier enforcement
    log().debug?.(`tool-gate: tool=${event.toolName} session=${ctx.sessionKey}`);
    return {};
  });
}
