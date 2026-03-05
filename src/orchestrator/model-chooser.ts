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
