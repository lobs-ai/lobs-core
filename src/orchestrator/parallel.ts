/**
 * Parallel task execution manager.
 *
 * Runs multiple tasks concurrently with a configurable concurrency limit.
 * If one task fails, others continue (don't cancel siblings).
 */

import { log } from "../util/logger.js";
import { runAgent } from "../runner/index.js";
import type { AgentResult } from "../runner/types.js";
import { getDb, getRawDb } from "../db/connection.js";
import { tasks as tasksTable } from "../db/schema.js";
import { eq } from "drizzle-orm";

export interface ParallelTask {
  taskId: string;
  agentType: string;
  modelTier?: string;
}

export interface ParallelGroup {
  tasks: ParallelTask[];
  maxConcurrent: number;
  /** Callback fired when each task completes */
  onTaskComplete?: (taskId: string, result: AgentResult) => void;
}

export interface ParallelResult {
  succeeded: boolean;
  results: Map<string, AgentResult>;
  /** Tasks that completed successfully */
  completedTasks: string[];
  /** Tasks that failed */
  failedTasks: string[];
  /** Total cost across all tasks */
  totalCost: number;
  /** Max duration (longest task) */
  maxDuration: number;
}

/**
 * Execute multiple tasks in parallel with a concurrency limit.
 *
 * - Respects maxConcurrent limit (default 3)
 * - Tracks which tasks are running vs queued
 * - If one task fails, others continue
 * - Returns when all tasks complete
 */
export async function executeParallel(group: ParallelGroup): Promise<ParallelResult> {
  const maxConcurrent = group.maxConcurrent || 3;
  log().info(
    `[PARALLEL] Starting ${group.tasks.length} tasks with max concurrency ${maxConcurrent}`,
  );

  const results = new Map<string, AgentResult>();
  const completedTasks: string[] = [];
  const failedTasks: string[] = [];
  let totalCost = 0;
  let maxDuration = 0;

  // Queue of pending tasks
  const queue = [...group.tasks];
  // Currently running tasks
  const running = new Set<Promise<void>>();

  /**
   * Process a single task from the queue.
   */
  async function processTask(task: ParallelTask): Promise<void> {
    const startTime = Date.now();

    try {
      // Fetch task details from DB
      const db = getDb();
      const taskRow = db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, task.taskId))
        .get();

      if (!taskRow) {
        log().error(`[PARALLEL] Task ${task.taskId.slice(0, 8)} not found in DB`);
        failedTasks.push(task.taskId);
        return;
      }

      // Get repo path from project
      let repoPath = process.cwd();
      if (taskRow.projectId) {
        const rawDb = getRawDb();
        const project = rawDb
          .prepare(`SELECT repo_path FROM projects WHERE id = ?`)
          .get(taskRow.projectId) as { repo_path: string | null } | undefined;
        if (project?.repo_path) {
          repoPath = project.repo_path;
        }
      }

      log().debug?.(`[PARALLEL] Starting task ${task.taskId.slice(0, 8)} (${task.agentType})`);

      // Run the agent
      const result = await runAgent({
        task: `${taskRow.title}\n\n${taskRow.notes ?? ""}`,
        agent: task.agentType,
        model: resolveModel(task.modelTier ?? "standard", task.agentType),
        cwd: repoPath,
        tools: ["exec", "read", "write", "edit", "memory_search", "memory_read"],
        timeout: 900,
        maxTurns: 200,
      });

      // Record result
      results.set(task.taskId, result);
      totalCost += result.costUsd;
      maxDuration = Math.max(maxDuration, result.durationSeconds);

      if (result.succeeded) {
        completedTasks.push(task.taskId);
        log().info(
          `[PARALLEL] ✓ Task ${task.taskId.slice(0, 8)} completed ` +
          `(cost=$${result.costUsd.toFixed(4)}, duration=${result.durationSeconds}s)`,
        );
      } else {
        failedTasks.push(task.taskId);
        log().warn(
          `[PARALLEL] ✗ Task ${task.taskId.slice(0, 8)} failed: ${result.error ?? "unknown"}`,
        );
      }

      // Fire callback if provided
      if (group.onTaskComplete) {
        group.onTaskComplete(task.taskId, result);
      }
    } catch (error) {
      log().error(`[PARALLEL] Task ${task.taskId.slice(0, 8)} threw error: ${error}`);
      failedTasks.push(task.taskId);

      // Create error result
      const errorResult: AgentResult = {
        succeeded: false,
        output: "",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        durationSeconds: (Date.now() - startTime) / 1000,
        turns: 0,
        stopReason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
      results.set(task.taskId, errorResult);
    }
  }

  /**
   * Main execution loop — keep pulling from queue until empty.
   */
  while (queue.length > 0 || running.size > 0) {
    // Start new tasks up to concurrency limit
    while (queue.length > 0 && running.size < maxConcurrent) {
      const task = queue.shift()!;
      const promise = processTask(task);
      running.add(promise);

      // Remove from running set when done
      promise.finally(() => {
        running.delete(promise);
      });
    }

    // Wait for at least one task to complete before checking queue again
    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  log().info(
    `[PARALLEL] Completed ${group.tasks.length} tasks — ` +
    `${completedTasks.length} succeeded, ${failedTasks.length} failed, ` +
    `cost=$${totalCost.toFixed(4)}, max_duration=${maxDuration}s`,
  );

  return {
    succeeded: failedTasks.length === 0,
    results,
    completedTasks,
    failedTasks,
    totalCost,
    maxDuration,
  };
}

// ── Model Resolution ─────────────────────────────────────────────────────────

function resolveModel(tier: string, _agentType: string): string {
  const tierMap: Record<string, string> = {
    micro: "lmstudio/qwen2.5-coder:7b",
    small: "anthropic/claude-sonnet-4-6",
    medium: "anthropic/claude-sonnet-4-6",
    standard: "anthropic/claude-sonnet-4-6",
    strong: "anthropic/claude-opus-4-6",
  };

  return tierMap[tier] ?? tierMap.standard;
}
