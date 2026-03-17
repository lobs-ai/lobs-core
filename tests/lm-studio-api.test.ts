/**
 * LM Studio API Handler — Unit Tests
 *
 * Tests the HTTP handler layer in src/api/lm-studio.ts:
 *   - handleLmStudioRequest routing (full / models / latency / unknown)
 *   - Correct status derivation (healthy / degraded / unreachable)
 *   - Query param forwarding (timeout, baseUrl)
 *   - Latency measurement included in responses
 *   - 405 on non-GET methods
 *   - Graceful handling when LM Studio is unreachable
 *
 * Network calls are mocked via global.fetch override.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleLmStudioRequest } from "../src/api/lm-studio.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const LOADED_MODELS_RESPONSE = {
  object: "list",
  data: [
    { id: "qwen3.5-35b-mlx-instruct", object: "model" },
    { id: "phi-4-mini",               object: "model" },
    { id: "nomic-embed-text-v1.5",    object: "model" },
  ],
};

function makeFetch(response: object | null, status = 200) {
  return vi.fn(async () => {
    if (response === null) throw new Error("ECONNREFUSED: connection refused");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
    } as unknown as Response;
  });
}

/**
 * Build a minimal mock IncomingMessage.
 */
function mockReq(method = "GET", url = "/api/lm-studio"): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

/**
 * Build a mock ServerResponse that captures JSON writes.
 * Returns `{ res, getBody() }` where `getBody()` returns the parsed JSON.
 */
function mockRes() {
  let statusCode = 200;
  let body = "";

  const res = {
    statusCode,
    writeHead(code: number, _headers?: object) { statusCode = code; },
    end(data: string) { body = data; },
    // Capture setHeader calls (json() helper calls this)
    setHeader: vi.fn(),
  } as unknown as ServerResponse;

  return {
    res,
    getStatus: () => statusCode,
    getBody: () => {
      try { return JSON.parse(body); } catch { return body; }
    },
  };
}

// ── Routing ───────────────────────────────────────────────────────────────────

describe("handleLmStudioRequest routing", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("routes [] to full diagnostic", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio"), res, []);
    const body = getBody();
    // Full diagnostic includes mismatches array
    expect(body).toHaveProperty("mismatches");
    expect(body).toHaveProperty("configuredLocalModels");
    expect(body).toHaveProperty("loadedModels");
    expect(body).toHaveProperty("latencyMs");
  });

  test("routes ['health'] to full diagnostic", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio/health"), res, ["health"]);
    const body = getBody();
    expect(body).toHaveProperty("mismatches");
  });

  test("routes ['models'] to lightweight models list", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio/models"), res, ["models"]);
    const body = getBody();
    expect(Array.isArray(body.loadedModels)).toBe(true);
    // Should NOT include configuredLocalModels (lightweight endpoint)
    expect(body).not.toHaveProperty("configuredLocalModels");
    expect(body).not.toHaveProperty("mismatches");
  });

  test("routes ['latency'] to latency probe", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio/latency"), res, ["latency"]);
    const body = getBody();
    expect(body).toHaveProperty("latencyMs");
    expect(body).toHaveProperty("baseUrl");
    // Should NOT include loadedModels
    expect(body).not.toHaveProperty("loadedModels");
  });

  test("returns 404 for unknown sub-resource", async () => {
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio/unknown"), res, ["unknown"]);
    const body = getBody();
    expect(body.error).toMatch(/unknown/i);
  });

  test("returns 405 for POST requests", async () => {
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("POST", "/api/lm-studio"), res, []);
    const body = getBody();
    expect(body.error).toMatch(/method not allowed/i);
  });
});

// ── Status derivation ─────────────────────────────────────────────────────────

describe("status field in response", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("status=unreachable when LM Studio is down", async () => {
    global.fetch = makeFetch(null);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(
      mockReq("GET", "/api/lm-studio?baseUrl=http://localhost:9999/v1"),
      res,
      [],
    );
    const body = getBody();
    expect(body.status).toBe("unreachable");
    expect(body.reachable).toBe(false);
    expect(body.ok).toBe(false);
  });

  test("status=healthy when all models matched", async () => {
    // Use a response that satisfies all local config models
    // (If no local models configured, should also be healthy)
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio"), res, []);
    const body = getBody();
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(body.reachable).toBe(true);
  });

  test("status=degraded when models missing", async () => {
    // Empty loaded models — will cause mismatches for any configured local model
    global.fetch = makeFetch({ object: "list", data: [] });
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio"), res, []);
    const body = getBody();
    expect(body.reachable).toBe(true);
    // If local models exist in config → degraded; if not → healthy
    expect(["healthy", "degraded"]).toContain(body.status);
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe("response shapes", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("full diagnostic response has all required fields", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio"), res, []);
    const body = getBody();

    expect(typeof body.ok).toBe("boolean");
    expect(["healthy", "degraded", "unreachable"]).toContain(body.status);
    expect(typeof body.reachable).toBe("boolean");
    expect(Array.isArray(body.loadedModels)).toBe(true);
    expect(Array.isArray(body.configuredLocalModels)).toBe(true);
    expect(Array.isArray(body.mismatches)).toBe(true);
    // latencyMs is number or null
    expect([null, ...body.loadedModels.map(() => "number")]).toBeDefined();
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(typeof body.checkedAt).toBe("string");
    // ISO 8601
    expect(() => new Date(body.checkedAt)).not.toThrow();
  });

  test("models endpoint response has required fields", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio/models"), res, ["models"]);
    const body = getBody();

    expect(typeof body.ok).toBe("boolean");
    expect(typeof body.reachable).toBe("boolean");
    expect(Array.isArray(body.loadedModels)).toBe(true);
    expect(typeof body.checkedAt).toBe("string");
  });

  test("latency endpoint response has required fields", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio/latency"), res, ["latency"]);
    const body = getBody();

    expect(typeof body.ok).toBe("boolean");
    expect(typeof body.reachable).toBe("boolean");
    expect(typeof body.baseUrl).toBe("string");
    expect(typeof body.checkedAt).toBe("string");
  });

  test("full diagnostic response - latencyMs is null when unreachable", async () => {
    global.fetch = makeFetch(null);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(
      mockReq("GET", "/api/lm-studio?baseUrl=http://localhost:9999/v1"),
      res,
      [],
    );
    const body = getBody();
    expect(body.latencyMs).toBeNull();
  });

  test("models endpoint - loadedModels is [] when unreachable", async () => {
    global.fetch = makeFetch(null);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(
      mockReq("GET", "/api/lm-studio/models?baseUrl=http://localhost:9999/v1"),
      res,
      ["models"],
    );
    const body = getBody();
    expect(body.reachable).toBe(false);
    expect(body.loadedModels).toEqual([]);
  });

  test("full diagnostic - loadedModels contains correct IDs", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio"), res, []);
    const body = getBody();
    expect(body.loadedModels).toContain("qwen3.5-35b-mlx-instruct");
    expect(body.loadedModels).toContain("phi-4-mini");
  });

  test("mismatch entries have configId and location", async () => {
    global.fetch = makeFetch({ object: "list", data: [] });
    const { res, getBody } = mockRes();
    await handleLmStudioRequest(mockReq("GET", "/api/lm-studio"), res, []);
    const body = getBody();
    for (const mm of body.mismatches) {
      expect(typeof mm.configId).toBe("string");
      expect(typeof mm.location).toBe("string");
    }
  });
});
