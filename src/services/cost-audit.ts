/**
 * Cost Audit Service — ADR-008 Phase 7
 *
 * Weekly spend verification: aggregates cost data from worker_runs and
 * model_usage_events, compares against expected subscription costs, and
 * creates inbox alerts for anomalies.
 *
 * Expected cost model (per ADR-008):
 * - MiniMax subscription: covers standard/small/medium tiers at $0 marginal cost
 * - Strong tier (opencode-go/glm-5.1): real per-token cost ~$5.25/run
 * - Any direct Anthropic/GPT API calls outside subscription = unexpected
 *
 * Alert thresholds:
 * - Strong tier >$50/week → alert Rafe
 * - Any direct API cost (non-subscription) → alert
 * - New model detected → alert
 */

import { getDb } from "../db/connection.js";
import { workerRuns, modelUsageEvents, inboxItems } from "../db/schema.js";
import { sql, eq, and, gte, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const SUBSCRIPTION_MODELS = new Set([
  "minimax/MiniMax-M2.7",
  "MiniMax-M2.7",
  "qwen/qwen3.5-9b",          // local, free
  "qwen2.5-1.5b-instruct-mlx", // local, free
]);

const KNOWN_DIRECT_API_MODELS = new Set([
  "opencode-go/glm-5.1",       // strong tier — expected to cost
  "glm-5.1",
  "anthropic/claude-sonnet-4-6",
  "claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "claude-haiku-4-5",
  "openai/gpt-4o",
  "gpt-4o",
]);

const STRONG_TIER_ALERT_THRESHOLD = 50; // $50/week

export interface CostAuditReport {
  periodStart: string;
  periodEnd: string;
  totalSpendUsd: number;
  byModel: Record<string, number>;
  directApiSpendUsd: number;
  strongTierSpendUsd: number;
  subscriptionSpendUsd: number;
  runCount: number;
  anomalyCount: number;
  anomalies: string[];
}

/** Returns the start of the previous 7-day window */
function auditWindowStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

function auditWindowEnd(): string {
  return new Date().toISOString();
}

/**
 * Run the weekly cost audit. Queries worker_runs and model_usage_events for
 * the last 7 days, calculates spend by model, and creates inbox alerts for
 * any anomalies.
 */
export async function runCostAudit(): Promise<CostAuditReport> {
  const db = getDb();
  const windowStart = auditWindowStart();
  const windowEnd = auditWindowEnd();

  log().info(`[COST_AUDIT] Starting audit for period ${windowStart} → ${windowEnd}`);

  // ── 1. Aggregate worker_runs costs ────────────────────────────────────────
  const workerRunRows = db
    .select({
      model: workerRuns.model,
      totalCostUsd: workerRuns.totalCostUsd,
    })
    .from(workerRuns)
    .where(
      and(
        gte(workerRuns.startedAt, windowStart),
        lt(workerRuns.startedAt, windowEnd),
        eq(workerRuns.succeeded, true),
      ),
    )
    .all();

  const runCount = workerRunRows.length;

  // ── 2. Aggregate model_usage_events costs ─────────────────────────────────
  const usageRows = db
    .select({
      model: modelUsageEvents.model,
      provider: modelUsageEvents.provider,
      estimatedCostUsd: modelUsageEvents.estimatedCostUsd,
      routeType: modelUsageEvents.routeType,
    })
    .from(modelUsageEvents)
    .where(
      and(
        gte(modelUsageEvents.timestamp, windowStart),
        lt(modelUsageEvents.timestamp, windowEnd),
      ),
    )
    .all();

  // ── 3. Build cost summary ──────────────────────────────────────────────────
  const byModel: Record<string, number> = {};
  let totalSpendUsd = 0;
  let directApiSpendUsd = 0;
  let strongTierSpendUsd = 0;
  let subscriptionSpendUsd = 0;

  for (const row of workerRunRows) {
    if (!row.model || row.totalCostUsd == null) continue;
    const cost = Number(row.totalCostUsd);
    byModel[row.model] = (byModel[row.model] ?? 0) + cost;
    totalSpendUsd += cost;
  }

  for (const row of usageRows) {
    if (!row.model || row.estimatedCostUsd == null) continue;
    const cost = Number(row.estimatedCostUsd);
    byModel[row.model] = (byModel[row.model] ?? 0) + cost;
    totalSpendUsd += cost;
  }

  // Classify each model's spend
  const anomalies: string[] = [];
  const detectedModels = Object.keys(byModel);

  for (const [model, spend] of Object.entries(byModel)) {
    if (SUBSCRIPTION_MODELS.has(model)) {
      subscriptionSpendUsd += spend;
    } else if (model.includes("glm-5.1") || model.includes("opencode-go")) {
      strongTierSpendUsd += spend;
    } else if (KNOWN_DIRECT_API_MODELS.has(model) || model.includes("anthropic") || model.includes("openai")) {
      directApiSpendUsd += spend;
      // These are expected only in emergencies; flag if > $0
      if (spend > 0) {
        anomalies.push(
          `Direct API usage detected: ${model} — $${spend.toFixed(2)} this week (expected: $0, use MiniMax subscription instead)`,
        );
      }
    } else {
      // Unknown model — flag it
      anomalies.push(`Unknown model detected: ${model} — $${spend.toFixed(2)} this week`);
    }
  }

  // ── 4. Check thresholds ────────────────────────────────────────────────────
  if (strongTierSpendUsd > STRONG_TIER_ALERT_THRESHOLD) {
    anomalies.push(
      `Strong tier spend exceeds $${STRONG_TIER_ALERT_THRESHOLD}/week threshold: $${strongTierSpendUsd.toFixed(2)}`,
    );
  }

  // ── 5. Build report ────────────────────────────────────────────────────────
  const report: CostAuditReport = {
    periodStart: windowStart,
    periodEnd: windowEnd,
    totalSpendUsd,
    byModel,
    directApiSpendUsd,
    strongTierSpendUsd,
    subscriptionSpendUsd,
    runCount,
    anomalyCount: anomalies.length,
    anomalies,
  };

  // ── 6. Log summary ────────────────────────────────────────────────────────
  log().info(`[COST_AUDIT] Report: ${runCount} runs, $${totalSpendUsd.toFixed(4)} total`);
  log().info(`[COST_AUDIT]   subscription: $${subscriptionSpendUsd.toFixed(4)}`);
  log().info(`[COST_AUDIT]   strong tier:   $${strongTierSpendUsd.toFixed(4)}`);
  log().info(`[COST_AUDIT]   direct API:    $${directApiSpendUsd.toFixed(4)}`);
  if (anomalies.length > 0) {
    for (const a of anomalies) {
      log().warn(`[COST_AUDIT] ANOMALY: ${a}`);
    }
  } else {
    log().info(`[COST_AUDIT] ✓ No anomalies detected`);
  }

  // ── 7. Create inbox alert if anomalies found ───────────────────────────────
  if (anomalies.length > 0) {
    await insertCostAuditAlert(report);
  }

  return report;
}

/**
 * Insert a cost audit anomaly alert into the inbox.
 * De-duplicates against any existing unread alert with the same triageCategory.
 */
async function insertCostAuditAlert(report: CostAuditReport): Promise<void> {
  const db = getDb();
  const alertKey = "cost-audit-weekly";
  const urgency = report.strongTierSpendUsd > STRONG_TIER_ALERT_THRESHOLD
    ? "high"
    : "medium";

  const content = buildAlertContent(report);

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
    log().debug(`[COST_AUDIT] Suppressing duplicate alert: ${alertKey}`);
    return;
  }

  db.insert(inboxItems).values({
    id: randomUUID(),
    title: `💰 Cost Audit: ${report.anomalyCount} anomaly${report.anomalyCount > 1 ? "ies" : ""} detected`,
    content,
    type: "alert",
    requiresAction: true,
    actionStatus: "pending",
    triageCategory: alertKey,
    triageUrgency: urgency,
    triageRoute: "system",
    sourceAgent: "cost-audit-cron",
    isRead: false,
  }).run();

  log().info(`[COST_AUDIT] Alert created: ${alertKey} (urgency=${urgency})`);
}

function buildAlertContent(report: CostAuditReport): string {
  const lines = [
    `## Weekly Cost Audit — ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    ``,
    `**Period:** ${new Date(report.periodStart).toLocaleDateString()} – ${new Date(report.periodEnd).toLocaleDateString()}`,
    `**Worker runs:** ${report.runCount}`,
    ``,
    `### Spend Summary`,
    `| Category | Amount |`,
    `|----------|-------|`,
    `| Subscription (MiniMax) | $${report.subscriptionSpendUsd.toFixed(4)} |`,
    `| Strong tier (opencode-go) | $${report.strongTierSpendUsd.toFixed(4)} |`,
    `| Direct API (unexpected) | $${report.directApiSpendUsd.toFixed(4)} |`,
    `| **Total** | **$${report.totalSpendUsd.toFixed(4)}** |`,
    ``,
    `### Spend by Model`,
  ];

  for (const [model, spend] of Object.entries(report.byModel).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${model} | $${spend.toFixed(4)} |`);
  }

  if (report.anomalies.length > 0) {
    lines.push(``, `### Anomalies`);
    for (const a of report.anomalies) {
      lines.push(`- ⚠️ ${a}`);
    }
  }

  return lines.join("\n");
}
