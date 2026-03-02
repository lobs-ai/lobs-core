/**
 * before_prompt_build hook — Prompter integration.
 *
 * Injects into agent context:
 * - Task-specific instructions
 * - Learning context (past successes/failures)
 * - Project context
 *
 * Replaces: lobs-server/app/orchestrator/prompter.py
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { log } from "../util/logger.js";

export function registerPromptBuildHook(api: OpenClawPluginApi): void {
  api.on("before_prompt_build", async (event, ctx) => {
    // Phase 4: inject task context and learning into prompts
    log().debug?.(`prompt-build: session=${ctx.sessionKey}`);
    return {};
  });
}
