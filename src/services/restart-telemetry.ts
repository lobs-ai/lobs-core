/**
 * Restart Telemetry — early-detection for restart cascade conditions.
 *
 * Implements four probes identified in the 2026-03-16 post-mortem:
 *
 *   1. Restart-frequency counter   — CRITICAL if ≥ 3 restarts in 10 min
 *   2. Disk-space probe            — WARN < 500 MB, CRITICAL < 200 MB (checked at startup + every 10 min)
 *   3. Gateway token probe         — CRITICAL at startup if missing
 *   4. Memory-supervisor cap       — emit CRITICAL after N consecutive health-check failures
 *
 * All probes write structured log lines so they can be grepped, and return
 * a summary object for the Nexus status panel / daily brief.
 *
 * @see docs/post-mortems/2026-03-16-restart-cascade.md
 */

import { statfs } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const HOME = process.env.HOME ?? "";
const STATE_DIR = resolve(HOME, ".lobs");
const RESTART_HISTORY_FILE = resolve(STATE_DIR, "restart-history.json");

// Thresholds
const DISK_WARN_BYTES = 500 * 1024 * 1024;   // 500 MB
const DISK_CRITICAL_BYTES = 200 * 1024 * 1024; // 200 MB
const RESTART_WINDOW_MS = 10 * 60 * 1000;     // 10 minutes
const RESTART_CRITICAL_COUNT = 3;             // ≥ 3 restarts in window → cascade risk
const DISK_CHECK_INTERVAL_MS = 10 * 60 * 1000; // check every 10 min

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TelemetryProbeResult {
  probe: string;
  level: "ok" | "warn" | "critical";
  message: string;
  detail?: Record<string, unknown>;
}

export interface StartupTelemetryReport {
  timestamp: string;
  results: TelemetryProbeResult[];
  hasCritical: boolean;
  hasWarn: boolean;
}

// ─── Restart History ───────────────────────────────────────────────────────

interface RestartHistory {
  timestamps: number[]; // Unix ms
}

function loadRestartHistory(): RestartHistory {
  try {
    if (existsSync(RESTART_HISTORY_FILE)) {
      return JSON.parse(readFileSync(RESTART_HISTORY_FILE, "utf-8")) as RestartHistory;
    }
  } catch {}
  return { timestamps: [] };
}

function saveRestartHistory(history: RestartHistory): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(RESTART_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch {}
}

/**
 * Record this startup and return a probe result describing restart frequency.
 * Prunes entries older than the detection window before evaluating.
 */
function checkRestartFrequency(): TelemetryProbeResult {
  const now = Date.now();
  const history = loadRestartHistory();

  // Add this startup
  history.timestamps.push(now);

  // Prune entries outside the window (keep a 24h window in file for debugging)
  const windowStart = now - RESTART_WINDOW_MS;
  const recentRestarts = history.timestamps.filter(t => t >= windowStart);
  // Keep 24h for history but only prune from working set
  history.timestamps = history.timestamps.filter(t => t >= now - 24 * 60 * 60 * 1000);
  saveRestartHistory(history);

  const count = recentRestarts.length;
  const windowMinutes = RESTART_WINDOW_MS / 60_000;

  if (count >= RESTART_CRITICAL_COUNT) {
    return {
      probe: "restart-frequency",
      level: "critical",
      message: `[restart-telemetry] CRITICAL: ${count} restarts in the last ${windowMinutes} min — possible restart cascade`,
      detail: {
        recentRestarts: count,
        windowMinutes,
        threshold: RESTART_CRITICAL_COUNT,
        timestamps: recentRestarts.map(t => new Date(t).toISOString()),
      },
    };
  }

  if (count >= 2) {
    return {
      probe: "restart-frequency",
      level: "warn",
      message: `[restart-telemetry] WARN: ${count} restarts in the last ${windowMinutes} min`,
      detail: { recentRestarts: count, windowMinutes },
    };
  }

  return {
    probe: "restart-frequency",
    level: "ok",
    message: `[restart-telemetry] restart frequency OK (${count} in last ${windowMinutes} min)`,
    detail: { recentRestarts: count, windowMinutes },
  };
}

// ─── Disk Space Probe ──────────────────────────────────────────────────────

async function checkDiskSpace(path = STATE_DIR): Promise<TelemetryProbeResult> {
  try {
    const stats = await statfs(path);
    const freeBytes = stats.bfree * stats.bsize;
    const freeMB = Math.round(freeBytes / 1024 / 1024);
    const totalBytes = stats.blocks * stats.bsize;
    const usedPct = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);

    if (freeBytes < DISK_CRITICAL_BYTES) {
      return {
        probe: "disk-space",
        level: "critical",
        message: `[restart-telemetry] CRITICAL: only ${freeMB} MB free on disk (${usedPct}% used) — ENOSPC risk`,
        detail: { freeMB, usedPct, criticalThresholdMB: DISK_CRITICAL_BYTES / 1024 / 1024 },
      };
    }

    if (freeBytes < DISK_WARN_BYTES) {
      return {
        probe: "disk-space",
        level: "warn",
        message: `[restart-telemetry] WARN: ${freeMB} MB free on disk (${usedPct}% used) — approaching limit`,
        detail: { freeMB, usedPct, warnThresholdMB: DISK_WARN_BYTES / 1024 / 1024 },
      };
    }

    return {
      probe: "disk-space",
      level: "ok",
      message: `[restart-telemetry] disk space OK (${freeMB} MB free, ${usedPct}% used)`,
      detail: { freeMB, usedPct },
    };
  } catch (err) {
    return {
      probe: "disk-space",
      level: "warn",
      message: `[restart-telemetry] WARN: could not check disk space — ${(err as Error).message}`,
    };
  }
}

// ─── Gateway Token Probe ──────────────────────────────────────────────────

function checkGatewayToken(token: string | undefined): TelemetryProbeResult {
  if (!token || token.trim() === "") {
    return {
      probe: "gateway-token",
      level: "critical",
      message:
        "[restart-telemetry] CRITICAL: no gateway auth token configured — spawn_agent will fail silently; check lobs.json gateway.auth.token",
    };
  }
  return {
    probe: "gateway-token",
    level: "ok",
    message: "[restart-telemetry] gateway auth token present",
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Run all startup probes and return a consolidated report.
 * Call this near the top of main() after config is loaded but before
 * starting the control loop.
 *
 * @param gatewayToken  The resolved gateway.auth.token from lobs.json
 */
export async function runStartupTelemetry(gatewayToken?: string): Promise<StartupTelemetryReport> {
  const results: TelemetryProbeResult[] = await Promise.all([
    Promise.resolve(checkRestartFrequency()),
    checkDiskSpace(),
    Promise.resolve(checkGatewayToken(gatewayToken)),
  ]);

  const report: StartupTelemetryReport = {
    timestamp: new Date().toISOString(),
    results,
    hasCritical: results.some(r => r.level === "critical"),
    hasWarn: results.some(r => r.level === "warn"),
  };

  // Emit structured log lines — always log, severity determines prefix
  for (const r of results) {
    if (r.level === "critical") console.error(r.message);
    else if (r.level === "warn") console.warn(r.message);
    else console.log(r.message);
  }

  return report;
}

/**
 * Start the recurring disk-space probe (runs every 10 min).
 * Returns a cleanup function — call on shutdown.
 */
export function startDiskSpaceMonitor(onCritical?: (freeMB: number) => void): () => void {
  const timer = setInterval(async () => {
    const result = await checkDiskSpace();
    if (result.level === "critical") {
      console.error(result.message);
      onCritical?.((result.detail?.freeMB as number) ?? 0);
    } else if (result.level === "warn") {
      console.warn(result.message);
    }
  }, DISK_CHECK_INTERVAL_MS);

  return () => clearInterval(timer);
}

/**
 * Emit a CRITICAL log if the memory-supervisor has exceeded the consecutive
 * failure threshold. Call this from the health-check retry loop.
 *
 * @param consecutiveFailures  Current consecutive failure count
 * @param maxBeforeAlert       Alert threshold (default: 10)
 * @returns true if the threshold was just crossed (caller should back off)
 */
export function checkMemorySupervisorHealth(
  consecutiveFailures: number,
  maxBeforeAlert = 10,
): boolean {
  if (consecutiveFailures === maxBeforeAlert) {
    console.error(
      `[restart-telemetry] CRITICAL: memory-supervisor health check has failed ${consecutiveFailures} consecutive times — ` +
        "backing off to 5-min retry interval. Check disk space and memory-server logs.",
    );
    return true;
  }
  return false;
}

/**
 * Summarise the last 24h of restart history for use in daily briefs / sentinel.
 */
export function getRestartHistorySummary(): {
  last24h: number;
  lastWindowCount: number;
  lastRestartAt: string | null;
  cascadeRisk: boolean;
} {
  const history = loadRestartHistory();
  const now = Date.now();
  const last24h = history.timestamps.filter(t => t >= now - 24 * 60 * 60 * 1000).length;
  const lastWindowCount = history.timestamps.filter(t => t >= now - RESTART_WINDOW_MS).length;
  const sorted = [...history.timestamps].sort((a, b) => b - a);
  return {
    last24h,
    lastWindowCount,
    lastRestartAt: sorted[0] ? new Date(sorted[0]).toISOString() : null,
    cascadeRisk: lastWindowCount >= RESTART_CRITICAL_COUNT,
  };
}
