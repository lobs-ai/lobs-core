/**
 * Provider Health Registry — tracks success/failure/latency per provider.
 * Port of lobs-server/app/orchestrator/provider_health.py
 * All operations are synchronous (better-sqlite3).
 */

import { log } from "../util/logger.js";
import { getDb } from "../db/connection.js";
import { orchestratorSettings } from "../db/schema.js";
import { eq } from "drizzle-orm";

export type ErrorType = "rate_limit" | "auth_error" | "quota_exceeded" | "timeout" | "server_error" | "unknown";

// Cooldown: [initialMs, maxMs, multiplier]
const COOLDOWN_POLICIES: Record<ErrorType, [number, number, number]> = {
  rate_limit:      [60_000,        900_000,   2.0],
  auth_error:      [86_400_000,    86_400_000, 1.0],
  quota_exceeded:  [86_400_000,    86_400_000, 1.0],
  timeout:         [600_000,       3_600_000,  1.5],
  server_error:    [120_000,       1_800_000,  2.0],
  unknown:         [60_000,        600_000,    1.5],
};

const HEALTH_WINDOW = 50;
const PERSIST_KEY = "provider_health.config";
const PERSIST_INTERVAL_MS = 300_000;

interface CooldownState {
  errorType: ErrorType;
  startedAt: number;
  durationMs: number;
  consecutiveFailures: number;
}

interface HealthStats {
  key: string;
  totalAttempts: number;
  successfulAttempts: number;
  recentHistory: boolean[];   // circular, last HEALTH_WINDOW
  cooldowns: Map<ErrorType, CooldownState>;
  disabled: boolean;
  disabledReason: string;
}

function newStats(key: string): HealthStats {
  return { key, totalAttempts: 0, successfulAttempts: 0, recentHistory: [], cooldowns: new Map(), disabled: false, disabledReason: "" };
}

function successRate(stats: HealthStats): number {
  if (!stats.recentHistory.length) return 1.0;
  return stats.recentHistory.filter(Boolean).length / stats.recentHistory.length;
}

function hasActiveCooldown(stats: HealthStats): boolean {
  const now = Date.now();
  for (const cd of stats.cooldowns.values()) {
    if (now < cd.startedAt + cd.durationMs) return true;
  }
  return false;
}

function healthScore(stats: HealthStats): number {
  if (stats.disabled) return 0.0;
  const sr = successRate(stats);
  const now = Date.now();
  let penalty = 0;
  const severities: Record<ErrorType, number> = {
    auth_error: 0.3, quota_exceeded: 0.3, rate_limit: 0.25,
    server_error: 0.2, timeout: 0.15, unknown: 0.1
  };
  for (const [type, cd] of stats.cooldowns) {
    if (now < cd.startedAt + cd.durationMs) penalty = Math.max(penalty, severities[type] ?? 0.1);
  }
  return Math.max(0, Math.min(1, sr * 0.7 + (1 - penalty) * 0.3));
}

function applyCooldown(stats: HealthStats, errorType: ErrorType): void {
  const [initial, max, mult] = COOLDOWN_POLICIES[errorType];
  const now = Date.now();
  if (stats.cooldowns.has(errorType)) {
    const cd = stats.cooldowns.get(errorType)!;
    cd.consecutiveFailures++;
    cd.durationMs = Math.min(cd.durationMs * mult, max);
    cd.startedAt = now;
  } else {
    stats.cooldowns.set(errorType, { errorType, startedAt: now, durationMs: initial, consecutiveFailures: 1 });
  }
}

export class ProviderHealthRegistry {
  private providerHealth = new Map<string, HealthStats>();
  private modelHealth = new Map<string, HealthStats>();
  private disabledProviders = new Set<string>();
  private disabledModels = new Set<string>();
  private lastPersist = 0;

  initialize(): void {
    try {
      const db = getDb();
      const row = db.select().from(orchestratorSettings).where(eq(orchestratorSettings.key, PERSIST_KEY)).get();
      if (row?.value && typeof row.value === "object") {
        const cfg = row.value as Record<string, unknown>;
        this.disabledProviders = new Set((cfg.disabled_providers as string[]) ?? []);
        this.disabledModels = new Set((cfg.disabled_models as string[]) ?? []);
        log().info(`[PROVIDER_HEALTH] Loaded config: ${this.disabledProviders.size} disabled providers`);
      }
    } catch (e) {
      log().warn(`[PROVIDER_HEALTH] Could not load config: ${String(e)}`);
    }
  }

  isAvailable(providerOrModel: string): boolean {
    if (providerOrModel.includes("/")) {
      const provider = providerOrModel.split("/")[0];
      if (this.disabledModels.has(providerOrModel)) return false;
      const ms = this.modelHealth.get(providerOrModel);
      if (ms?.disabled || (ms && hasActiveCooldown(ms))) return false;
      if (this.disabledProviders.has(provider)) return false;
      const ps = this.providerHealth.get(provider);
      if (ps?.disabled || (ps && hasActiveCooldown(ps))) return false;
    } else {
      if (this.disabledProviders.has(providerOrModel)) return false;
      const ps = this.providerHealth.get(providerOrModel);
      if (ps?.disabled || (ps && hasActiveCooldown(ps))) return false;
    }
    return true;
  }

  recordOutcome(provider: string, model: string, success: boolean, errorType?: ErrorType): void {
    if (!this.providerHealth.has(provider)) this.providerHealth.set(provider, newStats(provider));
    if (!this.modelHealth.has(model)) this.modelHealth.set(model, newStats(model));

    for (const stats of [this.providerHealth.get(provider)!, this.modelHealth.get(model)!]) {
      stats.totalAttempts++;
      if (success) stats.successfulAttempts++;
      stats.recentHistory.push(success);
      if (stats.recentHistory.length > HEALTH_WINDOW) stats.recentHistory.shift();
    }

    if (!success && errorType) {
      for (const stats of [this.providerHealth.get(provider)!, this.modelHealth.get(model)!]) {
        applyCooldown(stats, errorType);
        if (errorType === "auth_error" || errorType === "quota_exceeded") {
          stats.disabled = true;
          stats.disabledReason = errorType;
          log().warn(`[PROVIDER_HEALTH] Auto-disabled ${model} due to ${errorType}`);
        }
      }
    }

    const now = Date.now();
    if (now - this.lastPersist > PERSIST_INTERVAL_MS) {
      this._persist();
      this.lastPersist = now;
    }
  }

  getHealthReport(): Record<string, unknown> {
    const now = Date.now();
    const fmtStats = (stats: HealthStats) => ({
      healthScore: healthScore(stats),
      successRate: successRate(stats),
      totalAttempts: stats.totalAttempts,
      disabled: stats.disabled,
      disabledReason: stats.disabledReason,
      activeCooldowns: Object.fromEntries(
        [...stats.cooldowns.entries()]
          .filter(([, cd]) => now < cd.startedAt + cd.durationMs)
          .map(([type, cd]) => [type, { remainingSecs: Math.ceil((cd.startedAt + cd.durationMs - now) / 1000), consecutiveFailures: cd.consecutiveFailures }])
      ),
    });
    return {
      providers: Object.fromEntries([...this.providerHealth.entries()].map(([k, v]) => [k, fmtStats(v)])),
      models: Object.fromEntries([...this.modelHealth.entries()].map(([k, v]) => [k, fmtStats(v)])),
      disabledProviders: [...this.disabledProviders],
      disabledModels: [...this.disabledModels],
    };
  }

  resetProvider(provider: string): void {
    this.providerHealth.set(provider, newStats(provider));
    this.disabledProviders.delete(provider);
    log().info(`[PROVIDER_HEALTH] Reset provider: ${provider}`);
  }

  resetModel(model: string): void {
    this.modelHealth.set(model, newStats(model));
    this.disabledModels.delete(model);
    log().info(`[PROVIDER_HEALTH] Reset model: ${model}`);
  }

  toggleProvider(provider: string, enabled: boolean): void {
    if (enabled) {
      this.disabledProviders.delete(provider);
      const stats = this.providerHealth.get(provider);
      if (stats) { stats.disabled = false; stats.disabledReason = ""; }
    } else {
      this.disabledProviders.add(provider);
      if (!this.providerHealth.has(provider)) this.providerHealth.set(provider, newStats(provider));
      const stats = this.providerHealth.get(provider)!;
      stats.disabled = true; stats.disabledReason = "manual_disable";
    }
    this._persist();
  }

  private _persist(): void {
    try {
      const db = getDb();
      const config = {
        disabled_providers: [...this.disabledProviders].sort(),
        disabled_models: [...this.disabledModels].sort(),
        persisted_at: new Date().toISOString(),
      };
      const exists = db.select().from(orchestratorSettings).where(eq(orchestratorSettings.key, PERSIST_KEY)).get();
      if (exists) {
        db.update(orchestratorSettings).set({ value: config, updatedAt: new Date().toISOString() })
          .where(eq(orchestratorSettings.key, PERSIST_KEY)).run();
      } else {
        db.insert(orchestratorSettings).values({ key: PERSIST_KEY, value: config, updatedAt: new Date().toISOString() }).run();
      }
    } catch (e) {
      log().warn(`[PROVIDER_HEALTH] Persist failed: ${String(e)}`);
    }
  }
}
