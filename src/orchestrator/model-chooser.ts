/**
 * Model chooser — tier-based model selection with per-agent fallback chains.
 * Port of lobs-server/app/orchestrator/model_chooser.py (simplified).
 *
 * Tiers: micro → small → medium → standard → strong
 * Local models (Ollama/LM Studio) discovered dynamically when available.
 */

import { log } from "../util/logger.js";

// ── Model tier definitions ────────────────────────────────────────────────────

export type ModelTier = "micro" | "small" | "medium" | "standard" | "strong";

/**
 * Cloud model chains per tier (ordered by preference).
 * These are OpenRouter-compatible model IDs.
 */
const CLOUD_MODELS: Record<ModelTier, string[]> = {
  micro: [
    "anthropic/claude-haiku-4-5",
    "google/gemini-flash-1.5",
    "openai/gpt-4o-mini",
  ],
  small: [
    "anthropic/claude-sonnet-4-5",
    "google/gemini-pro-1.5",
    "openai/gpt-4o",
  ],
  medium: [
    "anthropic/claude-sonnet-4-5",
    "google/gemini-pro-1.5",
    "openai/gpt-4o",
  ],
  standard: [
    "anthropic/claude-opus-4-5",
    "openai/gpt-4o",
    "google/gemini-pro-1.5",
  ],
  strong: [
    "anthropic/claude-opus-4-5",
    "openai/o1",
    "google/gemini-ultra",
  ],
};

/** Per-agent-type default tier override. */
const AGENT_TIER_DEFAULTS: Record<string, ModelTier> = {
  programmer: "standard",
  researcher: "standard",
  writer: "small",
  architect: "strong",
  reviewer: "medium",
  "inbox-responder": "medium",
  lobs: "standard",
};

// ── Main chooser ──────────────────────────────────────────────────────────────

export interface ModelChoice {
  model: string;
  tier: ModelTier;
  provider: "cloud" | "local";
}

/**
 * Choose the best available model for a given tier and agent type.
 *
 * @param tier Requested tier (default: "standard")
 * @param agentType Optional agent type for per-agent defaults
 * @returns Chosen model ID
 */
export function chooseModel(
  tier?: ModelTier | string,
  agentType?: string,
): ModelChoice {
  // Resolve effective tier
  let effectiveTier: ModelTier;
  if (tier && isValidTier(tier)) {
    effectiveTier = tier as ModelTier;
  } else if (agentType && agentType in AGENT_TIER_DEFAULTS) {
    effectiveTier = AGENT_TIER_DEFAULTS[agentType];
  } else {
    effectiveTier = "standard";
  }

  const candidates = CLOUD_MODELS[effectiveTier] ?? CLOUD_MODELS.standard;
  const model = candidates[0];

  log().debug?.(`[MODEL_CHOOSER] ${agentType ?? "?"} → tier=${effectiveTier} model=${model}`);
  return { model, tier: effectiveTier, provider: "cloud" };
}

/**
 * Resolve model tier from task metadata.
 * task.model_tier → agent default → "standard"
 */
export function resolveTaskTier(task: Record<string, unknown>): ModelTier {
  const rawTier = task["model_tier"] as string | undefined;
  if (rawTier && isValidTier(rawTier)) return rawTier as ModelTier;

  const agentType = task["agent"] as string | undefined;
  if (agentType && agentType in AGENT_TIER_DEFAULTS) {
    return AGENT_TIER_DEFAULTS[agentType];
  }

  return "standard";
}

/**
 * Get escalation model — next tier up from current.
 * Used when a task needs to be retried with a stronger model.
 */
export function escalationModel(
  currentTier: ModelTier,
  agentType?: string,
): ModelChoice {
  const tierOrder: ModelTier[] = ["micro", "small", "medium", "standard", "strong"];
  const currentIdx = tierOrder.indexOf(currentTier);
  const nextTier = tierOrder[Math.min(currentIdx + 1, tierOrder.length - 1)];
  return chooseModel(nextTier, agentType);
}

function isValidTier(tier: string): boolean {
  return ["micro", "small", "medium", "standard", "strong"].includes(tier);
}

/**
 * Resolve a specific model for a given tier and agent type.
 * Returns the first model in the tier list, or null if none available.
 * Used by the model resolve hook.
 */
export function resolveModelForTier(tier: ModelTier, agentType?: string): string | null {
  const { model } = chooseModel(tier, agentType);
  return model ?? null;
}
