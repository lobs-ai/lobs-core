/**
 * Budget Guard — BudgetGuard class DB tests.
 *
 * Tests the `BudgetGuard.apply()` and `todayLaneSpend()` methods which read from
 * `model_usage_events` and `orchestrator_settings` tables. The in-memory DB is
 * already initialized by tests/setup.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getRawDb } from "../src/db/connection.js";
import {
  BudgetGuard,
  LANE_CRITICAL,
  LANE_STANDARD,
  LANE_BACKGROUND,
} from "../src/orchestrator/budget-guard.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function clearUsageEvents(): void {
  getRawDb().prepare(`DELETE FROM model_usage_events`).run();
}

function clearSettings(): void {
  getRawDb().prepare(`DELETE FROM orchestrator_settings WHERE key = 'budget_guard.lane_policy'`).run();
}

function insertUsageEvent(opts: {
  model: string;
  cost: number;
  budgetLane?: string;
  createdAt?: string;
}): void {
  const db = getRawDb();
  const now = opts.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO model_usage_events
       (id, model, provider, estimated_cost_usd, budget_lane, created_at, timestamp, source)
     VALUES (lower(hex(randomblob(8))), ?, 'test-provider', ?, ?, ?, ?, 'test')`
  ).run(opts.model, opts.cost, opts.budgetLane ?? null, now, now);
}

function setLanePolicy(policy: Record<string, unknown>): void {
  const db = getRawDb();
  db.prepare(
    `INSERT OR REPLACE INTO orchestrator_settings (key, value) VALUES ('budget_guard.lane_policy', ?)`
  ).run(JSON.stringify(policy));
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("BudgetGuard.apply — no budget events", () => {
  beforeEach(() => {
    clearUsageEvents();
    clearSettings();
  });

  it("returns not-over-budget with empty usage", () => {
    const guard = new BudgetGuard();
    const result = guard.apply(LANE_STANDARD, ["model-a", "model-b"]);
    expect(result.overBudget).toBe(false);
    expect(result.downgraded).toBe(false);
    expect(result.effectiveCandidates).toEqual(["model-a", "model-b"]);
    expect(result.lane).toBe(LANE_STANDARD);
  });

  it("critical lane has no cap by default — never over budget", () => {
    const guard = new BudgetGuard();
    // Insert huge cost, critical should still not cap
    insertUsageEvent({ model: "gpt-5-opus", cost: 9999, budgetLane: LANE_CRITICAL });
    const result = guard.apply(LANE_CRITICAL, ["gpt-5-opus"]);
    expect(result.capUsd).toBeNull();
    expect(result.overBudget).toBe(false);
  });

  it("standard lane default cap is $25", () => {
    const guard = new BudgetGuard();
    const result = guard.apply(LANE_STANDARD, ["model-a"]);
    expect(result.capUsd).toBe(25.0);
  });

  it("background lane default cap is $15", () => {
    const guard = new BudgetGuard();
    const result = guard.apply(LANE_BACKGROUND, ["model-a"]);
    expect(result.capUsd).toBe(15.0);
  });
});

describe("BudgetGuard.apply — over-budget triggers downgrade", () => {
  beforeEach(() => {
    clearUsageEvents();
    clearSettings();
  });

  // standard lane downgrades to "medium"; TIER_ORDER = ["strong","large","medium","small","micro"]
  // TIER_ORDER.slice(indexOf("medium")) = ["medium","small","micro"]
  // "claude-opus-strong" → "strong" tier (contains "strong") → filtered OUT
  // "claude-sonnet-large" → "large" tier (contains "sonnet") → filtered OUT
  // filtered = [] → falls back to original candidates, downgraded = false
  it("standard lane over $25 → reports overBudget + reason", () => {
    for (let i = 0; i < 26; i++) {
      insertUsageEvent({ model: "claude-3-sonnet", cost: 1.0, budgetLane: LANE_STANDARD });
    }
    const guard = new BudgetGuard();
    const result = guard.apply(LANE_STANDARD, ["claude-opus-strong", "claude-sonnet-large"]);
    expect(result.overBudget).toBe(true);
    expect(result.reason).toMatch(/over budget/i);
    expect(result.spentUsd).toBeCloseTo(26.0, 1);
    expect(result.capUsd).toBe(25.0);
    // Both are too "large/strong" — falls back to originals
    expect(result.effectiveCandidates.length).toBeGreaterThan(0);
  });

  // background lane downgrades to "small"; slice(indexOf("small")) = ["small","micro"]
  // "claude-3-haiku" → "micro" tier (contains "haiku") → KEPT
  // "claude-opus" → "strong" tier (contains "opus") → filtered OUT
  it("background lane over $15 → filters out strong models, keeps micro/small", () => {
    for (let i = 0; i < 16; i++) {
      insertUsageEvent({ model: "haiku", cost: 1.0, budgetLane: LANE_BACKGROUND });
    }
    const guard = new BudgetGuard();
    const result = guard.apply(LANE_BACKGROUND, ["claude-3-haiku", "claude-opus"]);
    expect(result.overBudget).toBe(true);
    // haiku → micro → in ["small","micro"] → kept; opus → strong → not in set → filtered
    expect(result.effectiveCandidates).not.toContain("claude-opus");
    expect(result.effectiveCandidates).toContain("claude-3-haiku");
    expect(result.downgraded).toBe(true);
  });

  it("reports spent amount correctly", () => {
    insertUsageEvent({ model: "claude-3-sonnet", cost: 10.5, budgetLane: LANE_STANDARD });
    insertUsageEvent({ model: "claude-3-sonnet", cost: 8.25, budgetLane: LANE_STANDARD });
    const guard = new BudgetGuard();
    const result = guard.apply(LANE_STANDARD, ["any-model"]);
    // 10.5 + 8.25 = 18.75 — under $25 cap
    expect(result.spentUsd).toBeCloseTo(18.75, 2);
    expect(result.overBudget).toBe(false);
  });

  it("over-budget with no candidates below cap → falls back to original candidates", () => {
    for (let i = 0; i < 30; i++) {
      insertUsageEvent({ model: "claude-sonnet", cost: 1.0, budgetLane: LANE_STANDARD });
    }
    const guard = new BudgetGuard();
    // All candidates are "strong" → none survive the downgrade filter → falls back to originals
    const candidates = ["claude-opus-4", "gpt-5-ultra"];
    const result = guard.apply(LANE_STANDARD, candidates);
    expect(result.effectiveCandidates.length).toBeGreaterThan(0);
  });

  it("events from yesterday don't count against today's budget", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    insertUsageEvent({ model: "claude-3-sonnet", cost: 99.0, budgetLane: LANE_STANDARD, createdAt: yesterday });
    const guard = new BudgetGuard();
    const result = guard.apply(LANE_STANDARD, ["model-a"]);
    // Yesterday's spend doesn't count — should be under cap
    expect(result.overBudget).toBe(false);
    expect(result.spentUsd).toBe(0);
  });
});

describe("BudgetGuard — custom policy from DB", () => {
  beforeEach(() => {
    clearUsageEvents();
    clearSettings();
  });

  it("reads custom dailyCapUsd from orchestrator_settings", () => {
    // Set a very low cap for standard lane
    setLanePolicy({ standard: { dailyCapUsd: 1.0, downgradeTier: "small" } });
    insertUsageEvent({ model: "claude-sonnet", cost: 2.0, budgetLane: LANE_STANDARD });
    const guard = new BudgetGuard();
    const result = guard.apply(LANE_STANDARD, ["claude-sonnet-large", "haiku-micro"]);
    expect(result.capUsd).toBe(1.0);
    expect(result.overBudget).toBe(true);
  });

  it("reads custom cap of null (uncapped) from orchestrator_settings", () => {
    setLanePolicy({ standard: { dailyCapUsd: null, downgradeTier: null } });
    insertUsageEvent({ model: "model-x", cost: 9999.0, budgetLane: LANE_STANDARD });
    const guard = new BudgetGuard();
    const result = guard.apply(LANE_STANDARD, ["model-x"]);
    expect(result.capUsd).toBeNull();
    expect(result.overBudget).toBe(false);
  });
});

describe("BudgetGuard.todayLaneSpend", () => {
  beforeEach(() => {
    clearUsageEvents();
    clearSettings();
  });

  it("returns 0 when no events today", () => {
    const guard = new BudgetGuard();
    expect(guard.todayLaneSpend(LANE_STANDARD)).toBe(0);
  });

  it("sums only events in the matching lane", () => {
    insertUsageEvent({ model: "claude-sonnet", cost: 5.0, budgetLane: LANE_STANDARD });
    insertUsageEvent({ model: "claude-haiku", cost: 3.0, budgetLane: LANE_BACKGROUND });
    insertUsageEvent({ model: "claude-opus", cost: 10.0, budgetLane: LANE_CRITICAL });
    const guard = new BudgetGuard();
    expect(guard.todayLaneSpend(LANE_STANDARD)).toBeCloseTo(5.0, 2);
    expect(guard.todayLaneSpend(LANE_BACKGROUND)).toBeCloseTo(3.0, 2);
    expect(guard.todayLaneSpend(LANE_CRITICAL)).toBeCloseTo(10.0, 2);
  });

  it("falls back to classifyModelLane when budget_lane is null", () => {
    // No budget_lane set → classified from model name
    insertUsageEvent({ model: "claude-3-haiku", cost: 4.0, budgetLane: undefined });
    const guard = new BudgetGuard();
    // haiku → BACKGROUND lane
    expect(guard.todayLaneSpend(LANE_BACKGROUND)).toBeCloseTo(4.0, 2);
  });

  it("multiple events accumulate correctly", () => {
    insertUsageEvent({ model: "some-sonnet", cost: 2.5, budgetLane: LANE_STANDARD });
    insertUsageEvent({ model: "some-sonnet", cost: 3.5, budgetLane: LANE_STANDARD });
    insertUsageEvent({ model: "some-sonnet", cost: 1.0, budgetLane: LANE_STANDARD });
    const guard = new BudgetGuard();
    expect(guard.todayLaneSpend(LANE_STANDARD)).toBeCloseTo(7.0, 2);
  });
});
