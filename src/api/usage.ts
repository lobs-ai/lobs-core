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

export async function handleUsageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
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

  return error(res, "Unknown usage endpoint", 404);
}
