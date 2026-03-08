/**
 * Model chooser — tier-based model selection with per-agent fallback chains.
 *
 * Tiers: micro → small → medium → standard → strong
 * Respects OpenClaw agent config model assignments.
 * Falls back to tier-based cloud defaults when no agent config exists.
 */

import { readFileSync } from "node:fs";
import { log } from "../util/logger.js";

export type ModelTier = "micro" | "small" | "medium" | "standard" | "strong";

// ── Tier-based model chains (fallbacks when agent config doesn't specify) ─────

export const TIER_MODELS: Record<ModelTier, string[]> = {
  micro: [
    // Local-first would be ideal but qwen never makes tool calls (10+ stalls today).
    // Use Claude Haiku as reliable micro-tier fallback.
    "anthropic/claude-haiku-4-5",
  ],
  small: [
    "anthropic/claude-sonnet-4-6",
  ],
  medium: [
    "anthropic/claude-sonnet-4-6",
  ],
  standard: [
    // Default for most work
    "anthropic/claude-sonnet-4-6",
  ],
  strong: [
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-4-6",
  ],
};

/**
 * Per-agent-type fallback chains for circuit-breaker routing.
 *
 * Ordered from cheapest/preferred → more capable/expensive.
 * When the preferred model is OPEN (circuit breaker), the next entry is tried.
 *
 * Used by chooseHealthyModel() in model-health.ts as the authoritative
 * fallback order. The within-tier TIER_MODELS fallbacks are only used when no
 * agent-type chain is defined here.
 */
export const AGENT_FALLBACK_CHAINS: Record<string, string[]> = {
  programmer: [
    "anthropic/claude-sonnet-4-6",         // tier: standard — preferred
    "anthropic/claude-haiku-4-5",           // tier: micro — fast fallback
  ],
  architect: [
    "anthropic/claude-opus-4-6",           // tier: strong — best for design
    "anthropic/claude-sonnet-4-6",         // tier: standard — final fallback
  ],
  reviewer: [
    "anthropic/claude-sonnet-4-6",         // tier: standard — preferred
    "anthropic/claude-opus-4-6",           // tier: strong — final fallback
  ],
  researcher: [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
  ],
  writer: [
    "anthropic/claude-sonnet-4-6",        // tier: small — preferred
    "anthropic/claude-opus-4-6",
  ],
  "inbox-responder": [
    "anthropic/claude-haiku-4-5",         // tier: micro — cheapest cloud
    "anthropic/claude-sonnet-4-6",
  ],
};

/** Per-agent-type default tier. */
const AGENT_TIER_DEFAULTS: Record<string, ModelTier> = {
  programmer: "standard",
  researcher: "standard",
  writer: "small",
  architect: "strong",
  reviewer: "medium",
  "inbox-responder": "micro",
};

// ── OpenClaw agent config cache ───────────────────────────────────────────────

interface AgentModelConfig {
  primary: string;
  fallbacks: string[];
}

let agentModelCache: Record<string, AgentModelConfig> | null = null;

function loadAgentModels(): Record<string, AgentModelConfig> {
  if (agentModelCache) return agentModelCache;
  try {
    const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const agents = cfg?.agents?.list ?? [];
    const result: Record<string, AgentModelConfig> = {};
    for (const agent of agents) {
      const id = agent.id as string;
      const modelCfg = agent.model;
      const primary = typeof modelCfg === "string" ? modelCfg : modelCfg?.primary;
      const fallbacks: string[] = Array.isArray(modelCfg?.fallbacks) ? modelCfg.fallbacks : [];
      if (id && primary) {
        result[id] = { primary, fallbacks };
      }
    }
    agentModelCache = result;
    log().info(`[MODEL_CHOOSER] Loaded agent models: ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    log().warn(`[MODEL_CHOOSER] Could not load agent models: ${e}`);
    return {};
  }
}

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
 * 1. OpenClaw agent config (agents.list[agentType].model.primary)
 * 2. Tier-based fallback chain
 */
function isCodexModel(model: string): boolean {
  return model.startsWith("openai-codex/");
}

function stripCodex(models: string[]): string[] {
  return models.filter(m => !isCodexModel(m));
}

export function chooseModel(
  tier?: ModelTier | string,
  agentType?: string,
): ModelChoice {
  const effectiveTier = resolveTier(tier, agentType);

  // For micro tier, prefer local models (skip agent config)
  if (agentType && effectiveTier !== "micro") {
    const agentModels = loadAgentModels();
    const configEntry = agentModels[agentType];
    if (configEntry) {
      // Safety: never pick Codex from config (and don't let it into fallbacks).
      if (isCodexModel(configEntry.primary)) {
        log().warn(`[MODEL_CHOOSER] ${agentType} agent-config primary is Codex (${configEntry.primary}); ignoring and using tier-default.`);
      } else {
        log().debug?.(`[MODEL_CHOOSER] ${agentType} → agent-config: ${configEntry.primary}`);
        return { model: configEntry.primary, tier: effectiveTier, source: "agent-config" };
      }
    }
  }

  // Fall back to tier-based selection
  const candidates = stripCodex(TIER_MODELS[effectiveTier] ?? TIER_MODELS.standard);
  const model = candidates[0];
  log().debug?.(`[MODEL_CHOOSER] ${agentType ?? "?"} → tier=${effectiveTier} model=${model}`);
  return { model, tier: effectiveTier, source: "tier-default" };
}

/**
 * Build the full fallback chain for a given model + agent type.
 *
 * Priority order for chain construction:
 * 1. Agent config (openclaw.json): [primary, ...fallbacks]
 *    — preferred model is already first; fallbacks from config follow.
 * 2. Hardcoded AGENT_FALLBACK_CHAINS[agentType] (cross-tier defaults).
 * 3. Tier-level TIER_MODELS fallbacks.
 *
 * The result is the ordered list of models to attempt for health-aware dispatch.
 * chooseHealthyModel() will walk this list and skip any with open circuits.
 */
export function buildFallbackChain(
  preferredModel: string,
  tier: ModelTier,
  agentType?: string,
): string[] {
  // Never allow Codex into PAW dispatch chains.
  if (isCodexModel(preferredModel)) {
    const tierModels = stripCodex(TIER_MODELS[tier] ?? TIER_MODELS.standard);
    preferredModel = tierModels[0] ?? "anthropic/claude-sonnet-4-6";
  }
  // 1. Use openclaw.json agent config fallbacks if available
  if (agentType) {
    const agentModels = loadAgentModels();
    const configEntry = agentModels[agentType];
    if (configEntry && configEntry.fallbacks.length > 0) {
      // Build chain: preferred model first, then config fallbacks (deduped)
      const rest = stripCodex(configEntry.fallbacks).filter(m => m !== preferredModel);
      const chain = stripCodex([preferredModel, ...rest]);
      log().debug?.(`[MODEL_CHOOSER] ${agentType} fallback chain (from config): ${chain.join(" → ")}`);
      return chain;
    }
  }

  // 2. Hardcoded per-agent fallback chains (cross-tier defaults)
  if (agentType && AGENT_FALLBACK_CHAINS[agentType]) {
    const chain = stripCodex(AGENT_FALLBACK_CHAINS[agentType]);
    // If preferred model matches chain head, use chain as-is
    if (chain[0] === preferredModel) return chain;
    // Move preferred model to front; keep rest of chain
    const rest = chain.filter(m => m !== preferredModel);
    return [preferredModel, ...rest];
  }

  // 3. No agent-specific chain — use tier fallbacks
  const tierModels = stripCodex(TIER_MODELS[tier] ?? TIER_MODELS.standard);
  const tierFallbacks = tierModels.filter(m => m !== preferredModel);
  return stripCodex([preferredModel, ...tierFallbacks]);
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

/** Invalidate the agent model cache (e.g., after config change). */
export function invalidateModelCache(): void {
  agentModelCache = null;
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

/**
 * Choose the healthiest model for a given tier + agent type, skipping any
 * open-circuit breaker models.
 *
 * @param tier        Agent model tier
 * @param agentType   Agent role (e.g., "programmer")
 * @param taskType    Task type for per-bucket tracking (defaults to agentType)
 * @returns           Model string, or null if all are open (caller should fall back)
 */
export function chooseHealthyModelForAgent(
  tier: ModelTier | string | undefined,
  agentType: string | undefined,
  taskType?: string,
): string | null {
  const choice = chooseModel(tier as ModelTier | undefined, agentType);
  const chain = buildFallbackChain(choice.model, choice.tier, agentType);
  return _cbChooseHealthy(chain, taskType ?? agentType ?? "__global__");
}

// Re-export for callers that already have a chain built
export { _cbChooseHealthy as chooseHealthyModel };
