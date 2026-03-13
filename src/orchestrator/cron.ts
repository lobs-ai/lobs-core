// Cron system for lobs-core.
// Lightweight cron scheduler (no external dependencies).
// Supports: minute, hour, day-of-month, month, day-of-week with * and */N.
// Format: "minute hour day month weekday"
// Examples:
//   "* * * * *"      - every minute
//   "*/30 * * * *"   - every 30 minutes
//   "0 */6 * * *"    - every 6 hours
//   "0 0 * * 0"      - weekly (Sunday midnight)

import { log } from "../util/logger.js";

export interface CronJob {
  id: string;
  name: string;
  schedule: string; // cron expression
  enabled: boolean;
  handler: () => Promise<void>;
  lastRun?: Date;
  nextRun?: Date;
}

interface ParsedSchedule {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

// Parse a cron field (minute, hour, etc.)
// Supports: * (all), */N (every N), and specific numbers
function parseField(field: string, min: number, max: number): number[] {
  // Wildcard
  if (field === "*") {
    const result: number[] = [];
    for (let i = min; i <= max; i++) {
      result.push(i);
    }
    return result;
  }

  // Step value (*/N)
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) {
      throw new Error(`Invalid step value: ${field}`);
    }
    
    const result: number[] = [];
    for (let i = min; i <= max; i += step) {
      result.push(i);
    }
    return result;
  }

  // Specific number
  const num = parseInt(field, 10);
  if (isNaN(num) || num < min || num > max) {
    throw new Error(`Invalid field value: ${field} (must be ${min}-${max})`);
  }
  
  return [num];
}

/**
 * Parse a cron expression into arrays of valid values.
 */
function parseCronExpression(expr: string): ParsedSchedule {
  const parts = expr.trim().split(/\s+/);
  
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expr}" (expected 5 fields)`);
  }

  try {
    return {
      minute: parseField(parts[0], 0, 59),
      hour: parseField(parts[1], 0, 23),
      dayOfMonth: parseField(parts[2], 1, 31),
      month: parseField(parts[3], 1, 12),
      dayOfWeek: parseField(parts[4], 0, 6), // 0 = Sunday
    };
  } catch (error) {
    throw new Error(`Failed to parse cron expression "${expr}": ${error}`);
  }
}

/**
 * Calculate next run time based on schedule.
 */
function calculateNextRun(schedule: ParsedSchedule, after: Date = new Date()): Date {
  const next = new Date(after);
  next.setSeconds(0);
  next.setMilliseconds(0);
  
  // Start from next minute
  next.setMinutes(next.getMinutes() + 1);
  
  // Find next matching time (give up after 1 year)
  const maxIterations = 60 * 24 * 365;
  let iterations = 0;
  
  while (iterations < maxIterations) {
    const minute = next.getMinutes();
    const hour = next.getHours();
    const dayOfMonth = next.getDate();
    const month = next.getMonth() + 1; // JS months are 0-indexed
    const dayOfWeek = next.getDay();
    
    if (
      schedule.minute.includes(minute) &&
      schedule.hour.includes(hour) &&
      schedule.dayOfMonth.includes(dayOfMonth) &&
      schedule.month.includes(month) &&
      schedule.dayOfWeek.includes(dayOfWeek)
    ) {
      return next;
    }
    
    // Try next minute
    next.setMinutes(next.getMinutes() + 1);
    iterations++;
  }
  
  throw new Error("Could not calculate next run time (exceeded max iterations)");
}

/**
 * Check if a time matches the schedule.
 */
function matchesSchedule(schedule: ParsedSchedule, time: Date): boolean {
  return (
    schedule.minute.includes(time.getMinutes()) &&
    schedule.hour.includes(time.getHours()) &&
    schedule.dayOfMonth.includes(time.getDate()) &&
    schedule.month.includes(time.getMonth() + 1) &&
    schedule.dayOfWeek.includes(time.getDay())
  );
}

/**
 * Cron job manager.
 */
export class CronManager {
  private jobs: Map<string, CronJob> = new Map();
  private schedules: Map<string, ParsedSchedule> = new Map();
  private interval?: NodeJS.Timeout;
  private running = false;

  /**
   * Add a cron job.
   */
  addJob(job: CronJob): void {
    try {
      const schedule = parseCronExpression(job.schedule);
      this.schedules.set(job.id, schedule);
      
      // Calculate next run
      job.nextRun = calculateNextRun(schedule);
      
      this.jobs.set(job.id, job);
      log().info(`[cron] Added job "${job.name}" (${job.schedule}) — next run: ${job.nextRun.toISOString()}`);
    } catch (error) {
      throw new Error(`Failed to add cron job "${job.name}": ${error}`);
    }
  }

  /**
   * Remove a cron job.
   */
  removeJob(id: string): void {
    this.jobs.delete(id);
    this.schedules.delete(id);
    log().info(`[cron] Removed job: ${id}`);
  }

  /**
   * Start the cron scheduler.
   * Checks every minute for jobs to run.
   */
  start(): void {
    if (this.running) {
      log().info("[cron] Already running");
      return;
    }

    this.running = true;
    
    // Check every 60 seconds
    this.interval = setInterval(() => {
      this.tick();
    }, 60_000);
    
    log().info("[cron] Started (checking every 60s)");
  }

  /**
   * Stop the cron scheduler.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    
    this.running = false;
    log().info("[cron] Stopped");
  }

  /**
   * Check and run due jobs.
   */
  private async tick(): Promise<void> {
    const now = new Date();
    now.setSeconds(0);
    now.setMilliseconds(0);

    for (const [id, job] of Array.from(this.jobs.entries())) {
      if (!job.enabled) continue;

      const schedule = this.schedules.get(id);
      if (!schedule) continue;

      // Check if job should run now
      if (matchesSchedule(schedule, now)) {
        // Avoid duplicate runs within the same minute
        if (job.lastRun && job.lastRun.getTime() === now.getTime()) {
          continue;
        }

        log().info(`[cron] Running job: ${job.name}`);
        job.lastRun = new Date(now);

        // Run job async (don't block other jobs)
        this.runJob(job).catch((error) => {
          log().info(`[cron] Job "${job.name}" failed: ${error}`);
        });

        // Calculate next run
        try {
          job.nextRun = calculateNextRun(schedule, now);
        } catch (error) {
          log().info(`[cron] Failed to calculate next run for "${job.name}": ${error}`);
        }
      }
    }
  }

  /**
   * Run a job handler.
   */
  private async runJob(job: CronJob): Promise<void> {
    const start = Date.now();
    
    try {
      await job.handler();
      const duration = Date.now() - start;
      log().info(`[cron] Job "${job.name}" completed in ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      log().info(`[cron] Job "${job.name}" failed after ${duration}ms: ${message}`);
      throw error;
    }
  }

  /**
   * Get all registered jobs.
   */
  getJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get a specific job by ID.
   */
  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Check if scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}

// Singleton instance
const manager = new CronManager();

export function getCronManager(): CronManager {
  return manager;
}
