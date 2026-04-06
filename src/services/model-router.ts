/**
 * Provider Registry & Task-Based Model Router
 *
 * Advisory routing system — picks the best model for a given task category
 * based on approved providers, health status, data policy, and cost constraints.
 *
 * The router does NOT create clients itself. It returns a ModelSelection that
 * callers use with createClient() or raw fetch().
 *
 * Config: ~/.lobs/config/model-router.json
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getLobsRoot } from "../config/lobs.js";
import { log } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskCategory =
  | "agent-loop"
  | "subagent"
  | "memory-processing"
  | "classification"
  | "summarization"
  | "embedding"
  | "background"
  | "benchmark";

export type ApiFormat =
  | "chat-completions"
  | "responses"
  | "anthropic-messages"
  | "embedding";

export type DataPolicy = "no-training" | "may-train" | "unknown";

export type ModelTier = "free" | "cheap" | "standard" | "premium";

export interface ProviderModel {
  id: string;
  displayName: string;
  tier: ModelTier;
  costPer1MInput: number;
  costPer1MOutput: number;
  contextWindow: number;
  /** 0–100 quality score; can be updated by benchmarks */
  quality: number;
  capabilities: string[];
  healthy: boolean;
  /** Timestamp (ms) — if set and in the future, model is temporarily unavailable */
  cooldownUntil?: number;
  failureCount: number;
}

export interface ProviderEntry {
  id: string;
  name: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  authType: "api-key" | "oauth" | "none";
  envKey?: string;
  dataPolicy: DataPolicy;
  models: ProviderModel[];
  enabled: boolean;
  healthy: boolean;
}

export interface RouteRule {
  /** Approved providers in priority order */
  providers: string[];
  allowedTiers: ModelTier[];
  /** Minimum quality score (0–100) */
  minQuality: number;
  /** Max cost per 1M output tokens; 0 = no limit */
  maxCostPer1MOutput: number;
  /** If true, caller should use local only — router returns null */
  localOnly: boolean;
}

export interface RoutingPolicy {
  routes: Record<TaskCategory, RouteRule>;
  global: {
    blockTrainingProviders: boolean;
    sensitiveCategories: TaskCategory[];
    fallbackToLocal: boolean;
  };
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  /** Resolved API key from env, or null */
  apiKey: string | null;
  quality: number;
  costTier: ModelTier;
  dataPolicy: DataPolicy;
}

export interface RouterStatus {
  providers: Array<{
    id: string;
    name: string;
    enabled: boolean;
    healthy: boolean;
    modelCount: number;
    healthyModelCount: number;
  }>;
  policy: RoutingPolicy;
}

/** Minimal interface for future UsageTracker integration */
export interface UsageTracker {
  canSpend(providerId: string, modelId: string): boolean;
  recordUsage(providerId: string, modelId: string, tokens: number, costUsd: number): void;
}

// ---------------------------------------------------------------------------
// Default providers
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDERS: ProviderEntry[] = [
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    apiFormat: "chat-completions",
    baseUrl: "https://opencode.ai/zen",
    authType: "api-key",
    envKey: "OPENCODE_API_KEY",
    dataPolicy: "may-train", // per-model override below; free models train
    enabled: true,
    healthy: true,
    models: [
      {
        id: "minimax-m2.5-free",
        displayName: "MiniMax M2.5 (Free)",
        tier: "free",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 32768,
        quality: 75,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
        // dataPolicy effectively "may-train" (free model)
      },
      {
        id: "minimax-m2.5",
        displayName: "MiniMax M2.5",
        tier: "cheap",
        costPer1MInput: 0.30,
        costPer1MOutput: 1.20,
        contextWindow: 32768,
        quality: 80,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "glm-5",
        displayName: "GLM-5",
        tier: "standard",
        costPer1MInput: 1.00,
        costPer1MOutput: 3.20,
        contextWindow: 32768,
        quality: 82,
        capabilities: ["chat", "code", "reasoning"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "kimi-k2.5",
        displayName: "Kimi K2.5",
        tier: "standard",
        costPer1MInput: 0.60,
        costPer1MOutput: 3.00,
        contextWindow: 131072,
        quality: 85,
        capabilities: ["chat", "code", "reasoning", "tool-use"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "qwen3.6-plus-free",
        displayName: "Qwen 3.6 Plus (Free)",
        tier: "free",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 32768,
        quality: 65,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "mimo-v2-pro-free",
        displayName: "Mimo V2 Pro (Free)",
        tier: "free",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 16384,
        quality: 60,
        capabilities: ["chat"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "nemotron-3-super-free",
        displayName: "Nemotron 3 Super (Free)",
        tier: "free",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 16384,
        quality: 55,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "big-pickle",
        displayName: "Big Pickle (Free)",
        tier: "free",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 16384,
        quality: 50,
        capabilities: ["chat"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "gpt-5-nano",
        displayName: "GPT-5 Nano (Free)",
        tier: "free",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 16384,
        quality: 70,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
    ],
  },

  {
    id: "opencode-go",
    name: "OpenCode Go",
    apiFormat: "chat-completions",
    baseUrl: "https://opencode.ai/zen/go",
    authType: "api-key",
    envKey: "OPENCODE_API_KEY",
    dataPolicy: "no-training",
    enabled: true,
    healthy: true,
    models: [
      {
        id: "glm-5",
        displayName: "GLM-5",
        tier: "cheap",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 32768,
        quality: 82,
        capabilities: ["chat", "code", "reasoning"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "kimi-k2.5",
        displayName: "Kimi K2.5",
        tier: "cheap",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 131072,
        quality: 85,
        capabilities: ["chat", "code", "reasoning", "tool-use"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "mimo-v2-pro",
        displayName: "Mimo V2 Pro",
        tier: "cheap",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 16384,
        quality: 60,
        capabilities: ["chat"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "mimo-v2-omni",
        displayName: "Mimo V2 Omni",
        tier: "cheap",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 16384,
        quality: 55,
        capabilities: ["chat"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "minimax-m2.5",
        displayName: "MiniMax M2.5",
        tier: "cheap",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 32768,
        quality: 80,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "minimax-m2.7",
        displayName: "MiniMax M2.7",
        tier: "cheap",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 32768,
        quality: 82,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
    ],
  },

  {
    id: "z-ai",
    name: "Z.AI (ZhipuAI)",
    apiFormat: "chat-completions",
    baseUrl: "https://open.z.ai/api/paas/v4",
    authType: "api-key",
    envKey: "ZAI_API_KEY",
    dataPolicy: "unknown",
    enabled: true,
    healthy: true,
    models: [
      {
        id: "glm-4.7-flash",
        displayName: "GLM-4.7 Flash (Free)",
        tier: "free",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 16384,
        quality: 60,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "glm-4.5-flash",
        displayName: "GLM-4.5 Flash (Free)",
        tier: "free",
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 16384,
        quality: 55,
        capabilities: ["chat"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "glm-5",
        displayName: "GLM-5",
        tier: "standard",
        costPer1MInput: 1.00,
        costPer1MOutput: 3.20,
        contextWindow: 32768,
        quality: 82,
        capabilities: ["chat", "code", "reasoning"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "glm-4.7",
        displayName: "GLM-4.7",
        tier: "cheap",
        costPer1MInput: 0.60,
        costPer1MOutput: 2.20,
        contextWindow: 32768,
        quality: 72,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
    ],
  },

  {
    id: "minimax",
    name: "MiniMax",
    apiFormat: "chat-completions",
    baseUrl: "https://api.minimax.chat/v1",
    authType: "api-key",
    envKey: "MINIMAX_API_KEY",
    dataPolicy: "unknown",
    enabled: true,
    healthy: true,
    models: [
      {
        id: "minimax-m2.5",
        displayName: "MiniMax M2.5",
        tier: "cheap",
        costPer1MInput: 0.20,
        costPer1MOutput: 1.00,
        contextWindow: 32768,
        quality: 80,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
    ],
  },

  {
    id: "kimi",
    name: "Kimi (Moonshot AI)",
    apiFormat: "chat-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    authType: "api-key",
    envKey: "KIMI_API_KEY",
    dataPolicy: "unknown",
    enabled: true,
    healthy: true,
    models: [
      {
        id: "kimi-k2.5",
        displayName: "Kimi K2.5",
        tier: "standard",
        costPer1MInput: 0.42,
        costPer1MOutput: 2.20,
        contextWindow: 131072,
        quality: 85,
        capabilities: ["chat", "code", "reasoning", "tool-use"],
        healthy: true,
        failureCount: 0,
      },
    ],
  },

  {
    id: "anthropic",
    name: "Anthropic",
    apiFormat: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    authType: "api-key",
    envKey: "ANTHROPIC_API_KEY",
    dataPolicy: "no-training",
    enabled: true,
    healthy: true,
    models: [
      {
        id: "claude-sonnet-4-20250514",
        displayName: "Claude Sonnet 4",
        tier: "standard",
        costPer1MInput: 3.00,
        costPer1MOutput: 15.00,
        contextWindow: 200000,
        quality: 92,
        capabilities: ["chat", "code", "reasoning", "tool-use"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "claude-haiku-4-20250514",
        displayName: "Claude Haiku 4",
        tier: "cheap",
        costPer1MInput: 0.80,
        costPer1MOutput: 4.00,
        contextWindow: 200000,
        quality: 78,
        capabilities: ["chat", "code", "tool-use"],
        healthy: true,
        failureCount: 0,
      },
    ],
  },

  {
    id: "openai",
    name: "OpenAI",
    apiFormat: "chat-completions",
    baseUrl: "https://api.openai.com/v1",
    authType: "api-key",
    envKey: "OPENAI_API_KEY",
    dataPolicy: "no-training",
    enabled: true,
    healthy: true,
    models: [
      {
        id: "gpt-4.1",
        displayName: "GPT-4.1",
        tier: "standard",
        costPer1MInput: 2.00,
        costPer1MOutput: 8.00,
        contextWindow: 1047576,
        quality: 90,
        capabilities: ["chat", "code", "reasoning", "tool-use"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "gpt-4.1-mini",
        displayName: "GPT-4.1 Mini",
        tier: "cheap",
        costPer1MInput: 0.40,
        costPer1MOutput: 1.60,
        contextWindow: 1047576,
        quality: 80,
        capabilities: ["chat", "code", "tool-use"],
        healthy: true,
        failureCount: 0,
      },
      {
        id: "gpt-4.1-nano",
        displayName: "GPT-4.1 Nano",
        tier: "cheap",
        costPer1MInput: 0.10,
        costPer1MOutput: 0.40,
        contextWindow: 1047576,
        quality: 70,
        capabilities: ["chat", "code"],
        healthy: true,
        failureCount: 0,
      },
    ],
  },

  {
    id: "openai-codex",
    name: "OpenAI Codex",
    apiFormat: "responses",
    baseUrl: "https://api.openai.com/v1",
    authType: "api-key",
    envKey: "OPENAI_CODEX_TOKEN",
    dataPolicy: "no-training",
    enabled: true,
    healthy: true,
    models: [
      {
        id: "codex-mini-latest",
        displayName: "Codex Mini",
        tier: "standard",
        costPer1MInput: 1.50,
        costPer1MOutput: 6.00,
        contextWindow: 200000,
        quality: 88,
        capabilities: ["chat", "code", "reasoning", "tool-use"],
        healthy: true,
        failureCount: 0,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Default routing policy
// ---------------------------------------------------------------------------

const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  routes: {
    "agent-loop": {
      providers: ["anthropic", "openai", "openai-codex"],
      allowedTiers: ["standard", "premium"],
      minQuality: 80,
      maxCostPer1MOutput: 0,
      localOnly: false,
    },
    "subagent": {
      providers: ["anthropic", "openai", "openai-codex", "opencode-zen"],
      allowedTiers: ["standard", "premium"],
      minQuality: 70,
      maxCostPer1MOutput: 0,
      localOnly: false,
    },
    "memory-processing": {
      providers: ["opencode-go", "z-ai", "minimax", "kimi", "opencode-zen"],
      allowedTiers: ["free", "cheap"],
      minQuality: 40,
      maxCostPer1MOutput: 5,
      localOnly: false,
    },
    "classification": {
      providers: ["opencode-go", "z-ai", "opencode-zen", "lmstudio"],
      allowedTiers: ["free", "cheap"],
      minQuality: 20,
      maxCostPer1MOutput: 2,
      localOnly: false,
    },
    "summarization": {
      providers: ["lmstudio"],
      allowedTiers: ["free", "cheap"],
      minQuality: 30,
      maxCostPer1MOutput: 2,
      localOnly: true, // keep local — free and private
    },
    "embedding": {
      providers: ["lmstudio"],
      allowedTiers: ["free"],
      minQuality: 0,
      maxCostPer1MOutput: 0,
      localOnly: true,
    },
    "background": {
      providers: ["opencode-go", "z-ai", "opencode-zen", "minimax", "kimi"],
      allowedTiers: ["free", "cheap"],
      minQuality: 30,
      maxCostPer1MOutput: 3,
      localOnly: false,
    },
    "benchmark": {
      providers: ["opencode-zen", "opencode-go", "z-ai", "minimax", "kimi"],
      allowedTiers: ["free", "cheap", "standard", "premium"],
      minQuality: 0,
      maxCostPer1MOutput: 0,
      localOnly: false,
    },
  },
  global: {
    blockTrainingProviders: false,
    sensitiveCategories: ["summarization", "agent-loop", "memory-processing"],
    fallbackToLocal: true,
  },
};

// ---------------------------------------------------------------------------
// Config file shape
// ---------------------------------------------------------------------------

interface RouterConfig {
  policy?: Partial<RoutingPolicy>;
  providers?: Record<string, Partial<Pick<ProviderEntry, "enabled" | "healthy">>>;
  modelOverrides?: Record<string, Partial<Pick<ProviderModel, "quality" | "healthy">>>;
}

const CONFIG_PATH = join(getLobsRoot(), "config", "model-router.json");

function loadConfig(): RouterConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as RouterConfig;
  } catch (err) {
    log().warn(`[model-router] Failed to parse config at ${CONFIG_PATH}: ${String(err)}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// ModelRouter
// ---------------------------------------------------------------------------

export class ModelRouter {
  private providers: Map<string, ProviderEntry>;
  private policy: RoutingPolicy;
  // Reserved for future usage-based budget enforcement
  private usageTracker: UsageTracker | null = null;

  constructor() {
    this.providers = new Map();
    this.policy = DEFAULT_ROUTING_POLICY;
    this._init();
  }

  private _init(): void {
    // Seed with defaults
    for (const p of DEFAULT_PROVIDERS) {
      this.providers.set(p.id, structuredClone(p));
    }

    // Merge config file overrides
    const cfg = loadConfig();

    if (cfg.policy) {
      this.policy = this._mergePolicy(DEFAULT_ROUTING_POLICY, cfg.policy);
    }

    if (cfg.providers) {
      for (const [id, overrides] of Object.entries(cfg.providers)) {
        const entry = this.providers.get(id);
        if (entry) {
          Object.assign(entry, overrides);
        }
        // Unknown provider IDs in config are silently ignored
      }
    }

    if (cfg.modelOverrides) {
      for (const [modelId, overrides] of Object.entries(cfg.modelOverrides)) {
        for (const provider of this.providers.values()) {
          const model = provider.models.find((m) => m.id === modelId);
          if (model) {
            Object.assign(model, overrides);
          }
        }
      }
    }
  }

  private _mergePolicy(base: RoutingPolicy, override: Partial<RoutingPolicy>): RoutingPolicy {
    return {
      routes: { ...base.routes, ...(override.routes ?? {}) },
      global: { ...base.global, ...(override.global ?? {}) },
    };
  }

  /**
   * Attach a usage tracker (optional — enables budget enforcement).
   */
  setUsageTracker(tracker: UsageTracker): void {
    this.usageTracker = tracker;
  }

  /**
   * Core method: pick the best model for a task category.
   * Returns null if nothing available (caller should fall back to local).
   */
  selectModel(
    category: TaskCategory,
    opts: {
      preferProvider?: string;
      excludeProviders?: string[];
      minQuality?: number;
      sensitiveData?: boolean;
    } = {}
  ): ModelSelection | null {
    const rule = this.policy.routes[category];

    // If route is local-only, signal caller to use local
    if (rule.localOnly) {
      return null;
    }

    const { preferProvider, excludeProviders = [], minQuality, sensitiveData } = opts;

    // Determine whether to block training providers
    const blockTraining =
      sensitiveData === true ||
      (this.policy.global.blockTrainingProviders &&
        this.policy.global.sensitiveCategories.includes(category));

    // Effective minimum quality
    const effectiveMinQuality = minQuality !== undefined ? minQuality : rule.minQuality;

    // Build candidate list: { provider, model, priorityIndex }
    interface Candidate {
      provider: ProviderEntry;
      model: ProviderModel;
      priorityIndex: number; // lower = higher priority in route list
    }

    const candidates: Candidate[] = [];
    const now = Date.now();

    for (let i = 0; i < rule.providers.length; i++) {
      const providerId = rule.providers[i];

      // Skip if explicitly excluded
      if (excludeProviders.includes(providerId)) continue;

      const provider = this.providers.get(providerId);
      if (!provider) continue;
      if (!provider.enabled) continue;
      if (!provider.healthy) continue;

      // Block training providers if required
      if (blockTraining && provider.dataPolicy === "may-train") continue;

      for (const model of provider.models) {
        if (!model.healthy) continue;

        // Check cooldown
        if (model.cooldownUntil !== undefined && model.cooldownUntil > now) continue;

        // Check tier
        if (!rule.allowedTiers.includes(model.tier)) continue;

        // Check quality
        if (model.quality < effectiveMinQuality) continue;

        // Check cost (0 = no limit)
        if (rule.maxCostPer1MOutput > 0 && model.costPer1MOutput > rule.maxCostPer1MOutput) continue;

        // Check usage budget if tracker is attached
        if (this.usageTracker && !this.usageTracker.canSpend(provider.id, model.id)) continue;

        candidates.push({ provider, model, priorityIndex: i });
      }
    }

    if (candidates.length === 0) return null;

    // Sort: preferred provider first, then quality desc, then cost asc, then priority order
    candidates.sort((a, b) => {
      // Preferred provider gets bumped to front
      const aPreferred = preferProvider && a.provider.id === preferProvider ? 0 : 1;
      const bPreferred = preferProvider && b.provider.id === preferProvider ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;

      // Quality descending
      if (b.model.quality !== a.model.quality) return b.model.quality - a.model.quality;

      // Cost ascending
      if (a.model.costPer1MOutput !== b.model.costPer1MOutput) {
        return a.model.costPer1MOutput - b.model.costPer1MOutput;
      }

      // Provider priority order (lower index = higher priority)
      return a.priorityIndex - b.priorityIndex;
    });

    const best = candidates[0];
    const apiKey = this._resolveApiKey(best.provider);

    return {
      providerId: best.provider.id,
      modelId: best.model.id,
      baseUrl: best.provider.baseUrl,
      apiFormat: best.provider.apiFormat as "chat-completions" | "responses" | "anthropic-messages",
      apiKey,
      quality: best.model.quality,
      costTier: best.model.tier,
      dataPolicy: best.provider.dataPolicy,
    };
  }

  /**
   * Report a successful call — resets failure count and updates health.
   */
  reportSuccess(providerId: string, modelId: string, latencyMs: number): void {
    const provider = this.providers.get(providerId);
    if (!provider) return;

    const model = provider.models.find((m) => m.id === modelId);
    if (!model) return;

    model.failureCount = 0;
    model.healthy = true;
    model.cooldownUntil = undefined;

    log().debug?.(
      `[model-router] success: ${providerId}/${modelId} latency=${latencyMs}ms`
    );
  }

  /**
   * Report a failed call — increments failure count, applies cooldown after threshold.
   */
  reportFailure(providerId: string, modelId: string, error: string): void {
    const provider = this.providers.get(providerId);
    if (!provider) return;

    const model = provider.models.find((m) => m.id === modelId);
    if (!model) return;

    model.failureCount += 1;

    // After 3 consecutive failures, apply 5-minute cooldown
    if (model.failureCount >= 3) {
      model.cooldownUntil = Date.now() + 5 * 60 * 1000;
      log().warn(
        `[model-router] ${providerId}/${modelId} hit ${model.failureCount} failures — cooling down for 5m. Error: ${error}`
      );
    } else {
      log().warn(
        `[model-router] ${providerId}/${modelId} failure #${model.failureCount}: ${error}`
      );
    }
  }

  /**
   * Get full router status for CLI display.
   */
  getStatus(): RouterStatus {
    const providers = Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      healthy: p.healthy,
      modelCount: p.models.length,
      healthyModelCount: p.models.filter(
        (m) => m.healthy && (m.cooldownUntil === undefined || m.cooldownUntil <= Date.now())
      ).length,
    }));

    return { providers, policy: this.policy };
  }

  /**
   * Reload config from disk and re-apply overrides.
   */
  reload(): void {
    // Reset to defaults
    this.providers = new Map();
    this.policy = DEFAULT_ROUTING_POLICY;
    this._init();
    log().info("[model-router] Config reloaded");
  }

  private _resolveApiKey(provider: ProviderEntry): string | null {
    if (provider.authType === "none") return null;
    if (provider.envKey) {
      const val = process.env[provider.envKey];
      if (val) return val;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _router: ModelRouter | null = null;

export function getModelRouter(): ModelRouter {
  if (!_router) {
    _router = new ModelRouter();
  }
  return _router;
}

export function resetModelRouter(): void {
  _router = null;
}
