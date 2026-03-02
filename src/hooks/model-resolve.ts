/**
 * before_model_resolve hook — ModelChooser integration.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveModelForTier, type ModelTier } from "../orchestrator/model-chooser.js";
import { log } from "../util/logger.js";

const sessionTierMap = new Map<string, { tier: ModelTier; agentType: string }>();

export function setSessionModelTier(sessionKey: string, tier: ModelTier, agentType: string): void {
  sessionTierMap.set(sessionKey, { tier, agentType });
}

export function clearSessionModelTier(sessionKey: string): void {
  sessionTierMap.delete(sessionKey);
}

export function registerModelResolveHook(api: OpenClawPluginApi): void {
  api.on("before_model_resolve", async (_event: unknown, ctx: unknown): Promise<Record<string, unknown>> => {
    const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
    if (!sessionKey) return {};

    const mapping = sessionTierMap.get(sessionKey);
    if (!mapping) return {};

    const resolved = resolveModelForTier(mapping.tier, mapping.agentType);
    if (resolved) {
      log().info(`[PAW] Model resolved: tier=${mapping.tier} agent=${mapping.agentType} → ${resolved}`);
      return { modelOverride: resolved };
    }
    return {};
  });
}
