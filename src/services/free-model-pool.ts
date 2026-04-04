/**
 * Free model pool — manages rotation through free cloud models (OpenCode Zen, etc.)
 *
 * Automatically rotates through available free models with escalating cooldowns
 * on failure. Falls back to null so callers can degrade gracefully to local models.
 *
 * Design:
 * - Round-robin through healthy models sorted by priority
 * - Escalating cooldowns: 30s → 2min → 10min → 1hr
 * - All-down returns null (caller falls back to local)
 * - Singleton instance shared across all workers
 */

import { log } from "../util/logger.js";
import { getModelConfig } from "../config/models.js";
import { getKeyPool } from "./key-pool.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FreeModel {
  id: string;           // e.g. "qwen3.6-plus-free"
  provider: string;     // e.g. "opencode"
  baseUrl: string;      // e.g. "https://opencode.ai/zen/v1"
  priority: number;     // lower = preferred
  healthy: boolean;
  lastFailure?: number; // timestamp ms
  failureCount: number;
  cooldownUntil?: number; // timestamp ms
}

export interface FreeModelHealthSummary {
  total: number;
  healthy: number;
  cooledDown: number;
  models: Array<{
    id: string;
    healthy: boolean;
    failureCount: number;
    cooldownUntil?: number;
    cooldownRemainingMs?: number;
  }>;
}

// ── Cooldown ladder (escalating) ─────────────────────────────────────────────

const COOLDOWN_LADDER_MS = [
  30_000,           // 1st failure: 30s
  2 * 60_000,       // 2nd failure: 2min
  10 * 60_000,      // 3rd failure: 10min
  60 * 60_000,      // 4th+ failure: 1hr
];

function getCooldownMs(failureCount: number): number {
  const idx = Math.min(failureCount - 1, COOLDOWN_LADDER_MS.length - 1);
  return COOLDOWN_LADDER_MS[Math.max(0, idx)];
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_FREE_MODELS: Array<{ id: string; provider: string; baseUrl: string; priority: number }> = [
  { id: "qwen3.6-plus-free",    provider: "opencode", baseUrl: "https://opencode.ai/zen/v1", priority: 1 },
  { id: "minimax-m2.5-free",    provider: "opencode", baseUrl: "https://opencode.ai/zen/v1", priority: 2 },
  { id: "nemotron-3-super-free",provider: "opencode", baseUrl: "https://opencode.ai/zen/v1", priority: 3 },
  { id: "mimo-v2-pro-free",     provider: "opencode", baseUrl: "https://opencode.ai/zen/v1", priority: 4 },
  { id: "big-pickle",           provider: "opencode", baseUrl: "https://opencode.ai/zen/v1", priority: 5 },
  { id: "gpt-5-nano",           provider: "opencode", baseUrl: "https://opencode.ai/zen/v1", priority: 6 },
];

// ── API Key Resolution ───────────────────────────────────────────────────────

/**
 * Resolve OpenCode API key in priority order:
 * 1. getModelConfig().free?.apiKey
 * 2. process.env.OPENCODE_API_KEY
 * 3. Key pool ("opencode")
 */
export function getOpenCodeApiKey(): string | null {
  // 1. Config file
  const cfg = getModelConfig();
  if (cfg.free?.apiKey) return cfg.free.apiKey;

  // 2. Environment variable
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;

  // 3. Key pool
  try {
    const keyPool = getKeyPool();
    if (keyPool.hasKeys("opencode" as never)) {
      const auth = keyPool.getAuth("opencode" as never, "__free_pool__");
      if (auth?.apiKey) return auth.apiKey;
    }
  } catch {
    // key pool may not support opencode — that's fine
  }

  return null;
}

// ── FreeModelPool ────────────────────────────────────────────────────────────

class FreeModelPool {
  private models: FreeModel[];
  private currentIndex: number = 0;

  constructor() {
    this.models = this.loadModels();
  }

  private loadModels(): FreeModel[] {
    const cfg = getModelConfig();
    const configModels = cfg.free?.models ?? DEFAULT_FREE_MODELS;

    return configModels
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map(m => ({
        id: m.id,
        provider: m.provider,
        baseUrl: m.baseUrl,
        priority: m.priority,
        healthy: true,
        failureCount: 0,
      }));
  }

  /**
   * Returns the best available healthy model using round-robin among
   * equally-prioritized healthy models. Automatically un-cools models
   * whose cooldownUntil is in the past.
   *
   * Returns null if ALL models are currently cooled down / unavailable.
   */
  getNextModel(): FreeModel | null {
    const cfg = getModelConfig();
    if (cfg.free?.enabled === false) return null;

    const now = Date.now();

    // Auto-uncool models whose cooldown has expired
    for (const model of this.models) {
      if (!model.healthy && model.cooldownUntil && now >= model.cooldownUntil) {
        model.healthy = true;
        model.cooldownUntil = undefined;
        log().debug?.(`[free-model-pool] Model ${model.id} cooled down, marking healthy again`);
      }
    }

    const healthyModels = this.models.filter(m => m.healthy);
    if (healthyModels.length === 0) return null;

    // Round-robin through the healthy models
    // currentIndex wraps around the full model list; find the next healthy one from that position
    const start = this.currentIndex % this.models.length;
    for (let offset = 0; offset < this.models.length; offset++) {
      const idx = (start + offset) % this.models.length;
      if (this.models[idx].healthy) {
        this.currentIndex = (idx + 1) % this.models.length;
        return this.models[idx];
      }
    }

    return null;
  }

  /**
   * Report a successful call — reset the model's failure count.
   */
  reportSuccess(modelId: string): void {
    const model = this.models.find(m => m.id === modelId);
    if (!model) return;

    if (model.failureCount > 0) {
      log().debug?.(`[free-model-pool] Model ${modelId} recovered after ${model.failureCount} failures`);
    }
    model.healthy = true;
    model.failureCount = 0;
    model.cooldownUntil = undefined;
    model.lastFailure = undefined;
  }

  /**
   * Report a failed call — increment failure count and apply escalating cooldown.
   */
  reportFailure(modelId: string): void {
    const model = this.models.find(m => m.id === modelId);
    if (!model) return;

    model.failureCount += 1;
    model.lastFailure = Date.now();
    const cooldownMs = getCooldownMs(model.failureCount);
    model.cooldownUntil = Date.now() + cooldownMs;
    model.healthy = false;

    log().warn(
      `[free-model-pool] Model ${modelId} failed (count=${model.failureCount}), ` +
      `cooling down for ${cooldownMs / 1000}s`,
    );
  }

  /**
   * Return a snapshot of pool health for diagnostics.
   */
  getHealthSummary(): FreeModelHealthSummary {
    const now = Date.now();
    return {
      total: this.models.length,
      healthy: this.models.filter(m => m.healthy).length,
      cooledDown: this.models.filter(m => !m.healthy).length,
      models: this.models.map(m => ({
        id: m.id,
        healthy: m.healthy,
        failureCount: m.failureCount,
        cooldownUntil: m.cooldownUntil,
        cooldownRemainingMs: m.cooldownUntil ? Math.max(0, m.cooldownUntil - now) : undefined,
      })),
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _pool: FreeModelPool | null = null;

export function getFreeModelPool(): FreeModelPool {
  if (!_pool) {
    _pool = new FreeModelPool();
  }
  return _pool;
}

/** Reset pool (for testing / config reload) */
export function resetFreeModelPool(): void {
  _pool = null;
}
