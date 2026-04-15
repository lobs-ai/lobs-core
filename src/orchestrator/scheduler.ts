/**
 * Smart task scheduler with priority-based scoring.
 *
 * Selects which tasks to execute based on:
 * - Urgency (task priority field)
 * - Age (how long task has been waiting)
 * - Cost efficiency (prefer cheaper tasks when budget is tight)
 *
 * Also enforces:
 * - Max concurrent workers
 * - Daily cost budget
 */

import { log } from "../util/logger.js";
import { getRawDb } from "../db/connection.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLobsRoot } from "../config/lobs.js";

export interface SchedulerConfig {
  maxConcurrentWorkers: number;
  maxDailyCostUsd: number;
  priorityWeights: {
    /** Weight for task priority (high/medium/low) */
    urgency: number;
    /** Weight for task age (minutes waiting) */
    age: number;
    /** Weight for cost efficiency (prefer cheaper) */
    costEfficiency: number;
  };
}

export interface Task {
  id: string;
  title: string;
  priority: string; // "high" | "medium" | "low"
  agent: string;
  modelTier?: string;
  createdAt: string;
  projectId?: string;
}

export interface DailyCostTracker {
  date: string;
  totalCostUsd: number;
  taskCount: number;
}

const COST_TRACKER_PATH = join(getLobsRoot(), "config/daily-cost.json");

/**
 * Get the next batch of tasks to execute, ordered by priority score.
 *
 * Scoring formula:
 * score = urgency_weight * priority_score + age_weight * wait_minutes + cost_weight * (1 / estimated_cost)
 *
 * Where:
 * - priority_score: high=10, medium=5, low=1
 * - wait_minutes: minutes since task was created
 * - estimated_cost: rough cost estimate based on model tier
 *
 * Returns up to maxConcurrentWorkers tasks.
 */
export function getNextTasks(config: SchedulerConfig): Task[] {
  const db = getRawDb();

  // Check current worker count
  const activeWorkers = db
    .prepare(`SELECT COUNT(*) as count FROM worker_runs WHERE ended_at IS NULL`)
    .get() as { count: number };

  const availableSlots = config.maxConcurrentWorkers - activeWorkers.count;
  if (availableSlots <= 0) {
    log().debug?.(`[SCHEDULER] No available worker slots (${activeWorkers.count}/${config.maxConcurrentWorkers})`);
    return [];
  }

  // NOTE: As of ADR-008 (Unlimited Operations), cost is managed at the model tier level
  // (MiniMax is $0; strong tier auto-escalates when needed). No daily budget enforcement here.
  // Get all ready tasks
  const readyTasks = db
    .prepare(
      `SELECT id, title, priority, agent, model_tier, created_at, project_id 
       FROM tasks 
       WHERE status = 'active' AND work_state = 'not_started'
       ORDER BY created_at ASC`,
    )
    .all() as Array<{
    id: string;
    title: string;
    priority: string | null;
    agent: string | null;
    model_tier: string | null;
    created_at: string;
    project_id: string | null;
  }>;

  if (readyTasks.length === 0) {
    return [];
  }

  // Score each task
  const now = Date.now();
  const scored = readyTasks.map((task) => {
    const priority = task.priority ?? "medium";
    const modelTier = task.model_tier ?? "medium";
    const createdAt = new Date(task.created_at).getTime();
    const waitMinutes = (now - createdAt) / 60000;

    // Priority score: high=10, medium=5, low=1
    const priorityScore =
      priority === "high" ? 10 : priority === "low" ? 1 : 5;

    // Estimated cost per task based on model tier
    const estimatedCost = estimateTaskCost(modelTier);

    // Calculate composite score
    const score =
      config.priorityWeights.urgency * priorityScore +
      config.priorityWeights.age * waitMinutes +
      config.priorityWeights.costEfficiency * (1 / estimatedCost);

    return {
      task: {
        id: task.id,
        title: task.title,
        priority,
        agent: task.agent ?? "programmer",
        modelTier,
        createdAt: task.created_at,
        projectId: task.project_id ?? undefined,
      },
      score,
      waitMinutes,
      estimatedCost,
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top N tasks (up to available slots)
  const selected = scored.slice(0, availableSlots).map((s) => s.task);

  if (selected.length > 0) {
    log().info(
      `[SCHEDULER] Selected ${selected.length} task(s) from ${readyTasks.length} ready ` +
      `(slots=${availableSlots}, budget_used=$${dailyCost.toFixed(2)}/$${config.maxDailyCostUsd.toFixed(2)})`,
    );
  }

  return selected;
}

/**
 * Estimate task cost in USD based on model tier.
 * These are rough estimates — actual costs are tracked in worker_runs.
 */
function estimateTaskCost(tier: string): number {
  const costMap: Record<string, number> = {
    micro: 0.0, // Local model, free
    small: 0.50, // ~100K tokens at sonnet pricing
    medium: 1.0,
    standard: 1.5,
    strong: 5.0, // Opus pricing
  };

  return costMap[tier] ?? costMap.standard;
}

/**
 * Get today's accumulated cost from the tracker file.
 */
export function getDailyCost(): number {
  const tracker = loadCostTracker();
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  if (tracker.date === today) {
    return tracker.totalCostUsd;
  }

  // New day — reset tracker
  saveCostTracker({ date: today, totalCostUsd: 0, taskCount: 0 });
  return 0;
}

/**
 * Record a completed task's cost.
 */
export function recordTaskCost(costUsd: number): void {
  const tracker = loadCostTracker();
  const today = new Date().toISOString().split("T")[0];

  if (tracker.date !== today) {
    // New day — reset
    tracker.date = today;
    tracker.totalCostUsd = 0;
    tracker.taskCount = 0;
  }

  tracker.totalCostUsd += costUsd;
  tracker.taskCount += 1;

  saveCostTracker(tracker);

  log().debug?.(
    `[SCHEDULER] Recorded $${costUsd.toFixed(4)} — daily total: $${tracker.totalCostUsd.toFixed(4)} (${tracker.taskCount} tasks)`,
  );
}

/**
 * Load daily cost tracker from file.
 */
function loadCostTracker(): DailyCostTracker {
  if (!existsSync(COST_TRACKER_PATH)) {
    const today = new Date().toISOString().split("T")[0];
    return { date: today, totalCostUsd: 0, taskCount: 0 };
  }

  try {
    const data = readFileSync(COST_TRACKER_PATH, "utf-8");
    return JSON.parse(data) as DailyCostTracker;
  } catch {
    const today = new Date().toISOString().split("T")[0];
    return { date: today, totalCostUsd: 0, taskCount: 0 };
  }
}

/**
 * Save daily cost tracker to file.
 */
function saveCostTracker(tracker: DailyCostTracker): void {
  try {
    writeFileSync(COST_TRACKER_PATH, JSON.stringify(tracker, null, 2), "utf-8");
  } catch (error) {
    log().error(`[SCHEDULER] Failed to save cost tracker: ${error}`);
  }
}

/**
 * Get default scheduler configuration from orchestrator settings.
 */
export function getSchedulerConfig(): SchedulerConfig {
  const db = getRawDb();
  const row = db
    .prepare(`SELECT value FROM orchestrator_settings WHERE key = 'scheduler_config'`)
    .get() as { value: string } | undefined;

  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Partial<SchedulerConfig>;
      return {
        maxConcurrentWorkers: parsed.maxConcurrentWorkers ?? 5,
        maxDailyCostUsd: parsed.maxDailyCostUsd ?? 50.0,
        priorityWeights: {
          urgency: parsed.priorityWeights?.urgency ?? 10,
          age: parsed.priorityWeights?.age ?? 0.1,
          costEfficiency: parsed.priorityWeights?.costEfficiency ?? 2,
        },
      };
    } catch {
      // Invalid JSON — use defaults
    }
  }

  // Defaults
  return {
    maxConcurrentWorkers: 5,
    maxDailyCostUsd: 50.0,
    priorityWeights: {
      urgency: 10,
      age: 0.1,
      costEfficiency: 2,
    },
  };
}
