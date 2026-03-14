/**
 * Model Failure Circuit Breaker
 *
 * Tracks per-(model, task_type) failure buckets plus a __global__ bucket.
 * States: closed → open (after N failures) → half-open (after cooldown) → closed.
 *
 * Storage: JSON file model-health.json in the PAW state dir.
 * Config: circuitBreaker block in ~/.lobs/config/lobs.json (optional).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../util/logger.js";
import { getLobsRoot, loadLobsConfig } from "../config/lobs.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface BucketEntry {
  failures: string[];
  openedAt?: string;
  state: CircuitState;
}

export interface ModelHealthStore {
  version: 1;
  updatedAt: string;
  buckets: Record<string, BucketEntry>;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMinutes: number;
  windowMinutes: number;
  enabled: boolean;
}

export type FailureReason =
  | "timeout"
  | "session_dead"
  | "crash"
  | "empty_output";

// ── Config ─────────────────────────────────────────────────────────────────────

let _cfg: CircuitBreakerConfig | null = null;

export function loadConfig(): CircuitBreakerConfig {
  if (_cfg) return _cfg;
  const defaults: CircuitBreakerConfig = {
    failureThreshold: 10,
    cooldownMinutes: 30,
    windowMinutes: 60,
    enabled: true,
  };
  try {
    const raw = loadLobsConfig();
    const cb = raw?.circuitBreaker ?? {};
    _cfg = {
      failureThreshold: Number(cb.failureThreshold) || defaults.failureThreshold,
      cooldownMinutes: Number(cb.cooldownMinutes) || defaults.cooldownMinutes,
      windowMinutes: Number(cb.windowMinutes) || defaults.windowMinutes,
      enabled: cb.enabled !== false,
    };
  } catch {
    _cfg = defaults;
  }
  return _cfg;
}

export function invalidateCircuitBreakerConfig(): void {
  _cfg = null;
}

// ── Storage ───────────────────────────────────────────────────────────────────

export function resolveStorePath(): string {
  return join(getLobsRoot(), "plugins", "paw", "model-health.json");
}

export function loadStore(): ModelHealthStore {
  try {
    const raw = readFileSync(resolveStorePath(), "utf8");
    return JSON.parse(raw) as ModelHealthStore;
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), buckets: {} };
  }
}

function saveStore(store: ModelHealthStore): void {
  const p = resolveStorePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    store.updatedAt = new Date().toISOString();
    writeFileSync(p, JSON.stringify(store, null, 2));
  } catch (e) {
    log().warn(`[CB] Failed to save model-health.json: ${e}`);
  }
}

// ── Key helpers ───────────────────────────────────────────────────────────────

export function bucketKey(model: string, taskType: string): string {
  return `${model}::${taskType}`;
}

export const GLOBAL_BUCKET = "__global__";

// ── State helpers ─────────────────────────────────────────────────────────────

function pruneWindow(entry: BucketEntry, windowMs: number): BucketEntry {
  const cutoff = Date.now() - windowMs;
  return { ...entry, failures: entry.failures.filter(ts => new Date(ts).getTime() > cutoff) };
}

function resolveState(entry: BucketEntry, cfg: CircuitBreakerConfig): CircuitState {
  if (entry.state === "open" && entry.openedAt) {
    const cooldownMs = cfg.cooldownMinutes * 60 * 1000;
    if (Date.now() - new Date(entry.openedAt).getTime() >= cooldownMs) {
      return "half-open";
    }
  }
  return entry.state;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isOpen(model: string, taskType: string): boolean {
  const cfg = loadConfig();
  if (!cfg.enabled) return false;

  const store = loadStore();
  let dirty = false;

  for (const key of [bucketKey(model, taskType), bucketKey(model, GLOBAL_BUCKET)]) {
    const entry = store.buckets[key];
    if (!entry) continue;

    const windowMs = cfg.windowMinutes * 60 * 1000;
    const pruned = pruneWindow(entry, windowMs);
    const currentState = resolveState(pruned, cfg);

    if (currentState !== entry.state) {
      store.buckets[key] = { ...pruned, state: currentState };
      dirty = true;
    }

    if (currentState === "open") {
      if (dirty) saveStore(store);
      return true;
    }
  }

  if (dirty) saveStore(store);
  return false;
}

export function onSuccess(model: string, taskType: string): void {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  const store = loadStore();
  let dirty = false;

  for (const key of [bucketKey(model, taskType), bucketKey(model, GLOBAL_BUCKET)]) {
    const entry = store.buckets[key];
    if (!entry) continue;

    const windowMs = cfg.windowMinutes * 60 * 1000;
    const pruned = pruneWindow(entry, windowMs);
    const currentState = resolveState(pruned, cfg);

    if (currentState === "half-open" || currentState === "open") {
      log().info(`[CB] Circuit reset → closed: model=${model} task=${taskType} (was ${currentState})`);
      store.buckets[key] = { failures: [], state: "closed" };
      dirty = true;
    } else if (pruned.failures.length !== entry.failures.length) {
      store.buckets[key] = { ...pruned, state: "closed" };
      dirty = true;
    }
  }

  if (dirty) saveStore(store);
}

export function onFailure(
  model: string,
  taskType: string,
  reason: FailureReason,
): void {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  const now = new Date().toISOString();
  const store = loadStore();

  for (const key of [bucketKey(model, taskType), bucketKey(model, GLOBAL_BUCKET)]) {
    let entry: BucketEntry = store.buckets[key] ?? { failures: [], state: "closed" };
    const windowMs = cfg.windowMinutes * 60 * 1000;
    entry = pruneWindow(entry, windowMs);
    entry.failures = [...entry.failures, now];

    const currentState = resolveState(entry, cfg);

    if (currentState !== "open" && entry.failures.length >= cfg.failureThreshold) {
      entry.state = "open";
      entry.openedAt = now;
      log().warn(
        `[CB] Circuit OPENED: model=${model} task=${taskType} ` +
        `reason=${reason} failures=${entry.failures.length}/${cfg.failureThreshold}`,
      );
    } else {
      entry.state = currentState === "open" ? "open" : "closed";
      log().info(
        `[CB] Failure recorded: model=${model} task=${taskType} ` +
        `reason=${reason} count=${entry.failures.length}/${cfg.failureThreshold} state=${entry.state}`,
      );
    }

    store.buckets[key] = entry;
  }

  saveStore(store);
}

export function chooseHealthyModel(
  chain: string[],
  taskType: string,
): string | null {
  const cfg = loadConfig();
  if (!cfg.enabled) return chain[0] ?? null;
  if (chain.length === 0) return null;

  for (const model of chain) {
    if (!isOpen(model, taskType)) return model;
    log().info(`[CB] Skipping open-circuit model: ${model} for task=${taskType}`);
  }

  log().warn(`[CB] All models in chain are open for task=${taskType}, using last-resort: ${chain[chain.length - 1]}`);
  // Return last model as last resort — better than nothing
  return chain[chain.length - 1] ?? null;
}

export function classifyOutcome(params: {
  succeeded: boolean;
  reason?: string;
  durationMs?: number;
  outputLength?: number;
}): FailureReason | null {
  if (params.succeeded) {
    // empty_output is expected for file-write agents (YouTube, meetings)
    // Don't treat it as a failure
    return null;
  }

  const durationMs = params.durationMs ?? 0;
  const reason = params.reason ?? "";

  if (reason === "timeout" || durationMs >= 300_000) return "timeout";
  if (durationMs > 0 && durationMs < 30_000) return "crash";
  if (reason === "error" || reason === "session_dead") return "session_dead";

  return "session_dead";
}

export function getCircuitStatus(): Array<{
  model: string;
  taskType: string;
  state: CircuitState;
  failures: number;
  openedAt?: string;
}> {
  const cfg = loadConfig();
  const store = loadStore();
  const windowMs = cfg.windowMinutes * 60 * 1000;

  return Object.entries(store.buckets).map(([key, entry]) => {
    const sepIdx = key.indexOf("::");
    const model = sepIdx >= 0 ? key.slice(0, sepIdx) : key;
    const taskType = sepIdx >= 0 ? key.slice(sepIdx + 2) : GLOBAL_BUCKET;
    const pruned = pruneWindow(entry, windowMs);
    const state = resolveState(pruned, cfg);
    return { model, taskType, state, failures: pruned.failures.length, openedAt: entry.openedAt };
  });
}

export function resetCircuit(model: string, taskType: string): void {
  const store = loadStore();
  delete store.buckets[bucketKey(model, taskType)];
  delete store.buckets[bucketKey(model, GLOBAL_BUCKET)];
  saveStore(store);
  log().info(`[CB] Circuit manually reset: model=${model} task=${taskType}`);
}
