/**
 * CronService — DB-backed scheduler that fires system events into the main agent.
 *
 * Supports three schedule kinds:
 *   - "cron"  — standard cron expressions (parsed to intervals for MVP)
 *   - "at"    — one-shot fire at specific ISO timestamp
 *   - "every" — recurring interval in milliseconds
 *
 * Jobs persist across restarts via SQLite.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface CronJob {
  id: string;
  name: string;
  schedule: {
    kind: "cron" | "at" | "every";
    expr?: string;      // cron expression (for kind=cron)
    at?: string;        // ISO timestamp (for kind=at)
    everyMs?: number;   // interval ms (for kind=every)
    tz?: string;        // timezone
  };
  payload: string;      // Text to inject as system event
  enabled: boolean;
  lastFired?: string;   // ISO timestamp
  createdAt: string;
}

export class CronService {
  private db: Database.Database;
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private onEvent: ((text: string) => Promise<void>) | null = null;
  private running = false;

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

  /** Set the event handler — called when a job fires */
  setEventHandler(handler: (text: string) => Promise<void>) {
    this.onEvent = handler;
  }

  /** Start the scheduler */
  start() {
    if (this.running) return;
    this.running = true;
    this.loadJobs();
    this.scheduleAll();
    console.log(`[cron-service] Started with ${this.jobs.size} jobs`);
  }

  /** Stop all scheduled jobs */
  stop() {
    this.running = false;
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /** Load jobs from DB */
  private loadJobs() {
    const rows = this.db
      .prepare("SELECT * FROM cron_jobs WHERE enabled = 1")
      .all() as any[];
    this.jobs.clear();
    for (const row of rows) {
      this.jobs.set(row.id, {
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

  /** Schedule all loaded jobs */
  private scheduleAll() {
    for (const job of this.jobs.values()) {
      this.scheduleJob(job);
    }
  }

  /** Schedule a single job */
  private scheduleJob(job: CronJob) {
    // Clear existing timer
    const existing = this.timers.get(job.id);
    if (existing) {
      clearTimeout(existing);
      clearInterval(existing);
    }

    switch (job.schedule.kind) {
      case "every": {
        const ms = job.schedule.everyMs || 60_000;
        const timer = setInterval(() => this.fireJob(job), ms);
        this.timers.set(job.id, timer);
        break;
      }
      case "at": {
        const targetTime = new Date(job.schedule.at!).getTime();
        const delay = targetTime - Date.now();
        if (delay > 0) {
          const timer = setTimeout(() => {
            this.fireJob(job);
            // One-shot: disable after firing
            this.db
              .prepare("UPDATE cron_jobs SET enabled = 0 WHERE id = ?")
              .run(job.id);
          }, delay);
          this.timers.set(job.id, timer);
        } else {
          // Already past — disable it
          this.db
            .prepare("UPDATE cron_jobs SET enabled = 0 WHERE id = ?")
            .run(job.id);
        }
        break;
      }
      case "cron": {
        const ms = this.parseCronToMs(job.schedule.expr || "*/30 * * * *");
        const timer = setInterval(() => this.fireJob(job), ms);
        this.timers.set(job.id, timer);
        break;
      }
    }
  }

  /** Fire a job — inject event into main agent */
  private async fireJob(job: CronJob) {
    console.log(`[cron-service] Firing job: ${job.name}`);

    // Update last fired
    this.db
      .prepare("UPDATE cron_jobs SET last_fired = datetime('now') WHERE id = ?")
      .run(job.id);
    job.lastFired = new Date().toISOString();

    // Fire event
    if (this.onEvent) {
      try {
        await this.onEvent(job.payload);
      } catch (err) {
        console.error(`[cron-service] Error firing job ${job.name}:`, err);
      }
    }
  }

  /**
   * MVP cron parser — converts common patterns to milliseconds.
   * Handles the most common scheduling patterns; full 5-field cron
   * parsing can be added later.
   */
  private parseCronToMs(expr: string): number {
    const parts = expr.trim().split(/\s+/);
    if (parts.length >= 5) {
      const [min, hour] = parts;
      // */N * * * * → every N minutes
      if (min.startsWith("*/")) {
        return parseInt(min.slice(2), 10) * 60_000;
      }
      // 0 * * * * → every hour
      if (min === "0" && hour === "*") return 3_600_000;
      // 0 */N * * * → every N hours
      if (min === "0" && hour.startsWith("*/")) {
        return parseInt(hour.slice(2), 10) * 3_600_000;
      }
    }
    // Default: 30 minutes
    return 1_800_000;
  }

  /** Add a new job */
  addJob(job: Omit<CronJob, "id" | "createdAt">): CronJob {
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

    const fullJob: CronJob = { ...job, id, createdAt: now };
    this.jobs.set(id, fullJob);
    if (job.enabled && this.running) this.scheduleJob(fullJob);
    return fullJob;
  }

  /** Remove a job */
  removeJob(id: string) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.delete(id);
    this.jobs.delete(id);
    this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  }

  /** Toggle a job enabled/disabled */
  toggleJob(id: string, enabled: boolean) {
    this.db
      .prepare("UPDATE cron_jobs SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    const job = this.jobs.get(id);
    if (job) {
      job.enabled = enabled;
      if (enabled) {
        this.scheduleJob(job);
      } else {
        const timer = this.timers.get(id);
        if (timer) {
          clearTimeout(timer);
          clearInterval(timer);
        }
        this.timers.delete(id);
      }
    }
  }

  /** List all jobs (including disabled, from DB) */
  listJobs(): CronJob[] {
    // Return from DB to include disabled jobs too
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

  /** Seed default jobs if none exist */
  seedDefaults() {
    const count = (
      this.db.prepare("SELECT COUNT(*) as c FROM cron_jobs").get() as any
    ).c;
    if (count > 0) return;

    this.addJob({
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

    console.log("[cron-service] Seeded default jobs");
  }
}

// ── Singleton access ────────────────────────────────────────────
let _instance: CronService | null = null;

export function initCronService(db: Database.Database): CronService {
  _instance = new CronService(db);
  return _instance;
}

export function getCronService(): CronService | null {
  return _instance;
}
