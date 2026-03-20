/**
 * Tests for src/api/usage.ts
 *
 * Signature: handleUsageRequest(req, res, sub?: string)
 * where sub = parts[1] from the router (e.g. "summary", "dashboard", etc.)
 *
 * Schema: modelUsageEvents has provider, model, estimatedCostUsd, inputTokens,
 *         outputTokens, cachedTokens, source, routeType, etc.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../src/db/connection.js";
import { modelUsageEvents, workerRuns } from "../src/db/schema.js";
import { handleUsageRequest, isCompliantCall } from "../src/api/usage.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

type ResHelper = {
  res: ServerResponse;
  body: () => Record<string, unknown>;
  arrayBody: () => Record<string, unknown>[];
  statusCode: () => number;
};

function makeRes(): ResHelper {
  let captured = "";
  let code = 200;
  const res = {
    statusCode: 200,
    writeHead(c: number) { code = c; this.statusCode = c; },
    setHeader() {},
    end(data: string) { captured = data; },
  } as unknown as ServerResponse;
  return {
    res,
    body: () => JSON.parse(captured) as Record<string, unknown>,
    arrayBody: () => JSON.parse(captured) as Record<string, unknown>[],
    statusCode: () => code,
  };
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

let eventSeed = 0;

function seedEvent(overrides: Partial<{
  provider: string;
  model: string;
  source: string;
  routeType: string;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
  timestamp: string;
  taskType: string;
}> = {}): string {
  const db = getDb();
  const id = `evt-${Date.now()}-${++eventSeed}-${Math.random().toString(36).slice(2)}`;
  db.insert(modelUsageEvents).values({
    id,
    provider: overrides.provider ?? "local",
    model: overrides.model ?? "qwen3:8b",
    source: overrides.source ?? "programmer",
    routeType: overrides.routeType ?? "local",
    estimatedCostUsd: overrides.estimatedCostUsd ?? 0.001,
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 50,
    cachedTokens: overrides.cachedTokens ?? 0,
    requests: overrides.requests ?? 1,
    taskType: overrides.taskType ?? "other",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  }).run();
  return id;
}

const seededIds: string[] = [];

afterEach(() => {
  const db = getDb();
  for (const id of seededIds) {
    try {
      db.delete(modelUsageEvents)
        .where(require("drizzle-orm").eq(modelUsageEvents.id, id))
        .run();
    } catch {}
  }
  seededIds.length = 0;
});

function seed(n: number, overrides: Parameters<typeof seedEvent>[0] = {}): void {
  for (let i = 0; i < n; i++) {
    seededIds.push(seedEvent(overrides));
  }
}

// ── isCompliantCall unit tests ─────────────────────────────────────────────────

describe("isCompliantCall", () => {
  it("routeType=local is always compliant", () => {
    expect(isCompliantCall("anthropic", "local")).toBe(true);
    expect(isCompliantCall("openai", "local")).toBe(true);
  });

  it("known cloud providers are non-compliant when routeType=api", () => {
    expect(isCompliantCall("anthropic", "api")).toBe(false);
    expect(isCompliantCall("openai", "api")).toBe(false);
    expect(isCompliantCall("google", "api")).toBe(false);
    expect(isCompliantCall("azure", "api")).toBe(false);
  });

  it("unknown providers default to compliant (local-safe)", () => {
    expect(isCompliantCall("local-lm", "api")).toBe(true);
    expect(isCompliantCall("unknown", "api")).toBe(true);
    expect(isCompliantCall("my-private-llm", "api")).toBe(true);
  });

  it("case-insensitive for provider name", () => {
    expect(isCompliantCall("Anthropic", "api")).toBe(false);
    expect(isCompliantCall("OPENAI", "api")).toBe(false);
  });
});

// ── /api/usage/summary ────────────────────────────────────────────────────────

describe("GET /api/usage/summary", () => {
  beforeEach(() => {
    seed(5, { provider: "local", model: "qwen3:8b", estimatedCostUsd: 0.01 });
    seed(3, { provider: "anthropic", model: "claude-3-5-haiku", estimatedCostUsd: 0.02, routeType: "api" });
  });

  it("returns HTTP 200", async () => {
    const { res, statusCode } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/summary"), res, "summary");
    expect(statusCode()).toBe(200);
  });

  it("response shape has all expected top-level fields", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/summary"), res, "summary");
    const b = body();
    expect(typeof b["total_requests"]).toBe("number");
    expect(typeof b["total_input_tokens"]).toBe("number");
    expect(typeof b["total_output_tokens"]).toBe("number");
    expect(typeof b["total_estimated_cost_usd"]).toBe("number");
    expect(b["period_start"]).toBeTruthy();
    expect(b["period_end"]).toBeTruthy();
    expect(b["window"]).toBeTruthy();
  });

  it("total_requests includes all seeded events", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/summary"), res, "summary");
    expect(body()["total_requests"] as number).toBeGreaterThanOrEqual(8);
  });

  it("total_estimated_cost_usd sums contributions correctly", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/summary"), res, "summary");
    // Our seeded data: 5×0.01 + 3×0.02 = 0.11
    expect(body()["total_estimated_cost_usd"] as number).toBeGreaterThanOrEqual(0.11 - 0.001);
  });

  it("by_model array contains seeded model entries", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/summary"), res, "summary");
    const byModel = body()["by_model"] as Array<Record<string, unknown>>;
    expect(Array.isArray(byModel)).toBe(true);
    const qwen = byModel.find(m => m["model"] === "qwen3:8b");
    expect(qwen).toBeTruthy();
    expect(typeof qwen!["requests"]).toBe("number");
    expect(typeof qwen!["estimated_cost_usd"]).toBe("number");
  });

  it("by_provider array contains seeded provider entries", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/summary"), res, "summary");
    const byProv = body()["by_provider"] as Array<Record<string, unknown>>;
    expect(Array.isArray(byProv)).toBe(true);
    const localProv = byProv.find(p => p["provider"] === "local");
    expect(localProv).toBeTruthy();
    const anthropicProv = byProv.find(p => p["provider"] === "anthropic");
    expect(anthropicProv).toBeTruthy();
  });

  it("total_input_tokens is sum of all event inputTokens", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/summary"), res, "summary");
    // 8 events seeded with 100 input tokens each = ≥800 total
    expect(body()["total_input_tokens"] as number).toBeGreaterThanOrEqual(800);
  });

  it("accepts window=day query param", async () => {
    const { res, statusCode } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/summary?window=day"), res, "summary");
    expect(statusCode()).toBe(200);
  });

  it("accepts window=week query param", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/summary?window=week"), res, "summary");
    expect(body()["window"]).toBe("week");
  });
});

// ── /api/usage/dashboard ──────────────────────────────────────────────────────

describe("GET /api/usage/dashboard", () => {
  beforeEach(() => {
    seed(4, {
      provider: "local",
      model: "qwen3:14b",
      estimatedCostUsd: 0.005,
      routeType: "local",
    });
  });

  it("returns HTTP 200", async () => {
    const { res, statusCode } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/dashboard"), res, "dashboard");
    expect(statusCode()).toBe(200);
  });

  it("response has totals block", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/dashboard"), res, "dashboard");
    const totals = body()["totals"] as Record<string, unknown>;
    expect(totals).toBeTruthy();
    expect(typeof totals["requests"]).toBe("number");
    expect(typeof totals["estimated_cost_usd"]).toBe("number");
    expect(typeof totals["input_tokens"]).toBe("number");
  });

  it("response has by_provider array", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/dashboard"), res, "dashboard");
    expect(Array.isArray(body()["by_provider"])).toBe(true);
  });

  it("response has by_model array", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/dashboard"), res, "dashboard");
    expect(Array.isArray(body()["by_model"])).toBe(true);
  });

  it("response has daily_series array", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/dashboard"), res, "dashboard");
    expect(Array.isArray(body()["daily_series"])).toBe(true);
  });

  it("period_start and period_end are ISO timestamps", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/dashboard"), res, "dashboard");
    const b = body();
    expect(b["period_start"] as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b["period_end"] as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── /api/usage/compliance ─────────────────────────────────────────────────────

describe("GET /api/usage/compliance", () => {
  beforeEach(() => {
    seed(6, { provider: "local", routeType: "local", estimatedCostUsd: 0.001 });
    seed(2, { provider: "anthropic", routeType: "api", estimatedCostUsd: 0.05 });
  });

  it("returns HTTP 200", async () => {
    const { res, statusCode } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/compliance"), res, "compliance");
    expect(statusCode()).toBe(200);
  });

  it("response has summary block", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/compliance"), res, "compliance");
    const summary = body()["summary"] as Record<string, unknown>;
    expect(summary).toBeTruthy();
    expect(typeof summary["compliant_count"]).toBe("number");
    expect(typeof summary["non_compliant_count"]).toBe("number");
    expect(typeof summary["compliant_pct"]).toBe("number");
  });

  it("compliant_count ≥ 6 (local events)", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/compliance"), res, "compliance");
    const summary = body()["summary"] as Record<string, unknown>;
    expect(summary["compliant_count"] as number).toBeGreaterThanOrEqual(6);
  });

  it("non_compliant_count ≥ 2 (anthropic events)", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/compliance"), res, "compliance");
    const summary = body()["summary"] as Record<string, unknown>;
    expect(summary["non_compliant_count"] as number).toBeGreaterThanOrEqual(2);
  });

  it("compliant_pct + non_compliant_pct ≈ 100 (or both 0 when empty)", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/compliance"), res, "compliance");
    const summary = body()["summary"] as Record<string, unknown>;
    const total = (summary["compliant_pct"] as number) + (summary["non_compliant_pct"] as number);
    expect(Math.round(total)).toBe(100);
  });

  it("daily_series is an array", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/compliance"), res, "compliance");
    expect(Array.isArray(body()["daily_series"])).toBe(true);
  });

  it("response includes human-readable note", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/compliance"), res, "compliance");
    expect(typeof body()["note"]).toBe("string");
  });
});

// ── /api/usage/projection ─────────────────────────────────────────────────────

describe("GET /api/usage/projection", () => {
  beforeEach(() => {
    seed(3, { estimatedCostUsd: 0.10 });
  });

  it("returns HTTP 200", async () => {
    const { res, statusCode } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/projection"), res, "projection");
    expect(statusCode()).toBe(200);
  });

  it("response includes projected_month_end_cost_usd", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/projection"), res, "projection");
    expect(typeof body()["projected_month_end_cost_usd"]).toBe("number");
  });

  it("response includes month_to_date_cost_usd", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/projection"), res, "projection");
    expect(typeof body()["month_to_date_cost_usd"]).toBe("number");
  });

  it("response includes current_daily_burn_usd", async () => {
    const { res, body } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/projection"), res, "projection");
    expect(typeof body()["current_daily_burn_usd"]).toBe("number");
  });
});

// ── /api/usage/budgets ────────────────────────────────────────────────────────

describe("GET /api/usage/budgets", () => {
  it("returns budget stub with expected fields", async () => {
    const { res, body, statusCode } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/budgets"), res, "budgets");
    expect(statusCode()).toBe(200);
    const b = body();
    expect(typeof b["monthly_total_usd"]).toBe("number");
    expect(typeof b["daily_alert_usd"]).toBe("number");
    expect(typeof b["per_task_hard_cap_usd"]).toBe("number");
  });
});

// ── /api/usage/providers ──────────────────────────────────────────────────────

describe("GET /api/usage/providers", () => {
  beforeEach(() => {
    seed(3, { provider: "openai", routeType: "api" });
    seed(2, { provider: "local", routeType: "local" });
  });

  it("returns an array", async () => {
    const { res, arrayBody } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/providers"), res, "providers");
    expect(Array.isArray(arrayBody())).toBe(true);
  });

  it("each entry has provider and requests fields", async () => {
    const { res, arrayBody } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/providers"), res, "providers");
    const entries = arrayBody();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e["provider"]).toBe("string");
      expect(typeof e["requests"]).toBe("number");
    }
  });
});

// ── /api/usage/models ─────────────────────────────────────────────────────────

describe("GET /api/usage/models", () => {
  beforeEach(() => {
    seed(3, { provider: "local", model: "qwen3:8b" });
    seed(2, { provider: "anthropic", model: "claude-3-5-sonnet", routeType: "api" });
  });

  it("returns an array", async () => {
    const { res, arrayBody } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/models"), res, "models");
    expect(Array.isArray(arrayBody())).toBe(true);
  });

  it("each entry has provider, model, requests fields", async () => {
    const { res, arrayBody } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/models"), res, "models");
    const entries = arrayBody();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e["provider"]).toBe("string");
      expect(typeof e["model"]).toBe("string");
      expect(typeof e["requests"]).toBe("number");
    }
  });

  it("seeded models appear in results", async () => {
    const { res, arrayBody } = makeRes();
    await handleUsageRequest(makeReq("GET", "/api/usage/models"), res, "models");
    const entries = arrayBody();
    expect(entries.some(e => e["model"] === "qwen3:8b")).toBe(true);
    expect(entries.some(e => e["model"] === "claude-3-5-sonnet")).toBe(true);
  });
});

// ── Routing errors ────────────────────────────────────────────────────────────

describe("Routing — unknown routes and method guards", () => {
  it("returns 404 for unknown sub-route", async () => {
    const { res, statusCode } = makeRes();
    await handleUsageRequest(
      makeReq("GET", "/api/usage/does-not-exist"),
      res,
      "does-not-exist",
    );
    expect(statusCode()).toBe(404);
  });

  it("returns 404 when sub is undefined", async () => {
    const { res, statusCode } = makeRes();
    await handleUsageRequest(
      makeReq("GET", "/api/usage"),
      res,
      undefined,
    );
    expect(statusCode()).toBe(404);
  });
});
