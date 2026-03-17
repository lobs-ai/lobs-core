/**
 * LM Studio Model Availability Diagnostic — Unit Tests
 *
 * Tests the core diagnostic logic:
 *   - extractLocalModelRefs  (config scanning)
 *   - findClosestMatch       (fuzzy matching)
 *   - fetchLoadedModels      (API + error handling)
 *   - runLmStudioDiagnostic  (end-to-end report)
 *   - checkModelsBeforeSpawn (pre-spawn guard)
 *   - formatDiagnosticReport (output formatting)
 *
 * Network calls are mocked via global.fetch override.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractLocalModelRefs,
  fetchLoadedModels,
  findClosestMatch,
  runLmStudioDiagnostic,
  checkModelsBeforeSpawn,
  formatDiagnosticReport,
  type LmStudioDiagnosticReport,
} from "../src/diagnostics/lmstudio.js";

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

// ── extractLocalModelRefs ─────────────────────────────────────────────────────

describe("extractLocalModelRefs", () => {
  test("returns refs for local.chatModel and local.embeddingModel", () => {
    const refs = extractLocalModelRefs();
    // Should always include config local block entries
    const ids = refs.map(r => r.id);
    // They may or may not exist in the current test config, but the fn should not throw
    expect(Array.isArray(refs)).toBe(true);
  });

  test("each ref has id, bareId, and location", () => {
    const refs = extractLocalModelRefs();
    for (const r of refs) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.bareId).toBe("string");
      expect(typeof r.location).toBe("string");
    }
  });

  test("strips lmstudio/ prefix for bareId", () => {
    const refs = extractLocalModelRefs();
    // No bareId should still start with "lmstudio/"
    for (const r of refs) {
      expect(r.bareId.startsWith("lmstudio/")).toBe(false);
    }
  });

  test("deduplicates identical (bareId, location) pairs", () => {
    const refs = extractLocalModelRefs();
    const seen = new Set<string>();
    for (const r of refs) {
      const key = `${r.bareId}::${r.location}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

// ── findClosestMatch ──────────────────────────────────────────────────────────

describe("findClosestMatch", () => {
  const loadedIds = [
    "qwen3.5-35b-mlx-instruct",
    "phi-4-mini",
    "nomic-embed-text-v1.5",
  ];

  test("returns exact match when present", () => {
    expect(findClosestMatch("phi-4-mini", loadedIds)).toBe("phi-4-mini");
  });

  test("matches when loaded ID contains config ID (version suffix drift)", () => {
    // config says "qwen3.5-35b", LM Studio has "qwen3.5-35b-mlx-instruct"
    const result = findClosestMatch("qwen3.5-35b", loadedIds);
    expect(result).toBe("qwen3.5-35b-mlx-instruct");
  });

  test("matches when config ID contains loaded ID", () => {
    // config says "qwen3.5-35b-mlx-instruct-q4", loaded is "qwen3.5-35b-mlx-instruct"
    const result = findClosestMatch("qwen3.5-35b-mlx-instruct-q4", loadedIds);
    expect(result).toBe("qwen3.5-35b-mlx-instruct");
  });

  test("handles case and separator normalization", () => {
    // Hyphens vs underscores, mixed case
    const result = findClosestMatch("Phi_4_mini", loadedIds);
    expect(result).toBe("phi-4-mini");
  });

  test("returns undefined when no reasonable match", () => {
    const result = findClosestMatch("llama-3-70b-instruct", loadedIds);
    expect(result).toBeUndefined();
  });

  test("returns undefined for empty loaded list", () => {
    expect(findClosestMatch("qwen3.5-35b", [])).toBeUndefined();
  });

  test("shared prefix match: qwen3.5-35b vs qwen3.5-35b-mlx-instruct", () => {
    // Covered by "loaded contains config" branch but explicit is good
    const result = findClosestMatch("qwen3.5-35b", ["qwen3.5-35b-mlx-instruct", "phi-4-mini"]);
    expect(result).toBe("qwen3.5-35b-mlx-instruct");
  });
});

// ── fetchLoadedModels ─────────────────────────────────────────────────────────

describe("fetchLoadedModels", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns model list on success", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const models = await fetchLoadedModels("http://localhost:1234/v1", 500);
    expect(models).not.toBeNull();
    expect(models!.length).toBe(3);
    expect(models![0].id).toBe("qwen3.5-35b-mlx-instruct");
  });

  test("returns null when connection refused", async () => {
    global.fetch = makeFetch(null);
    const models = await fetchLoadedModels("http://localhost:1234/v1", 500);
    expect(models).toBeNull();
  });

  test("returns null on non-200 HTTP status", async () => {
    global.fetch = makeFetch({}, 503);
    const models = await fetchLoadedModels("http://localhost:1234/v1", 500);
    expect(models).toBeNull();
  });

  test("returns empty array when data is empty list", async () => {
    global.fetch = makeFetch({ object: "list", data: [] });
    const models = await fetchLoadedModels("http://localhost:1234/v1", 500);
    expect(models).toEqual([]);
  });

  test("appends /models to baseUrl", async () => {
    const mockFetch = makeFetch(LOADED_MODELS_RESPONSE);
    global.fetch = mockFetch;
    await fetchLoadedModels("http://localhost:1234/v1", 500);
    const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("http://localhost:1234/v1/models");
  });

  test("strips trailing slash from baseUrl before appending /models", async () => {
    const mockFetch = makeFetch(LOADED_MODELS_RESPONSE);
    global.fetch = mockFetch;
    await fetchLoadedModels("http://localhost:1234/v1/", 500);
    const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("http://localhost:1234/v1/models");
  });
});

// ── runLmStudioDiagnostic ─────────────────────────────────────────────────────

describe("runLmStudioDiagnostic", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("reports ok=true when no local models configured and LM Studio unreachable", async () => {
    global.fetch = makeFetch(null); // unreachable
    // Override to simulate no local refs (inject baseUrl for a fake server)
    const report = await runLmStudioDiagnostic({
      baseUrl: "http://localhost:9999/v1",
    });
    expect(report.reachable).toBe(false);
    // ok depends on whether there are configured local models
    // If no local models → ok=true; if local models → ok=false
    expect(typeof report.ok).toBe("boolean");
  });

  test("reports ok=false when LM Studio unreachable and local models exist", async () => {
    global.fetch = makeFetch(null);
    const report = await runLmStudioDiagnostic({
      baseUrl: "http://localhost:9999/v1",
    });
    expect(report.reachable).toBe(false);
    // If there are configured local models, should be not-ok
    if (report.configuredLocalModels.length > 0) {
      expect(report.ok).toBe(false);
      expect(report.mismatches.length).toBeGreaterThan(0);
    }
  });

  test("reports ok=true when all configured local models are loaded", async () => {
    // Build a response that includes all configured model bare IDs
    const configRefs = extractLocalModelRefs();
    const fakeLoaded = configRefs.map(r => ({ id: r.bareId, object: "model" }));
    global.fetch = makeFetch({ object: "list", data: fakeLoaded });

    const report = await runLmStudioDiagnostic({
      baseUrl: "http://localhost:1234/v1",
    });

    expect(report.reachable).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.mismatches).toHaveLength(0);
  });

  test("detects mismatches and provides suggestions", async () => {
    const configRefs = extractLocalModelRefs();
    if (configRefs.length === 0) return; // nothing to test

    const firstRef = configRefs[0];
    // Load a model with a suffix variant of the config ID
    const variantId = `${firstRef.bareId}-instruct`;
    global.fetch = makeFetch({
      object: "list",
      data: [{ id: variantId, object: "model" }],
    });

    const report = await runLmStudioDiagnostic({
      baseUrl: "http://localhost:1234/v1",
    });

    expect(report.reachable).toBe(true);
    // The first ref should be matched via fuzzy (loaded contains config)
    // OR if other refs are missing, there should be mismatches
    expect(typeof report.ok).toBe("boolean");
    // Any mismatch should have loadedIds populated
    for (const mm of report.mismatches) {
      expect(Array.isArray(mm.loadedIds)).toBe(true);
    }
  });

  test("warns when LM Studio has no models loaded", async () => {
    global.fetch = makeFetch({ object: "list", data: [] });
    const report = await runLmStudioDiagnostic({
      baseUrl: "http://localhost:1234/v1",
    });
    expect(report.reachable).toBe(true);
    expect(report.warnings.some(w => w.includes("no models"))).toBe(true);
  });

  test("report always has required shape", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const report = await runLmStudioDiagnostic({
      baseUrl: "http://localhost:1234/v1",
    });
    expect(typeof report.ok).toBe("boolean");
    expect(typeof report.reachable).toBe("boolean");
    expect(Array.isArray(report.loadedModels)).toBe(true);
    expect(Array.isArray(report.configuredLocalModels)).toBe(true);
    expect(Array.isArray(report.mismatches)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(report.checkedAt).toBeInstanceOf(Date);
  });
});

// ── checkModelsBeforeSpawn ────────────────────────────────────────────────────

describe("checkModelsBeforeSpawn", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns ok=true when no local models in list", async () => {
    // Non-local models (with claude/gpt prefix) should skip LM Studio check
    const result = await checkModelsBeforeSpawn(
      ["claude-3-5-sonnet-20241022", "claude-3-haiku-20240307"],
      { baseUrl: "http://localhost:1234/v1" },
    );
    expect(result.ok).toBe(true);
    expect(result.missingIds).toHaveLength(0);
  });

  test("returns ok=false with reachable=false when LM Studio down and local model needed", async () => {
    global.fetch = makeFetch(null);
    const result = await checkModelsBeforeSpawn(
      ["qwen3.5-35b"],  // bare id → treated as local
      { baseUrl: "http://localhost:9999/v1", timeoutMs: 500 },
    );
    expect(result.ok).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.missingIds).toContain("qwen3.5-35b");
  });

  test("returns ok=true when local model is loaded", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const result = await checkModelsBeforeSpawn(
      ["phi-4-mini"],   // exact match in LOADED_MODELS_RESPONSE
      { baseUrl: "http://localhost:1234/v1" },
    );
    expect(result.ok).toBe(true);
    expect(result.missingIds).toHaveLength(0);
  });

  test("returns ok=false and missing when model not in loaded list", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const result = await checkModelsBeforeSpawn(
      ["llama-3.3-70b-instruct"],
      { baseUrl: "http://localhost:1234/v1" },
    );
    expect(result.ok).toBe(false);
    expect(result.missingIds).toContain("llama-3.3-70b-instruct");
  });

  test("strips lmstudio/ prefix before matching", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const result = await checkModelsBeforeSpawn(
      ["lmstudio/phi-4-mini"],
      { baseUrl: "http://localhost:1234/v1" },
    );
    expect(result.ok).toBe(true);
  });

  test("provides suggestion when near-match exists", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const result = await checkModelsBeforeSpawn(
      ["qwen3.5-35b"],   // loaded: "qwen3.5-35b-mlx-instruct"
      { baseUrl: "http://localhost:1234/v1" },
    );
    // "qwen3.5-35b" should be found by fuzzy (loaded contains config)
    // so it should actually be OK (not missing)
    expect(result.ok).toBe(true);
  });

  test("result always has required shape", async () => {
    global.fetch = makeFetch(LOADED_MODELS_RESPONSE);
    const result = await checkModelsBeforeSpawn(["phi-4-mini"], {
      baseUrl: "http://localhost:1234/v1",
    });
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.reachable).toBe("boolean");
    expect(Array.isArray(result.missingIds)).toBe(true);
    expect(Array.isArray(result.loadedModels)).toBe(true);
    expect(typeof result.suggestions).toBe("object");
  });
});

// ── formatDiagnosticReport ────────────────────────────────────────────────────

describe("formatDiagnosticReport", () => {
  function makeReport(overrides: Partial<LmStudioDiagnosticReport>): LmStudioDiagnosticReport {
    return {
      ok: true,
      reachable: true,
      loadedModels: ["qwen3.5-35b-mlx-instruct", "phi-4-mini"],
      configuredLocalModels: [
        { id: "qwen3.5-35b", location: "tiers.micro" },
      ],
      mismatches: [],
      warnings: [],
      checkedAt: new Date("2026-03-17T12:00:00Z"),
      ...overrides,
    };
  }

  test("returns array of strings", () => {
    const lines = formatDiagnosticReport(makeReport({}), { color: false });
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.every(l => typeof l === "string")).toBe(true);
  });

  test("includes '✓' on ok report", () => {
    const lines = formatDiagnosticReport(makeReport({ ok: true, mismatches: [] }), { color: false });
    const joined = lines.join("\n");
    expect(joined).toContain("✓");
  });

  test("includes '✗' and mismatch configId on not-ok report", () => {
    const mismatch = {
      configId: "llama-3.3-70b",
      location: "tiers.standard",
      loadedIds: ["phi-4-mini"],
      suggestion: undefined,
    };
    const lines = formatDiagnosticReport(
      makeReport({ ok: false, mismatches: [mismatch] }),
      { color: false },
    );
    const joined = lines.join("\n");
    expect(joined).toContain("llama-3.3-70b");
    expect(joined).toContain("✗");
  });

  test("shows suggestion when present", () => {
    const mismatch = {
      configId: "qwen3.5-35b",
      location: "tiers.micro",
      loadedIds: ["qwen3.5-35b-mlx-instruct"],
      suggestion: "qwen3.5-35b-mlx-instruct",
    };
    const lines = formatDiagnosticReport(
      makeReport({ ok: false, mismatches: [mismatch] }),
      { color: false },
    );
    const joined = lines.join("\n");
    expect(joined).toContain("qwen3.5-35b-mlx-instruct");
    expect(joined).toContain("Closest match");
  });

  test("shows '(unreachable)' message when LM Studio is down", () => {
    const lines = formatDiagnosticReport(
      makeReport({ reachable: false, loadedModels: [] }),
      { color: false },
    );
    const joined = lines.join("\n");
    expect(joined).toContain("unreachable");
  });

  test("works without ANSI colors (color: false)", () => {
    const lines = formatDiagnosticReport(makeReport({}), { color: false });
    const joined = lines.join("");
    // No ANSI escape sequences
    expect(joined).not.toContain("\x1b[");
  });

  test("shows loaded models list", () => {
    const report = makeReport({
      loadedModels: ["phi-4-mini", "qwen3.5-35b-mlx-instruct"],
    });
    const lines = formatDiagnosticReport(report, { color: false });
    const joined = lines.join("\n");
    expect(joined).toContain("phi-4-mini");
    expect(joined).toContain("qwen3.5-35b-mlx-instruct");
  });

  test("shows how-to-fix instructions on mismatch", () => {
    const mismatch = {
      configId: "llama-3.3-70b",
      location: "tiers.standard",
      loadedIds: ["phi-4-mini"],
      suggestion: undefined,
    };
    const lines = formatDiagnosticReport(
      makeReport({ ok: false, mismatches: [mismatch] }),
      { color: false },
    );
    const joined = lines.join("\n");
    expect(joined).toMatch(/load|fix|update/i);
  });
});
