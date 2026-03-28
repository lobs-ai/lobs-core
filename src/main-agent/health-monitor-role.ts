/**
 * Main Agent Health Monitor Role
 *
 * Autonomous decision-making for health alerts:
 * - Classify alerts (cascade/accumulation/stall/exhaustion)
 * - Run supplementary diagnostics
 * - Decide: auto-execute vs. propose to Rafe
 * - Create inbox items + audit trail
 *
 * @see docs/designs/main-agent-proactive-health-monitor.md
 */

import { getRawDb } from "../db/connection.js";
import type { PawDB } from "../db/connection.js";
import { log } from "../util/logger.js";
import type { HealthProbeResult, SystemHealthSnapshot } from "../services/health-monitor.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type AlertClassification =
  | "restart_cascade_loop" // <2 min uptime between restarts
  | "restart_cascade_risk" // ≥3 restarts in 10 min
  | "orphan_accumulation_severe" // ≥10 orphaned in 1h
  | "orphan_accumulation_warn" // ≥5 orphaned in 1h
  | "session_stall" // Session unchanged for >grace period
  | "resource_exhaustion_critical" // Disk <200 MB
  | "resource_exhaustion_warn"; // Disk <500 MB

export interface RemediationAction {
  type: "auto" | "propose";
  category: "tune" | "cleanup" | "abort" | "propose_restart" | "propose_kill" | "info";
  description: string;
  rationale: string;
  changes?: Record<string, unknown>;
  logs?: string[];
}

// ─── Alert Classification ──────────────────────────────────────────────────

/**
 * Classify a health probe into an actionable alert category
 */
export function classifyHealthAlert(probes: HealthProbeResult[]): AlertClassification | null {
  const restartProbe = probes.find(p => p.probe === "restart-frequency");
  const orphanProbe = probes.find(p => p.probe === "orphaned-tasks");
  const sessionProbe = probes.find(p => p.probe === "session-staleness");
  const resourceProbe = probes.find(p => p.probe === "resource-exhaustion");

  // Priority: restart cascade is most urgent
  if (restartProbe?.severity === "critical") {
    const count = (restartProbe.detail?.count ?? 0) as number;
    // Check if it's a loop (very clustered restarts)
    const recent = (restartProbe.detail?.recent ?? []) as string[];
    if (recent.length >= 3) {
      // Rough heuristic: if 3 restarts in <6 minutes, likely a loop
      const firstRestartTime = new Date(recent[0]).getTime();
      const lastRestartTime = new Date(recent[recent.length - 1]).getTime();
      const timeSpanMs = lastRestartTime - firstRestartTime;
      if (timeSpanMs < 6 * 60 * 1000 && timeSpanMs > 0) {
        return "restart_cascade_loop";
      }
    }
    return "restart_cascade_risk";
  }

  // Orphaned accumulation
  if (orphanProbe?.severity === "critical") {
    return "orphan_accumulation_severe";
  }
  if (orphanProbe?.severity === "warn") {
    return "orphan_accumulation_warn";
  }

  // Session staleness
  if (sessionProbe?.severity === "warn") {
    return "session_stall";
  }

  // Resource exhaustion (highest priority after restart cascade)
  if (resourceProbe?.severity === "critical") {
    return "resource_exhaustion_critical";
  }
  if (resourceProbe?.severity === "warn") {
    return "resource_exhaustion_warn";
  }

  return null;
}

// ─── Decision Engine ───────────────────────────────────────────────────────

/**
 * Decide what action to take for an alert classification
 */
export async function decideRemediationAction(
  classification: AlertClassification,
  snapshot: SystemHealthSnapshot,
  db: PawDB
): Promise<RemediationAction> {
  switch (classification) {
    // ─── Restart Cascade: Abort new work spawning ─────────────────────────

    case "restart_cascade_loop":
      return {
        type: "auto",
        category: "abort",
        description: "Abort new work spawning due to restart loop",
        rationale:
          "Detected <2 minute uptime between restarts. Spawning new work will create orphaned tasks. " +
          "Aborting new spawns to prevent accumulation cascade.",
        changes: { cascade_abort_enabled: true, abort_reason: "restart_loop" },
      };

    case "restart_cascade_risk":
      return {
        type: "propose",
        category: "propose_restart",
        description:
          `Detected ${snapshot.restarts10m} restarts in 10 minutes. ` +
          "Recommend investigating root cause and restarting lobs-core.",
        rationale:
          "Cascading restarts indicate a systemic issue (crash loop, resource exhaustion, or deploy loop). " +
          "Human intervention needed to diagnose and fix root cause.",
        logs: await getDiagnosticLogs(db, "restart_cascade"),
      };

    // ─── Orphaned Accumulation: Increase session timeout ───────────────────

    case "orphan_accumulation_severe":
      return {
        type: "propose",
        category: "tune",
        description:
          `Detected ${snapshot.orphaned1h} orphaned tasks in 1 hour. ` +
          "Consider increasing session timeout to prevent frequent orphaning.",
        rationale:
          "High orphan rate indicates workers are timing out or being killed prematurely. " +
          "Increasing timeout may allow longer-running tasks to complete.",
        changes: {
          proposed_timeout_increase: "session_timeout_ms: +30 seconds",
        },
        logs: await getDiagnosticLogs(db, "orphan_accumulation"),
      };

    case "orphan_accumulation_warn":
      return {
        type: "auto",
        category: "tune",
        description: "Detected 5+ orphaned tasks in 1 hour. Monitoring enabled.",
        rationale: "Orphan rate is elevated but not critical. Monitoring for trend increase.",
        changes: { health_monitor_active: true },
      };

    // ─── Session Staleness: Diagnostic log only ──────────────────────────

    case "session_stall":
      return {
        type: "auto",
        category: "info",
        description: `Detected ${snapshot.stalledSessions} stalled session(s). Creating diagnostic log.`,
        rationale:
          "Stalled sessions may recover or may need manual intervention. Logging for audit trail.",
        logs: await getDiagnosticLogs(db, "session_stall"),
      };

    // ─── Resource Exhaustion: Cleanup or propose restart ─────────────────

    case "resource_exhaustion_critical":
      return {
        type: "propose",
        category: "cleanup",
        description:
          `Disk usage critically high (${snapshot.diskUsagePercent}%). ` +
          "Recommend cleaning up old sessions and compressing logs.",
        rationale:
          "Disk space <200 MB may cause ENOSPC errors and restart cascades. " +
          "Cleanup can free space immediately; if insufficient, recommend restart.",
        logs: await getDiagnosticLogs(db, "disk_exhaustion"),
      };

    case "resource_exhaustion_warn":
      return {
        type: "auto",
        category: "cleanup",
        description: `Disk usage high (${snapshot.diskUsagePercent}%). Archiving old sessions.`,
        rationale: "Disk usage >87%. Archiving sessions from >7 days ago to free space proactively.",
        changes: { archive_old_sessions: true, archive_cutoff_days: 7 },
      };

    default:
      return {
        type: "propose",
        category: "info",
        description: "Unknown health alert. Manual review needed.",
        rationale: "Classification fell through all cases.",
      };
  }
}

// ─── Create Inbox Items ────────────────────────────────────────────────────

/**
 * Create an inbox item for a proposed action
 * Only called when action.type === "propose"
 */
export async function createProposalInboxItem(
  db: PawDB,
  action: RemediationAction,
  alertType: string
): Promise<number | null> {
  if (action.type !== "propose") {
    return null;
  }

  const now = new Date().toISOString();
  const inboxItem = {
    type: "health_alert_proposal",
    priority: action.category === "propose_restart" ? "high" : "medium",
    triageCategory: alertType,
    title: action.description,
    content: action.rationale,
    metadata: {
      action: action.category,
      changes: action.changes,
      logs: action.logs,
    },
    createdAt: now,
    resolvedAt: null,
  };

  try {
    const result = getRawDb()
      .prepare(
        `
      INSERT INTO inbox_items
        (type, priority, triage_category, title, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        inboxItem.type,
        inboxItem.priority,
        inboxItem.triageCategory,
        inboxItem.title,
        inboxItem.content,
        JSON.stringify(inboxItem.metadata),
        inboxItem.createdAt
      );

    log().info(
      `[health-monitor] Created inbox item for ${alertType}: ${action.description} (id=${result.lastInsertRowid})`
    );
    return (result.lastInsertRowid as number) ?? null;
  } catch (e) {
    log().warn(`[health-monitor] Failed to create inbox item: ${e}`);
    return null;
  }
}

// ─── Execute Auto Actions ──────────────────────────────────────────────────

/**
 * Execute auto actions (safe, low-risk)
 * Should not throw; log errors and continue
 */
export async function executeAutoAction(
  db: PawDB,
  action: RemediationAction
): Promise<boolean> {
  if (action.type !== "auto") {
    return false;
  }

  try {
    switch (action.category) {
      case "tune":
        // Adjust session timeout parameters
        // This would be stored in a config table or environment
        log().info(
          `[health-monitor] AUTO TUNE: ${action.description} (changes: ${JSON.stringify(
            action.changes
          )})`
        );
        return true;

      case "cleanup":
        // Archive old sessions, compress logs
        // Implementation would call archiveOldSessions() and compressLogs()
        log().info(
          `[health-monitor] AUTO CLEANUP: ${action.description} (changes: ${JSON.stringify(
            action.changes
          )})`
        );
        return true;

      case "abort":
        // Abort new work spawning
        // Implementation would set a flag in orchestrator or control loop
        log().info(
          `[health-monitor] AUTO ABORT: ${action.description} (changes: ${JSON.stringify(
            action.changes
          )})`
        );
        // TODO: wire abort flag to control-loop
        return true;

      case "info":
        // Just log diagnostic info
        log().info(
          `[health-monitor] AUTO INFO: ${action.description} (changes: ${JSON.stringify(
            action.changes
          )})`
        );
        return true;

      default:
        return false;
    }
  } catch (e) {
    log().warn(`[health-monitor] Failed to execute auto action: ${e}`);
    return false;
  }
}

// ─── Diagnostic Helpers ────────────────────────────────────────────────────

/**
 * Generate diagnostic logs for an alert
 * These are included in proposals to help Rafe understand the issue
 */
async function getDiagnosticLogs(
  db: PawDB,
  _alertType: string
): Promise<string[] | undefined> {
  // Stub implementation
  // In real code, this would query the DB for relevant logs
  return undefined;
}

// ─── Main Health Monitor Tick ──────────────────────────────────────────────

/**
 * Called every 30 seconds from control loop
 * Orchestrates the full health monitoring flow
 */
export async function runHealthMonitorTick(
  db: PawDB,
  snapshot: SystemHealthSnapshot
): Promise<{
  alertDetected: boolean;
  classification: AlertClassification | null;
  action: RemediationAction | null;
}> {
  // Classify alerts from probes
  const classification = classifyHealthAlert(snapshot.probes);

  if (!classification) {
    // All healthy
    return {
      alertDetected: false,
      classification: null,
      action: null,
    };
  }

  log().info(`[health-monitor] Alert detected: ${classification}`);

  // Decide action
  const action = await decideRemediationAction(classification, snapshot, db);

  // Execute or propose
  if (action.type === "auto") {
    await executeAutoAction(db, action);
  } else if (action.type === "propose") {
    await createProposalInboxItem(db, action, classification);
  }

  return {
    alertDetected: true,
    classification,
    action,
  };
}
