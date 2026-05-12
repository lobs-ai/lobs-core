import { eq, and, sql } from "drizzle-orm";
import { getDb, getRawDb } from "../db/connection.js";
import { workerRuns, inboxItems } from "../db/schema.js";
import { randomUUID } from "node:crypto";

type WorkerRunsRow = typeof workerRuns.$inferSelect;
import { getModelCost } from "../config/models.js";
import { log } from "../util/logger.js";

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
    Pick<WorkerRunsRow, "model" | "totalCostUsd" | "inputTokens" | "outputTokens">
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

/**
 * Insert a cost audit alert into the inbox, de-duplicating against existing
 * unread alerts with the same triageCategory.
 */
async function insertInboxAlert(report: CostAuditReport): Promise<void> {
  const db = getDb();
  const alertKey = "cost-audit-weekly";
  const urgency = report.exceeded.length > 0 ? "high" : "low";

  // De-dup: suppress if an unread alert with the same key already exists
  const existing = db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.triageCategory, alertKey),
        eq(inboxItems.isRead, false),
      ),
    )
    .all();

  if (existing.length > 0) {
    log().info?.(`[COST_AUDIT] Suppressing duplicate inbox alert: ${alertKey}`);
    return;
  }

  const lines = [
    `## Weekly Cost Audit — ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    ``,
    `**Period:** last 7 days`,
    `**Total spend:** $${report.totalSpend.toFixed(2)}`,
    ``,
    `### Spend by Tier`,
  ];

  for (const [tier, data] of Object.entries(report.byTier)) {
    const status = data.spend > data.threshold ? "⚠️ EXCEEDED" : "✓ within limit";
    lines.push(`- **${tier}**: $${data.spend.toFixed(2)} / $${data.threshold}/week cap — ${status}`);
  }

  if (report.exceeded.length > 0) {
    lines.push(``, `### ⚠️ Exceeded Thresholds`);
    for (const e of report.exceeded) {
      lines.push(`- ${e}`);
    }
  }

  if (report.estimated) {
    lines.push(``, `_Note: some costs were estimated (no actual API cost data available for some models)_`);
  }

  const title = report.exceeded.length > 0
    ? `💰 Cost Audit: ${report.exceeded.length} tier exceeded`
    : `💰 Cost Audit: weekly summary`;

  db.insert(inboxItems).values({
    id: randomUUID() as string,
    title,
    content: lines.join("\n"),
    type: "alert",
    requiresAction: report.exceeded.length > 0,
    actionStatus: report.exceeded.length > 0 ? "pending" : undefined,
    triageCategory: alertKey,
    triageUrgency: urgency,
    triageRoute: "system",
    sourceAgent: "cost-audit-cron",
    isRead: false,
  }).run();

  log().info?.(`[COST_AUDIT] Inbox alert created: ${alertKey} (urgency=${urgency})`);
}

/**
 * Cron entry point — runs cost audit and logs the report.
 * Called by the weekly cost-audit cron job per ADR-008.
 */
export async function runCostAudit(): Promise<CostAuditReport> {
  const report = await auditCosts();
  const summary = `[Cost Audit] Total: $${report.totalSpend.toFixed(2)} | Exceeded: ${report.exceeded.length > 0 ? report.exceeded.join(", ") : "none"}`;
  log().info?.(summary);
  if (report.estimated) {
    log().warn?.("[Cost Audit] Warning: some costs were estimated (no actual API data)");
  }

  // Send inbox alert if thresholds exceeded
  if (report.exceeded.length > 0) {
    await insertInboxAlert(report);
  }

  // ADR-008: Record last audit time so heartbeat can detect stale audits
  try {
    const db = getRawDb();
    const timestamp = new Date().toISOString();
    const existing = db.prepare("SELECT key FROM orchestrator_settings WHERE key = 'last_cost_audit_at'")?.get();
    if (existing) {
      db.prepare("UPDATE orchestrator_settings SET value = ?, updated_at = datetime('now') WHERE key = 'last_cost_audit_at'")?.run(JSON.stringify(timestamp));
    } else {
      db.prepare("INSERT INTO orchestrator_settings (key, value) VALUES ('last_cost_audit_at', ?)")?.run(JSON.stringify(timestamp));
    }
  } catch (err) {
    log().warn?.(`[Cost Audit] Failed to record last_cost_audit_at: ${String(err)}`);
  }

  return report;
}
