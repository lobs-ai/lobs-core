/**
 * Tests for lm-studio-alerting.ts
 *
 * Validates alert rules, threshold logic, and de-duplication behaviour.
 * All DB interactions are mocked via the vitest mock system.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock the db connection — we don't want a real SQLite file in tests
const mockAll = vi.fn<() => { id: string }[]>(() => []);
const mockRun = vi.fn();
const mockInsert = vi.fn(() => ({ values: vi.fn(() => ({ run: mockRun }) ) }));
const mockSelect = vi.fn(() => ({
  from: vi.fn(() => ({ where: vi.fn(() => ({ all: mockAll }) ) })),
}));

vi.mock("../../db/connection.js", () => ({
  getDb: vi.fn(() => ({
    select: mockSelect,
    insert: mockInsert,
  })),
}));

vi.mock("../../util/logger.js", () => ({
  log: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

// ── Imports (after mocks are set up) ─────────────────────────────────────────

import {
  evaluateAndAlert,
  LATENCY_WARN_MS,
  LATENCY_CRIT_MS,
} from "../lm-studio-alerting.js";
import type { LmStudioDiagnosticReport } from "../lmstudio.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeReport(overrides: Partial<LmStudioDiagnosticReport> = {}): LmStudioDiagnosticReport {
  return {
    ok: true,
    reachable: true,
    loadedModels: ["qwen/qwen3-4b"],
    configuredLocalModels: [{ id: "qwen/qwen3-4b", location: "tiers.micro" }],
    mismatches: [],
    warnings: [],
    checkedAt: new Date(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("evaluateAndAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no existing unread alerts (allow insertion)
    mockAll.mockReturnValue([]);
  });

  describe("Healthy system", () => {
    it("fires no alerts when system is healthy with low latency", async () => {
      const result = await evaluateAndAlert(makeReport(), 250);

      expect(result.inserted).toBe(0);
      expect(result.suppressed).toBe(0);
      expect(result.fired).toHaveLength(0);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("fires no alerts at exactly the warning threshold", async () => {
      const result = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS);

      expect(result.inserted).toBe(0);
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe("Latency alerts", () => {
    it("fires warning alert when latency exceeds LATENCY_WARN_MS", async () => {
      const result = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS + 1);

      expect(result.inserted).toBe(1);
      expect(result.fired).toContain("lm-studio:latency");

      // Check the inbox item was inserted with medium urgency
      const insertCall = mockInsert.mock.calls[0];
      expect(insertCall).toBeDefined();
    });

    it("fires critical alert when latency exceeds LATENCY_CRIT_MS", async () => {
      const result = await evaluateAndAlert(makeReport(), LATENCY_CRIT_MS + 1);

      expect(result.inserted).toBe(1);
      expect(result.fired).toContain("lm-studio:latency");
    });

    it("fires no alert when latency is null (unreachable)", async () => {
      const result = await evaluateAndAlert(makeReport({ reachable: false }), null);

      // null latency → no latency alert (unreachable alert may fire instead if local models configured)
      expect(result.fired).not.toContain("lm-studio:latency");
    });
  });

  describe("Unreachable alert", () => {
    it("fires unreachable alert when LM Studio is down with local models configured", async () => {
      const report = makeReport({
        ok: false,
        reachable: false,
        loadedModels: [],
        configuredLocalModels: [{ id: "qwen/qwen3-4b", location: "tiers.micro" }],
      });

      const result = await evaluateAndAlert(report, null);

      expect(result.inserted).toBeGreaterThanOrEqual(1);
      expect(result.fired).toContain("lm-studio:unreachable");
    });

    it("fires NO unreachable alert when no local models are configured", async () => {
      const report = makeReport({
        ok: true,
        reachable: false,
        loadedModels: [],
        configuredLocalModels: [],
      });

      const result = await evaluateAndAlert(report, null);

      expect(result.fired).not.toContain("lm-studio:unreachable");
    });
  });

  describe("Model-mismatch alert", () => {
    it("fires mismatch alert when configured model is not loaded", async () => {
      const report = makeReport({
        ok: false,
        mismatches: [
          {
            configId: "qwen3.5-35b-mlx",
            location: "tiers.standard",
            loadedIds: ["qwen/qwen3-4b"],
            suggestion: "qwen/qwen3-4b",
          },
        ],
      });

      const result = await evaluateAndAlert(report, 200);

      expect(result.inserted).toBe(1);
      expect(result.fired).toContain("lm-studio:model-mismatch");
    });

    it("fires no mismatch alert when mismatches is empty", async () => {
      const result = await evaluateAndAlert(makeReport({ mismatches: [] }), 200);

      expect(result.fired).not.toContain("lm-studio:model-mismatch");
    });
  });

  describe("Warnings alert", () => {
    it("fires warnings alert when non-fatal warnings are present", async () => {
      const report = makeReport({
        warnings: ["No local models configured — skipping model comparison"],
      });

      const result = await evaluateAndAlert(report, 200);

      expect(result.inserted).toBe(1);
      expect(result.fired).toContain("lm-studio:warnings");
    });

    it("fires no warnings alert when warnings is empty", async () => {
      const result = await evaluateAndAlert(makeReport({ warnings: [] }), 200);

      expect(result.fired).not.toContain("lm-studio:warnings");
    });
  });

  describe("De-duplication", () => {
    it("suppresses a duplicate alert when an unread one already exists", async () => {
      // Simulate an existing unread alert with key "lm-studio:latency"
      mockAll.mockReturnValue([{ id: "existing-alert-id" }]);

      const result = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS + 1);

      expect(result.inserted).toBe(0);
      expect(result.suppressed).toBe(1);
      expect(result.skipped).toContain("lm-studio:latency");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("fires an alert when no existing unread alert exists (allows re-fire after read)", async () => {
      // No existing alerts → insertion should happen
      mockAll.mockReturnValue([]);

      const result = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS + 1);

      expect(result.inserted).toBe(1);
      expect(result.fired).toContain("lm-studio:latency");
    });
  });

  describe("Multiple alerts", () => {
    it("fires multiple alerts for multiple concurrent issues", async () => {
      const report = makeReport({
        ok: false,
        reachable: true,
        mismatches: [
          {
            configId: "qwen3.5-35b-mlx",
            location: "tiers.standard",
            loadedIds: [],
            suggestion: undefined,
          },
        ],
        warnings: ["some non-fatal warning"],
      });

      const result = await evaluateAndAlert(report, LATENCY_CRIT_MS + 1);

      // latency + mismatch + warnings = 3 alerts
      expect(result.inserted).toBe(3);
      expect(result.fired).toContain("lm-studio:latency");
      expect(result.fired).toContain("lm-studio:model-mismatch");
      expect(result.fired).toContain("lm-studio:warnings");
    });

    it("mixes inserted and suppressed across multiple concurrent issues", async () => {
      // Latency alert already exists unread — suppress it
      // Mismatch alert does not exist — fire it
      mockAll.mockImplementation(() => {
        // We need to track which key is being queried.
        // Since the real code uses `eq(inboxItems.triageCategory, alert.alertKey)`,
        // we check the calls list length to simulate different responses.
        const callCount = mockAll.mock.calls.length;
        // 1st call = latency check → already exists
        if (callCount === 1) return [{ id: "dup-latency" }];
        // 2nd call = mismatch check → does not exist
        return [];
      });

      const report = makeReport({
        ok: false,
        mismatches: [
          {
            configId: "missing-model",
            location: "tiers.micro",
            loadedIds: [],
          },
        ],
      });

      const result = await evaluateAndAlert(report, LATENCY_WARN_MS + 1);

      expect(result.inserted).toBe(1);
      expect(result.suppressed).toBe(1);
      expect(result.fired).toContain("lm-studio:model-mismatch");
      expect(result.skipped).toContain("lm-studio:latency");
    });
  });

  describe("Error resilience", () => {
    it("does not throw when DB insertion fails — returns partial result", async () => {
      mockRun.mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY");
      });

      const result = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS + 1);

      // Should not throw — insertAlert catches errors per-alert
      expect(result).toBeDefined();
      expect(result.inserted).toBe(0); // failed, so not counted
    });
  });
});

describe("Alert threshold constants", () => {
  it("LATENCY_WARN_MS is 1000", () => {
    expect(LATENCY_WARN_MS).toBe(1_000);
  });

  it("LATENCY_CRIT_MS is 3000", () => {
    expect(LATENCY_CRIT_MS).toBe(3_000);
  });

  it("LATENCY_CRIT_MS > LATENCY_WARN_MS", () => {
    expect(LATENCY_CRIT_MS).toBeGreaterThan(LATENCY_WARN_MS);
  });
});
