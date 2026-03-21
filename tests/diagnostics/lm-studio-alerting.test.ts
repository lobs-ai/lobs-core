/**
 * Tests for src/diagnostics/lm-studio-alerting.ts
 *
 * Uses the real in-memory SQLite DB (set up in tests/setup.ts) rather than
 * mocks, so alert insertion and de-duplication are tested end-to-end.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/connection.js";
import { inboxItems } from "../../src/db/schema.js";
import {
  evaluateAndAlert,
  LATENCY_WARN_MS,
  LATENCY_CRIT_MS,
} from "../../src/diagnostics/lm-studio-alerting.js";
import type { LmStudioDiagnosticReport } from "../../src/diagnostics/lmstudio.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Read all inbox alerts from the in-memory DB. */
function readAlerts() {
  return getDb()
    .select()
    .from(inboxItems)
    .where(eq(inboxItems.type, "alert"))
    .all();
}

/** Delete all inbox items between tests. */
function clearInbox() {
  getDb().delete(inboxItems).run();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("evaluateAndAlert", () => {
  beforeEach(() => {
    clearInbox();
  });

  // ── Healthy system ──────────────────────────────────────────────────────────

  describe("Healthy system", () => {
    it("fires no alerts when latency is within threshold and system is healthy", async () => {
      const result = await evaluateAndAlert(makeReport(), 250);

      expect(result.inserted).toBe(0);
      expect(result.fired).toHaveLength(0);
      expect(readAlerts()).toHaveLength(0);
    });

    it("fires no alerts at exactly LATENCY_WARN_MS (boundary — not above)", async () => {
      const result = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS);

      expect(result.inserted).toBe(0);
      expect(readAlerts()).toHaveLength(0);
    });
  });

  // ── Latency alerts ──────────────────────────────────────────────────────────

  describe("Latency threshold alerts", () => {
    it("fires a latency warning alert when latencyMs > LATENCY_WARN_MS", async () => {
      const result = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS + 1);

      expect(result.inserted).toBe(1);
      expect(result.fired).toContain("lm-studio:latency");

      const alerts = readAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0].triageCategory).toBe("lm-studio:latency");
      expect(alerts[0].triageUrgency).toBe("medium");
      expect(alerts[0].type).toBe("alert");
      expect(alerts[0].isRead).toBe(false);
    });

    it("fires a critical latency alert when latencyMs > LATENCY_CRIT_MS", async () => {
      const result = await evaluateAndAlert(makeReport(), LATENCY_CRIT_MS + 1);

      expect(result.fired).toContain("lm-studio:latency");

      const alerts = readAlerts();
      expect(alerts[0].triageUrgency).toBe("high");
      expect(alerts[0].title).toContain("critical");
    });

    it("fires a warning (not critical) when latency is between warn and crit thresholds", async () => {
      const midLatency = LATENCY_WARN_MS + Math.floor((LATENCY_CRIT_MS - LATENCY_WARN_MS) / 2);
      await evaluateAndAlert(makeReport(), midLatency);

      const alerts = readAlerts();
      expect(alerts[0].triageUrgency).toBe("medium");
      expect(alerts[0].title).toContain("warning");
    });

    it("fires no latency alert when latencyMs is null (unreachable)", async () => {
      await evaluateAndAlert(makeReport({ reachable: false }), null);

      const alerts = readAlerts();
      const latencyAlerts = alerts.filter(a => a.triageCategory === "lm-studio:latency");
      expect(latencyAlerts).toHaveLength(0);
    });
  });

  // ── Unreachable alert ───────────────────────────────────────────────────────

  describe("Unreachable alert", () => {
    it("fires an unreachable alert when LM Studio is down with local models configured", async () => {
      const report = makeReport({
        ok: false,
        reachable: false,
        loadedModels: [],
        configuredLocalModels: [{ id: "qwen/qwen3-4b", location: "tiers.micro" }],
      });

      const result = await evaluateAndAlert(report, null);

      expect(result.fired).toContain("lm-studio:unreachable");

      const alerts = readAlerts();
      const unreachable = alerts.find(a => a.triageCategory === "lm-studio:unreachable");
      expect(unreachable).toBeDefined();
      expect(unreachable!.triageUrgency).toBe("high");
      expect(unreachable!.requiresAction).toBe(true);
    });

    it("does NOT fire an unreachable alert when no local models are configured", async () => {
      const report = makeReport({
        reachable: false,
        loadedModels: [],
        configuredLocalModels: [],
      });

      const result = await evaluateAndAlert(report, null);

      expect(result.fired).not.toContain("lm-studio:unreachable");
    });
  });

  // ── Model-mismatch alert ────────────────────────────────────────────────────

  describe("Model-mismatch alert", () => {
    it("fires a mismatch alert when a configured model is not loaded", async () => {
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

      expect(result.fired).toContain("lm-studio:model-mismatch");

      const alerts = readAlerts();
      const mismatch = alerts.find(a => a.triageCategory === "lm-studio:model-mismatch");
      expect(mismatch).toBeDefined();
      expect(mismatch!.triageUrgency).toBe("high");
      expect(mismatch!.content).toContain("qwen3.5-35b-mlx");
      expect(mismatch!.content).toContain("tiers.standard");
    });

    it("includes model suggestion in alert content when available", async () => {
      const report = makeReport({
        ok: false,
        mismatches: [
          {
            configId: "missing-model-id",
            location: "tiers.micro",
            loadedIds: ["qwen/qwen3-4b"],
            suggestion: "qwen/qwen3-4b",
          },
        ],
      });

      await evaluateAndAlert(report, 200);

      const alerts = readAlerts();
      const mismatch = alerts.find(a => a.triageCategory === "lm-studio:model-mismatch");
      expect(mismatch!.content).toContain("qwen/qwen3-4b");
    });

    it("fires no mismatch alert when mismatches is empty", async () => {
      await evaluateAndAlert(makeReport({ mismatches: [] }), 200);

      const alerts = readAlerts();
      const mismatch = alerts.find(a => a.triageCategory === "lm-studio:model-mismatch");
      expect(mismatch).toBeUndefined();
    });
  });

  // ── Warnings alert ──────────────────────────────────────────────────────────

  describe("Warnings alert", () => {
    it("fires a low-urgency warnings alert when non-fatal warnings are present", async () => {
      const report = makeReport({
        warnings: ["No local models configured — skipping model comparison"],
      });

      const result = await evaluateAndAlert(report, 200);

      expect(result.fired).toContain("lm-studio:warnings");

      const alerts = readAlerts();
      const warn = alerts.find(a => a.triageCategory === "lm-studio:warnings");
      expect(warn).toBeDefined();
      expect(warn!.triageUrgency).toBe("low");
    });

    it("includes all warning messages in the alert content", async () => {
      const report = makeReport({
        warnings: ["warning one", "warning two"],
      });

      await evaluateAndAlert(report, 200);

      const alerts = readAlerts();
      const warn = alerts.find(a => a.triageCategory === "lm-studio:warnings");
      expect(warn!.content).toContain("warning one");
      expect(warn!.content).toContain("warning two");
    });
  });

  // ── De-duplication ──────────────────────────────────────────────────────────

  describe("De-duplication", () => {
    it("suppresses a duplicate alert when an unread one already exists", async () => {
      // First evaluation fires the alert
      const first = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS + 1);
      expect(first.inserted).toBe(1);

      // Second evaluation should suppress (same alert key, still unread)
      const second = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS + 1);
      expect(second.inserted).toBe(0);
      expect(second.suppressed).toBe(1);
      expect(second.skipped).toContain("lm-studio:latency");

      // Only one alert in DB
      expect(readAlerts()).toHaveLength(1);
    });

    it("allows re-firing once the existing alert is marked as read", async () => {
      // Fire once
      await evaluateAndAlert(makeReport(), LATENCY_WARN_MS + 1);

      // Mark it as read (simulates user acknowledging the alert)
      const alerts = readAlerts();
      getDb()
        .update(inboxItems)
        .set({ isRead: true })
        .where(eq(inboxItems.id, alerts[0].id))
        .run();

      // Fire again — should insert a new alert
      const result = await evaluateAndAlert(makeReport(), LATENCY_WARN_MS + 1);
      expect(result.inserted).toBe(1);
      expect(readAlerts()).toHaveLength(2); // original (read) + new (unread)
    });
  });

  // ── Multiple concurrent alerts ──────────────────────────────────────────────

  describe("Multiple concurrent alerts", () => {
    it("fires three alerts for high latency + mismatch + warnings", async () => {
      const report = makeReport({
        ok: false,
        mismatches: [
          { configId: "drift-model", location: "tiers.standard", loadedIds: [] },
        ],
        warnings: ["non-fatal warning"],
      });

      const result = await evaluateAndAlert(report, LATENCY_CRIT_MS + 500);

      expect(result.inserted).toBe(3);
      expect(result.fired).toContain("lm-studio:latency");
      expect(result.fired).toContain("lm-studio:model-mismatch");
      expect(result.fired).toContain("lm-studio:warnings");

      expect(readAlerts()).toHaveLength(3);
    });
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("Alert threshold constants", () => {
  it("LATENCY_WARN_MS is 1000ms", () => {
    expect(LATENCY_WARN_MS).toBe(1_000);
  });

  it("LATENCY_CRIT_MS is 3000ms", () => {
    expect(LATENCY_CRIT_MS).toBe(3_000);
  });

  it("critical threshold is higher than warning threshold", () => {
    expect(LATENCY_CRIT_MS).toBeGreaterThan(LATENCY_WARN_MS);
  });
});
