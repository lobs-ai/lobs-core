/**
 * LM Studio alerting service.
 *
 * Evaluates diagnostic results against configured thresholds and fires
 * inbox alerts when latency is high or model-mismatch config drift is detected.
 *
 * Alert rules:
 *   LATENCY_WARN  — latencyMs > 1000ms  → triageUrgency "medium"
 *   LATENCY_CRIT  — latencyMs > 3000ms  → triageUrgency "high"
 *   UNREACHABLE   — LM Studio down with local models configured → "high"
 *   MODEL_MISMATCH — ≥1 configured local model not loaded → "high"
 *   WARNINGS      — any non-empty warnings[] field → "low"
 *
 * De-duplication:
 *   Alerts are keyed by (alertKey). If an unread alert with the same key
 *   already exists in the inbox, a new one is NOT created. Once the condition
 *   clears, future alerts can fire again.
 *
 * This module is intentionally side-effect-free on import — call
 * `evaluateAndAlert()` to trigger evaluation.
 */

import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { inboxItems } from "../db/schema.js";
import type { LmStudioDiagnosticReport } from "./lmstudio.js";
import { log } from "../util/logger.js";

// ── Thresholds (ms) ────────────────────────────────────────────────────────────

export const LATENCY_WARN_MS = 1_000;   // warn above 1 s
export const LATENCY_CRIT_MS = 3_000;   // critical above 3 s

// ── Alert descriptor ───────────────────────────────────────────────────────────

export type AlertUrgency = "low" | "medium" | "high";

export interface LmStudioAlert {
  /** Stable key used for de-duplication (stored as triageCategory) */
  alertKey: string;
  title: string;
  content: string;
  urgency: AlertUrgency;
}

// ── Alert builders ─────────────────────────────────────────────────────────────

function buildLatencyAlert(latencyMs: number): LmStudioAlert {
  const isCrit = latencyMs > LATENCY_CRIT_MS;
  return {
    alertKey: "lm-studio:latency",
    title: `LM Studio latency ${isCrit ? "critical" : "warning"}: ${latencyMs}ms`,
    content: [
      `LM Studio API round-trip latency is ${latencyMs}ms,`,
      `which exceeds the ${isCrit ? "critical" : "warning"} threshold of`,
      `${isCrit ? LATENCY_CRIT_MS : LATENCY_WARN_MS}ms.`,
      "",
      "Possible causes:",
      "  • LM Studio is running a large model inference",
      "  • System is under memory pressure (model being paged to swap)",
      "  • LM Studio process is overloaded",
      "",
      "Recommended actions:",
      "  1. Check LM Studio status and GPU/CPU usage",
      "  2. Consider unloading idle models",
      "  3. Run `lobs models` to see current state",
    ].join("\n"),
    urgency: isCrit ? "high" : "medium",
  };
}

function buildUnreachableAlert(baseUrl: string, mismatchCount: number): LmStudioAlert {
  return {
    alertKey: "lm-studio:unreachable",
    title: `LM Studio unreachable — ${mismatchCount} local model(s) cannot be verified`,
    content: [
      `LM Studio is not responding at ${baseUrl}.`,
      `${mismatchCount} local model(s) are configured but cannot be verified.`,
      "",
      "Any agent spawn requiring a local model will be blocked until LM Studio",
      "is reachable and the required models are loaded.",
      "",
      "Recommended actions:",
      "  1. Start LM Studio if it is not running",
      "  2. Verify the configured base URL in models.json: local.baseUrl",
      "  3. Load the required models and re-run `lobs models`",
    ].join("\n"),
    urgency: "high",
  };
}

function buildMismatchAlert(mismatches: LmStudioDiagnosticReport["mismatches"]): LmStudioAlert {
  const ids = mismatches.map(m => m.configId);
  const details = mismatches.map(m => {
    const suggestion = m.suggestion ? `  → closest loaded: ${m.suggestion}` : "  → no close match found";
    return `  • ${m.configId} (${m.location})\n${suggestion}`;
  });

  return {
    alertKey: "lm-studio:model-mismatch",
    title: `LM Studio model mismatch: ${ids.length} configured model(s) not loaded`,
    content: [
      `Config drift detected — ${ids.length} local model(s) referenced in config`,
      "are not currently loaded in LM Studio.",
      "",
      ...details,
      "",
      "Agent spawns requiring these models will be blocked.",
      "",
      "Recommended actions:",
      "  1. Load the missing model(s) in LM Studio (Server → Models → Load)",
      "  2. Or update ~/.lobs/config/models.json to match a loaded model ID",
      "  3. Run `lobs models` to verify resolution",
    ].join("\n"),
    urgency: "high",
  };
}

function buildWarningsAlert(warnings: string[]): LmStudioAlert {
  return {
    alertKey: "lm-studio:warnings",
    title: `LM Studio diagnostic warnings (${warnings.length})`,
    content: [
      "LM Studio diagnostic completed with non-fatal warnings:",
      "",
      ...warnings.map(w => `  ⚠ ${w}`),
      "",
      "These warnings do not block agent spawns but may indicate configuration",
      "drift or a degraded environment. Review and resolve at your earliest convenience.",
    ].join("\n"),
    urgency: "low",
  };
}

// ── Inbox insertion ────────────────────────────────────────────────────────────

/**
 * Write a single alert to the inbox, de-duplicating against unread alerts
 * with the same alertKey (stored as triageCategory).
 *
 * Returns true if the alert was inserted, false if a duplicate was suppressed.
 */
async function insertAlert(alert: LmStudioAlert): Promise<boolean> {
  const db = getDb();

  // De-dup: check for an existing unread alert with the same key
  const existing = db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.triageCategory, alert.alertKey),
        eq(inboxItems.isRead, false),
      ),
    )
    .all();

  if (existing.length > 0) {
    log().debug?.(`[LM_STUDIO_ALERT] Suppressing duplicate alert: ${alert.alertKey}`);
    return false;
  }

  db.insert(inboxItems).values({
    id: randomUUID(),
    title: alert.title,
    content: alert.content,
    type: "alert",
    requiresAction: true,
    actionStatus: "pending",
    triageCategory: alert.alertKey,
    triageUrgency: alert.urgency,
    triageRoute: "system",
    sourceAgent: "lm-studio-monitor",
    isRead: false,
  }).run();

  log().info(`[LM_STUDIO_ALERT] Alert fired: ${alert.alertKey} (urgency=${alert.urgency})`);
  return true;
}

// ── Main evaluation entry point ────────────────────────────────────────────────

export interface AlertEvaluationResult {
  /** Number of new alerts inserted */
  inserted: number;
  /** Number of alerts suppressed (duplicate) */
  suppressed: number;
  /** Keys of alerts that fired */
  fired: string[];
  /** Keys of alerts that were suppressed */
  skipped: string[];
}

/**
 * Evaluate an LM Studio diagnostic report against alerting thresholds.
 *
 * Fires inbox alerts for:
 *   - High latency (warn: >1000ms, crit: >3000ms)
 *   - LM Studio unreachable with local models configured
 *   - Model mismatches (config drift)
 *   - Non-fatal diagnostic warnings
 *
 * Safe to call on every diagnostic check — de-duplication prevents alert storms.
 *
 * @param report    Full diagnostic report from runLmStudioDiagnostic()
 * @param latencyMs Round-trip latency in ms (null if unreachable)
 */
export async function evaluateAndAlert(
  report: LmStudioDiagnosticReport,
  latencyMs: number | null,
): Promise<AlertEvaluationResult> {
  const candidates: LmStudioAlert[] = [];

  // Rule 1: Latency threshold breach
  if (latencyMs !== null && latencyMs > LATENCY_WARN_MS) {
    candidates.push(buildLatencyAlert(latencyMs));
  }

  // Rule 2: LM Studio unreachable with local models configured
  if (!report.reachable && report.configuredLocalModels.length > 0) {
    const cfgUrl = report.configuredLocalModels.length > 0
      ? "(see config local.baseUrl)"
      : "";
    candidates.push(buildUnreachableAlert(cfgUrl, report.configuredLocalModels.length));
  }

  // Rule 3: Model mismatches (config drift)
  if (report.mismatches.length > 0) {
    candidates.push(buildMismatchAlert(report.mismatches));
  }

  // Rule 4: Non-fatal diagnostic warnings
  if (report.warnings.length > 0) {
    candidates.push(buildWarningsAlert(report.warnings));
  }

  // Insert all candidates (each handles its own de-dup)
  const result: AlertEvaluationResult = {
    inserted: 0,
    suppressed: 0,
    fired: [],
    skipped: [],
  };

  for (const alert of candidates) {
    try {
      const inserted = await insertAlert(alert);
      if (inserted) {
        result.inserted++;
        result.fired.push(alert.alertKey);
      } else {
        result.suppressed++;
        result.skipped.push(alert.alertKey);
      }
    } catch (err) {
      // Never let alerting crash the diagnostic path
      log().warn(`[LM_STUDIO_ALERT] Failed to insert alert ${alert.alertKey}: ${err}`);
    }
  }

  return result;
}
