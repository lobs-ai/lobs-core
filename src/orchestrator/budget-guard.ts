/**
 * Budget Guard — per-lane daily spend cap enforcement with tier downgrade.
 * Port of lobs-server/app/orchestrator/budget_guard.py + budget_guardrails.py
 */

import { gte } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { modelUsageEvents, orchestratorSettings } from "../db/schema.js";
import { log } from "../util/logger.js";
import { eq, and, sum } from "drizzle-orm";

export const LANE_CRITICAL = "critical";
export const LANE_STANDARD = "standard";
export const LANE_BACKGROUND = "background";
export type BudgetLane = "critical" | "standard" | "background";

interface LanePolicy {
  dailyCapUsd: number | null;
  downgradeTier: string | null;
}

const DEFAULT_POLICY: Record<BudgetLane, LanePolicy> = {
  critical:   { dailyCapUsd: null, downgradeTier: null },
  standard:   { dailyCapUsd: 25.0, downgradeTier: "medium" },
  background: { dailyCapUsd: 15.0, downgradeTier: "small" },
};

const TIER_ORDER = ["strong", "large", "medium", "small", "micro"];
const LANE_POLICY_KEY = "budget_guard.lane_policy";

const CRITICAL_KW = ["opus", "gpt-5", "o3", "ultra", "strong"];
const BACKGROUND_KW = ["haiku", "micro", "mini", "ollama", "gemini-nano", "phi", "qwen"];

export function classifyTaskLane(agentType: string, criticality: string, modelTier?: string): BudgetLane {
  if (criticality === "high" || modelTier === "strong") return LANE_CRITICAL;
  if (["writer", "reviewer"].includes(agentType)) return LANE_BACKGROUND;
  return LANE_STANDARD;
}

export function classifyModelLane(modelName: string): BudgetLane {
  const lower = modelName.toLowerCase();
  if (CRITICAL_KW.some(k => lower.includes(k))) return LANE_CRITICAL;
  if (BACKGROUND_KW.some(k => lower.includes(k))) return LANE_BACKGROUND;
  return LANE_STANDARD;
}

export interface BudgetDecision {
  lane: BudgetLane;
  capUsd: number | null;
  spentUsd: number;
  overBudget: boolean;
  originalCandidates: string[];
  effectiveCandidates: string[];
  downgraded: boolean;
  reason: string;
}

export class BudgetGuard {
  private _policy: Record<BudgetLane, LanePolicy> | null = null;

  private loadPolicy(): Record<BudgetLane, LanePolicy> {
    if (this._policy) return this._policy;
    try {
      const db = getDb();
      const row = db.select().from(orchestratorSettings).where(eq(orchestratorSettings.key, LANE_POLICY_KEY)).get();
      if (row?.value && typeof row.value === "object") {
        const raw = row.value as Record<string, unknown>;
        const merged = { ...DEFAULT_POLICY };
        for (const lane of [LANE_CRITICAL, LANE_STANDARD, LANE_BACKGROUND] as BudgetLane[]) {
          if (raw[lane] && typeof raw[lane] === "object") {
            const entry = raw[lane] as Record<string, unknown>;
            if ("dailyCapUsd" in entry) merged[lane].dailyCapUsd = entry.dailyCapUsd as number | null;
            if ("downgradeTier" in entry) merged[lane].downgradeTier = entry.downgradeTier as string | null;
          }
        }
        this._policy = merged;
        return merged;
      }
    } catch (_) { /* use defaults */ }
    this._policy = { ...DEFAULT_POLICY };
    return this._policy;
  }

  todayLaneSpend(lane: BudgetLane): number {
    try {
      const db = getDb();
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      // Query usage events for today, grouped by lane (best effort)
      const rows = db.select({ cost: modelUsageEvents.estimatedCostUsd, model: modelUsageEvents.model, budgetLane: modelUsageEvents.budgetLane })
        .from(modelUsageEvents)
        .where(gte(modelUsageEvents.createdAt, todayStart.toISOString()))
        .all();
      return rows
        .filter(r => (r.budgetLane ?? classifyModelLane(r.model ?? "")) === lane)
        .reduce((acc, r) => acc + (r.cost ?? 0), 0);
    } catch (e) {
      log().warn(`[BUDGET_GUARD] Failed to query spend: ${String(e)}`);
      return 0;
    }
  }

  apply(lane: BudgetLane, candidates: string[]): BudgetDecision {
    const policy = this.loadPolicy();
    const lanePolicy = policy[lane];
    const spent = this.todayLaneSpend(lane);
    const cap = lanePolicy.dailyCapUsd;
    const overBudget = cap !== null && spent >= cap;

    if (!overBudget || !lanePolicy.downgradeTier) {
      return {
        lane, capUsd: cap, spentUsd: spent, overBudget: false,
        originalCandidates: candidates, effectiveCandidates: candidates,
        downgraded: false, reason: "",
      };
    }

    // Filter candidates to tier and below
    const maxIdx = TIER_ORDER.indexOf(lanePolicy.downgradeTier);
    const allowedTiers = maxIdx >= 0 ? new Set(TIER_ORDER.slice(maxIdx)) : null;
    const filtered = allowedTiers
      ? candidates.filter(m => allowedTiers.has(this._guessModelTier(m)))
      : candidates;
    const effective = filtered.length > 0 ? filtered : candidates;

    const reason = `${lane} lane over budget ($${spent.toFixed(2)}/$${cap?.toFixed(2)}). Downgrading to ${lanePolicy.downgradeTier} tier.`;
    log().warn(`[BUDGET_GUARD] ${reason}`);

    return {
      lane, capUsd: cap, spentUsd: spent, overBudget: true,
      originalCandidates: candidates, effectiveCandidates: effective,
      downgraded: effective.length !== candidates.length,
      reason,
    };
  }

  private _guessModelTier(model: string): string {
    const lower = model.toLowerCase();
    if (CRITICAL_KW.some(k => lower.includes(k))) return "strong";
    if (BACKGROUND_KW.some(k => lower.includes(k))) return "micro";
    if (lower.includes("sonnet") || lower.includes("gpt-4")) return "large";
    return "medium";
  }
}
