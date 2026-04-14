/**
 * Provider Usage Tracker — monitors spend per provider against subscription limits.
 *
 * Supports multi-provider model routing with hard caps for providers like
 * OpenCode Go ($12/5hr, $30/week, $60/month).
 *
 * Storage: ~/.lobs/data/usage-tracking.json (JSON, pruned to 90 days)
 * Auto-saves after every record(), debounced to at most once per 5 seconds.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getLobsRoot } from "../config/lobs.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UsageLimits {
  /** Max spend per 5-hour rolling window */
  per5Hours?: number;
  /** Max spend per rolling week */
  perWeek?: number;
  /** Max spend per calendar month */
  perMonth?: number;
  /** Hard daily limit */
  perDay?: number;
}

export interface UsageRecord {
  providerId: string;
  modelId: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** USD, calculated from provider's per-token pricing */
  estimatedCost: number;
  /** What type of task used this */
  taskCategory: string;
  latencyMs: number;
  success: boolean;
}

export interface UsageSummary {
  providerId: string;
  last5Hours: number;
  last24Hours: number;
  lastWeek: number;
  thisMonth: number;
  totalAllTime: number;
  limits: UsageLimits;
  /** Are all limits respected? */
  withinLimits: boolean;
  limitDetails: {
    per5Hours?: { used: number; limit: number; remaining: number; blocked: boolean };
    perWeek?: { used: number; limit: number; remaining: number; blocked: boolean };
    perMonth?: { used: number; limit: number; remaining: number; blocked: boolean };
    perDay?: { used: number; limit: number; remaining: number; blocked: boolean };
  };
}

// ── Pricing ───────────────────────────────────────────────────────────────────

/** Prices in USD per 1M tokens */
const PRICING: Record<string, Record<string, { input: number; output: number; cached?: number }>> = {
  "opencode-zen": {
    "minimax-m2.5-free": { input: 0, output: 0 },
    "minimax-m2.5": { input: 0.30, output: 1.20, cached: 0.06 },
    "glm-5": { input: 1.00, output: 3.20, cached: 0.20 },
    "kimi-k2.5": { input: 0.60, output: 3.00, cached: 0.10 },
    "qwen3.6-plus-free": { input: 0, output: 0 },
    "mimo-v2-pro-free": { input: 0, output: 0 },
    "mimo-v2-omni-free": { input: 0, output: 0 },
    "nemotron-3-super-free": { input: 0, output: 0 },
    "big-pickle": { input: 0, output: 0 },
    "gpt-5-nano": { input: 0, output: 0 },
  },
  "opencode-go": {
    "glm-5": { input: 1.00, output: 3.20 },
    "kimi-k2.5": { input: 0.60, output: 3.00 },
    "mimo-v2-pro": { input: 0.35, output: 1.50 },
    "mimo-v2-omni": { input: 0.20, output: 0.80 },
    "minimax-m2.5": { input: 0.30, output: 1.20 },
    "MiniMax-M2.7": { input: 0, output: 0 },  // Unlimited subscription
  },
  "z-ai": {
    "glm-4.7-flash": { input: 0, output: 0 },
    "glm-4.5-flash": { input: 0, output: 0 },
    "glm-5": { input: 1.00, output: 3.20 },
    "glm-4.7": { input: 0.60, output: 2.20 },
  },
  "minimax": {
    "minimax-m2.5": { input: 0.20, output: 1.00 },
  },
  "kimi": {
    "kimi-k2.5": { input: 0.42, output: 2.20 },
  },
};

// ── Default Limits ────────────────────────────────────────────────────────────

const DEFAULT_LIMITS: Record<string, UsageLimits> = {
  "opencode-go": {
    per5Hours: 12,
    perWeek: 30,
    perMonth: 60,
  },
  "opencode-zen": {
    perMonth: 50,
  },
  "z-ai": {
    perMonth: 20,
  },
  "minimax": {
    perMonth: 20,
  },
  "kimi": {
    perMonth: 20,
  },
  // anthropic, openai — no default limits (managed separately)
};

// ── Storage ───────────────────────────────────────────────────────────────────

const DB_PATH = join(getLobsRoot(), "data", "usage-tracking.json");
const PRUNE_DAYS = 90;
const MAX_RECORDS = 10_000;
const SAVE_DEBOUNCE_MS = 5_000;

interface StorageFormat {
  records: UsageRecord[];
  customLimits: Record<string, UsageLimits>;
  lastPrune: number;
}

// ── UsageTracker ──────────────────────────────────────────────────────────────

export class UsageTracker {
  private records: UsageRecord[] = [];
  private limits: Map<string, UsageLimits> = new Map();
  private dbPath: string;
  private saveDebounceTimer: NodeJS.Timeout | undefined;

  constructor(dbPath: string = DB_PATH) {
    this.dbPath = dbPath;
    this.load();
  }

  /**
   * Record a usage event. Auto-saves to disk (debounced, at most once per 5s).
   */
  record(event: Omit<UsageRecord, "timestamp">): void {
    const entry: UsageRecord = {
      ...event,
      timestamp: Date.now(),
    };
    this.records.push(entry);
    this.scheduleSave();
  }

  /**
   * Check if a provider is within its usage limits.
   * Returns true if the provider can accept more requests.
   */
  canUse(providerId: string): boolean {
    const summary = this.getSummary(providerId);
    return summary.withinLimits;
  }

  /**
   * Get detailed usage summary for a provider.
   */
  getSummary(providerId: string): UsageSummary {
    const now = Date.now();
    const ms5h = 5 * 60 * 60 * 1000;
    const ms24h = 24 * 60 * 60 * 1000;
    const ms7d = 7 * 24 * 60 * 60 * 1000;

    const providerRecords = this.records.filter(r => r.providerId === providerId);

    const last5Hours = sumCost(providerRecords, now - ms5h, now);
    const last24Hours = sumCost(providerRecords, now - ms24h, now);
    const lastWeek = sumCost(providerRecords, now - ms7d, now);
    const thisMonth = sumMonthCost(providerRecords, now);
    const totalAllTime = providerRecords.reduce((s, r) => s + r.estimatedCost, 0);

    const limits = this.getLimits(providerId);

    const limitDetails: UsageSummary["limitDetails"] = {};
    let withinLimits = true;

    if (limits.per5Hours !== undefined) {
      const remaining = Math.max(0, limits.per5Hours - last5Hours);
      const blocked = last5Hours >= limits.per5Hours;
      if (blocked) withinLimits = false;
      limitDetails.per5Hours = { used: last5Hours, limit: limits.per5Hours, remaining, blocked };
    }

    if (limits.perWeek !== undefined) {
      const remaining = Math.max(0, limits.perWeek - lastWeek);
      const blocked = lastWeek >= limits.perWeek;
      if (blocked) withinLimits = false;
      limitDetails.perWeek = { used: lastWeek, limit: limits.perWeek, remaining, blocked };
    }

    if (limits.perMonth !== undefined) {
      const remaining = Math.max(0, limits.perMonth - thisMonth);
      const blocked = thisMonth >= limits.perMonth;
      if (blocked) withinLimits = false;
      limitDetails.perMonth = { used: thisMonth, limit: limits.perMonth, remaining, blocked };
    }

    if (limits.perDay !== undefined) {
      const remaining = Math.max(0, limits.perDay - last24Hours);
      const blocked = last24Hours >= limits.perDay;
      if (blocked) withinLimits = false;
      limitDetails.perDay = { used: last24Hours, limit: limits.perDay, remaining, blocked };
    }

    return {
      providerId,
      last5Hours,
      last24Hours,
      lastWeek,
      thisMonth,
      totalAllTime,
      limits,
      withinLimits,
      limitDetails,
    };
  }

  /**
   * Get summaries for all providers that have records or configured limits.
   */
  getAllSummaries(): UsageSummary[] {
    const providerIds = new Set<string>();
    for (const r of this.records) providerIds.add(r.providerId);
    for (const id of Object.keys(DEFAULT_LIMITS)) providerIds.add(id);
    for (const id of this.limits.keys()) providerIds.add(id);
    return Array.from(providerIds).map(id => this.getSummary(id));
  }

  /**
   * Estimate cost for a request before making it.
   * Returns 0 if the provider/model is unknown (assumed free or tracked elsewhere).
   */
  estimateCost(
    providerId: string,
    modelId: string,
    estimatedInputTokens: number,
    estimatedOutputTokens: number,
  ): number {
    const providerPricing = PRICING[providerId];
    if (!providerPricing) return 0;
    const modelPricing = providerPricing[modelId];
    if (!modelPricing) return 0;
    return (estimatedInputTokens * modelPricing.input + estimatedOutputTokens * modelPricing.output) / 1_000_000;
  }

  /**
   * Set custom limits for a provider (persisted to disk).
   */
  setLimits(providerId: string, limits: UsageLimits): void {
    this.limits.set(providerId, limits);
    this.scheduleSave();
  }

  /**
   * Prune records older than 90 days.
   */
  prune(): void {
    const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
    this.records = this.records.filter(r => r.timestamp >= cutoff);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private getLimits(providerId: string): UsageLimits {
    return this.limits.get(providerId) ?? DEFAULT_LIMITS[providerId] ?? {};
  }

  private scheduleSave(): void {
    if (this.saveDebounceTimer !== undefined) return;
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = undefined;
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private save(): void {
    // Prune on save if record count is too high
    if (this.records.length > MAX_RECORDS) {
      this.prune();
    }

    const customLimits: Record<string, UsageLimits> = {};
    for (const [id, lim] of this.limits.entries()) {
      customLimits[id] = lim;
    }

    const data: StorageFormat = {
      records: this.records,
      customLimits,
      lastPrune: Date.now(),
    };

    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      writeFileSync(this.dbPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.error("[UsageTracker] Failed to save:", err);
    }
  }

  private load(): void {
    if (!existsSync(this.dbPath)) {
      this.records = [];
      this.limits = new Map();
      return;
    }

    try {
      const raw = readFileSync(this.dbPath, "utf8");
      const data = JSON.parse(raw) as StorageFormat;
      this.records = Array.isArray(data.records) ? data.records : [];
      this.limits = new Map(Object.entries(data.customLimits ?? {}));
    } catch (err) {
      console.error("[UsageTracker] Failed to load, starting fresh:", err);
      this.records = [];
      this.limits = new Map();
    }

    // Always prune on load
    this.prune();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sumCost(records: UsageRecord[], fromMs: number, toMs: number): number {
  return records
    .filter(r => r.timestamp >= fromMs && r.timestamp <= toMs)
    .reduce((s, r) => s + r.estimatedCost, 0);
}

function sumMonthCost(records: UsageRecord[], now: number): number {
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return sumCost(records, monthStart, now);
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _tracker: UsageTracker | null = null;

export function getUsageTracker(): UsageTracker {
  if (!_tracker) {
    _tracker = new UsageTracker();
  }
  return _tracker;
}

export function resetUsageTracker(): void {
  _tracker = null;
}
