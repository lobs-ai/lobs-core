/**
 * LM Studio monitor service.
 *
 * Provides a single `runLmStudioAlertCheck()` function that runs the full
 * diagnostic pipeline and fires inbox alerts for any threshold breach. This
 * is the canonical entry point for the periodic cron job so that the alert
 * loop does not depend on an HTTP round-trip through /api/lm-studio/alert-check.
 *
 * Designed to be called from the cron system job registered in main.ts:
 *
 *   cronService.registerSystemJob({
 *     id: "lm-studio-monitor",
 *     schedule: "* /5 * * * *",   // every 5 minutes
 *     handler: async () => {
 *       await runLmStudioAlertCheck();
 *     },
 *   });
 *
 * Safe to call on every tick — de-duplication inside evaluateAndAlert()
 * prevents alert storms by suppressing duplicate unread alerts.
 */

import { performance } from "node:perf_hooks";
import { runLmStudioDiagnostic } from "../diagnostics/lmstudio.js";
import {
  evaluateAndAlert,
  type AlertEvaluationResult,
} from "../diagnostics/lm-studio-alerting.js";
import { getModelConfig } from "../config/models.js";
import { log } from "../util/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LmStudioMonitorResult {
  /** true when LM Studio is reachable and all configured models are loaded */
  ok: boolean;
  /** "healthy" | "degraded" | "unreachable" */
  status: "healthy" | "degraded" | "unreachable";
  /** Round-trip latency in ms, or null if unreachable */
  latencyMs: number | null;
  /** Alert evaluation results */
  alerts: AlertEvaluationResult;
  /** ISO timestamp of the check */
  checkedAt: string;
  /** Duration of the check in ms */
  durationMs: number;
}

// ── Latency probe ─────────────────────────────────────────────────────────────

/**
 * Measure the round-trip latency to LM Studio /v1/models in milliseconds.
 * Returns null if the request fails or times out.
 */
async function measureLatency(baseUrl: string, timeoutMs: number): Promise<number | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    await res.json(); // consume full body for accurate round-trip
    return Math.round(performance.now() - start);
  } catch {
    return null;
  }
}

// ── Status derivation ─────────────────────────────────────────────────────────

function deriveStatus(
  reachable: boolean,
  ok: boolean,
): "healthy" | "degraded" | "unreachable" {
  if (!reachable) return "unreachable";
  if (!ok) return "degraded";
  return "healthy";
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the full LM Studio alert check:
 *   1. Run the model diagnostic (reachability + config drift detection)
 *   2. Measure round-trip latency in parallel
 *   3. Evaluate all alerting rules and insert inbox alerts for breaches
 *
 * Returns a summary result suitable for logging. Never throws — all errors
 * are caught and surfaced as a degraded result.
 *
 * @param options  Override baseUrl and/or timeoutMs for the diagnostic
 */
export async function runLmStudioAlertCheck(options: {
  baseUrl?: string;
  timeoutMs?: number;
} = {}): Promise<LmStudioMonitorResult> {
  const start = performance.now();
  const checkedAt = new Date().toISOString();

  try {
    const cfg = getModelConfig();
    const baseUrl = options.baseUrl ?? cfg.local.baseUrl;
    const timeoutMs = Math.min(options.timeoutMs ?? 4_000, 10_000);

    // Run diagnostic and latency probe in parallel
    const [report, latencyMs] = await Promise.all([
      runLmStudioDiagnostic({ baseUrl, timeoutMs }),
      measureLatency(baseUrl, timeoutMs),
    ]);

    // Evaluate all rules and fire inbox alerts for any breach
    const alerts = await evaluateAndAlert(report, latencyMs);

    const status = deriveStatus(report.reachable, report.ok);
    const durationMs = Math.round(performance.now() - start);

    if (alerts.inserted > 0) {
      log().info(
        `[lm-studio-monitor] ${status} — ${alerts.inserted} alert(s) fired: ${alerts.fired.join(", ")} (${durationMs}ms)`,
      );
    } else {
      log().debug?.(
        `[lm-studio-monitor] ${status} — no new alerts (${durationMs}ms)`,
      );
    }

    return {
      ok: report.ok,
      status,
      latencyMs,
      alerts,
      checkedAt,
      durationMs,
    };
  } catch (err) {
    // Never let the monitor crash the cron tick
    const durationMs = Math.round(performance.now() - start);
    log().warn(`[lm-studio-monitor] Check failed after ${durationMs}ms: ${err}`);

    return {
      ok: false,
      status: "unreachable",
      latencyMs: null,
      alerts: { inserted: 0, suppressed: 0, fired: [], skipped: [] },
      checkedAt,
      durationMs,
    };
  }
}
