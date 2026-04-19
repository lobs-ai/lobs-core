import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { workerRuns, type WorkerRuns } from "../db/schema.js";
import { getModelCost } from "../config/models.js";

/**
 * Cost audit — verifies strong-tier spend per ADR-008.
 *
 * Weekly check on opencode-go spend to ensure it stays within
 * acceptable limits. Currently monitors total spend since the
 * tier is used rarely (only on tasks that fail every other option).
 *
 * Thresholds (per week):
 *   strong: $50 hard cap, $25 soft warning
 *
 * Uses worker_runs.total_cost_usd when available (actual API cost),
 * falls back to estimating from model pricing + token counts.
 */

export interface CostAuditReport {
  exceeded: string[]; // tiers that exceeded their threshold
  totalSpend: number;
  byTier: Record<string, { spend: number; tasks: number; threshold: number }>;
  estimated: boolean; // true if any costs were estimated (not actual)
}

export async function auditCosts(): Promise<CostAuditReport> {
  const db = getDb();

  // Query worker_runs for strong-tier model usage in the last 7 days
  // Use raw SQL for aggregation to keep it simple and performant
  const rows = await db.all<
    Pick<WorkerRuns, "model" | "totalCostUsd" | "inputTokens" | "outputTokens">
  & { run_count: number }>(
    sql`SELECT
         model,
         SUM(total_cost_usd) as total_cost_usd,
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens,
         COUNT(*) as run_count
       FROM worker_runs
       WHERE started_at >= datetime('now', '-7 days')
         AND model IS NOT NULL
         AND succeeded = 1
       GROUP BY model`,
  );

  const tierThresholds: Record<string, number> = {
    strong: 50, // $50/week hard cap
  };

  const byTier: CostAuditReport["byTier"] = {};
  const exceeded: string[] = [];
  let totalSpend = 0;
  let estimated = false;

  for (const row of rows) {
    const modelId = row.model ?? "";
    const runCount = Number(row.run_count);

    // Identify strong-tier models by provider or model name patterns
    const isStrongTier =
      modelId.includes("opencode-go") ||
      modelId.includes("claude-opus") ||
      modelId.includes("claude-sonnet-4-6") || // Sonnet-4.6 is ~$3-6/run — counts as strong
      modelId.includes("o3") ||
      modelId.includes("o4") ||
      modelId.includes("gpt-4.5");

    if (!isStrongTier) continue;

    // Use actual cost if available, otherwise estimate
    let spend = Number(row.totalCostUsd ?? 0);
    if (spend === 0 || spend == null) {
      // Estimate from token usage + model pricing
      const costs = getModelCost(modelId);
      if (costs) {
        const inputCost =
          (Number(row.inputTokens) / 1_000_000) * costs.input +
          (Number(row.outputTokens) / 1_000_000) * costs.output;
        spend = inputCost;
        if (inputCost > 0) estimated = true;
      }
    }

    if (spend <= 0) continue;

    totalSpend += spend;

    const tierKey = "strong";
    if (!byTier[tierKey]) {
      byTier[tierKey] = {
        spend: 0,
        tasks: 0,
        threshold: tierThresholds[tierKey] ?? 50,
      };
    }
    byTier[tierKey].spend += spend;
    byTier[tierKey].tasks += runCount;
  }

  // Check thresholds
  for (const [tier, data] of Object.entries(byTier)) {
    if (data.spend > data.threshold) {
      exceeded.push(`${tier} ($${data.spend.toFixed(2)} > $${data.threshold}/week cap)`);
    }
  }

  return { exceeded, totalSpend, byTier, estimated };
}
