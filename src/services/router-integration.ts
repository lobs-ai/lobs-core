/**
 * router-integration.ts — bridges provider-usage-tracker with model-router.
 *
 * The model-router defines a minimal UsageTracker interface; the actual tracker
 * has a different API. This adapter translates between them and handles the
 * one-time wiring at startup.
 */

import { getModelRouter } from "./model-router.js";
import { getUsageTracker } from "./provider-usage-tracker.js";
import type { UsageTracker as RouterUsageTracker } from "./model-router.js";

/**
 * Bridge between the provider-usage-tracker and the model-router's
 * expected UsageTracker interface.
 */
class UsageTrackerAdapter implements RouterUsageTracker {
  canSpend(providerId: string, _modelId: string): boolean {
    return getUsageTracker().canUse(providerId);
  }

  recordUsage(providerId: string, modelId: string, tokens: number, costUsd: number): void {
    getUsageTracker().record({
      providerId,
      modelId,
      inputTokens: tokens,
      outputTokens: 0,
      cachedTokens: 0,
      estimatedCost: costUsd,
      taskCategory: "unknown",
      latencyMs: 0,
      success: true,
    });
  }
}

let _initialized = false;

/**
 * Call once at startup to wire the usage tracker into the model router.
 */
export function initializeModelRouting(): void {
  if (_initialized) return;
  const router = getModelRouter();
  router.setUsageTracker(new UsageTrackerAdapter());
  _initialized = true;
}
