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
    "lmstudio/qwen/qwen3.5-35b-a3b",
    "anthropic/claude-haiku-4-5",
  ],
  small: [
    "anthropic/claude-sonnet-4-6",
    "openai-codex/gpt-5.3-codex",
  ],
  medium: [
    "anthropic/claude-sonnet-4-6",
    "openai-codex/gpt-5.3-codex",
  ],
  standard: [
    "openai-codex/gpt-5.3-codex",
    "anthropic/claude-sonnet-4-6",
  ],
  strong: [
    "anthropic/claude-opus-4-6",
    "openai-codex/gpt-5.3-codex",
  ],
};

/**
 * Per-agent-type fallback chains for circuit-breaker routing.
 *
 * Ordered from cheapest/preferred → more capable/expensive.
 * When the preferred model is OPEN (circuit breaker), the next entry is tried.
 * These chains intentionally cross tier boundaries — e.g., a programmer task
 * prefers local qwen (cheap/micro) but escalates to codex or claude when OPEN.
 *
 * Used by chooseHealthyModel() in model-health.ts as the authoritative
 * fallback order. The within-tier TIER_MODELS fallbacks are only used when no
 * agent-type chain is defined here.
 */
export const AGENT_FALLBACK_CHAINS: Record<string, string[]> = {
  programmer: [
    "lmstudio/qwen/qwen3.5-35b-a3b",    // tier: micro — local, cheap
    "openai-codex/gpt-5.3-codex",         // tier: standard — cloud fallback
    "anthropic/claude-sonnet-4-6",         // tier: standard — final fallback
  ],
  architect: [
    "anthropic/claude-opus-4-6",           // tier: strong — best for design
    "openai-codex/gpt-5.3-codex",          // tier: standard — fallback
    "anthropic/claude-sonnet-4-6",         // tier: standard — final fallback
  ],
  reviewer: [
    "openai-codex/gpt-5.3-codex",         // tier: standard — preferred
    "anthropic/claude-sonnet-4-6",         // tier: standard — fallback
    "anthropic/claude-opus-4-6",           // tier: strong — final fallback
  ],
  researcher: [
    "openai-codex/gpt-5.3-codex",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
  ],
  writer: [
    "anthropic/claude-sonnet-4-6",        // tier: small — preferred
    "openai-codex/gpt-5.3-codex",
    "anthropic/claude-opus-4-6",
  ],
  "inbox-responder": [
    "lmstudio/qwen/qwen3.5-35b-a3b",     // tier: micro — cheapest
    "anthropic/claude-haiku-4-5",
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

let agentModelCache: Record<string, string> | null = null;

function loadAgentModels(): Record<string, string> {
  if (agentModelCache) return agentModelCache;
  try {
    const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const agents = cfg?.agents?.list ?? [];
    const result: Record<string, string> = {};
    for (const agent of agents) {
      const id = agent.id as string;
      const model = typeof agent.model === "string"
        ? agent.model
        : agent.model?.primary;
      if (id && model) {
        result[id] = model;
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
export function chooseModel(
  tier?: ModelTier | string,
  agentType?: string,
): ModelChoice {
  const effectiveTier = resolveTier(tier, agentType);

  // For micro tier, prefer local models (skip agent config)
  if (agentType && effectiveTier !== "micro") {
    const agentModels = loadAgentModels();
    const configModel = agentModels[agentType];
    if (configModel) {
      log().debug?.(`[MODEL_CHOOSER] ${agentType} → agent-config: ${configModel}`);
      return { model: configModel, tier: effectiveTier, source: "agent-config" };
    }
  }

  // Fall back to tier-based selection
  const candidates = TIER_MODELS[effectiveTier] ?? TIER_MODELS.standard;
  const model = candidates[0];
  log().debug?.(`[MODEL_CHOOSER] ${agentType ?? "?"} → tier=${effectiveTier} model=${model}`);
  return { model, tier: effectiveTier, source: "tier-default" };
}

/**
 * Build the full fallback chain for a given model + agent type.
 *
 * Strategy:
 * 1. Use AGENT_FALLBACK_CHAINS[agentType] if defined (cross-tier, ordered by preference).
 *    - If preferred model is already first in chain, return as-is.
 *    - If preferred model is elsewhere in chain, move it to front.
 *    - If preferred model is not in chain at all, prepend it.
 * 2. Fall back to [preferredModel, ...TIER_MODELS[tier]] if no agent chain.
 *
 * The result is the ordered list of models to attempt for health-aware dispatch.
 */
export function buildFallbackChain(
  preferredModel: string,
  tier: ModelTier,
  agentType?: string,
): string[] {
  if (agentType && AGENT_FALLBACK_CHAINS[agentType]) {
    const chain = AGENT_FALLBACK_CHAINS[agentType];
    // If preferred model matches chain head, use chain as-is
    if (chain[0] === preferredModel) return chain;
    // Move preferred model to front; keep rest of chain
    const rest = chain.filter(m => m !== preferredModel);
    return [preferredModel, ...rest];
  }
  // No agent-specific chain — use tier fallbacks
  const tierModels = TIER_MODELS[tier] ?? TIER_MODELS.standard;
  const tierFallbacks = tierModels.filter(m => m !== preferredModel);
  return [preferredModel, ...tierFallbacks];
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

import { chooseHealthyModel as _chooseHealthyModel, buildFallbackChain as _chainHelper } from "../services/circuit-breaker.js";

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
  return _chooseHealthyModel(chain, taskType ?? agentType ?? "__global__");
}

// Re-export the low-level helper for callers that already have a chain
export { _chooseHealthyModel as chooseHealthyModel };
