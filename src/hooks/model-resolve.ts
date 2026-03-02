/**
 * before_model_resolve hook — ModelChooser integration.
 *
 * Intercepts model selection to apply:
 * - Per-agent fallback chains
 * - Model tier resolution (micro/small/medium/standard/strong)
 * - Provider health-aware routing
 *
 * Replaces: lobs-server/app/orchestrator/model_chooser.py
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { log } from "../util/logger.js";

export function registerModelResolveHook(api: OpenClawPluginApi): void {
  api.on("before_model_resolve", async (event, ctx) => {
    // Phase 2: implement tier-based model selection
    // For now, pass through to OpenClaw's default routing
    log().debug?.(`model-resolve: session=${ctx.sessionKey}`);
    return {};
  });
}
