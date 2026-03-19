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

interface KeySelection {
  key: string;
  keyIndex: number;
  label?: string;
}

interface KeyHealth {
  healthy: boolean;
  lastFailure?: Date;
  recoverAt?: Date;
  failureReason?: string;
  failureType: "auth" | "rate_limit" | "unknown";
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_UNKNOWN_COOLDOWN_MS = 60 * 1000;

// ── KeyPool Service ──────────────────────────────────────────────────────────

export class KeyPoolService {
  private pools: Map<Provider, KeyEntry[]> = new Map();
  private assignments: Map<string, string> = new Map(); // "provider:sessionId" -> key identity
  private health: Map<string, KeyHealth> = new Map();   // "provider:keyIdentity" -> health

  private config: KeyConfig;
  private configSignature = "";
  private recoveryCheckInterval: NodeJS.Timeout | undefined;

  constructor() {
    this.config = loadKeyConfig();
    this.initializePools();
    this.configSignature = this.computeConfigSignature(this.config);
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
    const selection = this.getKeySelection(provider, sessionId);
    return selection?.key;
  }

  /**
   * Return the current session's selected key and index.
   */
  getKeySelection(provider: Provider, sessionId: string): KeySelection | undefined {
    this.refreshConfigIfChanged();

    const keys = this.pools.get(provider);
    if (!keys || keys.length === 0) return undefined;

    // Single key — just return it (no assignment needed)
    if (keys.length === 1) {
      const keyIndex = 0;
      if (!this.isHealthy(provider, keyIndex)) {
        return undefined; // Only key is unhealthy
      }
      return { key: keys[0].key, keyIndex, label: keys[0].label ?? `key-${keyIndex}` };
    }

    // Multi-key — sticky assignment
    const assignmentKey = `${provider}:${sessionId}`;
    const assignedIdentity = this.assignments.get(assignmentKey);
    let keyIndex = assignedIdentity ? keys.findIndex((entry) => this.getKeyIdentity(provider, entry.key) === assignedIdentity) : -1;

    // First time for this session — hash to initial key
    if (keyIndex < 0) {
      keyIndex = this.hashSessionToKey(sessionId, keys.length);
      this.assignments.set(assignmentKey, this.getKeyIdentity(provider, keys[keyIndex].key));
    }

    // Check if current assignment is healthy
    if (this.isHealthy(provider, keyIndex)) {
      return { key: keys[keyIndex].key, keyIndex, label: keys[keyIndex].label ?? `key-${keyIndex}` };
    }

    // Current key unhealthy — find next healthy key
    const nextIndex = this.findNextHealthyKey(provider, keyIndex, keys.length);
    if (nextIndex === undefined) {
      // All keys unhealthy — DON'T return a rate-limited key just to hammer it.
      // Instead, check if any key's cooldown has already expired (recovery loop
      // runs every 60s, so there's a window where a key is eligible but not yet
      // recovered). If we find one, recover it inline and use it.
      const recoveredIndex = this.tryInlineRecovery(provider, keys.length);
      if (recoveredIndex !== undefined) {
        this.assignments.set(assignmentKey, this.getKeyIdentity(provider, keys[recoveredIndex].key));
        const label = keys[recoveredIndex]?.label ?? `key-${recoveredIndex}`;
        console.log(`[KeyPool] Inline-recovered ${provider}/${label} for session=${sessionId.slice(0, 24)}`);
        return { key: keys[recoveredIndex].key, keyIndex: recoveredIndex, label };
      }

      // No keys available — return undefined so callers get clean "no keys" error
      // instead of retrying against rate-limited endpoints
      return undefined;
    }

    // Reassign to healthy key
    this.assignments.set(assignmentKey, this.getKeyIdentity(provider, keys[nextIndex].key));
    const oldLabel = keys[keyIndex]?.label ?? `key-${keyIndex}`;
    const newLabel = keys[nextIndex]?.label ?? `key-${nextIndex}`;
    console.warn(`[KeyPool] Reassigned ${provider} session=${sessionId.slice(0, 24)} from ${oldLabel} -> ${newLabel}`);
    return { key: keys[nextIndex].key, keyIndex: nextIndex, label: newLabel };
  }

  /**
   * Mark a key as failed — triggers failover for sessions using it.
   * @param errorType - auth (401/403), rate_limit (429), or unknown
   */
  markFailed(
    provider: Provider,
    keyIndex: number,
    error: string,
    errorType: "auth" | "rate_limit" | "unknown",
    cooldownMs?: number,
  ): void {
    this.refreshConfigIfChanged();

    const keys = this.pools.get(provider);
    const key = keys?.[keyIndex]?.key;
    if (!key) return;

    const healthKey = this.getKeyIdentity(provider, key);
    const now = Date.now();
    const effectiveCooldownMs =
      errorType === "rate_limit"
        ? Math.max(cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS, DEFAULT_RATE_LIMIT_COOLDOWN_MS)
        : cooldownMs ?? DEFAULT_UNKNOWN_COOLDOWN_MS;

    // If the key is already in cooldown, don't reset the timer — extend if needed
    // but never shorten. This prevents "thundering herd resets" where retries
    // against a rate-limited key keep pushing back its recovery time.
    const existing = this.health.get(healthKey);
    let recoverAt: Date | undefined;
    if (errorType === "auth") {
      recoverAt = undefined; // auth failures stay down permanently
    } else if (existing && !existing.healthy && existing.recoverAt) {
      // Key already in cooldown — only extend, never reset backwards
      const newRecoverAt = new Date(now + effectiveCooldownMs);
      recoverAt = newRecoverAt > existing.recoverAt ? newRecoverAt : existing.recoverAt;
    } else {
      recoverAt = new Date(now + effectiveCooldownMs);
    }

    this.health.set(healthKey, {
      healthy: false,
      lastFailure: new Date(now),
      recoverAt,
      failureReason: error,
      failureType: errorType,
    });

    const label = keys?.[keyIndex]?.label ?? `key-${keyIndex}`;
    const cooldownSuffix =
      errorType === "auth" ? "" : ` cooldown_ms=${effectiveCooldownMs}`;
    console.warn(`[KeyPool] Marked ${provider}/${label} as unhealthy (${errorType})${cooldownSuffix}: ${error}`);
  }

  markHealthy(provider: Provider, keyIndex: number): void {
    this.refreshConfigIfChanged();

    const keys = this.pools.get(provider);
    const key = keys?.[keyIndex]?.key;
    if (!key) return;

    const healthKey = this.getKeyIdentity(provider, key);
    const health = this.health.get(healthKey);
    if (!health || health.healthy) return;

    health.healthy = true;
    health.recoverAt = undefined;
    const label = keys?.[keyIndex]?.label ?? `key-${keyIndex}`;
    console.log(`[KeyPool] Marked ${provider}/${label} healthy after successful request`);
  }

  /**
   * Get OAuth token (for Anthropic) or API key for the given provider and session.
   * Returns { apiKey?, authToken?, isOAuth } or undefined if no keys configured.
   */
  getAuth(
    provider: Provider,
    sessionId: string
  ): { apiKey?: string; authToken?: string; isOAuth: boolean; keyIndex: number; label?: string } | undefined {
    const selection = this.getKeySelection(provider, sessionId);
    if (!selection) return undefined;
    const { key, keyIndex, label } = selection;

    // Detect OAuth token for Anthropic
    if (provider === "anthropic" && key.includes("sk-ant-oat")) {
      return { authToken: key, isOAuth: true, keyIndex, label };
    }

    return { apiKey: key, isOAuth: false, keyIndex, label };
  }

  getPoolHealthSummary(provider: Provider): {
    total: number;
    healthy: number;
    authFailed: number;
    rateLimited: number;
    providerFailed: number;
  } {
    this.refreshConfigIfChanged();

    const keys = this.pools.get(provider) ?? [];
    const summary = {
      total: keys.length,
      healthy: 0,
      authFailed: 0,
      rateLimited: 0,
      providerFailed: 0,
    };

    for (let i = 0; i < keys.length; i++) {
      const health = this.health.get(this.getKeyIdentity(provider, keys[i].key));
      if (!health || health.healthy) {
        summary.healthy += 1;
        continue;
      }
      if (health.failureType === "auth") summary.authFailed += 1;
      else if (health.failureType === "rate_limit") summary.rateLimited += 1;
      else summary.providerFailed += 1;
    }

    return summary;
  }

  /**
   * Mark the currently assigned key for a session as failed.
   */
  markSessionFailed(
    provider: Provider,
    sessionId: string,
    error: string,
    errorType: "auth" | "rate_limit" | "unknown",
    cooldownMs?: number,
  ): boolean {
    const assignmentKey = `${provider}:${sessionId}`;
    const keys = this.pools.get(provider);
    if (!keys || keys.length === 0) return false;

    let keyIndex = -1;
    const assignedIdentity = this.assignments.get(assignmentKey);
    if (assignedIdentity) {
      keyIndex = keys.findIndex((entry) => this.getKeyIdentity(provider, entry.key) === assignedIdentity);
    }
    if (keyIndex < 0) {
      keyIndex = keys.length === 1 ? 0 : this.hashSessionToKey(sessionId, keys.length);
      this.assignments.set(assignmentKey, this.getKeyIdentity(provider, keys[keyIndex].key));
    }

    this.markFailed(provider, keyIndex, error, errorType, cooldownMs);
    return true;
  }

  rotateSession(provider: Provider, sessionId: string, reason: string): boolean {
    this.refreshConfigIfChanged();

    const keys = this.pools.get(provider);
    if (!keys || keys.length <= 1) return false;

    const assignmentKey = `${provider}:${sessionId}`;
    const assignedIdentity = this.assignments.get(assignmentKey);
    const currentIndex = assignedIdentity
      ? keys.findIndex((entry) => this.getKeyIdentity(provider, entry.key) === assignedIdentity)
      : this.hashSessionToKey(sessionId, keys.length);
    const effectiveCurrentIndex = currentIndex >= 0 ? currentIndex : this.hashSessionToKey(sessionId, keys.length);
    const nextIndex = this.findNextHealthyKey(provider, effectiveCurrentIndex, keys.length);
    const targetIndex = nextIndex ?? this.findLeastBadKey(provider, keys.length, effectiveCurrentIndex);
    if (targetIndex === undefined || targetIndex === effectiveCurrentIndex) return false;

    this.assignments.set(assignmentKey, this.getKeyIdentity(provider, keys[targetIndex].key));
    const oldLabel = keys[effectiveCurrentIndex]?.label ?? `key-${effectiveCurrentIndex}`;
    const newLabel = keys[targetIndex]?.label ?? `key-${targetIndex}`;
    console.warn(
      `[KeyPool] Rotated ${provider} session=${sessionId.slice(0, 24)} from ${oldLabel} -> ${newLabel} (${reason})`,
    );
    return true;
  }

  getKeyLabel(provider: Provider, keyIndex: number): string | undefined {
    const keys = this.pools.get(provider);
    return keys?.[keyIndex]?.label ?? (keys?.[keyIndex] ? `key-${keyIndex}` : undefined);
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
    const key = this.pools.get(provider)?.[keyIndex]?.key;
    if (!key) return false;
    const healthKey = this.getKeyIdentity(provider, key);
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

  private findLeastBadKey(provider: Provider, poolSize: number, excludeIndex?: number): number | undefined {
    let bestIndex: number | undefined;
    let bestRecoverAt = Number.POSITIVE_INFINITY;

    for (let i = 0; i < poolSize; i++) {
      if (i === excludeIndex) continue;
      const health = this.health.get(`${provider}:${i}`);

      // Skip permanently-failed auth keys
      if (health?.failureType === "auth") continue;

      // Healthy keys are always best (shouldn't normally reach here, but be safe)
      if (!health || health.healthy !== false) {
        return i;
      }

      // Among unhealthy keys, pick the one that recovers soonest
      const recoverTime = health.recoverAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (recoverTime < bestRecoverAt) {
        bestIndex = i;
        bestRecoverAt = recoverTime;
      }
    }

    return bestIndex;
  }

  /**
   * Check if any key's cooldown has expired and recover it inline.
   * The periodic recovery loop runs every 60s, but there's a window where
   * a key is eligible for recovery but hasn't been recovered yet. This method
   * handles that case on-demand when we need a key now.
   */
  private tryInlineRecovery(provider: Provider, poolSize: number): number | undefined {
    const now = Date.now();
    for (let i = 0; i < poolSize; i++) {
      const key = this.pools.get(provider)?.[i]?.key;
      if (!key) continue;
      const healthKey = this.getKeyIdentity(provider, key);
      const health = this.health.get(healthKey);
      if (!health || health.healthy) return i; // already healthy
      if (health.failureType === "auth") continue; // permanently down
      if (health.recoverAt && now >= health.recoverAt.getTime()) {
        // Cooldown expired — recover this key
        health.healthy = true;
        health.recoverAt = undefined;
        const keys = this.pools.get(provider);
        const label = keys?.[i]?.label ?? `key-${i}`;
        console.log(`[KeyPool] Inline-recovered ${provider}/${label} (cooldown expired)`);
        return i;
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

      // Auth failures stay down until manual reset
      if (health.failureType === "auth") {
        continue;
      }

      if (!health.recoverAt || now < health.recoverAt) {
        continue;
      }

      if (health.failureType === "rate_limit") {
        health.healthy = true;
        health.recoverAt = undefined;
        const { provider, label } = this.getHealthKeyMeta(healthKey);
        console.log(`[KeyPool] Recovered ${provider}/${label} after rate limit cooldown`);
        continue;
      }

      if (health.failureType === "unknown") {
        health.healthy = true;
        health.recoverAt = undefined;
        const { provider, label } = this.getHealthKeyMeta(healthKey);
        console.log(`[KeyPool] Recovered ${provider}/${label} after cooldown`);
      }
    }
  }

  private refreshConfigIfChanged(): void {
    const nextConfig = loadKeyConfig();
    const nextSignature = this.computeConfigSignature(nextConfig);
    if (nextSignature === this.configSignature) return;

    this.config = nextConfig;
    this.initializePools();
    this.configSignature = nextSignature;
    console.log("[KeyPool] Reloaded key configuration");
  }

  private computeConfigSignature(config: KeyConfig): string {
    const serializePool = (provider?: { keys: KeyEntry[] }) =>
      provider?.keys.map((entry) => `${entry.label ?? ""}:${entry.key}`).join("|") ?? "";
    return [
      `anthropic=${serializePool(config.anthropic)}`,
      `openai=${serializePool(config.openai)}`,
      `openrouter=${serializePool(config.openrouter)}`,
    ].join(";");
  }

  private getKeyIdentity(provider: Provider, key: string): string {
    return `${provider}:${createHash("sha256").update(key).digest("hex")}`;
  }

  private getHealthKeyMeta(healthKey: string): { provider: Provider; label: string } {
    const [provider] = healthKey.split(":", 1) as [Provider];
    const keys = this.pools.get(provider) ?? [];
    const entry = keys.find((item) => this.getKeyIdentity(provider, item.key) === healthKey);
    return { provider, label: entry?.label ?? "unknown-key" };
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
