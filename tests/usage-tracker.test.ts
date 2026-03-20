/**
 * Tests for src/services/usage-tracker.ts
 *
 * Covers:
 *   - getUsageSummary: period labels, totals, byAgent, byModel, success rate
 *   - getDailyCosts: grouping by date, sorting, empty periods
 *   - getUsageDashboard: full composite, budget tracking, recentRuns limit
 *   - Edge cases: zero cost runs, missing fields (null model/agent/cost)
 *   - LOBS_DAILY_BUDGET env var overrides the budget limit
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRawDb } from "../src/db/connection.js";
import {
  getUsageSummary,
  getDailyCosts,
  getUsageDashboard,
} from "../src/services/usage-tracker.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function clearRuns() {
  getRawDb().exec("DELETE FROM worker_runs");
}

function seedRun(opts: {
  agentType?: string;
  model?: string;
  succeeded?: boolean;
  totalCostUsd?: number;
  totalTokens?: number;
  durationSeconds?: number;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
}) {
  const now = new Date().toISOString();
  const raw = getRawDb();
  raw.prepare(`
    INSERT INTO worker_runs
      (agent_type, model, succeeded, total_cost_usd, total_tokens, duration_seconds,
       started_at, ended_at, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.agentType ?? "programmer",
    opts.model ?? "claude-3-haiku",
    opts.succeeded === false ? 0 : 1,
    opts.totalCostUsd ?? 0,
    opts.totalTokens ?? 0,
    opts.durationSeconds ?? null,
    opts.startedAt ?? now,
    opts.endedAt ?? now,
    opts.summary ?? null,
  );
}

/** Returns an ISO timestamp for N days in the past */
function daysAgo(n: number, hour = 12): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

beforeEach(() => clearRuns());

// ── getUsageSummary ──────────────────────────────────────────────────────────

describe("getUsageSummary", () => {
  it("returns all zeros when no runs exist", () => {
    const s = getUsageSummary(1);
    expect(s.totalCost).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.totalRuns).toBe(0);
    expect(s.successRate).toBe(0);
    expect(s.avgCostPerRun).toBe(0);
    expect(s.avgDurationSeconds).toBe(0);
    expect(s.byAgent).toEqual({});
    expect(s.byModel).toEqual({});
  });

  it("labels period=1 as 'today'", () => {
    expect(getUsageSummary(1).period).toBe("today");
  });

  it("labels period=7 as 'week'", () => {
    expect(getUsageSummary(7).period).toBe("week");
  });

  it("labels period=30 as 'month'", () => {
    expect(getUsageSummary(30).period).toBe("month");
  });

  it("labels period=365 as 'all'", () => {
    expect(getUsageSummary(365).period).toBe("all");
  });

  it("sums totalCost, totalTokens, and counts runs", () => {
    seedRun({ totalCostUsd: 0.0025, totalTokens: 1500, succeeded: true });
    seedRun({ totalCostUsd: 0.0050, totalTokens: 3000, succeeded: true });
    seedRun({ totalCostUsd: 0.0010, totalTokens: 500, succeeded: false });

    const s = getUsageSummary(1);
    expect(s.totalRuns).toBe(3);
    expect(s.totalTokens).toBe(5000);
    expect(s.totalCost).toBeCloseTo(0.0085, 4);
  });

  it("computes successRate correctly", () => {
    seedRun({ succeeded: true });
    seedRun({ succeeded: true });
    seedRun({ succeeded: false });

    const s = getUsageSummary(1);
    expect(s.successRate).toBeCloseTo(0.67, 2);
  });

  it("successRate = 1.0 when all runs succeed", () => {
    seedRun({ succeeded: true });
    seedRun({ succeeded: true });
    expect(getUsageSummary(1).successRate).toBe(1);
  });

  it("successRate = 0 when all runs fail", () => {
    seedRun({ succeeded: false });
    seedRun({ succeeded: false });
    expect(getUsageSummary(1).successRate).toBe(0);
  });

  it("computes avgCostPerRun", () => {
    seedRun({ totalCostUsd: 0.01 });
    seedRun({ totalCostUsd: 0.03 });

    const s = getUsageSummary(1);
    expect(s.avgCostPerRun).toBeCloseTo(0.02, 4);
  });

  it("computes avgDurationSeconds", () => {
    seedRun({ durationSeconds: 10 });
    seedRun({ durationSeconds: 30 });

    const s = getUsageSummary(1);
    expect(s.avgDurationSeconds).toBe(20);
  });

  it("groups byAgent correctly", () => {
    seedRun({ agentType: "programmer", totalCostUsd: 0.005, succeeded: true });
    seedRun({ agentType: "programmer", totalCostUsd: 0.005, succeeded: false });
    seedRun({ agentType: "researcher", totalCostUsd: 0.010, succeeded: true });

    const s = getUsageSummary(1);
    expect(s.byAgent["programmer"].runs).toBe(2);
    expect(s.byAgent["programmer"].cost).toBeCloseTo(0.01, 4);
    expect(s.byAgent["programmer"].successRate).toBeCloseTo(0.5, 2);
    expect(s.byAgent["researcher"].runs).toBe(1);
    expect(s.byAgent["researcher"].successRate).toBe(1);
  });

  it("groups byModel correctly", () => {
    seedRun({ model: "claude-3-haiku", totalCostUsd: 0.002, totalTokens: 1000 });
    seedRun({ model: "claude-3-haiku", totalCostUsd: 0.003, totalTokens: 1500 });
    seedRun({ model: "claude-3-opus", totalCostUsd: 0.050, totalTokens: 8000 });

    const s = getUsageSummary(1);
    expect(s.byModel["claude-3-haiku"].runs).toBe(2);
    expect(s.byModel["claude-3-haiku"].tokens).toBe(2500);
    expect(s.byModel["claude-3-opus"].cost).toBeCloseTo(0.05, 4);
  });

  it("handles null model/agentType as 'unknown'", () => {
    const raw = getRawDb();
    const now = new Date().toISOString();
    raw.prepare(`
      INSERT INTO worker_runs (started_at) VALUES (?)
    `).run(now);

    const s = getUsageSummary(1);
    expect(s.byAgent["unknown"]).toBeTruthy();
    expect(s.byModel["unknown"]).toBeTruthy();
  });

  it("only includes runs within the period (filters old runs)", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 0.01 });  // today ✓
    seedRun({ startedAt: daysAgo(2), totalCostUsd: 0.99 });  // 2 days ago ✗ for period=1

    const s = getUsageSummary(1);
    expect(s.totalRuns).toBe(1);
    expect(s.totalCost).toBeCloseTo(0.01, 4);
  });

  it("period=7 includes runs from last week", () => {
    seedRun({ startedAt: daysAgo(6), totalCostUsd: 0.01 });  // 6 days ago ✓
    seedRun({ startedAt: daysAgo(8), totalCostUsd: 0.99 });  // 8 days ago ✗

    const s = getUsageSummary(7);
    expect(s.totalRuns).toBe(1);
  });

  it("rounds cost to 4 decimal places", () => {
    // 3 * 0.0001234 = 0.0003702 — rounds to 0.0004
    seedRun({ totalCostUsd: 0.0001234 });
    seedRun({ totalCostUsd: 0.0001234 });
    seedRun({ totalCostUsd: 0.0001234 });

    const s = getUsageSummary(1);
    // Value should be rounded to 4 decimal places
    expect(s.totalCost.toString().replace("0.", "").length).toBeLessThanOrEqual(4);
  });
});

// ── getDailyCosts ────────────────────────────────────────────────────────────

describe("getDailyCosts", () => {
  it("returns empty array when no runs", () => {
    expect(getDailyCosts(7)).toEqual([]);
  });

  it("groups runs by YYYY-MM-DD date", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 0.01, totalTokens: 100 });
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 0.02, totalTokens: 200 });
    seedRun({ startedAt: daysAgo(1), totalCostUsd: 0.05, totalTokens: 500 });

    const costs = getDailyCosts(7);
    expect(costs).toHaveLength(2);
    // daysAgo(0) uses local hour=12 → find the date by matching the inserted startedAt
    const todayDate = daysAgo(0).slice(0, 10);
    const today = costs.find(c => c.date === todayDate);
    expect(today?.runs).toBe(2);
    expect(today?.cost).toBeCloseTo(0.03, 4);
    expect(today?.tokens).toBe(300);
  });

  it("returns dates sorted ascending (oldest first)", () => {
    seedRun({ startedAt: daysAgo(2), totalCostUsd: 0.01 });
    seedRun({ startedAt: daysAgo(1), totalCostUsd: 0.02 });
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 0.03 });

    const costs = getDailyCosts(7);
    expect(costs).toHaveLength(3);
    // Verify ascending order
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i].date >= costs[i - 1].date).toBe(true);
    }
  });

  it("respects the days parameter (excludes older runs)", () => {
    seedRun({ startedAt: daysAgo(3), totalCostUsd: 0.01 });  // within 7 days ✓
    seedRun({ startedAt: daysAgo(10), totalCostUsd: 0.99 }); // outside 7 days ✗

    const costs = getDailyCosts(7);
    expect(costs).toHaveLength(1);
  });

  it("default days=30 returns up to 30 days", () => {
    // Seed runs spanning 31 days (29 within, 1 outside)
    seedRun({ startedAt: daysAgo(5), totalCostUsd: 0.01 });
    seedRun({ startedAt: daysAgo(29), totalCostUsd: 0.01 });
    seedRun({ startedAt: daysAgo(31), totalCostUsd: 0.99 }); // outside

    const costs = getDailyCosts();
    expect(costs).toHaveLength(2);
  });

  it("each DailyCost has date, cost, runs, tokens fields", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 0.005, totalTokens: 200 });
    const [entry] = getDailyCosts(1);
    expect(typeof entry.date).toBe("string");
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof entry.cost).toBe("number");
    expect(typeof entry.runs).toBe("number");
    expect(typeof entry.tokens).toBe("number");
  });
});

// ── getUsageDashboard ────────────────────────────────────────────────────────

describe("getUsageDashboard", () => {
  it("returns dashboard with today/week/month summaries", () => {
    const dashboard = getUsageDashboard();
    expect(dashboard.today.period).toBe("today");
    expect(dashboard.week.period).toBe("week");
    expect(dashboard.month.period).toBe("month");
  });

  it("includes dailyCosts for last 30 days", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 0.01 });
    const dashboard = getUsageDashboard();
    expect(Array.isArray(dashboard.dailyCosts)).toBe(true);
    expect(dashboard.dailyCosts.length).toBeGreaterThanOrEqual(1);
  });

  it("limits recentRuns to 20", () => {
    for (let i = 0; i < 25; i++) {
      seedRun({ totalCostUsd: 0.001 });
    }
    const dashboard = getUsageDashboard();
    expect(dashboard.recentRuns.length).toBeLessThanOrEqual(20);
  });

  it("recentRuns have correct shape", () => {
    seedRun({
      agentType: "programmer",
      model: "claude-3-haiku",
      succeeded: true,
      totalCostUsd: 0.005,
      totalTokens: 1200,
      durationSeconds: 45,
      summary: "Completed task",
    });

    const dashboard = getUsageDashboard();
    const run = dashboard.recentRuns[0];
    expect(run.agentType).toBe("programmer");
    expect(run.model).toBe("claude-3-haiku");
    expect(run.succeeded).toBe(true);
    expect(run.cost).toBeCloseTo(0.005, 4);
    expect(run.tokens).toBe(1200);
    expect(run.duration).toBe(45);
    expect(run.summary).toBe("Completed task");
    expect(typeof run.startedAt).toBe("string");
  });

  it("truncates summary to 200 chars in recentRuns", () => {
    const longSummary = "x".repeat(300);
    seedRun({ summary: longSummary });

    const dashboard = getUsageDashboard();
    expect(dashboard.recentRuns[0].summary.length).toBeLessThanOrEqual(200);
  });

  it("budget reflects dailyLimit and todaySpent", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 1.50 });

    const dashboard = getUsageDashboard();
    expect(typeof dashboard.budget.dailyLimit).toBe("number");
    expect(dashboard.budget.todaySpent).toBeCloseTo(1.50, 4);
    expect(dashboard.budget.remaining).toBeGreaterThanOrEqual(0);
    expect(typeof dashboard.budget.onTrack).toBe("boolean");
  });

  it("budget.onTrack=true when under dailyLimit", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 0.10 }); // under $5 default

    const dashboard = getUsageDashboard();
    expect(dashboard.budget.onTrack).toBe(true);
  });

  it("budget.onTrack=false when over dailyLimit", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 99.99 }); // over default

    const dashboard = getUsageDashboard();
    expect(dashboard.budget.onTrack).toBe(false);
    expect(dashboard.budget.remaining).toBe(0); // Clamped to 0
  });

  it("budget.remaining is clamped to 0 (never negative)", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 100.00 }); // massive cost

    const dashboard = getUsageDashboard();
    expect(dashboard.budget.remaining).toBe(0);
  });

  it("week summary includes today's runs", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 0.05 }); // today
    seedRun({ startedAt: daysAgo(3), totalCostUsd: 0.10 }); // within week

    const dashboard = getUsageDashboard();
    expect(dashboard.week.totalRuns).toBe(2);
    expect(dashboard.week.totalCost).toBeCloseTo(0.15, 4);
  });

  it("month includes runs from last 30 days but not older", () => {
    seedRun({ startedAt: daysAgo(0), totalCostUsd: 0.01 });
    seedRun({ startedAt: daysAgo(29), totalCostUsd: 0.01 });
    seedRun({ startedAt: daysAgo(31), totalCostUsd: 0.99 }); // outside

    const dashboard = getUsageDashboard();
    expect(dashboard.month.totalRuns).toBe(2);
  });
});

// ── LOBS_DAILY_BUDGET env override ───────────────────────────────────────────

describe("LOBS_DAILY_BUDGET env override", () => {
  it("is a positive number by default (e.g. $5)", () => {
    const dashboard = getUsageDashboard();
    expect(dashboard.budget.dailyLimit).toBeGreaterThan(0);
    expect(dashboard.budget.dailyLimit).toBe(
      parseFloat(process.env.LOBS_DAILY_BUDGET ?? "5.00"),
    );
  });
});

// ── Zero-cost runs and edge cases ────────────────────────────────────────────

describe("edge cases", () => {
  it("handles runs with null cost gracefully (treats as 0)", () => {
    const raw = getRawDb();
    const now = new Date().toISOString();
    raw.prepare(`
      INSERT INTO worker_runs (agent_type, model, succeeded, started_at)
      VALUES (?, ?, ?, ?)
    `).run("programmer", "claude", 1, now);

    const s = getUsageSummary(1);
    expect(s.totalCost).toBe(0);
    expect(s.totalRuns).toBe(1);
  });

  it("handles runs with null duration (treats as 0)", () => {
    const raw = getRawDb();
    const now = new Date().toISOString();
    raw.prepare(`
      INSERT INTO worker_runs (agent_type, model, started_at)
      VALUES (?, ?, ?)
    `).run("programmer", "claude", now);

    const s = getUsageSummary(1);
    expect(s.avgDurationSeconds).toBe(0);
  });

  it("byModel sums tokens across multiple runs", () => {
    seedRun({ model: "claude-3-haiku", totalTokens: 500 });
    seedRun({ model: "claude-3-haiku", totalTokens: 300 });
    seedRun({ model: "claude-3-haiku", totalTokens: 200 });

    const s = getUsageSummary(1);
    expect(s.byModel["claude-3-haiku"].tokens).toBe(1000);
  });

  it("single run - successRate is either 0 or 1", () => {
    seedRun({ succeeded: true });
    expect(getUsageSummary(1).successRate).toBe(1);

    clearRuns();
    seedRun({ succeeded: false });
    expect(getUsageSummary(1).successRate).toBe(0);
  });
});
