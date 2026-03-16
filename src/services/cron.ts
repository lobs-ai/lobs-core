/**
 * CronService — unified scheduler for lobs-core.
 *
 * Two kinds of jobs:
 *   1. System jobs — registered at boot with code handlers (heartbeat, memory condensation, etc.)
 *      Not stored in DB. Managed via code, not the agent tool.
 *   2. Agent jobs — DB-backed, fire text payloads into the main agent via handleSystemEvent.
 *      Managed by the agent via the cron tool, or via the API.
 *
 * Schedule kinds:
 *   - "cron"  — standard 5-field cron expression (minute hour day month weekday)
 *   - "at"    — one-shot fire at specific ISO timestamp
 *   - "every" — recurring interval in milliseconds
 *
 * Uses proper cron expression parsing (supports *, *\/N, specific values, ranges, lists).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { log } from "../util/logger.js";

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
 * Supports: * (all), *\/N (every N), N (specific), N-M (range), N,M (list)
 */
function parseField(field: string, min: number, max: number): number[] {
  const results = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    // */N — every N
    if (trimmed.startsWith("*/")) {
      const step = parseInt(trimmed.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${trimmed}`);
      for (let i = min; i <= max; i += step) results.add(i);
      continue;
    }

    // * — wildcard
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) results.add(i);
      continue;
    }

    // N-M — range
    if (trimmed.includes("-")) {
      const [startStr, endStr] = trimmed.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range: ${trimmed}`);
      for (let i = start; i <= end; i++) results.add(i);
      continue;
    }

    // N — specific value
    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < min || num > max) {
      throw new Error(`Invalid value: ${trimmed} (must be ${min}-${max})`);
    }
    results.add(num);
  }

  return Array.from(results).sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression.
 */
function parseCronExpression(expr: string): ParsedSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expr}" (expected 5 fields)`);
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6), // 0 = Sunday
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
  payload: string;       // Text injected as system event
  enabled: boolean;
  lastFired?: string;    // ISO timestamp
  createdAt: string;
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
}

// ── CronService ─────────────────────────────────────────────────

export class CronService {
  private db: Database.Database;

  // System jobs (in-memory, code handlers)
  private systemJobs: Map<string, SystemJob> = new Map();
  private systemSchedules: Map<string, ParsedSchedule> = new Map();

  // Agent jobs (DB-backed, text payloads)
  private agentJobs: Map<string, AgentJob> = new Map();
  private agentTimers: Map<string, NodeJS.Timeout> = new Map();

  // Unified tick interval
  private tickInterval?: NodeJS.Timeout;
  private running = false;

  // Event handler for agent jobs
  private onEvent: ((text: string) => Promise<void>) | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTables();
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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
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
  setEventHandler(handler: (text: string) => Promise<void>) {
    this.onEvent = handler;
  }

  /** Add a new agent job */
  addAgentJob(job: Omit<AgentJob, "id" | "createdAt">): AgentJob {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO cron_jobs
           (id, name, schedule_kind, schedule_expr, schedule_at, schedule_every_ms,
            schedule_tz, payload, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );

    const fullJob: AgentJob = { ...job, id, createdAt: now };
    this.agentJobs.set(id, fullJob);
    if (job.enabled && this.running) this.scheduleAgentJob(fullJob);
    return fullJob;
  }

  /** Remove an agent job */
  removeAgentJob(id: string) {
    const timer = this.agentTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.agentTimers.delete(id);
    this.agentJobs.delete(id);
    this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  }

  /** Toggle an agent job enabled/disabled */
  toggleAgentJob(id: string, enabled: boolean) {
    this.db
      .prepare("UPDATE cron_jobs SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    const job = this.agentJobs.get(id);
    if (job) {
      job.enabled = enabled;
      if (enabled) {
        this.scheduleAgentJob(job);
      } else {
        const timer = this.agentTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          clearInterval(timer);
        }
        this.agentTimers.delete(id);
      }
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
      });
    }

    // Agent jobs
    for (const job of this.listAgentJobs()) {
      const scheduleStr =
        job.schedule.kind === "cron"
          ? job.schedule.expr ?? "*/30 * * * *"
          : job.schedule.kind === "every"
            ? `every ${job.schedule.everyMs}ms`
            : `at ${job.schedule.at}`;

      views.push({
        id: job.id,
        name: job.name,
        kind: "agent",
        schedule: scheduleStr,
        enabled: job.enabled,
        lastRun: job.lastFired ?? null,
      });
    }

    return views;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /** Start the unified scheduler */
  start() {
    if (this.running) return;
    this.running = true;

    // Load and schedule agent jobs from DB
    this.loadAgentJobs();
    this.scheduleAllAgentJobs();

    // Start the 60-second tick for system cron jobs
    this.tickInterval = setInterval(() => this.tick(), 60_000);

    const systemCount = this.systemJobs.size;
    const agentCount = this.agentJobs.size;
    console.log(
      `[cron] Started — ${systemCount} system job(s), ${agentCount} agent job(s)`,
    );
  }

  /** Stop everything */
  stop() {
    this.running = false;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }

    for (const [, timer] of this.agentTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.agentTimers.clear();

    log().info("[cron] Stopped");
  }

  /** Seed default agent jobs if none exist */
  seedDefaults() {
    const count = (
      this.db.prepare("SELECT COUNT(*) as c FROM cron_jobs").get() as any
    ).c;
    if (count > 0) return;

    this.addAgentJob({
      name: "Heartbeat",
      schedule: {
        kind: "cron",
        expr: "*/30 * * * *",
        tz: "America/New_York",
      },
      payload:
        "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
      enabled: true,
    });

    console.log("[cron] Seeded default agent jobs");
  }

  /** Manually trigger a job by ID (system or agent) */
  async triggerJob(id: string): Promise<boolean> {
    // Check system jobs first
    const systemJob = this.systemJobs.get(id);
    if (systemJob) {
      log().info(`[cron] Manually triggering system job: ${systemJob.name}`);
      await this.runSystemJob(systemJob);
      return true;
    }

    // Check agent jobs
    const agentJob = this.agentJobs.get(id);
    if (agentJob) {
      log().info(`[cron] Manually triggering agent job: ${agentJob.name}`);
      await this.fireAgentJob(agentJob);
      return true;
    }

    return false;
  }

  // ── Internal: System Job Tick ─────────────────────────────────

  /**
   * Tick — runs every 60 seconds, checks system cron jobs.
   * Agent jobs use their own timers (setTimeout/setInterval).
   */
  private async tick(): Promise<void> {
    const now = new Date();
    now.setSeconds(0);
    now.setMilliseconds(0);

    for (const [id, job] of this.systemJobs.entries()) {
      if (!job.enabled) continue;

      const schedule = this.systemSchedules.get(id);
      if (!schedule) continue;

      if (!matchesCronSchedule(schedule, now)) continue;

      // Avoid duplicate runs within the same minute
      if (job.lastRun && job.lastRun.getTime() === now.getTime()) continue;

      await this.runSystemJob(job);
    }
  }

  private async runSystemJob(job: SystemJob): Promise<void> {
    const start = Date.now();
    job.lastRun = new Date();

    try {
      await job.handler();
      const duration = Date.now() - start;
      log().info(`[cron] System job "${job.name}" completed in ${duration}ms`);
    } catch (err) {
      const duration = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      log().warn(`[cron] System job "${job.name}" failed after ${duration}ms: ${msg}`);
    }
  }

  // ── Internal: Agent Job Scheduling ────────────────────────────

  private loadAgentJobs() {
    const rows = this.db
      .prepare("SELECT * FROM cron_jobs WHERE enabled = 1")
      .all() as any[];
    this.agentJobs.clear();
    for (const row of rows) {
      this.agentJobs.set(row.id, {
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
        enabled: true,
        lastFired: row.last_fired ?? undefined,
        createdAt: row.created_at,
      });
    }
  }

  private scheduleAllAgentJobs() {
    for (const job of this.agentJobs.values()) {
      this.scheduleAgentJob(job);
    }
  }

  private scheduleAgentJob(job: AgentJob) {
    // Clear existing timer
    const existing = this.agentTimers.get(job.id);
    if (existing) {
      clearTimeout(existing);
      clearInterval(existing);
    }

    switch (job.schedule.kind) {
      case "every": {
        const ms = job.schedule.everyMs || 60_000;
        const timer = setInterval(() => this.fireAgentJob(job), ms);
        this.agentTimers.set(job.id, timer);
        break;
      }
      case "at": {
        const targetTime = new Date(job.schedule.at!).getTime();
        const delay = targetTime - Date.now();
        if (delay > 0) {
          const timer = setTimeout(() => {
            this.fireAgentJob(job);
            this.db
              .prepare("UPDATE cron_jobs SET enabled = 0 WHERE id = ?")
              .run(job.id);
          }, delay);
          this.agentTimers.set(job.id, timer);
        } else {
          this.db
            .prepare("UPDATE cron_jobs SET enabled = 0 WHERE id = ?")
            .run(job.id);
        }
        break;
      }
      case "cron": {
        // Use proper cron parsing — run via the tick system instead of setInterval
        // But we still need the interval approach for agent jobs since the tick
        // only handles system jobs. Convert to approximate ms interval.
        const ms = this.cronToMs(job.schedule.expr || "*/30 * * * *");
        const timer = setInterval(() => this.fireAgentJob(job), ms);
        this.agentTimers.set(job.id, timer);
        break;
      }
    }
  }

  private async fireAgentJob(job: AgentJob) {
    log().info(`[cron] Firing agent job: ${job.name}`);

    this.db
      .prepare("UPDATE cron_jobs SET last_fired = datetime('now') WHERE id = ?")
      .run(job.id);
    job.lastFired = new Date().toISOString();

    if (this.onEvent) {
      try {
        await this.onEvent(job.payload);
      } catch (err) {
        log().warn(`[cron] Error firing agent job ${job.name}: ${err}`);
      }
    }
  }

  /**
   * Convert common cron patterns to approximate ms.
   * Used for agent job interval scheduling.
   * (System jobs use proper cron matching via the tick loop.)
   */
  private cronToMs(expr: string): number {
    const parts = expr.trim().split(/\s+/);
    if (parts.length >= 5) {
      const [min, hour] = parts;
      if (min.startsWith("*/")) return parseInt(min.slice(2), 10) * 60_000;
      if (min === "0" && hour === "*") return 3_600_000;
      if (min === "0" && hour.startsWith("*/")) return parseInt(hour.slice(2), 10) * 3_600_000;
    }
    return 1_800_000; // default 30 min
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
