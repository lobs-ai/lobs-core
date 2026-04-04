/**
 * KeyPool service — sticky key assignment with failover.
 *
 * Features:
 * - Sticky assignment: same sessionId always gets same key (prompt caching)
 * - Failover: on 401/403/429, move session to next healthy key
 * - Auto-recovery: keys recover after cooldown period
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { KeyEntry, KeyConfig } from "../config/keys.js";
import { loadKeyConfig } from "../config/keys.js";

const KEY_HEALTH_STATE_PATH = join(homedir(), ".lobs", "key-health-state.json");

// ── Types ────────────────────────────────────────────────────────────────────

type Provider = "anthropic" | "openai" | "openai-codex" | "openrouter";

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
  consecutiveFailures: number;
  lastRecovery?: Date;
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_UNKNOWN_COOLDOWN_MS = 60 * 1000;

// ── KeyPool Service ──────────────────────────────────────────────────────────

// In-flight request tracking per key — used to deprioritize keys that are
// potentially stuck (many requests, none completing).
interface InFlightInfo {
  count: number;
  oldestStart: number; // timestamp of oldest in-flight request
  lastSuccess: number; // timestamp of last successful completion
}

export class KeyPoolService {
  private pools: Map<Provider, KeyEntry[]> = new Map();
  private assignments: Map<string, string> = new Map(); // "provider:sessionId" -> key identity
  private health: Map<string, KeyHealth> = new Map();   // "provider:keyIdentity" -> health
  private preferredHealthyKey: Map<Provider, string> = new Map(); // provider -> last successful key identity
  private inFlight: Map<string, InFlightInfo> = new Map(); // "provider:keyIdentity" -> in-flight tracking

  private config: KeyConfig;
  private configSignature = "";
  private recoveryCheckInterval: NodeJS.Timeout | undefined;

  private saveDebounceTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.config = loadKeyConfig();
    this.initializePools();
    this.configSignature = this.computeConfigSignature(this.config);
    this.loadHealthState();
    this.startRecoveryLoop();
  }

  private initializePools(): void {
    if (this.config.anthropic?.keys) {
      this.pools.set("anthropic", this.config.anthropic.keys);
    }
    if (this.config.openai?.keys) {
      this.pools.set("openai", this.config.openai.keys);
    }
    if (this.config["openai-codex"]?.keys) {
      this.pools.set("openai-codex", this.config["openai-codex"].keys);
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

    // First time for this session — prefer the last key that actually succeeded.
    // If we don't have one, spread new sessions across healthy keys instead of
    // purely hashing into one slot and blackholing concurrent chats on the same key.
    // Also skip "suspect" keys — those with in-flight requests that aren't completing.
    if (keyIndex < 0) {
      keyIndex =
        this.getPreferredHealthyKeyIndex(provider, keys)
        ?? this.selectHealthyKeyForNewSession(provider, sessionId, keys)
        ?? this.hashSessionToKey(sessionId, keys.length);

      // If the selected key is suspect (stuck in-flight requests), try to find a non-suspect one
      if (this.isKeySuspect(provider, keyIndex)) {
        const nonSuspect = this.findNonSuspectHealthyKey(provider, keyIndex, keys.length);
        if (nonSuspect !== undefined) {
          const suspectLabel = keys[keyIndex]?.label ?? `key-${keyIndex}`;
          const newLabel = keys[nonSuspect]?.label ?? `key-${nonSuspect}`;
          console.warn(
            `[KeyPool] Avoided suspect key ${provider}/${suspectLabel} for new session=${sessionId.slice(0, 24)}, ` +
            `using ${newLabel} instead`,
          );
          keyIndex = nonSuspect;
        }
      }

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
    const existing = this.health.get(healthKey);

    // Track consecutive failures for escalating cooldowns.
    // If the key was recently recovered (within 5 min) and failed again,
    // keep the failure count high — it didn't actually recover.
    const recentRecovery = existing?.lastRecovery && (now - existing.lastRecovery.getTime()) < 5 * 60 * 1000;
    const consecutiveFailures = recentRecovery
      ? (existing?.consecutiveFailures ?? 0) + 1
      : (!existing || existing.healthy) ? 1 : (existing.consecutiveFailures ?? 0) + 1;

    // Escalating cooldown: base * 2^(failures-1), capped at 30 minutes.
    // 1st failure: base (60s/120s), 2nd: 2x, 3rd: 4x, 4th: 8x, etc.
    const baseCooldownMs =
      errorType === "rate_limit"
        ? Math.max(cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS, DEFAULT_RATE_LIMIT_COOLDOWN_MS)
        : cooldownMs ?? DEFAULT_UNKNOWN_COOLDOWN_MS;
    const MAX_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
    const escalationFactor = Math.pow(2, Math.min(consecutiveFailures - 1, 8));
    const effectiveCooldownMs = Math.min(baseCooldownMs * escalationFactor, MAX_COOLDOWN_MS);

    // If the key is already in cooldown, don't reset the timer — extend if needed
    // but never shorten. This prevents "thundering herd resets" where retries
    // against a rate-limited key keep pushing back its recovery time.
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
      consecutiveFailures,
      lastRecovery: existing?.lastRecovery,
    });

    if (this.preferredHealthyKey.get(provider) === healthKey) {
      this.preferredHealthyKey.delete(provider);
    }

    const label = keys?.[keyIndex]?.label ?? `key-${keyIndex}`;
    const cooldownSuffix =
      errorType === "auth" ? "" : ` cooldown_ms=${effectiveCooldownMs} consecutive=${consecutiveFailures}`;
    console.warn(`[KeyPool] Marked ${provider}/${label} as unhealthy (${errorType})${cooldownSuffix}: ${error}`);
    this.saveHealthState();
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
    health.lastRecovery = new Date();
    // Don't reset consecutiveFailures here — if it fails again within 5 min,
    // markFailed will see the recent recovery and keep escalating.
    // consecutiveFailures resets only when a key stays healthy for 5+ minutes
    // (tracked via the recentRecovery check in markFailed).
    this.preferredHealthyKey.set(provider, healthKey);
    const label = keys?.[keyIndex]?.label ?? `key-${keyIndex}`;
    console.log(`[KeyPool] Marked ${provider}/${label} healthy after successful request (prior_failures=${health.consecutiveFailures})`);
    this.saveHealthState();
  }

  // ── In-Flight Request Tracking ─────────────────────────────────────────────

  /**
   * Record that a request is starting on this key. Call before making the API request.
   */
  trackRequestStart(provider: Provider, keyIndex: number): void {
    const key = this.pools.get(provider)?.[keyIndex]?.key;
    if (!key) return;
    const healthKey = this.getKeyIdentity(provider, key);
    const info = this.inFlight.get(healthKey);
    const now = Date.now();
    if (info) {
      info.count++;
      if (now < info.oldestStart || info.count === 1) info.oldestStart = now;
    } else {
      this.inFlight.set(healthKey, { count: 1, oldestStart: now, lastSuccess: now });
    }
  }

  /**
   * Record that a request completed (success or failure). Call after the API request finishes.
   */
  trackRequestEnd(provider: Provider, keyIndex: number, success: boolean): void {
    const key = this.pools.get(provider)?.[keyIndex]?.key;
    if (!key) return;
    const healthKey = this.getKeyIdentity(provider, key);
    const info = this.inFlight.get(healthKey);
    if (info) {
      info.count = Math.max(0, info.count - 1);
      if (success) info.lastSuccess = Date.now();
      if (info.count === 0) info.oldestStart = Date.now();
    }
  }

  /**
   * Check if a key appears stuck — has in-flight requests with no recent success.
   * A key is "suspect" if it has requests that have been running for >15s with no
   * success in that window. This is much faster than waiting for the full 60s timeout.
   */
  private isKeySuspect(provider: Provider, keyIndex: number): boolean {
    const key = this.pools.get(provider)?.[keyIndex]?.key;
    if (!key) return false;
    const healthKey = this.getKeyIdentity(provider, key);
    const info = this.inFlight.get(healthKey);
    if (!info || info.count === 0) return false;

    const now = Date.now();
    const SUSPECT_THRESHOLD_MS = 15_000; // 15 seconds with no success
    const oldestAge = now - info.oldestStart;
    const timeSinceSuccess = now - info.lastSuccess;

    // Key is suspect if it has in-flight requests older than 15s AND no success in that time
    return oldestAge > SUSPECT_THRESHOLD_MS && timeSinceSuccess > SUSPECT_THRESHOLD_MS;
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
   * Full status of all providers and keys — for the Nexus dashboard.
   * Never exposes actual key values, only labels and health state.
   */
  getFullStatus(): {
    providers: Record<string, {
      total: number;
      healthy: number;
      keys: Array<{
        label: string;
        healthy: boolean;
        failureType?: string;
        failureReason?: string;
        recoverAt?: string;
      }>;
    }>;
  } {
    this.refreshConfigIfChanged();
    const providers: Record<string, {
      total: number;
      healthy: number;
      keys: Array<{
        label: string;
        healthy: boolean;
        failureType?: string;
        failureReason?: string;
        recoverAt?: string;
      }>;
    }> = {};

    for (const [provider, keys] of this.pools.entries()) {
      const keyStatuses = keys.map((entry, i) => {
        const healthKey = this.getKeyIdentity(provider, entry.key);
        const health = this.health.get(healthKey);
        const isHealthy = !health || health.healthy !== false;
        return {
          label: entry.label ?? `key-${i}`,
          healthy: isHealthy,
          ...(health && !isHealthy ? {
            failureType: health.failureType,
            failureReason: health.failureReason,
            recoverAt: health.recoverAt?.toISOString(),
          } : {}),
        };
      });

      providers[provider] = {
        total: keys.length,
        healthy: keyStatuses.filter(k => k.healthy).length,
        keys: keyStatuses,
      };
    }

    return { providers };
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
      if (keys.length === 1) {
        keyIndex = 0;
      } else {
        console.warn(
          `[KeyPool] Ignored markSessionFailed for ${provider} session=${sessionId.slice(0, 24)} ` +
          `because no key assignment was recorded`,
        );
        return false;
      }
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
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    // Save state synchronously on shutdown so it persists across restarts
    this.saveHealthStateSync();
  }

  // ── Health State Persistence ───────────────────────────────────────────────

  private loadHealthState(): void {
    try {
      const raw = readFileSync(KEY_HEALTH_STATE_PATH, "utf-8");
      const state = JSON.parse(raw) as Record<string, {
        healthy: boolean;
        lastFailure?: string;
        recoverAt?: string;
        failureReason?: string;
        failureType: "auth" | "rate_limit" | "unknown";
        consecutiveFailures: number;
        lastRecovery?: string;
      }>;

      const now = Date.now();
      let loaded = 0;
      let skippedExpired = 0;
      let skippedOld = 0;

      for (const [healthKey, entry] of Object.entries(state)) {
        // Skip entries older than 1 hour — stale data is worse than no data
        const lastFailure = entry.lastFailure ? new Date(entry.lastFailure).getTime() : 0;
        if (now - lastFailure > 60 * 60 * 1000) {
          skippedOld++;
          continue;
        }

        const recoverAt = entry.recoverAt ? new Date(entry.recoverAt) : undefined;

        // If cooldown already expired, mark as recovered but preserve failure history
        if (recoverAt && now >= recoverAt.getTime() && entry.failureType !== "auth") {
          this.health.set(healthKey, {
            healthy: true,
            lastFailure: entry.lastFailure ? new Date(entry.lastFailure) : undefined,
            recoverAt: undefined,
            failureReason: entry.failureReason,
            failureType: entry.failureType,
            consecutiveFailures: entry.consecutiveFailures,
            lastRecovery: new Date(now),
          });
          skippedExpired++;
          continue;
        }

        this.health.set(healthKey, {
          healthy: entry.healthy,
          lastFailure: entry.lastFailure ? new Date(entry.lastFailure) : undefined,
          recoverAt,
          failureReason: entry.failureReason,
          failureType: entry.failureType,
          consecutiveFailures: entry.consecutiveFailures,
          lastRecovery: entry.lastRecovery ? new Date(entry.lastRecovery) : undefined,
        });
        loaded++;
      }

      console.log(
        `[KeyPool] Loaded health state: ${loaded} active, ${skippedExpired} expired-but-tracked, ${skippedOld} stale-discarded`,
      );
    } catch {
      // No state file or invalid — start fresh (normal on first run)
    }
  }

  private saveHealthState(): void {
    // Debounce saves — health changes can come in bursts
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      this.saveHealthStateSync();
    }, 2000);
  }

  private saveHealthStateSync(): void {
    try {
      const state: Record<string, object> = {};
      for (const [healthKey, health] of this.health.entries()) {
        // Only persist unhealthy keys or recently-recovered ones (for failure tracking)
        if (health.healthy && !health.consecutiveFailures) continue;
        state[healthKey] = {
          healthy: health.healthy,
          lastFailure: health.lastFailure?.toISOString(),
          recoverAt: health.recoverAt?.toISOString(),
          failureReason: health.failureReason,
          failureType: health.failureType,
          consecutiveFailures: health.consecutiveFailures,
          lastRecovery: health.lastRecovery?.toISOString(),
        };
      }
      mkdirSync(dirname(KEY_HEALTH_STATE_PATH), { recursive: true });
      writeFileSync(KEY_HEALTH_STATE_PATH, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn(`[KeyPool] Failed to save health state: ${err}`);
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

  /**
   * Find a healthy key that isn't suspect (no stuck in-flight requests).
   * Used for new session assignment to avoid piling onto a potentially-dead key.
   */
  private findNonSuspectHealthyKey(provider: Provider, currentIndex: number, poolSize: number): number | undefined {
    for (let offset = 1; offset < poolSize; offset++) {
      const tryIndex = (currentIndex + offset) % poolSize;
      if (this.isHealthy(provider, tryIndex) && !this.isKeySuspect(provider, tryIndex)) {
        return tryIndex;
      }
    }
    // All other keys are also suspect or unhealthy — fall back to any healthy key
    return this.findNextHealthyKey(provider, currentIndex, poolSize);
  }

  private findLeastBadKey(provider: Provider, poolSize: number, excludeIndex?: number): number | undefined {
    let bestIndex: number | undefined;
    let bestRecoverAt = Number.POSITIVE_INFINITY;

    for (let i = 0; i < poolSize; i++) {
      if (i === excludeIndex) continue;
      const key = this.pools.get(provider)?.[i]?.key;
      if (!key) continue;
      const health = this.health.get(this.getKeyIdentity(provider, key));

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

  private getPreferredHealthyKeyIndex(provider: Provider, keys: KeyEntry[]): number | undefined {
    // NOTE: We no longer blindly funnel all new sessions to a single "preferred" key.
    // That caused thundering-herd effects where one key took all load, got rate-limited,
    // then the next key took all load, etc. Instead, preferred key is only used as a
    // tiebreaker in selectHealthyKeyForNewSession (via load-balancing).
    // Return undefined here so new sessions go through proper load-balanced selection.
    return undefined;
  }

  private selectHealthyKeyForNewSession(
    provider: Provider,
    sessionId: string,
    keys: KeyEntry[],
  ): number | undefined {
    const counts = new Map<number, number>();
    const healthyIndices: number[] = [];

    for (let i = 0; i < keys.length; i++) {
      if (!this.isHealthy(provider, i)) continue;
      if (this.isKeySuspect(provider, i)) continue; // Skip keys with stuck in-flight requests
      healthyIndices.push(i);
      counts.set(i, 0);
    }

    if (healthyIndices.length === 0) return undefined;

    for (const [assignmentKey, identity] of this.assignments.entries()) {
      if (!assignmentKey.startsWith(`${provider}:`)) continue;
      const assignedIndex = keys.findIndex((entry) => this.getKeyIdentity(provider, entry.key) === identity);
      if (assignedIndex >= 0 && counts.has(assignedIndex)) {
        counts.set(assignedIndex, (counts.get(assignedIndex) ?? 0) + 1);
      }
    }

    let minCount = Number.POSITIVE_INFINITY;
    const leastLoaded: number[] = [];
    for (const index of healthyIndices) {
      const count = counts.get(index) ?? 0;
      if (count < minCount) {
        minCount = count;
        leastLoaded.length = 0;
        leastLoaded.push(index);
      } else if (count === minCount) {
        leastLoaded.push(index);
      }
    }

    if (leastLoaded.length === 1) return leastLoaded[0];
    const tieBreak = this.hashSessionToKey(sessionId, leastLoaded.length);
    return leastLoaded[tieBreak];
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
        health.lastRecovery = new Date(now);
        const keys = this.pools.get(provider);
        const label = keys?.[i]?.label ?? `key-${i}`;
        console.log(`[KeyPool] Inline-recovered ${provider}/${label} (cooldown expired, prior_failures=${health.consecutiveFailures})`);
        this.saveHealthState();
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
    let anyRecovered = false;

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
        health.lastRecovery = now;
        anyRecovered = true;
        const { provider, label } = this.getHealthKeyMeta(healthKey);
        console.log(`[KeyPool] Recovered ${provider}/${label} after rate limit cooldown (prior_failures=${health.consecutiveFailures})`);
        continue;
      }

      if (health.failureType === "unknown") {
        health.healthy = true;
        health.recoverAt = undefined;
        health.lastRecovery = now;
        anyRecovered = true;
        const { provider, label } = this.getHealthKeyMeta(healthKey);
        console.log(`[KeyPool] Recovered ${provider}/${label} after cooldown (prior_failures=${health.consecutiveFailures})`);
      }
    }

    if (anyRecovered) this.saveHealthState();
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
