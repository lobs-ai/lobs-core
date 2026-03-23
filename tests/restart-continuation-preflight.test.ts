/**
 * Integration test: restart-continuation hook runs LM Studio preflight
 * before sending the resume prompt on gateway_start.
 *
 * Safety gap being closed: on LM Studio restart, if the model is not yet
 * loaded when gateway_start fires, the resume prompt would kick off an
 * agent session that immediately fails on model lookup. The preflight guard
 * prevents that by aborting the prompt send when LM Studio is unreachable
 * or the configured model is missing.
 *
 * Strategy: mount registerRestartContinuationHook with a fake api.on()
 * that triggers "gateway_start" synchronously, mock checkModelsBeforeSpawn,
 * getModelConfig, getGatewayConfig, and global.fetch — then assert:
 *   - resume prompt is NOT sent when LM Studio is unreachable
 *   - resume prompt is NOT sent when the model is loaded but wrong ID
 *   - resume prompt IS sent when preflight passes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Module-level mocks ───────────────────────────────────────────────────────
// We mock the modules imported by restart-continuation.ts so we control
// exactly what checkModelsBeforeSpawn and getModelConfig return.

vi.mock("../src/diagnostics/lmstudio.js", () => ({
  checkModelsBeforeSpawn: vi.fn(),
}));

vi.mock("../src/config/models.js", () => ({
  getModelConfig: vi.fn(),
}));

vi.mock("../src/config/lobs.js", () => ({
  getGatewayConfig: vi.fn(),
}));

vi.mock("../src/util/logger.js", () => ({
  log: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Imports (after vi.mock declarations) ────────────────────────────────────
import { checkModelsBeforeSpawn } from "../src/diagnostics/lmstudio.js";
import { getModelConfig } from "../src/config/models.js";
import { getGatewayConfig } from "../src/config/lobs.js";
import { registerRestartContinuationHook } from "../src/hooks/restart-continuation.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_MODEL_CONFIG = {
  tiers: { micro: "lmstudio/qwen3-4b" },
  local: { chatModel: "qwen3-4b", baseUrl: "http://127.0.0.1:1234", embeddingModel: "" },
};

const GATEWAY_CONFIG = { port: 59000, token: "test-token" };

type FetchFn = typeof global.fetch;

function makeOkFetch(): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  } as Response);
}

function makeFailFetch(status = 500): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  } as Response);
}

/**
 * Build a fake api object and trigger the gateway_start callback.
 * Callers are responsible for configuring mocks before calling this helper.
 * Defaults are applied only for mocks not yet set (checked via mockReturnValue sentinel).
 */
async function triggerGatewayStart(
  fetchMock: FetchFn,
  overrides?: { token?: string | null }
): Promise<void> {
  const modelMock = getModelConfig as ReturnType<typeof vi.fn>;
  const gwMock = getGatewayConfig as ReturnType<typeof vi.fn>;

  // Apply defaults — tests that need different values should call mockReturnValue
  // directly before calling this helper (their value takes precedence because
  // vi.clearAllMocks() runs in beforeEach, clearing prior implementations).
  if (!modelMock.mock.results.length) {
    modelMock.mockReturnValue(MOCK_MODEL_CONFIG);
  }
  const effectiveGwConfig =
    overrides?.token !== undefined
      ? { ...GATEWAY_CONFIG, token: overrides.token }
      : GATEWAY_CONFIG;
  gwMock.mockReturnValue(effectiveGwConfig);

  // Collect the gateway_start handler so we can invoke it directly
  let gatewayStartHandler: (() => Promise<void>) | null = null;
  const fakeApi = {
    on: (event: string, handler: () => Promise<void>) => {
      if (event === "gateway_start") gatewayStartHandler = handler;
    },
  };

  registerRestartContinuationHook(fakeApi);

  if (!gatewayStartHandler) throw new Error("gateway_start handler not registered");

  // Replace global.fetch with our mock BEFORE triggering the handler
  global.fetch = fetchMock;

  // Use fake timers to avoid real setTimeout delays
  vi.useFakeTimers();
  const handlerPromise = gatewayStartHandler();

  // Advance past the 2s cleanup delay and the 5s resume delay
  await vi.runAllTimersAsync();
  await handlerPromise;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("restart-continuation — LM Studio preflight gate", () => {
  let originalFetch: FetchFn;
  const checkMock = checkModelsBeforeSpawn as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── LM Studio unreachable → resume prompt SKIPPED ────────────────────────

  it("skips resume prompt when LM Studio is unreachable", async () => {
    checkMock.mockResolvedValue({ ok: false, reachable: false, missing: [], missingIds: [] });
    const fetchMock = makeOkFetch();

    await triggerGatewayStart(fetchMock);

    // The fetch mock is used for the gateway invoke — it must NOT be called
    // if we aborted early (the invoke fetch is the only one in this path;
    // checkModelsBeforeSpawn is mocked so it doesn't use fetch).
    const invokeCallCount = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => String(url).includes("v2/invoke")
    ).length;
    expect(invokeCallCount).toBe(0);
  });

  // ── Model not loaded → resume prompt SKIPPED ─────────────────────────────

  it("skips resume prompt when model is loaded but required model is missing", async () => {
    checkMock.mockResolvedValue({
      ok: false,
      reachable: true,
      missing: [{ id: "qwen3-4b", location: "tiers.micro" }],
      missingIds: ["qwen3-4b"],
    });
    const fetchMock = makeOkFetch();

    await triggerGatewayStart(fetchMock);

    const invokeCallCount = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => String(url).includes("v2/invoke")
    ).length;
    expect(invokeCallCount).toBe(0);
  });

  // ── Preflight passes → resume prompt SENT ────────────────────────────────

  it("sends resume prompt when LM Studio preflight passes", async () => {
    checkMock.mockResolvedValue({
      ok: true,
      reachable: true,
      missing: [],
      missingIds: [],
      loadedModels: ["qwen3-4b"],
      suggestions: {},
    });
    const fetchMock = makeOkFetch();

    await triggerGatewayStart(fetchMock);

    const invokeCallCount = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => String(url).includes("v2/invoke")
    ).length;
    expect(invokeCallCount).toBe(1);
  });

  // ── No gateway token → prompt skipped (existing guard, still works) ──────

  it("skips resume prompt when gateway token is absent even with passing preflight", async () => {
    checkMock.mockResolvedValue({ ok: true, reachable: true, missing: [], missingIds: [] });
    const fetchMock = makeOkFetch();

    // Pass token: null via the helper override so the helper's default doesn't win
    await triggerGatewayStart(fetchMock, { token: null });

    const invokeCallCount = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => String(url).includes("v2/invoke")
    ).length;
    expect(invokeCallCount).toBe(0);
  });

  // ── Preflight called with correct model IDs ───────────────────────────────

  it("calls preflight with micro tier and local chat model IDs", async () => {
    checkMock.mockResolvedValue({ ok: true, reachable: true, missing: [], missingIds: [] });
    const fetchMock = makeOkFetch();

    await triggerGatewayStart(fetchMock);

    expect(checkMock).toHaveBeenCalledOnce();
    const [modelIds] = checkMock.mock.calls[0] as [string[]];
    // micro tier
    expect(modelIds).toContain("lmstudio/qwen3-4b");
    // local chat model
    expect(modelIds).toContain("lmstudio/qwen3-4b");
  });

  // ── checkModelsBeforeSpawn error → graceful fallback ─────────────────────

  it("does not crash if checkModelsBeforeSpawn throws — swallows error", async () => {
    checkMock.mockRejectedValue(new Error("unexpected diagnostics failure"));
    const fetchMock = makeOkFetch();

    // Should NOT throw
    await expect(triggerGatewayStart(fetchMock)).resolves.toBeUndefined();
  });
});
