/**
 * Centralized model configuration.
 *
 * ALL model references in lobs-core should read from here.
 * To swap models, change this file — nothing else.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getLobsRoot } from "./lobs.js";

const CONFIG_PATH = resolve(getLobsRoot(), "config/models.json");

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelConfig {
  /** Model tiers — what the orchestrator and spawn_agent use */
  tiers: {
    micro: string;    // Local/free model for simple tasks
    small: string;    // Fast cloud model for lightweight work
    medium: string;   // Balanced cost/quality
    standard: string; // Default for most work
    strong: string;   // Best quality for complex tasks
  };

  /** Per-agent primary model + fallback chain */
  agents: {
    programmer: ModelChain;
    researcher: ModelChain;
    writer: ModelChain;
    reviewer: ModelChain;
    architect: ModelChain;
    suggester: ModelChain;
  };

  /** Local model settings (LM Studio) */
  local: {
    baseUrl: string;
    chatModel: string;      // For classification, general use
    summaryModel?: string;  // For structured JSON extraction (non-thinking preferred)
    embeddingModel: string;  // For vector embeddings
  };


  /** Scheduler intelligence settings */
  scheduler?: {
    enabled?: boolean;
    localOnly?: boolean;
    tier?: "micro" | "small" | "medium" | "standard" | "strong";
    overrideModel?: string | null;
    temperature?: number;
    maxTokens?: number;
  };

  /** Cost per 1M tokens (for cost tracking) */
  costs: Record<string, {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }>;

  /** Voice/realtime models (OpenAI-specific) */
  voice?: {
    realtimeModel: string;       // default: "gpt-4o-realtime-preview"
    transcriptionModel: string;  // default: "gpt-4o-mini-transcribe"
  };

  /** Context window sizes */
  contextLimits: Record<string, number>;

  /** Discord-specific settings */
  discord?: {
    /** Default model tier for all Discord channels (overridden per-channel) */
    defaultTier?: "micro" | "small" | "medium" | "standard" | "strong";
  };
}

export interface ModelChain {
  primary: string;
  fallbacks: string[];
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: ModelConfig = {
  tiers: {
    micro: "lmstudio/qwen3-4b",
    small: "anthropic/claude-haiku-4-5",
    medium: "anthropic/claude-sonnet-4-6",
    standard: "anthropic/claude-sonnet-4-6",
    strong: "anthropic/claude-opus-4-6",
  },

  agents: {
    programmer: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["anthropic/claude-haiku-4-5"] },
    researcher: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["anthropic/claude-opus-4-6"] },
    writer:     { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["anthropic/claude-opus-4-6"] },
    reviewer:   { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["anthropic/claude-opus-4-6"] },
    architect:  { primary: "anthropic/claude-opus-4-6",   fallbacks: ["anthropic/claude-sonnet-4-6"] },
    suggester:  { primary: "anthropic/claude-haiku-4-5",  fallbacks: ["anthropic/claude-sonnet-4-6"] },
  },

  local: {
    baseUrl: "http://localhost:1234/v1",
    chatModel: "qwen/qwen3.5-9b",
    embeddingModel: "text-embedding-qwen3-embedding-4b",
  },

  scheduler: {
    enabled: true,
    localOnly: true,
    tier: "micro",
    overrideModel: null,
    temperature: 0.2,
    maxTokens: 900,
  },

  costs: {
    "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4":   { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-opus-4-6":   { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    "claude-opus-4-5":   { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    "claude-opus-4":     { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    "claude-haiku-4-5":  { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    "gpt-4o":            { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
    "minimax-m2.7":      { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
  },

  voice: {
    realtimeModel: "gpt-4o-realtime-preview",
    transcriptionModel: "gpt-4o-mini-transcribe",
  },

  contextLimits: {
    "claude-sonnet-4-6": 200_000,
    "claude-sonnet-4-5": 200_000,
    "claude-sonnet-4":   200_000,
    "claude-opus-4-6":   200_000,
    "claude-opus-4-5":   200_000,
    "claude-opus-4":     200_000,
    "claude-haiku-4-5":  200_000,
    "gpt-4o":            128_000,
    "qwen":              32_000,
  },
};

// ── Singleton ────────────────────────────────────────────────────────────────

let _config: ModelConfig | null = null;

/**
 * Load model config. Reads from ~/.lobs/config/models.json if it exists,
 * otherwise uses defaults. Config file is merged on top of defaults
 * (so you only need to specify overrides).
 */
export function getModelConfig(): ModelConfig {
  if (_config) return _config;

  _config = { ...DEFAULT_CONFIG };

  if (existsSync(CONFIG_PATH)) {
    try {
      const fileData = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      // Deep merge
      if (fileData.tiers) _config.tiers = { ..._config.tiers, ...fileData.tiers };
      if (fileData.agents) {
        for (const [k, v] of Object.entries(fileData.agents)) {
          (_config.agents as any)[k] = v;
        }
      }
      if (fileData.local) _config.local = { ..._config.local, ...fileData.local };
      if (fileData.voice) _config.voice = { ..._config.voice, ...fileData.voice };
      if (fileData.scheduler) _config.scheduler = { ..._config.scheduler, ...fileData.scheduler };
      if (fileData.costs) _config.costs = { ..._config.costs, ...fileData.costs };
      if (fileData.contextLimits) _config.contextLimits = { ..._config.contextLimits, ...fileData.contextLimits };
    } catch { /* use defaults */ }
  }

  return _config;
}

/**
 * Save current config to disk (for runtime updates).
 */
export function saveModelConfig(config?: ModelConfig): void {
  const toSave = config ?? _config ?? DEFAULT_CONFIG;
  const dir = resolve(getLobsRoot(), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2));
  _config = toSave;
}

/**
 * Reset config cache (forces re-read from disk on next access).
 */
export function resetModelConfig(): void {
  _config = null;
}

// ── Convenience Accessors ────────────────────────────────────────────────────

/** Get model for a tier (micro/small/medium/standard/strong) */
export function getModelForTier(tier: string): string {
  const cfg = getModelConfig();
  return (cfg.tiers as Record<string, string>)[tier] ?? cfg.tiers.standard;
}

/** Get primary model for an agent type */
export function getAgentModel(agentType: string): string {
  const cfg = getModelConfig();
  const chain = (cfg.agents as Record<string, ModelChain>)[agentType];
  return chain?.primary ?? cfg.tiers.standard;
}

/** Get fallback chain, tier-aware.
 *  If modelTier is provided and tierFallbacks exist in config, those take
 *  priority (since the primary model comes from the tier, not the agent). */
export function getAgentFallbacks(agentType: string, modelTier?: string): string[] {
  const cfg = getModelConfig();
  if (modelTier) {
    const tierFb = (cfg as unknown as Record<string, unknown>)["tierFallbacks"] as Record<string, string[]> | undefined;
    if (tierFb?.[modelTier]?.length) {
      return tierFb[modelTier];
    }
  }
  const chain = (cfg.agents as Record<string, ModelChain>)[agentType];
  return chain?.fallbacks ?? [];
}

/** Get cost rates for a model (matches by partial key) */
export function getModelCost(model: string): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  const cfg = getModelConfig();
  for (const [key, rates] of Object.entries(cfg.costs)) {
    if (model.includes(key)) return rates;
  }
  return null;
}

/** Get context limit for a model */
export function getContextLimit(model: string): number {
  const cfg = getModelConfig();
  for (const [key, limit] of Object.entries(cfg.contextLimits)) {
    if (model.includes(key)) return limit;
  }
  return 128_000; // safe default
}

/** Update a single tier mapping and save to disk */
export function setTier(tier: string, model: string): void {
  const cfg = getModelConfig();
  if (!(tier in (cfg.tiers as Record<string, string>))) {
    throw new Error(`Unknown tier: ${tier}. Valid: ${Object.keys(cfg.tiers).join(", ")}`);
  }
  (cfg.tiers as Record<string, string>)[tier] = model;
  saveModelConfig(cfg);
}

/** Get Discord default model tier */
export function getDiscordDefaultTier(): "micro" | "small" | "medium" | "standard" | "strong" | null {
  return getModelConfig().discord?.defaultTier ?? null;
}

/** Set Discord default model tier */
export function setDiscordDefaultTier(tier: "micro" | "small" | "medium" | "standard" | "strong" | null): void {
  const cfg = getModelConfig();
  if (tier === null) {
    delete cfg.discord;
  } else {
    cfg.discord = { defaultTier: tier };
  }
  saveModelConfig(cfg);
}

/** Get voice/realtime model config */
export function getVoiceConfig(): NonNullable<ModelConfig["voice"]> {
  const cfg = getModelConfig();
  return cfg.voice ?? { realtimeModel: "gpt-4o-realtime-preview", transcriptionModel: "gpt-4o-mini-transcribe" };
}

/** Get local model settings (strips lmstudio/ prefix from model IDs) */
export function getLocalConfig(): ModelConfig["local"] {
  const local = getModelConfig().local;
  return {
    ...local,
    // LM Studio API expects bare model IDs — strip the routing prefix
    chatModel: local.chatModel.replace(/^lmstudio\//, ""),
    summaryModel: local.summaryModel?.replace(/^lmstudio\//, ""),
  };
}
