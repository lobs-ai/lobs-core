/**
 * Usage tracking — aggregates cost, token, and agent metrics from worker_runs.
 *
 * Provides data for the Nexus Usage dashboard:
 * - Daily/weekly/monthly cost
 * - Cost per agent type
 * - Cost per model
 * - Token usage breakdown
 * - Worker success/failure rates
 * - Agent productivity (tasks completed per day)
 */

import { getDb } from "../db/connection.js";
import { workerRuns } from "../db/schema.js";
import { sql, and, gte, lte, eq, desc, count, sum } from "drizzle-orm";
import { log } from "../util/logger.js";

export interface UsageSummary {
  period: string; // "today" | "week" | "month" | "all"
  totalCost: number;
  totalTokens: number;
  totalRuns: number;
  successRate: number;
  avgCostPerRun: number;
  avgDurationSeconds: number;
  byAgent: Record<string, { cost: number; runs: number; successRate: number }>;
  byModel: Record<string, { cost: number; runs: number; tokens: number }>;
}

export interface DailyCost {
  date: string;
  cost: number;
  runs: number;
  tokens: number;
}

export interface UsageDashboard {
  today: UsageSummary;
  week: UsageSummary;
  month: UsageSummary;
  dailyCosts: DailyCost[]; // last 30 days
  recentRuns: Array<{
    id: number;
    agentType: string;
    model: string;
    succeeded: boolean;
    cost: number;
    tokens: number;
    duration: number;
    startedAt: string;
    summary: string;
  }>;
  budget: {
    dailyLimit: number;
    todaySpent: number;
    remaining: number;
    onTrack: boolean;
  };
}

const DAILY_BUDGET_USD = parseFloat(process.env.LOBS_DAILY_BUDGET ?? "5.00");

/**
 * Get usage summary for a time period.
 */
export function getUsageSummary(periodDays: number): UsageSummary {
  const db = getDb();
  const since = new Date(Date.now() - periodDays * 86400000).toISOString();

  const runs = db.select().from(workerRuns)
    .where(gte(workerRuns.startedAt, since))
    .all();

  const totalCost = runs.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
  const totalTokens = runs.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
  const successCount = runs.filter(r => !!r.succeeded).length;

  // By agent
  const byAgent: Record<string, { cost: number; runs: number; succeeded: number }> = {};
  for (const r of runs) {
    const agent = r.agentType ?? "unknown";
    if (!byAgent[agent]) byAgent[agent] = { cost: 0, runs: 0, succeeded: 0 };
    byAgent[agent].cost += r.totalCostUsd ?? 0;
    byAgent[agent].runs += 1;
    if (!!r.succeeded) byAgent[agent].succeeded += 1;
  }

  // By model
  const byModel: Record<string, { cost: number; runs: number; tokens: number }> = {};
  for (const r of runs) {
    const model = r.model ?? "unknown";
    if (!byModel[model]) byModel[model] = { cost: 0, runs: 0, tokens: 0 };
    byModel[model].cost += r.totalCostUsd ?? 0;
    byModel[model].runs += 1;
    byModel[model].tokens += r.totalTokens ?? 0;
  }

  const periodLabel = periodDays === 1 ? "today" : periodDays <= 7 ? "week" : periodDays <= 30 ? "month" : "all";

  return {
    period: periodLabel,
    totalCost: Math.round(totalCost * 10000) / 10000,
    totalTokens,
    totalRuns: runs.length,
    successRate: runs.length > 0 ? Math.round((successCount / runs.length) * 100) / 100 : 0,
    avgCostPerRun: runs.length > 0 ? Math.round((totalCost / runs.length) * 10000) / 10000 : 0,
    avgDurationSeconds: runs.length > 0
      ? Math.round(runs.reduce((s, r) => s + (r.durationSeconds ?? 0), 0) / runs.length)
      : 0,
    byAgent: Object.fromEntries(
      Object.entries(byAgent).map(([k, v]) => [k, {
        cost: Math.round(v.cost * 10000) / 10000,
        runs: v.runs,
        successRate: v.runs > 0 ? Math.round((v.succeeded / v.runs) * 100) / 100 : 0,
      }])
    ),
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([k, v]) => [k, {
        cost: Math.round(v.cost * 10000) / 10000,
        runs: v.runs,
        tokens: v.tokens,
      }])
    ),
  };
}

/**
 * Get daily costs for the last N days.
 */
export function getDailyCosts(days: number = 30): DailyCost[] {
  const db = getDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const runs = db.select().from(workerRuns)
    .where(gte(workerRuns.startedAt, since))
    .all();

  // Group by date
  const byDate: Record<string, { cost: number; runs: number; tokens: number }> = {};

  for (const r of runs) {
    const date = (r.startedAt ?? "").slice(0, 10); // YYYY-MM-DD
    if (!date) continue;
    if (!byDate[date]) byDate[date] = { cost: 0, runs: 0, tokens: 0 };
    byDate[date].cost += r.totalCostUsd ?? 0;
    byDate[date].runs += 1;
    byDate[date].tokens += r.totalTokens ?? 0;
  }

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      cost: Math.round(d.cost * 10000) / 10000,
      runs: d.runs,
      tokens: d.tokens,
    }));
}

/**
 * Get full usage dashboard data.
 */
export function getUsageDashboard(): UsageDashboard {
  const db = getDb();

  const recentRuns = db.select().from(workerRuns)
    .orderBy(desc(workerRuns.startedAt))
    .limit(20)
    .all()
    .map(r => ({
      id: r.id,
      agentType: r.agentType ?? "unknown",
      model: r.model ?? "unknown",
      succeeded: !!r.succeeded,
      cost: Math.round((r.totalCostUsd ?? 0) * 10000) / 10000,
      tokens: r.totalTokens ?? 0,
      duration: Math.round(r.durationSeconds ?? 0),
      startedAt: r.startedAt ?? "",
      summary: (r.summary ?? "").slice(0, 200),
    }));

  const todaySummary = getUsageSummary(1);

  return {
    today: todaySummary,
    week: getUsageSummary(7),
    month: getUsageSummary(30),
    dailyCosts: getDailyCosts(30),
    recentRuns,
    budget: {
      dailyLimit: DAILY_BUDGET_USD,
      todaySpent: todaySummary.totalCost,
      remaining: Math.max(0, DAILY_BUDGET_USD - todaySummary.totalCost),
      onTrack: todaySummary.totalCost <= DAILY_BUDGET_USD,
    },
  };
}
