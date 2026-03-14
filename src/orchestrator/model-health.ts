/**
 * Model Health — circuit breaker per (model, agent_type) pair.
 *
 * States: closed → open → half_open → closed
 *
 * - 3 consecutive failures → OPEN
 * - After recovery window (default 30 min) → HALF_OPEN
 * - Probe success → CLOSED; probe fail → OPEN (timer reset)
 * - chooseHealthyModel() walks fallback chain, returns first non-OPEN
 * - All OPEN → degrade gracefully (returns first model with warning)
 */

import { log } from "../util/logger.js";
import { getRawDb } from "../db/connection.js";
import { getModelForTier } from "../config/models.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface ModelHealthRow {
  model: string;
  agentType: string;
  state: CircuitState;
  consecutiveFailures: number;
  totalFailures: number;
  totalRuns: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  openedAt: string | null;
  recoveryAfter: string | null;
  lastErrorSummary: string | null;
  manualOverride: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RECOVERY_MINUTES = 30;

function getSettings(): { threshold: number; recoveryMinutes: number; enabled: boolean } {
  try {
    const db = getRawDb();
    const row = db.prepare(
      "SELECT value FROM orchestrator_settings WHERE key = 'circuit_breaker'"
    ).get() as { value: string } | undefined;
    if (row?.value) {
      const cfg = JSON.parse(row.value) as Record<string, unknown>;
      return {
        threshold: (cfg.failure_threshold as number) ?? DEFAULT_FAILURE_THRESHOLD,
        recoveryMinutes: (cfg.recovery_minutes as number) ?? DEFAULT_RECOVERY_MINUTES,
        enabled: (cfg.enabled as boolean) ?? true,
      };
    }
  } catch { /* ignore */ }
  return { threshold: DEFAULT_FAILURE_THRESHOLD, recoveryMinutes: DEFAULT_RECOVERY_MINUTES, enabled: true };
}

/** Map raw SQLite snake_case columns to the camelCase ModelHealthRow interface. */
function mapRow(raw: Record<string, unknown>): ModelHealthRow {
  return {
    model: raw.model as string,
    agentType: (raw.agent_type ?? raw.agentType) as string,
    state: (raw.state ?? "closed") as CircuitState,
    consecutiveFailures: (raw.consecutive_failures ?? raw.consecutiveFailures ?? 0) as number,
    totalFailures: (raw.total_failures ?? raw.totalFailures ?? 0) as number,
    totalRuns: (raw.total_runs ?? raw.totalRuns ?? 0) as number,
    lastFailureAt: (raw.last_failure_at ?? raw.lastFailureAt ?? null) as string | null,
    lastSuccessAt: (raw.last_success_at ?? raw.lastSuccessAt ?? null) as string | null,
    openedAt: (raw.opened_at ?? raw.openedAt ?? null) as string | null,
    recoveryAfter: (raw.recovery_after ?? raw.recoveryAfter ?? null) as string | null,
    lastErrorSummary: (raw.last_error_summary ?? raw.lastErrorSummary ?? null) as string | null,
    manualOverride: (raw.manual_override ?? raw.manualOverride ?? null) as string | null,
    createdAt: (raw.created_at ?? raw.createdAt ?? "") as string,
    updatedAt: (raw.updated_at ?? raw.updatedAt ?? "") as string,
  };
}

function getOrCreate(model: string, agentType: string): ModelHealthRow {
  const db = getRawDb();
  const existing = db.prepare(
    "SELECT * FROM model_health WHERE model = ? AND agent_type = ?"
  ).get(model, agentType) as Record<string, unknown> | undefined;
  if (existing) return mapRow(existing);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO model_health
      (model, agent_type, state, consecutive_failures, total_failures, total_runs,
       last_failure_at, last_success_at, opened_at, recovery_after,
       last_error_summary, manual_override, created_at, updated_at)
    VALUES (?, ?, 'closed', 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `).run(model, agentType, now, now);
  return mapRow(db.prepare(
    "SELECT * FROM model_health WHERE model = ? AND agent_type = ?"
  ).get(model, agentType) as Record<string, unknown>);
}

function save(row: ModelHealthRow): void {
  const db = getRawDb();
  db.prepare(`
    UPDATE model_health SET
      state = ?, consecutive_failures = ?, total_failures = ?, total_runs = ?,
      last_failure_at = ?, last_success_at = ?, opened_at = ?, recovery_after = ?,
      last_error_summary = ?, manual_override = ?, updated_at = ?
    WHERE model = ? AND agent_type = ?
  `).run(
    row.state, row.consecutiveFailures, row.totalFailures, row.totalRuns,
    row.lastFailureAt, row.lastSuccessAt, row.openedAt, row.recoveryAfter,
    row.lastErrorSummary, row.manualOverride, new Date().toISOString(),
    row.model, row.agentType
  );
}

function resolveState(row: ModelHealthRow): CircuitState {
  if (row.manualOverride === "force_open") return "open";
  if (row.manualOverride === "force_closed") return "closed";
  if (row.state === "open" && row.recoveryAfter) {
    if (new Date() >= new Date(row.recoveryAfter)) {
      row.state = "half_open";
      save(row);
      log().info("[MODEL_HEALTH] " + row.model + "/" + row.agentType + ": OPEN → HALF_OPEN");
      return "half_open";
    }
  }
  return row.state;
}

/**
 * Exponential cooldown schedule based on consecutive failures.
 * 3 failures → 30 min, 4 → 1h, 5 → 3h, 6+ → 12h
 */
function cooldownMinutes(consecutiveFailures: number): number {
  if (consecutiveFailures <= 3) return 30;
  if (consecutiveFailures === 4) return 60;
  if (consecutiveFailures === 5) return 180;
  return 720; // 12 hours
}

function openCircuit(row: ModelHealthRow, _recoveryMinutes: number): void {
  const now = new Date();
  const minutes = cooldownMinutes(row.consecutiveFailures);
  row.state = "open";
  row.openedAt = now.toISOString();
  row.recoveryAfter = new Date(now.getTime() + minutes * 60_000).toISOString();
  save(row);
  log().warn("[MODEL_HEALTH] ⚠️  Circuit OPENED: " + row.model + "/" + row.agentType +
    " (failures=" + row.consecutiveFailures + ", recovery_after=" + row.recoveryAfter + ")");
  try {
    const db = getRawDb();
    db.prepare(
      "INSERT INTO control_loop_events (event_type, payload, created_at) VALUES ('circuit_opened', ?, ?)"
    ).run(JSON.stringify({
      model: row.model, agent_type: row.agentType,
      consecutive_failures: row.consecutiveFailures, recovery_after: row.recoveryAfter,
    }), now.toISOString());
  } catch { /* non-fatal */ }
}

/** Record outcome of a worker run. Call after saving worker_runs row. */
export function recordRunOutcome(
  model: string,
  agentType: string,
  succeeded: boolean,
  errorSummary = "",
): void {
  const { threshold, recoveryMinutes, enabled } = getSettings();
  if (!enabled) return;
  try {
    const row = getOrCreate(model, agentType);
    const state = resolveState(row);
    row.totalRuns++;
    if (succeeded) {
      row.consecutiveFailures = 0;
      row.lastSuccessAt = new Date().toISOString();
      if (state === "half_open") {
        row.state = "closed";
        row.openedAt = null;
        row.recoveryAfter = null;
        save(row);
        log().info("[MODEL_HEALTH] ✅ Circuit CLOSED: " + model + "/" + agentType + " (probe succeeded)");
        try {
          const db = getRawDb();
          db.prepare(
            "INSERT INTO control_loop_events (event_type, payload, created_at) VALUES ('circuit_closed', ?, ?)"
          ).run(JSON.stringify({ model, agent_type: agentType, reason: "probe_success" }), new Date().toISOString());
        } catch { /* non-fatal */ }
      } else {
        save(row);
      }
    } else {
      row.consecutiveFailures++;
      row.totalFailures++;
      row.lastFailureAt = new Date().toISOString();
      row.lastErrorSummary = errorSummary.slice(0, 500) || null;
      if (state === "half_open") {
        openCircuit(row, recoveryMinutes);
      } else if (state === "closed" && row.consecutiveFailures >= threshold) {
        openCircuit(row, recoveryMinutes);
      } else {
        save(row);
        log().debug?.("[MODEL_HEALTH] " + model + "/" + agentType +
          ": failure " + row.consecutiveFailures + "/" + threshold);
      }
    }
  } catch (e) {
    log().warn("[MODEL_HEALTH] recordRunOutcome error: " + String(e));
  }
}

/**
 * Walk a fallback chain and return the first healthy model.
 * Falls back gracefully to first model if all circuits are open.
 */
export function chooseHealthyModel(
  fallbackChain: string[],
  agentType: string,
): { model: string; degraded: boolean } {
  const { enabled } = getSettings();
  if (!enabled || fallbackChain.length === 0) {
    return { model: fallbackChain[0] ?? getModelForTier("standard"), degraded: false };
  }
  try {
    for (const model of fallbackChain) {
      const row = getOrCreate(model, agentType);
      const state = resolveState(row);
      if (state === "closed" || state === "half_open") {
        if (state === "half_open") {
          log().info("[MODEL_HEALTH] " + model + "/" + agentType + ": using HALF_OPEN probe");
        }
        return { model, degraded: false };
      }
      log().warn("[MODEL_HEALTH] Skipping " + model + "/" + agentType +
        ": circuit OPEN (recovery_after=" + row.recoveryAfter + ")");
    }
  } catch (e) {
    log().warn("[MODEL_HEALTH] chooseHealthyModel error: " + String(e));
    return { model: fallbackChain[0], degraded: false };
  }
  log().warn("[MODEL_HEALTH] ⚠️  All models for " + agentType + " circuit-open; degrading to " + fallbackChain[0]);
  return { model: fallbackChain[0], degraded: true };
}

/** Return all tracked health rows. */
export function getHealthSnapshot(): ModelHealthRow[] {
  try {
    const db = getRawDb();
    const rows = db.prepare("SELECT * FROM model_health ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  } catch { return []; }
}

/** Reset a specific circuit to closed. */
export function resetCircuit(model: string, agentType: string): void {
  try {
    const db = getRawDb();
    db.prepare(`
      UPDATE model_health SET state = 'closed', consecutive_failures = 0,
        opened_at = NULL, recovery_after = NULL, manual_override = NULL, updated_at = ?
      WHERE model = ? AND agent_type = ?
    `).run(new Date().toISOString(), model, agentType);
    log().info("[MODEL_HEALTH] Circuit reset: " + model + "/" + agentType);
  } catch (e) {
    log().warn("[MODEL_HEALTH] resetCircuit error: " + String(e));
  }
}

/** Force a circuit state. override: 'force_open' | 'force_closed' | null */
export function setManualOverride(model: string, agentType: string, override: string | null): void {
  try {
    const db = getRawDb();
    db.prepare(
      "UPDATE model_health SET manual_override = ?, updated_at = ? WHERE model = ? AND agent_type = ?"
    ).run(override, new Date().toISOString(), model, agentType);
    log().info("[MODEL_HEALTH] Override: " + model + "/" + agentType + " → " + (override ?? "cleared"));
  } catch (e) {
    log().warn("[MODEL_HEALTH] setManualOverride error: " + String(e));
  }
}

/**
 * Backfill model_health from recent worker_runs history.
 * Called once on orchestrator startup to give the circuit breaker accurate
 * context from before the restart. Only seeds rows that don't already exist.
 *
 * Design doc rule: orphaned-on-restart runs do NOT count as consecutive_failures —
 * those are infrastructure failures. Seed totals only; consecutive_failures starts at 0.
 * The circuit breaker will engage naturally going forward.
 */
export function seedModelHealthFromHistory(lookbackHours = 24): void {
  try {
    const db = getRawDb();

    // Query recent worker_runs grouped by (model, agent_type)
    const rows = db.prepare(`
      SELECT
        model,
        agent_type,
        COUNT(*) as total_runs,
        SUM(CASE WHEN succeeded = 0 AND timeout_reason IN ('session_dead', 'session_timeout') THEN 1 ELSE 0 END) as total_failures,
        MAX(CASE WHEN succeeded = 0 THEN ended_at END) as last_failure_at,
        MAX(CASE WHEN succeeded = 1 THEN ended_at END) as last_success_at
      FROM worker_runs
      WHERE model IS NOT NULL
        AND agent_type IS NOT NULL
        AND started_at > datetime('now', '-' || ? || ' hours')
      GROUP BY model, agent_type
    `).all(lookbackHours) as Array<{
      model: string;
      agent_type: string;
      total_runs: number;
      total_failures: number;
      last_failure_at: string | null;
      last_success_at: string | null;
    }>;

    if (rows.length === 0) {
      log().info("[MODEL_HEALTH] Boot seed: no recent worker_runs found (nothing to seed)");
      return;
    }

    const now = new Date().toISOString();
    let seeded = 0;
    let skipped = 0;

    for (const row of rows) {
      // Only seed if no existing row — don't overwrite live circuit state
      const existing = db.prepare(
        "SELECT model FROM model_health WHERE model = ? AND agent_type = ?"
      ).get(row.model, row.agent_type);

      if (existing) {
        skipped++;
        continue;
      }

      db.prepare(`
        INSERT INTO model_health
          (model, agent_type, state, consecutive_failures, total_failures, total_runs,
           last_failure_at, last_success_at, opened_at, recovery_after,
           last_error_summary, manual_override, created_at, updated_at)
        VALUES (?, ?, 'closed', 0, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        row.model,
        row.agent_type,
        row.total_failures,
        row.total_runs,
        row.last_failure_at,
        row.last_success_at,
        now,
        now,
      );
      seeded++;
    }

    log().info(
      `[MODEL_HEALTH] Boot seed: seeded ${seeded} model/agent_type pairs from last ${lookbackHours}h of worker_runs` +
      (skipped > 0 ? ` (${skipped} already existed, skipped)` : "")
    );
  } catch (e) {
    log().warn("[MODEL_HEALTH] seedModelHealthFromHistory error: " + String(e));
  }
}
