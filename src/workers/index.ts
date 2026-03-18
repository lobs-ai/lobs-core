/**
 * Worker Registry — manages lifecycle of all local model workers.
 *
 * Responsibilities:
 * - Register workers at boot
 * - Wire scheduled workers into the cron system
 * - Dispatch events to event-triggered workers
 * - Log all worker runs to DB
 * - Enforce concurrency limits (local model can only handle so much)
 * - Provide status/health info for the Nexus dashboard
 */

import type Database from "better-sqlite3";
import { log } from "../util/logger.js";
import type { CronService } from "../services/cron.js";
import type { BaseWorker, WorkerResult, WorkerEvent } from "./base-worker.js";

// ── DB Table ─────────────────────────────────────────────────────────────

const CREATE_WORKER_LOGS_TABLE = `
  CREATE TABLE IF NOT EXISTS worker_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT NOT NULL,
    worker_name TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    success INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    artifacts_count INTEGER NOT NULL DEFAULT 0,
    alerts_count INTEGER NOT NULL DEFAULT 0,
    trigger_type TEXT NOT NULL DEFAULT 'scheduled',
    trigger_event TEXT,
    summary TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const CREATE_WORKER_LOGS_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_worker_logs_worker_id ON worker_logs(worker_id);
`;

// ── Registry ─────────────────────────────────────────────────────────────

export class WorkerRegistry {
  private workers: Map<string, BaseWorker> = new Map();
  private db: Database.Database;
  private cron: CronService;
  private runningCount = 0;
  private maxConcurrency = 2;  // Max simultaneous local model calls

  constructor(db: Database.Database, cron: CronService) {
    this.db = db;
    this.cron = cron;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(CREATE_WORKER_LOGS_TABLE);
    this.db.exec(CREATE_WORKER_LOGS_INDEX);
  }

  /**
   * Register a worker. If it has a cron schedule, wire it into the cron system.
   */
  register(worker: BaseWorker): void {
    const { config } = worker;

    if (this.workers.has(config.id)) {
      log().warn(`[worker-registry] Worker "${config.id}" already registered, replacing`);
    }

    this.workers.set(config.id, worker);

    // Wire into cron if scheduled
    if (config.schedule && config.enabled) {
      this.cron.registerSystemJob({
        id: `worker:${config.id}`,
        name: `Worker: ${config.name}`,
        schedule: config.schedule,
        enabled: true,
        handler: async () => {
          await this.runWorker(config.id);
        },
      });
    }

    log().info(`[worker-registry] Registered "${config.name}" (${config.id})${config.schedule ? ` [${config.schedule}]` : " [event-driven]"}`);
  }

  /**
   * Run a specific worker by ID.
   * Respects concurrency limits.
   */
  async runWorker(id: string, event?: WorkerEvent): Promise<WorkerResult | null> {
    const worker = this.workers.get(id);
    if (!worker) {
      log().warn(`[worker-registry] Worker "${id}" not found`);
      return null;
    }

    if (!worker.config.enabled) {
      log().info(`[worker-registry] Worker "${id}" is disabled, skipping`);
      return null;
    }

    // Concurrency check
    if (this.runningCount >= this.maxConcurrency) {
      log().warn(`[worker-registry] Concurrency limit reached (${this.runningCount}/${this.maxConcurrency}), queuing "${id}"`);
      // For now, just skip. Could implement a queue later.
      return null;
    }

    this.runningCount++;
    const startedAt = new Date().toISOString();

    try {
      log().info(`[worker-registry] Running "${worker.config.name}"...`);
      const result = await worker.run(event);

      // Log to DB
      this.logRun(worker, startedAt, result, event);

      // Handle alerts
      for (const alert of result.alerts) {
        if (alert.severity === "critical") {
          log().error(`[worker:${id}] CRITICAL: ${alert.title} — ${alert.message}`);
          // TODO: surface to main agent via escalation
        } else if (alert.severity === "warning") {
          log().warn(`[worker:${id}] ${alert.title} — ${alert.message}`);
        }
      }

      if (result.summary) {
        log().info(`[worker:${id}] ${result.summary}`);
      }

      return result;
    } finally {
      this.runningCount--;
    }
  }

  /**
   * Dispatch an event to all workers that might handle it.
   */
  async dispatchEvent(event: WorkerEvent): Promise<void> {
    for (const [id, worker] of this.workers) {
      if (!worker.config.enabled) continue;

      // Only dispatch to workers that have an onEvent handler
      // (BaseWorker's default returns null, so this is safe)
      try {
        const result = await this.runWorker(id, event);
        if (result) {
          log().info(`[worker-registry] "${id}" handled event "${event.type}"`);
        }
      } catch (err) {
        log().error(`[worker-registry] "${id}" failed on event "${event.type}": ${err}`);
      }
    }
  }

  /**
   * Get status of all workers.
   */
  getStatus(): Array<{
    id: string;
    name: string;
    enabled: boolean;
    schedule?: string;
    lastRun?: { at: string; success: boolean; durationMs: number };
    totalRuns: number;
    totalTokens: number;
  }> {
    const statuses = [];

    for (const [id, worker] of this.workers) {
      const lastRun = this.db.prepare(
        "SELECT started_at, success, duration_ms FROM worker_logs WHERE worker_id = ? ORDER BY id DESC LIMIT 1"
      ).get(id) as { started_at: string; success: number; duration_ms: number } | undefined;

      const stats = this.db.prepare(
        "SELECT COUNT(*) as total_runs, COALESCE(SUM(tokens_used), 0) as total_tokens FROM worker_logs WHERE worker_id = ?"
      ).get(id) as { total_runs: number; total_tokens: number };

      statuses.push({
        id,
        name: worker.config.name,
        enabled: worker.config.enabled,
        schedule: worker.config.schedule,
        lastRun: lastRun ? {
          at: lastRun.started_at,
          success: lastRun.success === 1,
          durationMs: lastRun.duration_ms,
        } : undefined,
        totalRuns: stats.total_runs,
        totalTokens: stats.total_tokens,
      });
    }

    return statuses;
  }

  /**
   * Get recent logs for a specific worker.
   */
  getWorkerLogs(workerId: string, limit = 10): Array<Record<string, unknown>> {
    return this.db.prepare(
      "SELECT * FROM worker_logs WHERE worker_id = ? ORDER BY id DESC LIMIT ?"
    ).all(workerId, limit) as Array<Record<string, unknown>>;
  }

  /**
   * Get all registered worker IDs.
   */
  getWorkerIds(): string[] {
    return Array.from(this.workers.keys());
  }

  // ── Internal ────────────────────────────────────────────────────────

  private logRun(
    worker: BaseWorker,
    startedAt: string,
    result: WorkerResult,
    event?: WorkerEvent,
  ): void {
    this.db.prepare(
      `INSERT INTO worker_logs
        (worker_id, worker_name, started_at, ended_at, success, tokens_used,
         duration_ms, artifacts_count, alerts_count, trigger_type, trigger_event,
         summary, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      worker.config.id,
      worker.config.name,
      startedAt,
      new Date().toISOString(),
      result.success ? 1 : 0,
      result.tokensUsed,
      result.durationMs,
      result.artifacts.length,
      result.alerts.length,
      event ? "event" : "scheduled",
      event ? JSON.stringify(event) : null,
      result.summary ?? null,
      result.error ?? null,
    );
  }
}
