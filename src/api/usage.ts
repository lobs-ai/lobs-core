import { desc, gte } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { modelUsageEvents, workerRuns } from "../db/schema.js";
import { json, error, parseQuery } from "./index.js";

function windowToMs(window: string): number {
  switch (window) {
    case "day": return 24 * 3600_000;
    case "week": return 7 * 24 * 3600_000;
    case "month": default: return 30 * 24 * 3600_000;
  }
}

/**
 * SAIL Compliance Classification
 *
 * "Compliant" calls are routed to local (on-premises) models — no data leaves
 * the user's machine. "Non-compliant" calls are routed to cloud AI providers
 * (Anthropic, OpenAI, Google, etc.) which may process sensitive data off-site.
 *
 * Classification priority:
 *   1. routeType === "local"  → compliant (explicit local route)
 *   2. Known cloud providers  → non-compliant
 *   3. Everything else        → compliant (local/unknown is safer default)
 */
const CLOUD_PROVIDERS = new Set([
  "anthropic", "openai", "google", "mistral", "cohere", "ai21",
  "huggingface", "together", "replicate", "perplexity", "groq",
  "anyscale", "fireworks", "deepinfra", "lepton", "azure",
]);

export function isCompliantCall(provider: string, routeType: string): boolean {
  if (routeType === "local") return true;
  return !CLOUD_PROVIDERS.has(provider.toLowerCase());
}

export async function handleUsageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  // Route v2 endpoints to native usage tracker (worker_runs based)
  if (sub?.startsWith("v2")) {
    const v2Sub = sub.replace("v2/", "").replace("v2", "dashboard");
    handleUsageV2(v2Sub, res);
    return;
  }

  const db = getDb();
  const q = parseQuery(req.url ?? "");
  const window = q.window ?? "month";
  const periodMs = windowToMs(window);
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - periodMs);
  const since = periodStart.toISOString();

  const events = db.select().from(modelUsageEvents)
    .where(gte(modelUsageEvents.timestamp, since))
    .orderBy(desc(modelUsageEvents.timestamp))
    .all();

  if (sub === "budgets") {
    if (req.method === "PATCH") {
      // Stub: accept and echo back
      let body = "";
      await new Promise<void>((resolve) => {
        req.on("data", (c: Buffer) => { body += c.toString(); });
        req.on("end", resolve);
      });
      try { return json(res, JSON.parse(body)); } catch { /* fall through */ }
    }
    return json(res, {
      monthly_total_usd: 100,
      daily_alert_usd: 10,
      per_provider_monthly_usd: {},
      per_task_hard_cap_usd: 5,
    });
  }

  if (sub === "dashboard") {
    // Build provider and model aggregations
    const byProvider: Record<string, { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number; taskIds: Set<string>; latencies: number[]; errors: number }> = {};
    const byModel: Record<string, { provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number; taskIds: Set<string>; latencies: number[] }> = {};
    const dailyBuckets: Record<string, Record<string, { taskIds: Set<string>; inputTokens: number; outputTokens: number; cost: number }>> = {};

    for (const e of events) {
      const prov = e.provider ?? "unknown";
      const model = e.model ?? "unknown";
      const day = (e.timestamp ?? "").slice(0, 10);

      // Provider
      const p = byProvider[prov] ?? { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, taskIds: new Set(), latencies: [], errors: 0 };
      p.requests += e.requests ?? 1;
      p.inputTokens += e.inputTokens ?? 0;
      p.outputTokens += e.outputTokens ?? 0;
      p.cachedTokens += e.cachedTokens ?? 0;
      p.cost += e.estimatedCostUsd ?? 0;
      if (e.taskType) p.taskIds.add(e.taskType);
      byProvider[prov] = p;

      // Model
      const mk = `${prov}::${model}`;
      const m = byModel[mk] ?? { provider: prov, model, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, taskIds: new Set(), latencies: [] };
      m.requests += e.requests ?? 1;
      m.inputTokens += e.inputTokens ?? 0;
      m.outputTokens += e.outputTokens ?? 0;
      m.cachedTokens += e.cachedTokens ?? 0;
      m.cost += e.estimatedCostUsd ?? 0;
      if (e.taskType) m.taskIds.add(e.taskType);
      byModel[mk] = m;

      // Daily
      if (!dailyBuckets[day]) dailyBuckets[day] = {};
      const dp = dailyBuckets[day][prov] ?? { taskIds: new Set(), inputTokens: 0, outputTokens: 0, cost: 0 };
      dp.inputTokens += e.inputTokens ?? 0;
      dp.outputTokens += e.outputTokens ?? 0;
      dp.cost += e.estimatedCostUsd ?? 0;
      if (e.taskType) dp.taskIds.add(e.taskType);
      dailyBuckets[day][prov] = dp;
    }

    const totalIn = events.reduce((s, e) => s + (e.inputTokens ?? 0), 0);
    const totalOut = events.reduce((s, e) => s + (e.outputTokens ?? 0), 0);
    const totalCached = events.reduce((s, e) => s + (e.cachedTokens ?? 0), 0);
    const totalCost = events.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);
    const allTaskIds = new Set(events.filter(e => e.taskType).map(e => e.taskType));

    const dailySeries: { date: string; provider: string; task_count: number; input_tokens: number; output_tokens: number; total_tokens: number; estimated_cost_usd: number }[] = [];
    for (const [date, provs] of Object.entries(dailyBuckets).sort()) {
      for (const [prov, d] of Object.entries(provs)) {
        dailySeries.push({
          date,
          provider: prov,
          task_count: d.taskIds.size,
          input_tokens: d.inputTokens,
          output_tokens: d.outputTokens,
          total_tokens: d.inputTokens + d.outputTokens,
          estimated_cost_usd: d.cost,
        });
      }
    }

    return json(res, {
      window,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      totals: {
        task_count: allTaskIds.size,
        requests: events.length,
        input_tokens: totalIn,
        output_tokens: totalOut,
        cached_tokens: totalCached,
        total_tokens: totalIn + totalOut,
        estimated_cost_usd: totalCost,
      },
      by_provider: Object.entries(byProvider).map(([provider, p]) => ({
        provider,
        task_count: p.taskIds.size,
        requests: p.requests,
        input_tokens: p.inputTokens,
        output_tokens: p.outputTokens,
        cached_tokens: p.cachedTokens,
        total_tokens: p.inputTokens + p.outputTokens,
        estimated_cost_usd: p.cost,
        avg_latency_ms: null,
        error_count: p.errors,
      })),
      by_model: Object.entries(byModel).map(([, m]) => ({
        provider: m.provider,
        model: m.model,
        route_type: "direct",
        task_count: m.taskIds.size,
        requests: m.requests,
        input_tokens: m.inputTokens,
        output_tokens: m.outputTokens,
        cached_tokens: m.cachedTokens,
        total_tokens: m.inputTokens + m.outputTokens,
        estimated_cost_usd: m.cost,
        avg_latency_ms: null,
      })),
      daily_series: dailySeries,
    });
  }

  if (sub === "summary") {
    const totalIn = events.reduce((s, e) => s + (e.inputTokens ?? 0), 0);
    const totalOut = events.reduce((s, e) => s + (e.outputTokens ?? 0), 0);
    const totalCached = events.reduce((s, e) => s + (e.cachedTokens ?? 0), 0);
    const totalCost = events.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);

    // Build provider/model summaries matching MC's UsageProviderSummary/UsageModelSummary
    const byProv: Record<string, { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number; errors: number }> = {};
    const byModel: Record<string, { provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }> = {};
    for (const e of events) {
      const prov = e.provider ?? "unknown";
      const model = e.model ?? "unknown";
      const p = byProv[prov] ?? { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, errors: 0 };
      p.requests += e.requests ?? 1; p.inputTokens += e.inputTokens ?? 0; p.outputTokens += e.outputTokens ?? 0;
      p.cachedTokens += e.cachedTokens ?? 0; p.cost += e.estimatedCostUsd ?? 0;
      byProv[prov] = p;

      const mk = `${prov}::${model}`;
      const m = byModel[mk] ?? { provider: prov, model, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
      m.requests += e.requests ?? 1; m.inputTokens += e.inputTokens ?? 0; m.outputTokens += e.outputTokens ?? 0;
      m.cachedTokens += e.cachedTokens ?? 0; m.cost += e.estimatedCostUsd ?? 0;
      byModel[mk] = m;
    }

    return json(res, {
      window,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      total_requests: events.length,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
      total_cached_tokens: totalCached,
      total_estimated_cost_usd: totalCost,
      by_provider: Object.entries(byProv).map(([provider, p]) => ({
        provider, requests: p.requests, input_tokens: p.inputTokens, output_tokens: p.outputTokens,
        cached_tokens: p.cachedTokens, estimated_cost_usd: p.cost, avg_latency_ms: null, error_rate: 0,
      })),
      by_model: Object.entries(byModel).map(([, m]) => ({
        provider: m.provider, model: m.model, route_type: "direct",
        requests: m.requests, input_tokens: m.inputTokens, output_tokens: m.outputTokens,
        cached_tokens: m.cachedTokens, estimated_cost_usd: m.cost, avg_latency_ms: null, error_rate: 0,
      })),
    });
  }

  if (sub === "providers") {
    const byProv: Record<string, { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }> = {};
    for (const e of events) {
      const prov = e.provider ?? "unknown";
      const p = byProv[prov] ?? { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
      p.requests += e.requests ?? 1; p.inputTokens += e.inputTokens ?? 0; p.outputTokens += e.outputTokens ?? 0;
      p.cachedTokens += e.cachedTokens ?? 0; p.cost += e.estimatedCostUsd ?? 0;
      byProv[prov] = p;
    }
    return json(res, Object.entries(byProv).map(([provider, p]) => ({
      provider, requests: p.requests, input_tokens: p.inputTokens, output_tokens: p.outputTokens,
      cached_tokens: p.cachedTokens, estimated_cost_usd: p.cost, avg_latency_ms: null, error_rate: 0,
    })));
  }

  if (sub === "models") {
    const byModel: Record<string, { provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }> = {};
    for (const e of events) {
      const prov = e.provider ?? "unknown";
      const model = e.model ?? "unknown";
      const mk = `${prov}::${model}`;
      const m = byModel[mk] ?? { provider: prov, model, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
      m.requests += e.requests ?? 1; m.inputTokens += e.inputTokens ?? 0; m.outputTokens += e.outputTokens ?? 0;
      m.cachedTokens += e.cachedTokens ?? 0; m.cost += e.estimatedCostUsd ?? 0;
      byModel[mk] = m;
    }
    return json(res, Object.entries(byModel).map(([, m]) => ({
      provider: m.provider, model: m.model, route_type: "direct",
      requests: m.requests, input_tokens: m.inputTokens, output_tokens: m.outputTokens,
      cached_tokens: m.cachedTokens, estimated_cost_usd: m.cost, avg_latency_ms: null, error_rate: 0,
    })));
  }

  if (sub === "projection") {
    const weekStart = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const weekEvents = events.filter(e => (e.timestamp ?? "") >= weekStart);
    const weekCost = weekEvents.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const monthEvents = events.filter(e => (e.timestamp ?? "") >= monthStart.toISOString());
    const mtdCost = monthEvents.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);
    const dailyBurn = weekCost / 7;
    const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const dayOfMonth = new Date().getDate();
    const projected = mtdCost + dailyBurn * (daysInMonth - dayOfMonth);

    return json(res, {
      month_start: monthStart.toISOString(),
      now: new Date().toISOString(),
      month_to_date_cost_usd: mtdCost,
      current_daily_burn_usd: dailyBurn,
      projected_month_end_cost_usd: projected,
    });
  }

  if (sub === "compliance") {
    // SAIL compliance report: compliant (local) vs non-compliant (cloud) AI calls
    let compliantCount = 0;
    let nonCompliantCount = 0;
    let compliantTokens = 0;
    let nonCompliantTokens = 0;
    let compliantCost = 0;
    let nonCompliantCost = 0;

    // Daily breakdown keyed by date
    const dailyCompliant: Record<string, number> = {};
    const dailyNonCompliant: Record<string, number> = {};

    for (const e of events) {
      const prov = e.provider ?? "unknown";
      const rt = e.routeType ?? "api";
      const compliant = isCompliantCall(prov, rt);
      const reqs = e.requests ?? 1;
      const tokens = (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
      const cost = e.estimatedCostUsd ?? 0;
      const day = (e.timestamp ?? "").slice(0, 10);

      if (compliant) {
        compliantCount += reqs;
        compliantTokens += tokens;
        compliantCost += cost;
        dailyCompliant[day] = (dailyCompliant[day] ?? 0) + reqs;
      } else {
        nonCompliantCount += reqs;
        nonCompliantTokens += tokens;
        nonCompliantCost += cost;
        dailyNonCompliant[day] = (dailyNonCompliant[day] ?? 0) + reqs;
      }
    }

    const totalCount = compliantCount + nonCompliantCount;
    const compliantPct = totalCount > 0 ? Math.round((compliantCount / totalCount) * 10000) / 100 : 0;
    const nonCompliantPct = totalCount > 0 ? Math.round((nonCompliantCount / totalCount) * 10000) / 100 : 0;

    // Build daily series across all dates observed
    const allDays = Array.from(new Set([...Object.keys(dailyCompliant), ...Object.keys(dailyNonCompliant)])).sort();
    const dailySeries = allDays.map(date => {
      const c = dailyCompliant[date] ?? 0;
      const nc = dailyNonCompliant[date] ?? 0;
      const t = c + nc;
      return {
        date,
        compliant_count: c,
        non_compliant_count: nc,
        total_count: t,
        compliant_pct: t > 0 ? Math.round((c / t) * 10000) / 100 : 0,
        non_compliant_pct: t > 0 ? Math.round((nc / t) * 10000) / 100 : 0,
      };
    });

    return json(res, {
      window,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      summary: {
        total_count: totalCount,
        compliant_count: compliantCount,
        non_compliant_count: nonCompliantCount,
        compliant_pct: compliantPct,
        non_compliant_pct: nonCompliantPct,
        compliant_tokens: compliantTokens,
        non_compliant_tokens: nonCompliantTokens,
        compliant_cost_usd: compliantCost,
        non_compliant_cost_usd: nonCompliantCost,
      },
      daily_series: dailySeries,
      note: "Compliant calls use local (on-premises) models. Non-compliant calls are routed to cloud AI providers.",
    });
  }

  return error(res, "Unknown usage endpoint", 404);
}

// ── V2 Usage API — pulls from worker_runs (native runner) ────────────────────

import { getUsageDashboard, getUsageSummary, getDailyCosts } from "../services/usage-tracker.js";

/**
 * Handle /api/usage/v2/* requests.
 * These use the native runner's worker_runs table instead of the legacy modelUsageEvents.
 */
export function handleUsageV2(sub: string, res: ServerResponse): void {
  try {
    if (sub === "dashboard") {
      json(res, getUsageDashboard());
      return;
    }

    if (sub === "summary") {
      json(res, getUsageSummary(30));
      return;
    }

    if (sub === "daily-costs") {
      json(res, getDailyCosts(30));
      return;
    }

    error(res, `Unknown v2 usage endpoint: ${sub}`, 404);
  } catch (err) {
    error(res, `Usage v2 error: ${String(err)}`, 500);
  }
}
