/**
 * Extended tests for src/api/plugins.ts
 *
 * Handlers:
 *   handlePluginsRequest(req, res, id?, parts)   — GET list, GET single, PATCH single, invoke
 *   handleUiAffordancesRequest(req, res)           — GET { affordances: [...] }
 *   handleUiConfigRequest(req, res)                — GET / PATCH ui-config
 *
 * Important shapes:
 *   GET /api/plugins        → { plugins: PawPlugin[] }
 *   GET /api/ui-affordances → { affordances: UIAffordance[] }
 *   GET /api/ui-config      → { id, layout, widgetOrder[], hiddenWidgets[], ... }
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/connection.js";
import { plugins, uiConfig } from "../src/db/schema.js";
import {
  handlePluginsRequest,
  handleUiAffordancesRequest,
  handleUiConfigRequest,
  buildPromptPlan,
  buildRefinementPrompt,
} from "../src/api/plugins.js";
import type { UIAffordance } from "../src/types/plugin.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(method: string, url: string, body: unknown = {}): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  (req as unknown as Record<string, unknown>).method = method;
  (req as unknown as Record<string, unknown>).url = url;
  process.nextTick(() => {
    (req as unknown as Readable).push(JSON.stringify(body));
    (req as unknown as Readable).push(null);
  });
  return req;
}

type ResHelper = {
  res: ServerResponse;
  body: () => Record<string, unknown>;
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
    statusCode: () => code,
  };
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

const seededPluginIds: string[] = [];

function seedPlugin(id: string, overrides: Partial<{
  name: string;
  description: string;
  category: string;
  enabled: number;
  config: string;
  configSchema: string;
  uiAffordances: string;
}> = {}): void {
  getDb().insert(plugins).values({
    id,
    name: overrides.name ?? `Plugin ${id}`,
    description: overrides.description ?? "Test plugin",
    category: overrides.category ?? "dev",
    enabled: overrides.enabled ?? 0,
    config: overrides.config ?? "{}",
    configSchema: overrides.configSchema ?? "{}",
    uiAffordances: overrides.uiAffordances ?? "[]",
  }).run();
  seededPluginIds.push(id);
}

afterEach(() => {
  const db = getDb();
  for (const id of seededPluginIds) {
    try { db.delete(plugins).where(eq(plugins.id, id)).run(); } catch {}
  }
  seededPluginIds.length = 0;
  try { db.delete(uiConfig).run(); } catch {}
});

// ── GET /api/plugins — list ───────────────────────────────────────────────────

describe("GET /api/plugins — list all plugins", () => {
  beforeEach(() => {
    seedPlugin("plug-a", { name: "Plugin A", category: "dev", enabled: 1 });
    seedPlugin("plug-b", { name: "Plugin B", category: "productivity", enabled: 0 });
    seedPlugin("plug-c", { name: "Plugin C", category: "academic", enabled: 1 });
  });

  it("returns HTTP 200", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(makeReq("GET", "/api/plugins"), res, undefined, ["plugins"]);
    expect(statusCode()).toBe(200);
  });

  it("returns { plugins: [...] } shape (NOT a bare array)", async () => {
    const { res, body } = makeRes();
    await handlePluginsRequest(makeReq("GET", "/api/plugins"), res, undefined, ["plugins"]);
    const b = body();
    expect(Array.isArray(b["plugins"])).toBe(true);
  });

  it("list includes all seeded plugins", async () => {
    const { res, body } = makeRes();
    await handlePluginsRequest(makeReq("GET", "/api/plugins"), res, undefined, ["plugins"]);
    const list = body()["plugins"] as Record<string, unknown>[];
    expect(list.some(p => p["id"] === "plug-a")).toBe(true);
    expect(list.some(p => p["id"] === "plug-b")).toBe(true);
    expect(list.some(p => p["id"] === "plug-c")).toBe(true);
  });

  it("each plugin has required fields: id, name, category, enabled", async () => {
    const { res, body } = makeRes();
    await handlePluginsRequest(makeReq("GET", "/api/plugins"), res, undefined, ["plugins"]);
    const list = body()["plugins"] as Record<string, unknown>[];
    for (const p of list) {
      expect(typeof p["id"]).toBe("string");
      expect(typeof p["name"]).toBe("string");
      expect(typeof p["category"]).toBe("string");
      expect(typeof p["enabled"]).toBe("boolean");
    }
  });

  it("enabled field is boolean — not raw integer", async () => {
    const { res, body } = makeRes();
    await handlePluginsRequest(makeReq("GET", "/api/plugins"), res, undefined, ["plugins"]);
    const list = body()["plugins"] as Record<string, unknown>[];
    const a = list.find(p => p["id"] === "plug-a");
    const b = list.find(p => p["id"] === "plug-b");
    expect(a!["enabled"]).toBe(true);
    expect(b!["enabled"]).toBe(false);
  });

  it("config is a parsed object (not a raw JSON string)", async () => {
    seedPlugin("cfg-plug", {
      config: '{"threshold": 42, "active": true}',
    });
    const { res, body } = makeRes();
    await handlePluginsRequest(makeReq("GET", "/api/plugins"), res, undefined, ["plugins"]);
    const list = body()["plugins"] as Record<string, unknown>[];
    const cp = list.find(p => p["id"] === "cfg-plug");
    expect(typeof cp!["config"]).toBe("object");
    expect((cp!["config"] as Record<string, unknown>)["threshold"]).toBe(42);
  });

  it("uiAffordances is a parsed array (not a raw JSON string)", async () => {
    seedPlugin("aff-parsed", {
      uiAffordances: '[{"id":"btn-x","label":"Go","type":"button","aiAction":"summarize"}]',
    });
    const { res, body } = makeRes();
    await handlePluginsRequest(makeReq("GET", "/api/plugins"), res, undefined, ["plugins"]);
    const list = body()["plugins"] as Record<string, unknown>[];
    const ap = list.find(p => p["id"] === "aff-parsed");
    expect(Array.isArray(ap!["uiAffordances"])).toBe(true);
    expect((ap!["uiAffordances"] as unknown[]).length).toBe(1);
  });

  it("returns 405 for PUT on /api/plugins", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(makeReq("PUT", "/api/plugins", {}), res, undefined, ["plugins"]);
    expect(statusCode()).toBe(405);
  });

  it("returns 405 for POST on /api/plugins", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(makeReq("POST", "/api/plugins", {}), res, undefined, ["plugins"]);
    expect(statusCode()).toBe(405);
  });
});

// ── GET /api/plugins/:id ──────────────────────────────────────────────────────

describe("GET /api/plugins/:id — fetch single", () => {
  beforeEach(() => {
    seedPlugin("detail-plug", {
      name: "Detail Plugin",
      category: "productivity",
      enabled: 1,
      config: '{"key":"val"}',
      uiAffordances: '[{"id":"dp-btn","label":"Fetch","type":"button","aiAction":"summarize"}]',
    });
  });

  it("returns HTTP 200 with the plugin", async () => {
    const { res, body, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("GET", "/api/plugins/detail-plug"),
      res,
      "detail-plug",
      ["plugins", "detail-plug"],
    );
    expect(statusCode()).toBe(200);
    expect(body()["id"]).toBe("detail-plug");
    expect(body()["name"]).toBe("Detail Plugin");
  });

  it("returns 404 for nonexistent plugin", async () => {
    const { res, body, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("GET", "/api/plugins/ghost"),
      res,
      "ghost",
      ["plugins", "ghost"],
    );
    expect(statusCode()).toBe(404);
    expect(body()["error"]).toBeTruthy();
  });

  it("config is parsed as object", async () => {
    const { res, body } = makeRes();
    await handlePluginsRequest(
      makeReq("GET", "/api/plugins/detail-plug"),
      res,
      "detail-plug",
      ["plugins", "detail-plug"],
    );
    const config = body()["config"] as Record<string, unknown>;
    expect(typeof config).toBe("object");
    expect(config["key"]).toBe("val");
  });

  it("uiAffordances is parsed as array", async () => {
    const { res, body } = makeRes();
    await handlePluginsRequest(
      makeReq("GET", "/api/plugins/detail-plug"),
      res,
      "detail-plug",
      ["plugins", "detail-plug"],
    );
    const affs = body()["uiAffordances"] as unknown[];
    expect(Array.isArray(affs)).toBe(true);
    expect(affs.length).toBe(1);
  });

  it("enabled is boolean in single-fetch response", async () => {
    const { res, body } = makeRes();
    await handlePluginsRequest(
      makeReq("GET", "/api/plugins/detail-plug"),
      res,
      "detail-plug",
      ["plugins", "detail-plug"],
    );
    expect(body()["enabled"]).toBe(true);
  });
});

// ── PATCH /api/plugins/:id ────────────────────────────────────────────────────

describe("PATCH /api/plugins/:id — toggle enabled / update config", () => {
  beforeEach(() => {
    seedPlugin("patch-plug", { name: "Before Patch", category: "dev", enabled: 0 });
  });

  it("toggles enabled false → true", async () => {
    const { res, body } = makeRes();
    await handlePluginsRequest(
      makeReq("PATCH", "/api/plugins/patch-plug", { enabled: true }),
      res,
      "patch-plug",
      ["plugins", "patch-plug"],
    );
    expect(body()["enabled"]).toBe(true);
  });

  it("toggles enabled true → false", async () => {
    // First enable it
    await handlePluginsRequest(
      makeReq("PATCH", "/api/plugins/patch-plug", { enabled: true }),
      makeRes().res,
      "patch-plug",
      ["plugins", "patch-plug"],
    );
    // Then disable it
    const { res, body } = makeRes();
    await handlePluginsRequest(
      makeReq("PATCH", "/api/plugins/patch-plug", { enabled: false }),
      res,
      "patch-plug",
      ["plugins", "patch-plug"],
    );
    expect(body()["enabled"]).toBe(false);
  });

  it("updates config with object value", async () => {
    const { res, body } = makeRes();
    await handlePluginsRequest(
      makeReq("PATCH", "/api/plugins/patch-plug", { config: { threshold: 10, mode: "auto" } }),
      res,
      "patch-plug",
      ["plugins", "patch-plug"],
    );
    const config = body()["config"] as Record<string, unknown>;
    expect(config["threshold"]).toBe(10);
    expect(config["mode"]).toBe("auto");
  });

  it("returns 404 when patching nonexistent plugin", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("PATCH", "/api/plugins/no-such-plugin", { enabled: true }),
      res,
      "no-such-plugin",
      ["plugins", "no-such-plugin"],
    );
    expect(statusCode()).toBe(404);
  });

  it("persists PATCH changes to DB", async () => {
    await handlePluginsRequest(
      makeReq("PATCH", "/api/plugins/patch-plug", { enabled: true }),
      makeRes().res,
      "patch-plug",
      ["plugins", "patch-plug"],
    );
    const row = getDb().select().from(plugins).where(eq(plugins.id, "patch-plug")).get();
    expect(row!.enabled).toBe(1);
  });

  it("PATCH without changes still returns the plugin", async () => {
    const { res, body, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("PATCH", "/api/plugins/patch-plug", {}),
      res,
      "patch-plug",
      ["plugins", "patch-plug"],
    );
    expect(statusCode()).toBe(200);
    expect(body()["id"]).toBe("patch-plug");
  });

  it("returns 405 for DELETE on /api/plugins/:id", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("DELETE", "/api/plugins/patch-plug"),
      res,
      "patch-plug",
      ["plugins", "patch-plug"],
    );
    expect(statusCode()).toBe(405);
  });
});

// ── POST /api/plugins/:id/invoke ──────────────────────────────────────────────

describe("POST /api/plugins/:id/invoke", () => {
  beforeEach(() => {
    seedPlugin("invoke-plug", {
      enabled: 1,
      uiAffordances: JSON.stringify([
        { id: "sum-aff", label: "Summarize", type: "button", aiAction: "summarize" },
      ]),
    });
  });

  it("returns 404 when plugin does not exist", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("POST", "/api/plugins/ghost/invoke", {
        affordanceId: "sum-aff",
        context: "test context",
      }),
      res,
      "ghost",
      ["plugins", "ghost", "invoke"],
    );
    expect(statusCode()).toBe(404);
  });

  it("returns 400 when affordanceId is missing", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("POST", "/api/plugins/invoke-plug/invoke", { context: "some context" }),
      res,
      "invoke-plug",
      ["plugins", "invoke-plug", "invoke"],
    );
    expect(statusCode()).toBe(400);
  });

  it("returns 400 when context is missing", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("POST", "/api/plugins/invoke-plug/invoke", { affordanceId: "sum-aff" }),
      res,
      "invoke-plug",
      ["plugins", "invoke-plug", "invoke"],
    );
    expect(statusCode()).toBe(400);
  });

  it("returns 400 when plugin is disabled", async () => {
    seedPlugin("disabled-plug", {
      enabled: 0,
      uiAffordances: JSON.stringify([
        { id: "aff-1", label: "Do thing", type: "button", aiAction: "summarize" },
      ]),
    });
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("POST", "/api/plugins/disabled-plug/invoke", {
        affordanceId: "aff-1",
        context: "some text",
      }),
      res,
      "disabled-plug",
      ["plugins", "disabled-plug", "invoke"],
    );
    expect(statusCode()).toBe(400);
  });

  it("returns 404 when affordanceId does not exist in the plugin", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("POST", "/api/plugins/invoke-plug/invoke", {
        affordanceId: "nonexistent-aff",
        context: "test context",
      }),
      res,
      "invoke-plug",
      ["plugins", "invoke-plug", "invoke"],
    );
    expect(statusCode()).toBe(404);
  });

  it("successful invoke returns result object with mode field (gateway may be down = AI unavailable)", async () => {
    const { res, body, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("POST", "/api/plugins/invoke-plug/invoke", {
        affordanceId: "sum-aff",
        context: "This is the context to summarize.",
      }),
      res,
      "invoke-plug",
      ["plugins", "invoke-plug", "invoke"],
    );
    // Should succeed (200) even if AI returns "[AI unavailable]"
    expect(statusCode()).toBe(200);
    const b = body();
    expect(b["result"]).toBeTruthy();
    expect(b["mode"]).toBeTruthy();
    expect(b["pluginId"]).toBe("invoke-plug");
    expect(b["affordanceId"]).toBe("sum-aff");
  });

  it("returns 405 for GET on /api/plugins/:id/invoke", async () => {
    const { res, statusCode } = makeRes();
    await handlePluginsRequest(
      makeReq("GET", "/api/plugins/invoke-plug/invoke"),
      res,
      "invoke-plug",
      ["plugins", "invoke-plug", "invoke"],
    );
    expect(statusCode()).toBe(405);
  });
});

// ── GET /api/ui-affordances ───────────────────────────────────────────────────

describe("GET /api/ui-affordances", () => {
  beforeEach(() => {
    seedPlugin("aff-enabled", {
      enabled: 1,
      uiAffordances: JSON.stringify([
        { id: "btn-enabled", label: "Run Analysis", type: "button", aiAction: "summarize" },
      ]),
    });
    seedPlugin("aff-disabled", {
      enabled: 0,
      uiAffordances: JSON.stringify([
        { id: "btn-disabled", label: "Hidden", type: "button", aiAction: "explain" },
      ]),
    });
  });

  it("returns HTTP 200", async () => {
    const { res, statusCode } = makeRes();
    await handleUiAffordancesRequest(makeReq("GET", "/api/ui-affordances"), res);
    expect(statusCode()).toBe(200);
  });

  it("returns { affordances: [...] } shape (NOT a bare array)", async () => {
    const { res, body } = makeRes();
    await handleUiAffordancesRequest(makeReq("GET", "/api/ui-affordances"), res);
    const b = body();
    expect(Array.isArray(b["affordances"])).toBe(true);
  });

  it("includes affordances only from enabled plugins", async () => {
    const { res, body } = makeRes();
    await handleUiAffordancesRequest(makeReq("GET", "/api/ui-affordances"), res);
    const affs = body()["affordances"] as Array<Record<string, unknown>>;
    const ids = affs.map(a => a["id"]);
    expect(ids).toContain("btn-enabled");
    expect(ids).not.toContain("btn-disabled");
  });

  it("each affordance has pluginId injected", async () => {
    const { res, body } = makeRes();
    await handleUiAffordancesRequest(makeReq("GET", "/api/ui-affordances"), res);
    const affs = body()["affordances"] as Array<Record<string, unknown>>;
    const aff = affs.find(a => a["id"] === "btn-enabled");
    expect(aff!["pluginId"]).toBe("aff-enabled");
  });

  it("each affordance has id, label, type fields from affordance definition", async () => {
    const { res, body } = makeRes();
    await handleUiAffordancesRequest(makeReq("GET", "/api/ui-affordances"), res);
    const affs = body()["affordances"] as Array<Record<string, unknown>>;
    const aff = affs.find(a => a["id"] === "btn-enabled");
    expect(aff!["label"]).toBe("Run Analysis");
    expect(aff!["type"]).toBe("button");
  });

  it("returns empty affordances for plugins with empty uiAffordances arrays", async () => {
    // Plugin with no affordances
    seedPlugin("aff-empty", { enabled: 1, uiAffordances: "[]" });

    const { res, body, statusCode } = makeRes();
    await handleUiAffordancesRequest(makeReq("GET", "/api/ui-affordances"), res);
    expect(statusCode()).toBe(200);
    // The response is still an array, but aff-empty contributes nothing
    const affs = body()["affordances"] as Array<Record<string, unknown>>;
    expect(affs.every(a => a["pluginId"] !== "aff-empty")).toBe(true);
  });

  it("aggregates affordances from multiple enabled plugins", async () => {
    seedPlugin("aff-multi", {
      enabled: 1,
      uiAffordances: JSON.stringify([
        { id: "multi-btn-1", label: "Action 1", type: "button", aiAction: "explain" },
        { id: "multi-btn-2", label: "Action 2", type: "button", aiAction: "rewrite" },
      ]),
    });
    const { res, body } = makeRes();
    await handleUiAffordancesRequest(makeReq("GET", "/api/ui-affordances"), res);
    const affs = body()["affordances"] as Array<Record<string, unknown>>;
    const ids = affs.map(a => a["id"]);
    expect(ids).toContain("btn-enabled");
    expect(ids).toContain("multi-btn-1");
    expect(ids).toContain("multi-btn-2");
  });
});

// ── GET /api/ui-config ────────────────────────────────────────────────────────

describe("GET /api/ui-config", () => {
  it("returns HTTP 200 with default config when DB is empty", async () => {
    const { res, body, statusCode } = makeRes();
    await handleUiConfigRequest(makeReq("GET", "/api/ui-config"), res);
    expect(statusCode()).toBe(200);
    const b = body();
    expect(b["layout"]).toBeTruthy();
    expect(b["id"]).toBe("default");
  });

  it("widgetOrder and hiddenWidgets are arrays (not raw JSON strings)", async () => {
    const { res, body } = makeRes();
    await handleUiConfigRequest(makeReq("GET", "/api/ui-config"), res);
    const b = body();
    expect(Array.isArray(b["widgetOrder"])).toBe(true);
    expect(Array.isArray(b["hiddenWidgets"])).toBe(true);
    expect(Array.isArray(b["agentHighlights"])).toBe(true);
  });

  it("default layout is 'command-center'", async () => {
    const { res, body } = makeRes();
    await handleUiConfigRequest(makeReq("GET", "/api/ui-config"), res);
    expect(body()["layout"]).toBe("command-center");
  });

  it("returns 405 for DELETE", async () => {
    const { res, statusCode } = makeRes();
    await handleUiConfigRequest(makeReq("DELETE", "/api/ui-config"), res);
    expect(statusCode()).toBe(405);
  });
});

describe("PATCH /api/ui-config", () => {
  it("updates layout field", async () => {
    const { res, body } = makeRes();
    await handleUiConfigRequest(
      makeReq("PATCH", "/api/ui-config", { layout: "dashboard" }),
      res,
    );
    expect(body()["layout"]).toBe("dashboard");
  });

  it("updates widgetOrder array", async () => {
    const { res, body } = makeRes();
    await handleUiConfigRequest(
      makeReq("PATCH", "/api/ui-config", { widgetOrder: ["tasks", "calendar", "inbox"] }),
      res,
    );
    const order = body()["widgetOrder"] as string[];
    expect(order).toContain("tasks");
    expect(order).toContain("calendar");
    expect(order).toContain("inbox");
  });

  it("updates hiddenWidgets array", async () => {
    const { res, body } = makeRes();
    await handleUiConfigRequest(
      makeReq("PATCH", "/api/ui-config", { hiddenWidgets: ["weather", "news"] }),
      res,
    );
    const hidden = body()["hiddenWidgets"] as string[];
    expect(hidden).toContain("weather");
    expect(hidden).toContain("news");
  });

  it("updates updatedBy field", async () => {
    const { res, body } = makeRes();
    await handleUiConfigRequest(
      makeReq("PATCH", "/api/ui-config", { updatedBy: "user" }),
      res,
    );
    expect(body()["updatedBy"]).toBe("user");
  });

  it("persists change — subsequent GET reflects it", async () => {
    await handleUiConfigRequest(
      makeReq("PATCH", "/api/ui-config", { layout: "split-view" }),
      makeRes().res,
    );
    const { res, body } = makeRes();
    await handleUiConfigRequest(makeReq("GET", "/api/ui-config"), res);
    expect(body()["layout"]).toBe("split-view");
  });

  it("multiple PATCHes accumulate — latest value wins", async () => {
    await handleUiConfigRequest(
      makeReq("PATCH", "/api/ui-config", { layout: "layout-A" }),
      makeRes().res,
    );
    await handleUiConfigRequest(
      makeReq("PATCH", "/api/ui-config", { layout: "layout-B" }),
      makeRes().res,
    );
    const { res, body } = makeRes();
    await handleUiConfigRequest(makeReq("GET", "/api/ui-config"), res);
    expect(body()["layout"]).toBe("layout-B");
  });

  it("widgetOrder is serialised and deserialised correctly as JSON array", async () => {
    const order = ["a", "b", "c", "d"];
    await handleUiConfigRequest(
      makeReq("PATCH", "/api/ui-config", { widgetOrder: order }),
      makeRes().res,
    );
    const { res, body } = makeRes();
    await handleUiConfigRequest(makeReq("GET", "/api/ui-config"), res);
    expect(body()["widgetOrder"]).toEqual(order);
  });
});

// ── buildPromptPlan unit tests ────────────────────────────────────────────────

describe("buildPromptPlan", () => {
  const ctx = "Example content to process.";

  it("summarize → single-pass plan", () => {
    const aff = { id: "a", label: "Summarize", type: "button", aiAction: "summarize" } as UIAffordance;
    const plan = buildPromptPlan(aff, ctx);
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe("single-pass");
    expect(plan!.modelTier).toBe("small");
    expect(plan!.prompt).toContain(ctx);
  });

  it("suggest-reply → single-pass plan with 3 replies instruction", () => {
    const aff = { id: "a", label: "Reply", type: "button", aiAction: "suggest-reply" } as UIAffordance;
    const plan = buildPromptPlan(aff, ctx);
    expect(plan!.prompt).toContain("3");
    expect(plan!.mode).toBe("single-pass");
  });

  it("explain → single-pass plan", () => {
    const aff = { id: "a", label: "Explain", type: "button", aiAction: "explain" } as UIAffordance;
    const plan = buildPromptPlan(aff, ctx);
    expect(plan!.mode).toBe("single-pass");
    expect(plan!.prompt).toContain(ctx);
  });

  it("rewrite → single-pass plan", () => {
    const aff = { id: "a", label: "Rewrite", type: "button", aiAction: "rewrite" } as UIAffordance;
    const plan = buildPromptPlan(aff, ctx);
    expect(plan!.mode).toBe("single-pass");
  });

  it("generate → draft plan with refinementTier", () => {
    const aff = {
      id: "a", label: "Gen", type: "button", aiAction: "generate",
      config: { template: "commit-message", modelTier: "micro", refinementTier: "standard" },
    } as UIAffordance;
    const plan = buildPromptPlan(aff, ctx);
    expect(plan!.mode).toBe("draft");
    expect(plan!.refinementTier).toBeTruthy();
  });

  it("generate with pr-description template → draft plan containing PR sections", () => {
    const aff = {
      id: "a", label: "Gen PR", type: "button", aiAction: "generate",
      config: { template: "pr-description" },
    } as UIAffordance;
    const plan = buildPromptPlan(aff, ctx);
    expect(plan!.mode).toBe("draft");
    expect(plan!.prompt.toLowerCase()).toContain("pull request");
  });

  it("assess → single-pass plan", () => {
    const aff = { id: "a", label: "Assess", type: "button", aiAction: "assess" } as UIAffordance;
    expect(buildPromptPlan(aff, ctx)!.mode).toBe("single-pass");
  });

  it("extract-actions → single-pass plan", () => {
    const aff = { id: "a", label: "Extract", type: "button", aiAction: "extract-actions" } as UIAffordance;
    expect(buildPromptPlan(aff, ctx)!.mode).toBe("single-pass");
  });

  it("unknown aiAction → returns null", () => {
    const aff = { id: "a", label: "X", type: "button", aiAction: "unknown-action-xyz" as unknown } as UIAffordance;
    expect(buildPromptPlan(aff, ctx)).toBeNull();
  });

  it("insights → single-pass plan with bullet point instruction", () => {
    const aff = { id: "a", label: "Insights", type: "button", aiAction: "insights" } as UIAffordance;
    const plan = buildPromptPlan(aff, ctx);
    expect(plan!.mode).toBe("single-pass");
    expect(plan!.prompt).toContain("bullet");
  });

  it("daily-summary → single-pass plan", () => {
    const aff = { id: "a", label: "Daily", type: "button", aiAction: "daily-summary" } as UIAffordance;
    expect(buildPromptPlan(aff, ctx)!.mode).toBe("single-pass");
  });
});

// ── buildRefinementPrompt unit tests ──────────────────────────────────────────

describe("buildRefinementPrompt", () => {
  it("includes the original context in the prompt", () => {
    const plan = { prompt: "do something", mode: "draft" as const, modelTier: "micro", draftKind: "commit-message" };
    const result = buildRefinementPrompt(plan, "original ctx", "draft text");
    expect(result).toContain("original ctx");
  });

  it("includes the draft text in the prompt", () => {
    const plan = { prompt: "x", mode: "draft" as const, modelTier: "micro", draftKind: "pr-description" };
    const result = buildRefinementPrompt(plan, "ctx", "my draft here");
    expect(result).toContain("my draft here");
  });

  it("includes draftKind in the prompt header", () => {
    const plan = { prompt: "x", mode: "draft" as const, modelTier: "micro", draftKind: "doc-stub" };
    const result = buildRefinementPrompt(plan, "ctx", "draft");
    expect(result).toContain("doc-stub");
  });

  it("includes refinementNotes when provided", () => {
    const plan = { prompt: "x", mode: "draft" as const, modelTier: "micro" };
    const result = buildRefinementPrompt(plan, "ctx", "draft", "please be shorter");
    expect(result).toContain("please be shorter");
  });

  it("does NOT include Refinement notes block when notes are absent", () => {
    const plan = { prompt: "x", mode: "draft" as const, modelTier: "micro" };
    const result = buildRefinementPrompt(plan, "ctx", "draft");
    expect(result).not.toContain("Refinement notes:");
  });

  it("ends with instruction to return only the refined text", () => {
    const plan = { prompt: "x", mode: "draft" as const, modelTier: "micro" };
    const result = buildRefinementPrompt(plan, "ctx", "draft");
    expect(result.toLowerCase()).toContain("return only");
  });
});
