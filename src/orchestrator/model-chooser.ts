/**
 * Model chooser — tier-based model selection with per-agent fallback chains.
 *
 * Tiers: micro → small → medium → standard → strong
 *
 * ALL model knowledge comes from config/models.ts — no hardcoded model strings here.
 * To swap models, update ~/.lobs/config/models.json or the defaults in config/models.ts.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../util/logger.js";
import {
  getModelConfig,
  getModelForTier,
  getAgentModel,
  getAgentFallbacks,
} from "../config/models.js";

export type ModelTier = "micro" | "small" | "medium" | "standard" | "strong";

// ── Tier-based model arrays (built from config) ──────────────────────────────

function buildTierModels(): Record<ModelTier, string[]> {
  const cfg = getModelConfig();
  const tiers = cfg.tiers;
  const result: Record<ModelTier, string[]> = {
    micro: [tiers.micro],
    small: [tiers.small],
    medium: [tiers.medium],
    standard: [tiers.standard],
    strong: [tiers.strong],
  };
  // For strong tier, add standard as fallback if different
  if (tiers.strong !== tiers.standard) {
    result.strong.push(tiers.standard);
  }
  return result;
}

export function getTierModels(): Record<ModelTier, string[]> {
  return buildTierModels();
}

// Legacy export for existing callers — lazily initialized
let _tierModelsCache: Record<ModelTier, string[]> | null = null;
export function TIER_MODELS_getter(): Record<ModelTier, string[]> {
  if (!_tierModelsCache) _tierModelsCache = buildTierModels();
  return _tierModelsCache;
}
// For backwards compat with code that reads TIER_MODELS directly
export const TIER_MODELS: Record<ModelTier, string[]> = new Proxy({} as Record<ModelTier, string[]>, {
  get(_target, prop) {
    return buildTierModels()[prop as ModelTier];
  },
  ownKeys() {
    return ["micro", "small", "medium", "standard", "strong"];
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (["micro", "small", "medium", "standard", "strong"].includes(prop as string)) {
      return { configurable: true, enumerable: true, value: buildTierModels()[prop as ModelTier] };
    }
  },
});

/**
 * Per-agent-type fallback chains — built from config, not hardcoded.
 */
function buildAgentFallbackChains(): Record<string, string[]> {
  const cfg = getModelConfig();
  const result: Record<string, string[]> = {};
  for (const [agentType, chain] of Object.entries(cfg.agents)) {
    result[agentType] = [chain.primary, ...chain.fallbacks];
  }
  return result;
}

export function getAgentFallbackChains(): Record<string, string[]> {
  return buildAgentFallbackChains();
}

// Legacy export
export const AGENT_FALLBACK_CHAINS: Record<string, string[]> = new Proxy({} as Record<string, string[]>, {
  get(_target, prop) {
    return buildAgentFallbackChains()[prop as string];
  },
  ownKeys() {
    return Object.keys(getModelConfig().agents);
  },
  getOwnPropertyDescriptor(_target, prop) {
    const chains = buildAgentFallbackChains();
    if (prop in chains) {
      return { configurable: true, enumerable: true, value: chains[prop as string] };
    }
  },
});

/** Per-agent-type default tier. Costs go down fast with medium vs standard. */
const AGENT_TIER_DEFAULTS: Record<string, ModelTier> = {
  main: "strong",
  programmer: "standard",
  researcher: "medium",
  writer: "small",
  architect: "strong",
  reviewer: "small",
  "inbox-responder": "micro",
  suggester: "micro",
};

// ── Main chooser ──────────────────────────────────────────────────────────────

export interface ModelChoice {
  model: string;
  tier: ModelTier;
  source: "agent-config" | "tier-default";
}

/**
 * Choose the best model for a given tier and agent type.
 *
 * Priority:
 * 1. lobs config (config/models.ts → ~/.lobs/config/models.json) agent entry
 * 2. Tier-based selection from config
 */
export function chooseModel(
  tier?: ModelTier | string,
  agentType?: string,
): ModelChoice {
  const effectiveTier = resolveTier(tier, agentType);
  const cfg = getModelConfig();

  // Check agent-specific config
  if (agentType && effectiveTier !== "micro") {
    const agentCfg = (cfg.agents as Record<string, { primary: string; fallbacks: string[] }>)[agentType];
    if (agentCfg?.primary) {
      log().debug?.(`[MODEL_CHOOSER] ${agentType} → agent-config: ${agentCfg.primary}`);
      return { model: agentCfg.primary, tier: effectiveTier, source: "agent-config" };
    }
  }

  // Fall back to tier-based selection from config
  const model = getModelForTier(effectiveTier);
  log().debug?.(`[MODEL_CHOOSER] ${agentType ?? "?"} → tier=${effectiveTier} model=${model}`);
  return { model, tier: effectiveTier, source: "tier-default" };
}

/**
 * Build the full fallback chain for a given model + agent type.
 */
export function buildFallbackChain(
  preferredModel: string,
  tier: ModelTier,
  agentType?: string,
): string[] {
  // 1. Use lobs config agent fallbacks if available
  if (agentType) {
    const cfg = getModelConfig();
    const agentCfg = (cfg.agents as Record<string, { primary: string; fallbacks: string[] }>)[agentType];
    if (agentCfg?.fallbacks?.length) {
      const rest = agentCfg.fallbacks.filter(m => m !== preferredModel);
      const chain = [preferredModel, ...rest];
      log().debug?.(`[MODEL_CHOOSER] ${agentType} fallback chain: ${chain.join(" → ")}`);
      return [...new Set(chain)];
    }
  }

  // 2. Use tier fallbacks
  const tierModels = buildTierModels();
  const candidates = tierModels[tier] ?? [getModelForTier("medium")];
  const tierFallbacks = candidates.filter(m => m !== preferredModel);
  return [...new Set([preferredModel, ...tierFallbacks])];
}

function resolveTier(tier?: string, agentType?: string): ModelTier {
  if (tier && isValidTier(tier)) return tier as ModelTier;
  if (agentType && agentType in AGENT_TIER_DEFAULTS) return AGENT_TIER_DEFAULTS[agentType];
  return "standard";
}

/**
 * Resolve model tier from task metadata.
 */
export function resolveTaskTier(task: Record<string, unknown>): ModelTier {
  const rawTier = task["model_tier"] as string | undefined;
  if (rawTier && isValidTier(rawTier)) return rawTier as ModelTier;
  const agentType = task["agent"] as string | undefined;
  if (agentType && agentType in AGENT_TIER_DEFAULTS) return AGENT_TIER_DEFAULTS[agentType];
  return "standard";
}

/**
 * Get escalation model — next tier up from current.
 */
export function escalationModel(currentTier: ModelTier, agentType?: string): ModelChoice {
  const tierOrder: ModelTier[] = ["micro", "small", "medium", "standard", "strong"];
  const currentIdx = tierOrder.indexOf(currentTier);
  const nextTier = tierOrder[Math.min(currentIdx + 1, tierOrder.length - 1)];
  return chooseModel(nextTier, agentType);
}

/**
 * Force-select a specific model (e.g., local model for testing).
 */
export function forceModel(model: string, tier: ModelTier = "standard"): ModelChoice {
  return { model, tier, source: "tier-default" };
}

/** Invalidate caches (e.g., after config change). */
export function invalidateModelCache(): void {
  _tierModelsCache = null;
}

function isValidTier(tier: string): boolean {
  return ["micro", "small", "medium", "standard", "strong"].includes(tier);
}

export function resolveModelForTier(tier: ModelTier, agentType?: string): string | null {
  const { model } = chooseModel(tier, agentType);
  return model ?? null;
}

// ── Circuit-breaker-aware model selection ────────────────────────────────────

import { chooseHealthyModel as _cbChooseHealthy } from "../services/circuit-breaker.js";

export function chooseHealthyModelForAgent(
  tier: ModelTier | string | undefined,
  agentType: string | undefined,
  taskType?: string,
): string | null {
  const choice = chooseModel(tier as ModelTier | undefined, agentType);
  const chain = buildFallbackChain(choice.model, choice.tier, agentType);
  return _cbChooseHealthy(chain, taskType ?? agentType ?? "__global__");
}

export { _cbChooseHealthy as chooseHealthyModel };
