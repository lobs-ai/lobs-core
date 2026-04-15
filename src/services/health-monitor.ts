/**
 * Proactive System Health Monitor
 *
 * Runs every 30 seconds to detect:
 * - Restart cascades (≥3 restarts in 10 min)
 * - Orphaned task accumulation (≥5 in 1 hour)
 * - Session staleness (mtime unchanged > grace period)
 * - Resource exhaustion (disk <200 MB, memory pressure)
 *
 * Fires alerts to mainAgentHealthMonitorRole for decision-making.
 *
 * @see docs/designs/main-agent-proactive-health-monitor.md
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { os } from "node:os";
import { resolve } from "node:path";
import { getRawDb } from "../db/connection.js";
import type { PawDB } from "../db/connection.js";
import { log } from "../util/logger.js";
import { getLobsRoot } from "../config/lobs.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface HealthProbeResult {
  probe: string;
  healthy: boolean;
  severity: "ok" | "warn" | "critical";
  message: string;
  timestamp: Date;
  detail?: Record<string, unknown>;
}

export interface SystemHealthSnapshot {
  timestamp: Date;
  restarts10m: number;
  orphaned1h: number;
  openSessions: number;
  stalledSessions: number;
  diskUsagePercent: number;
  memoryUsagePercent: number;
  probes: HealthProbeResult[];
}

// ─── Thresholds ────────────────────────────────────────────────────────────

export const HEALTH_THRESHOLDS = {
  // Restart cascade detection
  restartCascadeWindow: 10 * 60 * 1000,      // 10 minutes
  restartWarnCount: 3,                        // ≥3 restarts = warn
  restartCriticalCount: 5,                    // ≥5 restarts = critical
  minUptimeMs: 2 * 60 * 1000,                 // <2 min uptime = loop

  // Orphaned task accumulation
  orphanAccumulationWindow: 60 * 60 * 1000,   // 1 hour
  orphanWarnThreshold: 5,                     // ≥5 orphans = warn
  orphanCriticalThreshold: 10,                // ≥10 orphans = critical

  // Session staleness
  sessionMtimeGraceMs: 30 * 1000,              // 30 seconds
  sessionStallCheckInterval: 30 * 1000,        // run check every 30s

  // Resource exhaustion
  diskCriticalBytes: 200 * 1024 * 1024,       // 200 MB
  diskWarnBytes: 500 * 1024 * 1024,           // 500 MB
};

// ─── Restart History (Probe A) ──────────────────────────────────────────────

/**
 * Probe A: Check restart frequency
 * Returns WARN if ≥3 restarts in 10 min, CRITICAL if ≥5 or <2 min uptime
 */
export function probeRestartFrequency(): HealthProbeResult {
  const historyFile = resolve(getLobsRoot(), "restart-history.json");

  let timestamps: number[] = [];
  if (existsSync(historyFile)) {
    try {
      const content = JSON.parse(readFileSync(historyFile, "utf-8")) as { timestamps?: number[] };
      timestamps = content.timestamps ?? [];
    } catch (e) {
      log().warn(`[health-monitor] Failed to parse restart history: ${e}`);
    }
  }

  const now = Date.now();
  const window = HEALTH_THRESHOLDS.restartCascadeWindow;
  const recentRestarts = timestamps.filter(t => t >= now - window);

  let severity: "ok" | "warn" | "critical" = "ok";
  let message = `Restart frequency OK (${recentRestarts.length} in 10 min)`;

  if (recentRestarts.length >= HEALTH_THRESHOLDS.restartCriticalCount) {
    // Check if they're clustered (min uptime between restarts)
    let minUptimeBetweenRestarts = Infinity;
    for (let i = 1; i < recentRestarts.length; i++) {
      minUptimeBetweenRestarts = Math.min(
        minUptimeBetweenRestarts,
        recentRestarts[i] - recentRestarts[i - 1]
      );
    }

    if (minUptimeBetweenRestarts < HEALTH_THRESHOLDS.minUptimeMs) {
      severity = "critical";
      message = `[restart-telemetry] CRITICAL: ${recentRestarts.length} restarts in ${Math.round(
        window / 60_000
      )}m — possible restart LOOP (min uptime ${Math.round(
        minUptimeBetweenRestarts / 1000
      )}s)`;
    } else if (recentRestarts.length >= HEALTH_THRESHOLDS.restartCriticalCount) {
      severity = "critical";
      message = `[restart-telemetry] CRITICAL: ${recentRestarts.length} restarts in 10 min — cascade risk`;
    }
  } else if (recentRestarts.length >= HEALTH_THRESHOLDS.restartWarnCount) {
    severity = "warn";
    message = `[restart-telemetry] WARN: ${recentRestarts.length} restarts in 10 min`;
  }

  return {
    probe: "restart-frequency",
    healthy: severity === "ok",
    severity,
    message,
    timestamp: new Date(),
    detail: {
      count: recentRestarts.length,
      window: `${Math.round(window / 60_000)}m`,
      recent: recentRestarts.map(t => new Date(t).toISOString()),
    },
  };
}

// ─── Orphaned Task Accumulation (Probe B) ───────────────────────────────────

/**
 * Probe B: Count orphaned tasks in last 1 hour
 * Returns WARN if ≥5, CRITICAL if ≥10
 */
export function probeOrphanedTasksAccumulation(db: PawDB): HealthProbeResult {
  const oneHourAgo = new Date(Date.now() - HEALTH_THRESHOLDS.orphanAccumulationWindow)
    .toISOString();

  try {
    const result = getRawDb()
      .prepare(
        `
      SELECT COUNT(*) as count FROM worker_runs
      WHERE timeout_reason IN ('orphaned on restart', 'orphaned-on-restart')
        AND ended_at > ?
    `
      )
      .get(oneHourAgo) as { count: number };

    const count = result.count;
    let severity: "ok" | "warn" | "critical" = "ok";
    let message = `Orphaned tasks OK (${count} in 1h)`;

    if (count >= HEALTH_THRESHOLDS.orphanCriticalThreshold) {
      severity = "critical";
      message = `[health-monitor] CRITICAL: ${count} orphaned tasks in 1h — potential accumulation cascade`;
    } else if (count >= HEALTH_THRESHOLDS.orphanWarnThreshold) {
      severity = "warn";
      message = `[health-monitor] WARN: ${count} orphaned tasks in 1h`;
    }

    return {
      probe: "orphaned-tasks",
      healthy: severity === "ok",
      severity,
      message,
      timestamp: new Date(),
      detail: { count, window: "1h" },
    };
  } catch (_e) {
    return {
      probe: "orphaned-tasks",
      healthy: false,
      severity: "warn",
      message: "Failed to query orphaned tasks",
      timestamp: new Date(),
    };
  }
}

// ─── Session Staleness (Probe C) ────────────────────────────────────────────

/**
 * Probe C: Check for stalled sessions
 * Returns WARN if any open session unchanged for >grace period
 */
export function probeSessionStaleness(db: PawDB): HealthProbeResult {
  try {
    // Find all open worker_runs (no ended_at)
    const openRuns = getRawDb()
      .prepare(
        `
      SELECT id, task_id, agent_type, child_session_key, started_at
      FROM worker_runs
      WHERE ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 20
    `
      )
      .all() as Array<{
      id: number;
      task_id: string;
      agent_type: string;
      child_session_key: string;
      started_at: string;
    }>;

    const now = Date.now();
    const graceMs = HEALTH_THRESHOLDS.sessionMtimeGraceMs;
    const stalledSessions = [];

    for (const run of openRuns) {
      try {
        const sessionPath = resolve(
          getLobsRoot(),
          "agents",
          run.agent_type,
          "sessions",
          `${run.task_id}.jsonl`
        );
        if (!existsSync(sessionPath)) {
          continue;
        }

        const stat = statSync(sessionPath);
        const ageMs = now - stat.mtimeMs;

        if (ageMs > graceMs) {
          stalledSessions.push({
            taskId: run.task_id,
            agentType: run.agent_type,
            ageSeconds: Math.round(ageMs / 1000),
          });
        }
      } catch (e) {
        log().debug?.(`[health-monitor] Failed to stat session for run ${run.id}: ${e}`);
      }
    }

    const severity = stalledSessions.length > 0 ? "warn" : "ok";
    const message =
      stalledSessions.length > 0
        ? `[health-monitor] WARN: ${stalledSessions.length} stalled session(s)`
        : `Session staleness OK`;

    return {
      probe: "session-staleness",
      healthy: stalledSessions.length === 0,
      severity,
      message,
      timestamp: new Date(),
      detail: {
        stalledCount: stalledSessions.length,
        sessions: stalledSessions,
      },
    };
  } catch (e) {
    return {
      probe: "session-staleness",
      healthy: false,
      severity: "warn",
      message: `Failed to check session staleness: ${e}`,
      timestamp: new Date(),
    };
  }
}

// ─── Resource Exhaustion (Probe D) ──────────────────────────────────────────

const DISK_CRITICAL_MB = 200;
const DISK_WARN_MB = 500;
const MEMORY_CRITICAL_PCT = 90;
const MEMORY_WARN_PCT = 85;
const CPU_CRITICAL = 1.0;
const CPU_WARN = 0.8;

/**
 * Probe D: Check disk, memory, and CPU availability.
 * Warns or criticals before processes crash with ENOSPC / OOM.
 */
export async function probeResourceExhaustion(): Promise<HealthProbeResult> {
  try {
    const issues: string[] = [];
    let diskUsagePct = 0;
    let diskFreeMB = 0;
    let memoryUsagePct = 0;
    let cpuLoad1m = 0;

    // ── Disk check ──────────────────────────────────────────────────────────
    try {
      const stateDir = resolve(os.homedir(), ".lobs");
      const stats = await statfs(stateDir);
      const freeBytes = stats.bfree * stats.bsize;
      const totalBytes = stats.blocks * stats.bsize;
      diskFreeMB = Math.round(freeBytes / 1024 / 1024);
      diskUsagePct = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);

      if (diskFreeMB < DISK_CRITICAL_MB) {
        issues.push(`disk CRITICAL: only ${diskFreeMB} MB free (${diskUsagePct}% used)`);
      } else if (diskFreeMB < DISK_WARN_MB) {
        issues.push(`disk WARN: ${diskFreeMB} MB free (${diskUsagePct}% used)`);
      }
    } catch {
      // statfs can fail on some platforms — skip disk check
    }

    // ── Memory check ─────────────────────────────────────────────────────────
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      memoryUsagePct = Math.round((usedMem / totalMem) * 100);

      if (memoryUsagePct > MEMORY_CRITICAL_PCT) {
        issues.push(`memory CRITICAL: ${memoryUsagePct}% used`);
      } else if (memoryUsagePct > MEMORY_WARN_PCT) {
        issues.push(`memory WARN: ${memoryUsagePct}% used`);
      }
    } catch {
      // skip
    }

    // ── CPU check ────────────────────────────────────────────────────────────
    try {
      const loadAvg = os.loadavg();
      cpuLoad1m = loadAvg[0]; // 1-minute load average
      const cpuCount = os.cpus().length;
      const normalizedLoad = cpuLoad1m / cpuCount;

      if (normalizedLoad > CPU_CRITICAL) {
        issues.push(`CPU CRITICAL: load ${cpuLoad1m.toFixed(2)} on ${cpuCount} cores`);
      } else if (normalizedLoad > CPU_WARN) {
        issues.push(`CPU WARN: load ${cpuLoad1m.toFixed(2)} on ${cpuCount} cores`);
      }
    } catch {
      // skip
    }

    if (issues.length === 0) {
      return {
        probe: "resource-exhaustion",
        healthy: true,
        severity: "ok",
        message: `Resources OK — disk ${diskUsagePct}% used, memory ${memoryUsagePct}%, CPU load ${cpuLoad1m.toFixed(2)}`,
        timestamp: new Date(),
        detail: { diskUsagePercent: diskUsagePct, diskFreeMB, memoryUsagePercent: memoryUsagePct, cpuLoad1m },
      };
    }

    const topIssue = issues[0];
    const isCritical = topIssue.includes("CRITICAL");
    return {
      probe: "resource-exhaustion",
      healthy: false,
      severity: isCritical ? "critical" : "warn",
      message: issues.join("; "),
      timestamp: new Date(),
      detail: { diskUsagePercent: diskUsagePct, diskFreeMB, memoryUsagePercent: memoryUsagePct, cpuLoad1m, issues },
    };
  } catch (e) {
    return {
      probe: "resource-exhaustion",
      healthy: false,
      severity: "warn",
      message: `Failed to check resource usage: ${e}`,
      timestamp: new Date(),
    };
  }
}

// ─── Main Health Check ──────────────────────────────────────────────────────

/**
 * Run all probes and return combined health snapshot
 */
export async function runHealthCheck(db: PawDB): Promise<SystemHealthSnapshot> {
  const [restart, orphan, staleness, resource] = await Promise.all([
    Promise.resolve(probeRestartFrequency()),
    Promise.resolve(probeOrphanedTasksAccumulation(db)),
    Promise.resolve(probeSessionStaleness(db)),
    probeResourceExhaustion(), // now async (disk + memory + CPU)
  ]);

  const probeResults = [restart, orphan, staleness, resource];

  return {
    timestamp: new Date(),
    restarts10m: (restart.detail?.count ?? 0) as number,
    orphaned1h: (orphan.detail?.count ?? 0) as number,
    openSessions: 0, // TODO: compute from db
    stalledSessions: (staleness.detail?.stalledCount ?? 0) as number,
    diskUsagePercent: (resource.detail?.diskUsagePercent ?? 0) as number,
    memoryUsagePercent: (resource.detail?.memoryUsagePercent ?? 0) as number,
    probes: probeResults,
  };
}

// ─── Utility: Create Health Alert from Probe ────────────────────────────────

export function probeToAlert(probe: HealthProbeResult) {
  if (probe.severity === "ok") {
    return null;
  }

  return {
    type: probe.probe,
    severity: probe.severity,
    message: probe.message,
    timestamp: probe.timestamp,
    detail: probe.detail,
  };
}
