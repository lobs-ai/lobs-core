/**
 * CronService — unified scheduler for lobs-core.
 *
 * Three kinds of jobs:
 *   1. System jobs — registered at boot with code handlers (heartbeat, memory condensation, etc.)
 *      Not stored in DB. Managed via code, not the agent tool.
 *   2. Agent jobs — DB-backed, fire text payloads into the main agent via handleSystemEvent.
 *      Managed by the agent via the cron tool, or via the API.
 *   3. Script jobs — DB-backed like agent jobs, but execute a shell command directly
 *      instead of invoking the LLM. For deterministic tasks that don't need AI reasoning.
 *
 * Both kinds of jobs are checked in a single 60-second tick loop
 * using proper cron expression matching.
 *
 * Observability: Every job fire is recorded in an in-memory ring buffer (CronFireEvent).
 * The fire log is accessible via getCronFireLog() / getCronFireSummary() and exposed at
 * GET /api/scheduler/fire-log so diagnosing "did this cron actually fire?" takes seconds,
 * not hours.
 */

import { randomUUID } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { log } from "../util/logger.js";

const execAsync = promisify(execCb);

// ── Fire-log observability ──────────────────────────────────────

/** Maximum number of fire events kept per job in the in-memory ring buffer. */
const FIRE_LOG_MAX_PER_JOB = 50;

/**
 * A single recorded fire of a cron job.
 *
 * Stored in-memory only — survives restarts only via the `lastFired` DB column,
 * but this detail log (outcome, duration, error) is purely runtime state.
 */
export interface CronFireEvent {
  jobId: string;
  jobName: string;
  /** "system" | "agent" | "script" */
  jobKind: string;
  /** ISO timestamp of when the job was fired */
  firedAt: string;
  /** Whether the job completed without throwing */
  success: boolean;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Error message if success=false */
  error?: string;
  /** Whether this fire was triggered manually (vs scheduler tick) */
  manual: boolean;
}

// ── Cron Expression Parser ──────────────────────────────────────

interface ParsedSchedule {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

/**
 * Parse a single cron field into an array of valid values.
 * Supports: * (all), N (specific), N-M (range), N,M (list), step /N
 */
function parseField(field: string, min: number, max: number): number[] {
  const results = new Set<number>();

  for (const part of field.split(",")) {
    const [rangeStr, stepStr] = part.trim().split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;

    if (rangeStr === "*") {
      for (let i = min; i <= max; i += step) results.add(i);
    } else if (rangeStr.includes("-")) {
      const [lo, hi] = rangeStr.split("-").map(Number);
      for (let i = lo; i <= hi; i += step) results.add(i);
    } else {
      results.add(parseInt(rangeStr, 10));
    }
  }

  return Array.from(results).sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression.
 */
export function parseCronExpression(expr: string): ParsedSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) {
    throw new Error(`Invalid cron expression: "${expr}"`);
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  };
}

/**
 * Check if a Date matches a parsed cron schedule.
 */
function matchesCronSchedule(schedule: ParsedSchedule, time: Date): boolean {
  return (
    schedule.minute.includes(time.getMinutes()) &&
    schedule.hour.includes(time.getHours()) &&
    schedule.dayOfMonth.includes(time.getDate()) &&
    schedule.month.includes(time.getMonth() + 1) &&
    schedule.dayOfWeek.includes(time.getDay())
  );
}

// ── Types ───────────────────────────────────────────────────────

/** DB-backed agent job */
export interface AgentJob {
  id: string;
  name: string;
  schedule: {
    kind: "cron" | "at" | "every";
    expr?: string;       // cron expression (for kind=cron)
    at?: string;         // ISO timestamp (for kind=at)
    everyMs?: number;    // interval ms (for kind=every)
    tz?: string;         // timezone
  };
  payload: string;       // Text injected as system event (agent) or shell command (script)
  payloadKind?: "agent" | "script"; // Execution mode (default: 'agent')
  enabled: boolean;
  lastFired?: string;    // ISO timestamp
  createdAt: string;
  channelId?: string;    // Discord channel ID to post replies to (optional)
}

/** In-memory system job */
export interface SystemJob {
  id: string;
  name: string;
  schedule: string;      // cron expression
  enabled: boolean;
  handler: () => Promise<void>;
  lastRun?: Date;
}

/** Unified view returned by list endpoints */
export interface CronJobView {
  id: string;
  name: string;
  kind: "system" | "agent";
  schedule: string;       // human-readable schedule string
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null; // ISO timestamp of next scheduled run
  channelId?: string;     // Discord channel ID for agent jobs
  payloadKind: "system" | "agent" | "script"; // Execution mode
}

/**
 * Compute the next fire time for a cron expression, brute-force scanning minute-by-minute.
 * Returns null if no match within 8 days (safeguard).
 */
function computeNextCronRun(cronExpr: string): string | null {
  try {
    const schedule = parseCronExpression(cronExpr);
    const now = new Date();
    // Start from next minute boundary
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Scan up to 8 days ahead (11520 minutes) to cover weekly schedules
    for (let i = 0; i < 11520; i++) {
      if (
        schedule.minute.includes(candidate.getMinutes()) &&
        schedule.hour.includes(candidate.getHours()) &&
        schedule.dayOfMonth.includes(candidate.getDate()) &&
        schedule.month.includes(candidate.getMonth() + 1) &&
        schedule.dayOfWeek.includes(candidate.getDay())
      ) {
        return candidate.toISOString();
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return null;
  } catch {
    return null;
  }
}

// ── CronService ─────────────────────────────────────────────────

export class CronService {
  private db: Database.Database;

  // System jobs (in-memory, code handlers)
  private systemJobs: Map<string, SystemJob> = new Map();
  private systemSchedules: Map<string, ParsedSchedule> = new Map();

  // Agent jobs (DB-backed, text payloads) — loaded from DB each tick
  private agentJobs: Map<string, AgentJob> = new Map();
  // Parsed schedules for cron-type agent jobs
  private agentSchedules: Map<string, ParsedSchedule> = new Map();

  // Unified tick interval
  private tickInterval?: NodeJS.Timeout;
  private running = false;

  // Event handler for agent jobs
  private onEvent: ((text: string, channelId?: string) => Promise<void>) | null = null;

  // ── Fire-log ring buffer ──
  /** Per-job ring buffer of the last FIRE_LOG_MAX_PER_JOB fire events (newest first). */
  private fireLog: Map<string, CronFireEvent[]> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTables();
    this.runMigrations();
  }

  private ensureTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule_kind TEXT NOT NULL,
        schedule_expr TEXT,
        schedule_at TEXT,
        schedule_every_ms INTEGER,
        schedule_tz TEXT DEFAULT 'America/New_York',
        payload TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_fired TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        channel_id TEXT
      );
    `);
  }

  /** Idempotent migrations — safe to leave permanently */
  private runMigrations() {
    // Remove the old seeded Heartbeat agent job (duplicated the system heartbeat job)
    this.db.prepare("DELETE FROM cron_jobs WHERE name = 'Heartbeat'").run();
    // Add channel_id column if it doesn't exist yet
    const cols = (
      this.db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!cols.includes("channel_id")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN channel_id TEXT");
    }
    // Add payload_kind column ('agent' or 'script') if it doesn't exist yet
    if (!cols.includes("payload_kind")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN payload_kind TEXT NOT NULL DEFAULT 'agent'");
    }
  }

  // ── System Job Registration ─────────────────────────────────

  /**
   * Register a system job (code handler, not DB-backed).
   * Called at boot time. These are infrastructure jobs like heartbeat, memory condensation, etc.
   */
  registerSystemJob(job: Omit<SystemJob, "lastRun">): void {
    try {
      const schedule = parseCronExpression(job.schedule);
      this.systemSchedules.set(job.id, schedule);
      this.systemJobs.set(job.id, { ...job, lastRun: undefined });
      log().info(`[cron] Registered system job "${job.name}" (${job.schedule})`);
    } catch (err) {
      log().warn(`[cron] Failed to register system job "${job.name}": ${err}`);
    }
  }

  /**
   * Enable/disable a system job at runtime.
   */
  toggleSystemJob(id: string, enabled: boolean): boolean {
    const job = this.systemJobs.get(id);
    if (!job) return false;
    job.enabled = enabled;
    log().info(`[cron] System job "${job.name}" ${enabled ? "enabled" : "disabled"}`);
    return true;
  }

  // ── Agent Job Management (DB-backed) ─────────────────────────

  /** Set the event handler for agent jobs */
  setEventHandler(handler: (text: string, channelId?: string) => Promise<void>) {
    this.onEvent = handler;
  }

  /** Add a new agent job. Returns the created job with generated ID. */
  addAgentJob(job: Omit<AgentJob, "id" | "createdAt">): AgentJob {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO cron_jobs
           (id, name, schedule_kind, schedule_expr, schedule_at, schedule_every_ms,
            schedule_tz, payload, enabled, channel_id, payload_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        job.name,
        job.schedule.kind,
        job.schedule.expr ?? null,
        job.schedule.at ?? null,
        job.schedule.everyMs ?? null,
        job.schedule.tz || "America/New_York",
        job.payload,
        job.enabled ? 1 : 0,
        job.channelId ?? null,
        job.payloadKind || "agent",
      );

    const fullJob: AgentJob = { ...job, id, createdAt: now };
    this.agentJobs.set(id, fullJob);

    // Parse cron schedule if applicable
    if (job.schedule.kind === "cron" && job.schedule.expr) {
      try {
        const parsed = parseCronExpression(job.schedule.expr);
        this.agentSchedules.set(id, parsed);
      } catch (err) {
        log().warn(`[cron] Failed to parse cron for agent job "${job.name}": ${err}`);
      }
    }

    return fullJob;
  }

  /** Remove an agent job. Returns true if a job was deleted. */
  removeAgentJob(id: string): boolean {
    this.agentSchedules.delete(id);
    this.agentJobs.delete(id);
    const result = this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Toggle an agent job enabled/disabled */
  toggleAgentJob(id: string, enabled: boolean) {
    this.db
      .prepare("UPDATE cron_jobs SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    const job = this.agentJobs.get(id);
    if (job) {
      job.enabled = enabled;
    }
  }

  /** List all agent jobs (including disabled, from DB) */
  listAgentJobs(): AgentJob[] {
    const rows = this.db.prepare("SELECT * FROM cron_jobs").all() as any[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      schedule: {
        kind: row.schedule_kind as "cron" | "at" | "every",
        expr: row.schedule_expr ?? undefined,
        at: row.schedule_at ?? undefined,
        everyMs: row.schedule_every_ms ?? undefined,
        tz: row.schedule_tz ?? "America/New_York",
      },
      payload: row.payload,
      payloadKind: (row.payload_kind as "agent" | "script") || "agent",
      enabled: row.enabled === 1,
      lastFired: row.last_fired ?? undefined,
      createdAt: row.created_at,
    }));
  }

  // ── Unified Job Listing ──────────────────────────────────────

  /** List all jobs (system + agent) in a unified view */
  listAllJobs(): CronJobView[] {
    const views: CronJobView[] = [];

    // System jobs
    for (const job of this.systemJobs.values()) {
      views.push({
        id: job.id,
        name: job.name,
        kind: "system",
        schedule: job.schedule,
        enabled: job.enabled,
        lastRun: job.lastRun?.toISOString() ?? null,
        nextRun: job.enabled ? computeNextCronRun(job.schedule) : null,
        payloadKind: "system",
      });
    }

    // Agent jobs (from DB for freshness)
    for (const agentJob of this.listAgentJobs()) {
      const scheduleStr =
        agentJob.schedule.kind === "cron"
          ? agentJob.schedule.expr ?? "(unknown)"
          : agentJob.schedule.kind === "at"
            ? `at ${agentJob.schedule.at}`
            : `every ${(agentJob.schedule.everyMs ?? 0) / 1000}s`;

      let nextRun: string | null = null;
      if (agentJob.enabled) {
        if (agentJob.schedule.kind === "cron" && agentJob.schedule.expr) {
          nextRun = computeNextCronRun(agentJob.schedule.expr);
        } else if (agentJob.schedule.kind === "at" && agentJob.schedule.at) {
          const atTime = new Date(agentJob.schedule.at);
          nextRun = atTime.getTime() > Date.now() ? atTime.toISOString() : null;
        }
      }

      views.push({
        id: agentJob.id,
        name: agentJob.name,
        kind: "agent",
        schedule: scheduleStr,
        enabled: agentJob.enabled,
        lastRun: agentJob.lastFired ?? null,
        nextRun,
        channelId: agentJob.channelId,
        payloadKind: agentJob.payloadKind || "agent",
      });
    }

    return views;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /** Start the unified scheduler */
  start() {
    if (this.running) return;
    this.running = true;

    // Load agent jobs from DB into memory
    this.loadAgentJobs();

    // Check for missed agent jobs and catch up (async, non-blocking)
    this.catchUpMissedJobs().catch((err) => {
      log().warn(`[cron] Error during startup catch-up: ${err}`);
    });

    // Start the 60-second tick for ALL jobs (system + agent)
    this.tickInterval = setInterval(() => this.tick(), 60_000);

    const systemCount = this.systemJobs.size;
    const agentCount = this.agentJobs.size;
    console.log(
      `[cron] Started — ${systemCount} system job(s), ${agentCount} agent job(s)`,
    );
  }

  /**
   * Catch-up: on startup, check if any enabled cron-type agent jobs missed
   * their scheduled fire time while lobs was down. If a job should have fired
   * within the last CATCH_UP_WINDOW_MS but didn't, fire it now.
   * Only catches up the most recent missed occurrence (not all of them).
   */
  private async catchUpMissedJobs(): Promise<void> {
    const CATCH_UP_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
    const now = new Date();

    for (const [id, job] of this.agentJobs.entries()) {
      if (!job.enabled || job.schedule.kind !== "cron") continue;

      const schedule = this.agentSchedules.get(id);
      if (!schedule) continue;

      // Find the most recent time this cron should have fired
      const lastExpectedFire = this.findLastCronMatch(schedule, now, CATCH_UP_WINDOW_MS);
      if (!lastExpectedFire) continue; // No expected fire within the window

      // Check if it actually fired at or after that time
      let lastFiredTime: Date | null = null;
      if (job.lastFired) {
        const normalised = job.lastFired.includes("T") || job.lastFired.endsWith("Z")
          ? job.lastFired
          : job.lastFired.replace(" ", "T") + "Z";
        lastFiredTime = new Date(normalised);
      }

      // If never fired, or last fire was before the expected fire time, catch up
      if (!lastFiredTime || lastFiredTime.getTime() < lastExpectedFire.getTime()) {
        log().info(
          `[cron] Catch-up: firing missed agent job "${job.name}" ` +
          `(should have fired at ${lastExpectedFire.toISOString()}, ` +
          `last fired: ${lastFiredTime?.toISOString() ?? "never"})`,
        );
        await this.fireAgentJob(job);
      }
    }
  }

  /**
   * Scan backwards from `now` to find the most recent time a cron schedule
   * would have matched, within `windowMs` milliseconds.
   * Returns the matching Date or null if none found within the window.
   */
  private findLastCronMatch(
    schedule: ParsedSchedule,
    now: Date,
    windowMs: number,
  ): Date | null {
    // Start from the current minute, go backwards
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);

    const cutoff = now.getTime() - windowMs;

    // Scan backwards minute-by-minute (up to windowMs / 60000 minutes)
    const maxMinutes = Math.ceil(windowMs / 60_000);
    for (let i = 0; i < maxMinutes; i++) {
      if (candidate.getTime() < cutoff) break;

      if (matchesCronSchedule(schedule, candidate)) {
        return new Date(candidate);
      }
      candidate.setMinutes(candidate.getMinutes() - 1);
    }

    return null;
  }

  /** Stop everything */
  stop() {
    this.running = false;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }

    log().info("[cron] Stopped");
  }

  /** Seed default agent jobs — no-op, no default agent jobs needed */
  seedDefaults() {
    // Previously seeded a "Heartbeat" agent job, but that duplicated the
    // system heartbeat job registered in main.ts. No default agent jobs needed.
  }

  // ── Fire-log helpers ────────────────────────────────────────────

  /**
   * Record a fire event into the per-job ring buffer (newest first, max FIRE_LOG_MAX_PER_JOB).
   * Called internally after every job execution.
   */
  private recordFire(event: CronFireEvent): void {
    const existing = this.fireLog.get(event.jobId) ?? [];
    // Prepend newest, cap length
    const updated = [event, ...existing].slice(0, FIRE_LOG_MAX_PER_JOB);
    this.fireLog.set(event.jobId, updated);
  }

  /**
   * Return the fire-log for all jobs, or just one job if jobId is supplied.
   * Entries are newest-first within each job.
   */
  getFireLog(jobId?: string): CronFireEvent[] {
    if (jobId) {
      return this.fireLog.get(jobId) ?? [];
    }
    // Merge all jobs, sort overall newest-first
    const all: CronFireEvent[] = [];
    for (const events of this.fireLog.values()) {
      all.push(...events);
    }
    return all.sort((a, b) => b.firedAt.localeCompare(a.firedAt));
  }

  /**
   * Return a per-job summary: last fire time, last success, consecutive failure count.
   * Useful for a status-page roll-up without sending the full raw log.
   */
  getFireSummary(): Array<{
    jobId: string;
    jobName: string;
    jobKind: string;
    lastFiredAt: string | null;
    lastSuccess: boolean | null;
    consecutiveFailures: number;
    totalFires: number;
  }> {
    const result = [];

    // Include every job in scope (system + agent + script)
    const allJobIds = new Set([
      ...Array.from(this.systemJobs.keys()),
      ...Array.from(this.agentJobs.keys()),
      // jobs with fire-log entries but no longer in memory
      ...Array.from(this.fireLog.keys()),
    ]);

    for (const id of allJobIds) {
      const events = this.fireLog.get(id) ?? [];
      const systemJob = this.systemJobs.get(id);
      const agentJob = this.agentJobs.get(id);
      const jobName = systemJob?.name ?? agentJob?.name ?? id;
      const jobKind = systemJob ? "system" : agentJob?.payloadKind === "script" ? "script" : "agent";

      let consecutiveFailures = 0;
      for (const ev of events) {
        if (!ev.success) consecutiveFailures++;
        else break;
      }

      result.push({
        jobId: id,
        jobName,
        jobKind,
        lastFiredAt: events[0]?.firedAt ?? null,
        lastSuccess: events[0]?.success ?? null,
        consecutiveFailures,
        totalFires: events.length,
      });
    }

    // Sort: jobs with failures first, then by most-recently-fired
    return result.sort((a, b) => {
      if (b.consecutiveFailures !== a.consecutiveFailures) {
        return b.consecutiveFailures - a.consecutiveFailures;
      }
      if (a.lastFiredAt && b.lastFiredAt) return b.lastFiredAt.localeCompare(a.lastFiredAt);
      if (a.lastFiredAt) return -1;
      if (b.lastFiredAt) return 1;
      return 0;
    });
  }

  /** Manually trigger a job by ID (system or agent) */
  async triggerJob(id: string): Promise<boolean> {
    // Check system jobs first
    const systemJob = this.systemJobs.get(id);
    if (systemJob) {
      log().info(`[cron] Manually triggering system job: ${systemJob.name}`);
      await this.runSystemJob(systemJob, true);
      return true;
    }

    // Check agent jobs
    const agentJob = this.agentJobs.get(id);
    if (agentJob) {
      log().info(`[cron] Manually triggering agent job: ${agentJob.name}`);
      await this.fireAgentJob(agentJob, true);
      return true;
    }

    return false;
  }

  // ── Internal: Unified Tick ────────────────────────────────────

  /**
   * Tick — runs every 60 seconds, checks ALL jobs (system + agent).
   * Both system and agent cron jobs use proper cron expression matching.
   */
  private async tick(): Promise<void> {
    const now = new Date();
    now.setSeconds(0);
    now.setMilliseconds(0);

    // ── System jobs ──
    for (const [id, job] of this.systemJobs.entries()) {
      if (!job.enabled) continue;

      const schedule = this.systemSchedules.get(id);
      if (!schedule) continue;

      if (!matchesCronSchedule(schedule, now)) continue;

      // Avoid duplicate runs within the same minute
      if (job.lastRun && job.lastRun.getTime() === now.getTime()) continue;

      await this.runSystemJob(job);
    }

    // ── Agent jobs ──
    // Reload from DB each tick to pick up newly added/changed jobs
    this.loadAgentJobs();

    for (const [id, job] of this.agentJobs.entries()) {
      if (!job.enabled) continue;

      switch (job.schedule.kind) {
        case "cron": {
          const schedule = this.agentSchedules.get(id);
          if (!schedule) continue;

          if (!matchesCronSchedule(schedule, now)) continue;

          // Avoid duplicate runs within the same minute
          if (job.lastFired) {
            // Normalize: SQLite datetime('now') stores UTC without 'Z' suffix,
            // so "2026-03-23 11:00:00" must be treated as UTC, not local time.
            const normalised = job.lastFired.includes("T") || job.lastFired.endsWith("Z")
              ? job.lastFired
              : job.lastFired.replace(" ", "T") + "Z";
            const lastFiredTime = new Date(normalised);
            lastFiredTime.setSeconds(0);
            lastFiredTime.setMilliseconds(0);
            if (lastFiredTime.getTime() === now.getTime()) continue;
          }

          await this.fireAgentJob(job);
          break;
        }
        case "at": {
          if (!job.schedule.at) continue;
          const targetTime = new Date(job.schedule.at).getTime();
          // Fire once when target time is reached, then disable
          if (Date.now() >= targetTime && !job.lastFired) {
            await this.fireAgentJob(job);
            this.db
              .prepare("UPDATE cron_jobs SET enabled = 0 WHERE id = ?")
              .run(job.id);
          }
          break;
        }
        case "every": {
          const ms = job.schedule.everyMs || 60_000;
          let lastFiredMs = 0;
          if (job.lastFired) {
            // Normalize UTC-without-Z strings from SQLite
            const normalised = job.lastFired.includes("T") || job.lastFired.endsWith("Z")
              ? job.lastFired
              : job.lastFired.replace(" ", "T") + "Z";
            lastFiredMs = new Date(normalised).getTime();
          }
          if (Date.now() - lastFiredMs >= ms) {
            await this.fireAgentJob(job);
          }
          break;
        }
      }
    }
  }

  private async runSystemJob(job: SystemJob, manual = false): Promise<void> {
    const start = Date.now();
    const firedAt = new Date().toISOString();
    job.lastRun = new Date();

    try {
      await job.handler();
      const durationMs = Date.now() - start;
      log().info(`[cron] ✅ System job "${job.name}" fired${manual ? " (manual)" : ""} — completed in ${durationMs}ms`);
      this.recordFire({
        jobId: job.id,
        jobName: job.name,
        jobKind: "system",
        firedAt,
        success: true,
        durationMs,
        manual,
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      log().warn(`[cron] ❌ System job "${job.name}" fired${manual ? " (manual)" : ""} — FAILED after ${durationMs}ms: ${msg}`);
      this.recordFire({
        jobId: job.id,
        jobName: job.name,
        jobKind: "system",
        firedAt,
        success: false,
        durationMs,
        error: msg,
        manual,
      });
    }
  }

  // ── Internal: Agent Job Helpers ───────────────────────────────

  /** Load all agent jobs from DB into memory, parsing cron schedules */
  private loadAgentJobs() {
    const rows = this.db
      .prepare("SELECT * FROM cron_jobs")
      .all() as any[];

    this.agentJobs.clear();
    this.agentSchedules.clear();

    for (const row of rows) {
      const job: AgentJob = {
        id: row.id,
        name: row.name,
        schedule: {
          kind: row.schedule_kind,
          expr: row.schedule_expr ?? undefined,
          at: row.schedule_at ?? undefined,
          everyMs: row.schedule_every_ms ?? undefined,
          tz: row.schedule_tz ?? "America/New_York",
        },
        payload: row.payload,
        payloadKind: (row.payload_kind as "agent" | "script") || "agent",
        enabled: row.enabled === 1,
        lastFired: row.last_fired ?? undefined,
        createdAt: row.created_at,
        channelId: row.channel_id ?? undefined,
      };
      this.agentJobs.set(row.id, job);

      // Pre-parse cron expressions for cron-type jobs
      if (job.schedule.kind === "cron" && job.schedule.expr) {
        try {
          const parsed = parseCronExpression(job.schedule.expr);
          this.agentSchedules.set(row.id, parsed);
        } catch (err) {
          log().warn(`[cron] Failed to parse cron for agent job "${job.name}": ${err}`);
        }
      }
    }
  }

  private async fireAgentJob(job: AgentJob, manual = false) {
    const jobKind = job.payloadKind === "script" ? "script" : "agent";
    log().info(`[cron] Firing ${jobKind} job: "${job.name}"${manual ? " (manual)" : ""}`);

    const start = Date.now();
    // Store as ISO 8601 UTC with 'Z' suffix so Node.js Date parsing is unambiguous
    const firedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE cron_jobs SET last_fired = ? WHERE id = ?")
      .run(firedAt, job.id);
    job.lastFired = firedAt;

    // Script jobs: execute shell command directly, no LLM involved
    if (job.payloadKind === "script") {
      try {
        const { stdout, stderr } = await execAsync(job.payload, {
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, HOME: process.env.HOME },
          shell: "/bin/bash",
        });
        const durationMs = Date.now() - start;
        log().info(`[cron] ✅ Script job "${job.name}" fired${manual ? " (manual)" : ""} — completed in ${durationMs}ms`);
        if (stdout.trim()) log().info(`[cron] Script job "${job.name}" stdout: ${stdout.trim().slice(0, 500)}`);
        if (stderr.trim()) log().warn(`[cron] Script job "${job.name}" stderr: ${stderr.trim().slice(0, 500)}`);
        this.recordFire({ jobId: job.id, jobName: job.name, jobKind, firedAt, success: true, durationMs, manual });
      } catch (err) {
        const durationMs = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        log().warn(`[cron] ❌ Script job "${job.name}" fired${manual ? " (manual)" : ""} — FAILED after ${durationMs}ms: ${msg}`);
        this.recordFire({ jobId: job.id, jobName: job.name, jobKind, firedAt, success: false, durationMs, error: msg, manual });
      }
      return;
    }

    // Agent jobs: fire text into the LLM via onEvent handler
    if (this.onEvent) {
      try {
        // Each agent job runs in a dedicated internal channel so the LLM
        // gets clean context and status replies don't leak to Discord.
        // Clear all but the last 2 messages from that channel before firing.
        const conversationChannel = `cron:${job.id}`;
        try {
          this.db
            .prepare(
              `DELETE FROM main_agent_messages
               WHERE channel_id = ?
               AND id NOT IN (
                 SELECT id FROM main_agent_messages
                 WHERE channel_id = ?
                 ORDER BY created_at DESC LIMIT 2
               )`,
            )
            .run(conversationChannel, conversationChannel);
        } catch {
          // table not present — no-op
        }

        // The agent uses the `message` tool to send to the actual Discord
        // channel. Its conversational replies stay on this internal channel.
        await this.onEvent(job.payload, conversationChannel);
        const durationMs = Date.now() - start;
        log().info(`[cron] ✅ Agent job "${job.name}" fired${manual ? " (manual)" : ""} — dispatched in ${durationMs}ms`);
        this.recordFire({ jobId: job.id, jobName: job.name, jobKind, firedAt, success: true, durationMs, manual });
      } catch (err) {
        const durationMs = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        log().warn(`[cron] ❌ Agent job "${job.name}" fired${manual ? " (manual)" : ""} — FAILED after ${durationMs}ms: ${msg}`);
        this.recordFire({ jobId: job.id, jobName: job.name, jobKind, firedAt, success: false, durationMs, error: msg, manual });
      }
    } else {
      const durationMs = Date.now() - start;
      log().warn(`[cron] ⚠️  Agent job "${job.name}" fired${manual ? " (manual)" : ""} but no onEvent handler registered — job dropped!`);
      this.recordFire({ jobId: job.id, jobName: job.name, jobKind, firedAt, success: false, durationMs, error: "No onEvent handler registered", manual });
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────

let _instance: CronService | null = null;

export function initCronService(db: Database.Database): CronService {
  _instance = new CronService(db);
  return _instance;
}

export function getCronService(): CronService | null {
  return _instance;
}
