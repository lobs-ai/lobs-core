/**
 * Goals Worker — autonomous execution loop for active goals.
 *
 * Runs every 30 minutes. For each active goal, checks how many open tasks
 * are already in flight. If < 2, calls the LLM to suggest the next concrete
 * task and inserts it into the tasks table as 'inbox'.
 */

import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/connection.js";
import { goals, tasks } from "../db/schema.js";
import { log } from "../util/logger.js";
import {
  BaseWorker,
  callLocalModelJSON,
  type WorkerArtifact,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
} from "./base-worker.js";

// ── LLM Response Types ───────────────────────────────────────────────────

interface TaskSuggestion {
  title: string;
  notes: string;
  agent: string;
  model_tier: string;
  estimated_minutes: number;
}

// ── Worker ───────────────────────────────────────────────────────────────

export class GoalsWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "goals-worker",
    name: "Goals Worker",
    description: "Generates tasks for active goals",
    schedule: "*/30 * * * *",
    enabled: true,
    maxTokens: 512,
    timeoutMs: 60_000,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const db = getDb();
    const artifacts: WorkerArtifact[] = [];
    const alerts: WorkerResult["alerts"] = [];
    let totalTokens = 0;
    let tasksCreated = 0;
    let goalsProcessed = 0;
    let goalsSkipped = 0;

    // 1. Load all active goals ordered by priority DESC
    const activeGoals = await db
      .select()
      .from(goals)
      .where(eq(goals.status, "active"))
      .orderBy(desc(goals.priority));

    if (activeGoals.length === 0) {
      return {
        success: true,
        artifacts: [],
        alerts: [],
        tokensUsed: 0,
        durationMs: 0,
        summary: "No active goals found",
      };
    }

    for (const goal of activeGoals) {
      try {
        // 2a. Count open tasks already linked to this goal
        const openCountResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(tasks)
          .where(
            and(
              eq(tasks.goalId, goal.id),
              inArray(tasks.status, ["inbox", "active"]),
            ),
          );

        const openCount = openCountResult[0]?.count ?? 0;

        if (openCount >= 2) {
          goalsSkipped++;
          log().info(`[goals-worker] Goal "${goal.title}" already has ${openCount} open tasks — skipping`);
          continue;
        }

        // 2b. Load last 5 completed tasks for this goal (for context)
        const recentCompleted = await db
          .select({ title: tasks.title, notes: tasks.notes })
          .from(tasks)
          .where(
            and(
              eq(tasks.goalId, goal.id),
              eq(tasks.status, "completed"),
            ),
          )
          .orderBy(desc(tasks.updatedAt))
          .limit(5);

        // 2c. Build prompt and call LLM
        const prompt = buildPrompt(goal, recentCompleted, openCount);

        let suggestion: TaskSuggestion | null = null;
        let tokensUsed = 0;

        try {
          const result = await callLocalModelJSON<TaskSuggestion | null>(prompt, {
            maxTokens: this.config.maxTokens,
            timeoutMs: this.config.timeoutMs,
            taskCategory: "background",
          });
          suggestion = result.data;
          tokensUsed = result.tokensUsed;
          totalTokens += tokensUsed;
        } catch (llmErr) {
          const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
          alerts.push({
            severity: "warning",
            title: `Goals Worker: LLM failed for goal "${goal.title}"`,
            message: msg,
            actionRequired: false,
          });
          continue;
        }

        if (!suggestion || !suggestion.title) {
          log().info(`[goals-worker] No task suggested for goal "${goal.title}"`);
          goalsProcessed++;
          continue;
        }

        // 2d. Insert the suggested task
        const now = new Date().toISOString();
        const taskId = randomUUID().slice(0, 8);

        await db.insert(tasks).values({
          id: taskId,
          title: suggestion.title.slice(0, 200),
          status: "inbox",
          owner: "lobs",
          goalId: goal.id,
          notes: suggestion.notes ?? null,
          agent: suggestion.agent ?? null,
          modelTier: suggestion.model_tier ?? null,
          estimatedMinutes: typeof suggestion.estimated_minutes === "number"
            ? suggestion.estimated_minutes
            : null,
        });

        // 2e. Update goal.lastWorked and increment goal.taskCount
        await db
          .update(goals)
          .set({
            lastWorked: now,
            taskCount: (goal.taskCount ?? 0) + 1,
          })
          .where(eq(goals.id, goal.id));

        tasksCreated++;
        goalsProcessed++;

        artifacts.push({
          type: "db_record",
          content: `Created task "${suggestion.title}" for goal "${goal.title}" (id: ${taskId})`,
          metadata: { taskId, goalId: goal.id },
        });

        log().info(`[goals-worker] Created task "${suggestion.title}" for goal "${goal.title}"`);

      } catch (err) {
        // One goal failing shouldn't stop others
        const msg = err instanceof Error ? err.message : String(err);
        log().error(`[goals-worker] Failed processing goal "${goal.title}": ${msg}`);
        alerts.push({
          severity: "warning",
          title: `Goals Worker: Error processing goal "${goal.title}"`,
          message: msg,
          actionRequired: false,
        });
      }
    }

    const parts: string[] = [];
    if (tasksCreated > 0) parts.push(`${tasksCreated} task${tasksCreated !== 1 ? "s" : ""} created`);
    if (goalsSkipped > 0) parts.push(`${goalsSkipped} goal${goalsSkipped !== 1 ? "s" : ""} skipped (enough in flight)`);
    if (goalsProcessed === 0 && goalsSkipped === activeGoals.length) {
      parts.push("all goals have sufficient open tasks");
    }

    return {
      success: true,
      artifacts,
      alerts,
      tokensUsed: totalTokens,
      durationMs: 0,
      summary: parts.length > 0
        ? parts.join(" · ")
        : `Processed ${activeGoals.length} active goal${activeGoals.length !== 1 ? "s" : ""}, no new tasks needed`,
    };
  }
}

// ── Prompt Builder ───────────────────────────────────────────────────────

function buildPrompt(
  goal: typeof goals.$inferSelect,
  recentCompleted: Array<{ title: string; notes: string | null }>,
  openCount: number,
): string {
  const completedSection = recentCompleted.length > 0
    ? recentCompleted.map(t => `- ${t.title}${t.notes ? `: ${t.notes.slice(0, 100)}` : ""}`).join("\n")
    : "none yet";

  const openSection = openCount > 0
    ? `${openCount} task${openCount !== 1 ? "s" : ""} currently in progress`
    : "none";

  return `You are a task planner for an AI agent system called Lobs.

Goal: ${goal.title}
Description: ${goal.description ?? "No description provided"}
Priority: ${goal.priority}/100

Recent completed tasks for this goal:
${completedSection}

Current open tasks:
${openSection}

What is the single most valuable next concrete task to make progress on this goal?
Respond with JSON only:
{
  "title": "...",       // specific, actionable, <80 chars
  "notes": "...",       // 1-2 sentences of context/approach
  "agent": "programmer|researcher|writer|architect",
  "model_tier": "small|standard|strong",
  "estimated_minutes": 30
}
Or respond with null if there is genuinely nothing to do right now.`;
}
