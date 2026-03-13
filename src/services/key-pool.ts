/**
 * KeyPool service — sticky key assignment with failover.
 *
 * Features:
 * - Sticky assignment: same sessionId always gets same key (prompt caching)
 * - Failover: on 401/403/429, move session to next healthy key
 * - Auto-recovery: keys recover after cooldown period
 */

import { createHash } from "node:crypto";
import type { KeyEntry, KeyConfig } from "../config/keys.js";
import { loadKeyConfig } from "../config/keys.js";

// ── Types ────────────────────────────────────────────────────────────────────

type Provider = "anthropic" | "openai" | "openrouter";

interface KeyHealth {
  healthy: boolean;
  lastFailure?: Date;
  failureReason?: string;
  failureType: "auth" | "rate_limit" | "unknown";
}

// ── KeyPool Service ──────────────────────────────────────────────────────────

export class KeyPoolService {
  private pools: Map<Provider, KeyEntry[]> = new Map();
  private assignments: Map<string, number> = new Map(); // "provider:sessionId" -> keyIndex
  private health: Map<string, KeyHealth> = new Map();   // "provider:keyIndex" -> health

  private config: KeyConfig;
  private recoveryCheckInterval: NodeJS.Timeout | undefined;

  constructor() {
    this.config = loadKeyConfig();
    this.initializePools();
    this.startRecoveryLoop();
  }

  private initializePools(): void {
    if (this.config.anthropic?.keys) {
      this.pools.set("anthropic", this.config.anthropic.keys);
    }
    if (this.config.openai?.keys) {
      this.pools.set("openai", this.config.openai.keys);
    }
    if (this.config.openrouter?.keys) {
      this.pools.set("openrouter", this.config.openrouter.keys);
    }
  }

  /**
   * Get API key for a session — sticky assignment.
   * Returns undefined if no keys configured for this provider.
   */
  getKey(provider: Provider, sessionId: string): string | undefined {
    const keys = this.pools.get(provider);
    if (!keys || keys.length === 0) return undefined;

    // Single key — just return it (no assignment needed)
    if (keys.length === 1) {
      const keyIndex = 0;
      if (!this.isHealthy(provider, keyIndex)) {
        return undefined; // Only key is unhealthy
      }
      return keys[0].key;
    }

    // Multi-key — sticky assignment
    const assignmentKey = `${provider}:${sessionId}`;
    let keyIndex = this.assignments.get(assignmentKey);

    // First time for this session — hash to initial key
    if (keyIndex === undefined) {
      keyIndex = this.hashSessionToKey(sessionId, keys.length);
      this.assignments.set(assignmentKey, keyIndex);
    }

    // Check if current assignment is healthy
    if (this.isHealthy(provider, keyIndex)) {
      return keys[keyIndex].key;
    }

    // Current key unhealthy — find next healthy key
    const nextIndex = this.findNextHealthyKey(provider, keyIndex, keys.length);
    if (nextIndex === undefined) {
      return undefined; // All keys unhealthy
    }

    // Reassign to healthy key
    this.assignments.set(assignmentKey, nextIndex);
    return keys[nextIndex].key;
  }

  /**
   * Mark a key as failed — triggers failover for sessions using it.
   * @param errorType - auth (401/403), rate_limit (429), or unknown
   */
  markFailed(provider: Provider, keyIndex: number, error: string, errorType: "auth" | "rate_limit" | "unknown"): void {
    const healthKey = `${provider}:${keyIndex}`;
    this.health.set(healthKey, {
      healthy: false,
      lastFailure: new Date(),
      failureReason: error,
      failureType: errorType,
    });

    const keys = this.pools.get(provider);
    const label = keys?.[keyIndex]?.label ?? `key-${keyIndex}`;
    console.warn(`[KeyPool] Marked ${provider}/${label} as unhealthy (${errorType}): ${error}`);
  }

  /**
   * Get OAuth token (for Anthropic) or API key for the given provider and session.
   * Returns { apiKey?, authToken?, isOAuth } or undefined if no keys configured.
   */
  getAuth(
    provider: Provider,
    sessionId: string
  ): { apiKey?: string; authToken?: string; isOAuth: boolean } | undefined {
    const key = this.getKey(provider, sessionId);
    if (!key) return undefined;

    // Detect OAuth token for Anthropic
    if (provider === "anthropic" && key.includes("sk-ant-oat")) {
      return { authToken: key, isOAuth: true };
    }

    return { apiKey: key, isOAuth: false };
  }

  /**
   * Check if any keys are configured for the given provider.
   */
  hasKeys(provider: Provider): boolean {
    const keys = this.pools.get(provider);
    return !!keys && keys.length > 0;
  }

  /**
   * Cleanup on shutdown.
   */
  shutdown(): void {
    if (this.recoveryCheckInterval) {
      clearInterval(this.recoveryCheckInterval);
    }
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  private hashSessionToKey(sessionId: string, poolSize: number): number {
    const hash = createHash("sha256").update(sessionId).digest();
    const num = hash.readUInt32BE(0);
    return num % poolSize;
  }

  private isHealthy(provider: Provider, keyIndex: number): boolean {
    const healthKey = `${provider}:${keyIndex}`;
    const health = this.health.get(healthKey);
    return health?.healthy !== false;
  }

  private findNextHealthyKey(provider: Provider, currentIndex: number, poolSize: number): number | undefined {
    // Try all other keys in round-robin order
    for (let offset = 1; offset < poolSize; offset++) {
      const tryIndex = (currentIndex + offset) % poolSize;
      if (this.isHealthy(provider, tryIndex)) {
        return tryIndex;
      }
    }
    return undefined;
  }

  private startRecoveryLoop(): void {
    // Check for key recovery every 60s
    this.recoveryCheckInterval = setInterval(() => {
      this.recoverKeys();
    }, 60_000);
  }

  private recoverKeys(): void {
    const now = new Date();

    for (const [healthKey, health] of this.health.entries()) {
      if (health.healthy) continue; // Already healthy
      if (!health.lastFailure) continue;

      const elapsed = now.getTime() - health.lastFailure.getTime();

      // Auth failures stay down until manual reset
      if (health.failureType === "auth") {
        continue;
      }

      // Rate limit failures recover after 60s
      if (health.failureType === "rate_limit" && elapsed > 60_000) {
        health.healthy = true;
        const [provider, indexStr] = healthKey.split(":");
        const keyIndex = parseInt(indexStr, 10);
        const keys = this.pools.get(provider as Provider);
        const label = keys?.[keyIndex]?.label ?? `key-${keyIndex}`;
        console.log(`[KeyPool] Recovered ${provider}/${label} after rate limit cooldown`);
        continue;
      }

      // Unknown failures recover after 60s
      if (health.failureType === "unknown" && elapsed > 60_000) {
        health.healthy = true;
        const [provider, indexStr] = healthKey.split(":");
        const keyIndex = parseInt(indexStr, 10);
        const keys = this.pools.get(provider as Provider);
        const label = keys?.[keyIndex]?.label ?? `key-${keyIndex}`;
        console.log(`[KeyPool] Recovered ${provider}/${label} after cooldown`);
      }
    }
  }
}

// ── Singleton Instance ───────────────────────────────────────────────────────

let instance: KeyPoolService | undefined;

export function getKeyPool(): KeyPoolService {
  if (!instance) {
    instance = new KeyPoolService();
  }
  return instance;
}

export function shutdownKeyPool(): void {
  if (instance) {
    instance.shutdown();
    instance = undefined;
  }
}
