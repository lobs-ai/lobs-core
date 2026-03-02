import { desc, gte } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { modelUsageEvents, modelPricing } from "../db/schema.js";
import { json, error, parseQuery } from "./index.js";

export async function handleUsageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  const db = getDb();

  if (sub === "budgets") {
    // Stub: no budget lane table yet
    return json(res, { lanes: [] });
  }

  const q = parseQuery(req.url ?? "");
  const since = q.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const events = db.select().from(modelUsageEvents).where(gte(modelUsageEvents.timestamp, since)).orderBy(desc(modelUsageEvents.timestamp)).all();

  const totalCost = events.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);
  const totalTokens = events.reduce((s, e) => s + (e.inputTokens ?? 0) + (e.outputTokens ?? 0), 0);

  if (sub === "summary") {
    return json(res, {
      total_cost_usd: totalCost,
      total_tokens: totalTokens,
      event_count: events.length,
      since,
      timestamp: new Date().toISOString(),
    });
  }

  if (sub === "dashboard") {
    const byProvider: Record<string, { cost: number; tokens: number; requests: number }> = {};
    const byModel: Record<string, { cost: number; tokens: number; requests: number }> = {};
    for (const e of events) {
      const p = byProvider[e.provider] ?? { cost: 0, tokens: 0, requests: 0 };
      p.cost += e.estimatedCostUsd ?? 0;
      p.tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
      p.requests += e.requests ?? 1;
      byProvider[e.provider] = p;

      const m = byModel[e.model] ?? { cost: 0, tokens: 0, requests: 0 };
      m.cost += e.estimatedCostUsd ?? 0;
      m.tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
      m.requests += e.requests ?? 1;
      byModel[e.model] = m;
    }
    return json(res, {
      total_cost_usd: totalCost,
      total_tokens: totalTokens,
      event_count: events.length,
      by_provider: byProvider,
      by_model: byModel,
      since,
      timestamp: new Date().toISOString(),
    });
  }

  if (sub === "providers") {
    const byProvider: Record<string, { cost: number; tokens: number; requests: number }> = {};
    for (const e of events) {
      const p = byProvider[e.provider] ?? { cost: 0, tokens: 0, requests: 0 };
      p.cost += e.estimatedCostUsd ?? 0;
      p.tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
      p.requests += e.requests ?? 1;
      byProvider[e.provider] = p;
    }
    return json(res, byProvider);
  }

  if (sub === "models") {
    const byModel: Record<string, { cost: number; tokens: number; requests: number }> = {};
    for (const e of events) {
      const m = byModel[e.model] ?? { cost: 0, tokens: 0, requests: 0 };
      m.cost += e.estimatedCostUsd ?? 0;
      m.tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
      m.requests += e.requests ?? 1;
      byModel[e.model] = m;
    }
    return json(res, byModel);
  }

  if (sub === "projection") {
    // Simple 30-day projection based on last 7 days
    const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekEvents = events.filter(e => e.timestamp >= week);
    const weekCost = weekEvents.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);
    const projectedMonthly = (weekCost / 7) * 30;
    return json(res, {
      projected_monthly_usd: projectedMonthly,
      based_on_days: 7,
      week_cost_usd: weekCost,
      timestamp: new Date().toISOString(),
    });
  }

  return error(res, "Unknown usage endpoint", 404);
}
