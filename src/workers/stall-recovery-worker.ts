/**
 * Stall Recovery Worker
 *
 * Runs daily. Finds goals that have been stagnant for 3+ days — no completed
 * tasks, no recent agent activity — diagnoses WHY using recent task history
 * and failure messages, then creates a specific unblocking task and notifies
 * Rafe via Discord.
 *
 * This closes the feedback loop: stagnant goals don't just get flagged in the
 * morning brief, they get actively triaged.
 *
 * Schedule: 9:30 AM daily (after priority-advisor at 8am, before goals-worker peak)
 */

import { randomUUID } from "crypto";
import { eq, and, gte, inArray, desc, lt } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { goals, tasks } from "../db/schema.js";
import { discordService } from "../services/discord.js";
import { log } from "../util/logger.js";
import {
  BaseWorker,
  callApiModelJSON,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
  type WorkerArtifact,
} from "./base-worker.js";

const ALERTS_CHANNEL = "1466921249421660415";
const STALL_THRESHOLD_DAYS = 3;
const MAX_GOALS_TO_RECOVER = 3; // Don't flood with unblocking tasks

// ── Types ─────────────────────────────────────────────────────────────────

interface StalledGoal {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  daysSinceActivity: number;
  recentTasks: {
    title: string;
    status: string;
    notes: string | null;
    finishedAt: string | null;
  }[];
}

interface RecoveryPlan {
  diagnosis: string;       // 2-3 sentences: why is it stalled?
  unblockerTitle: string;  // Specific, actionable task title
  unblockerNotes: string;  // Context for the agent that will pick this up
  priority: "high" | "medium" | "low";
  skipReason?: string;     // If we should skip creating a task (e.g. goal is genuinely done)
}

// ── Worker ────────────────────────────────────────────────────────────────

export class StallRecoveryWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "stall-recovery",
    name: "Stall Recovery",
    description:
      "Detects stagnant goals, diagnoses why they're stuck, and creates specific unblocking tasks",
    schedule: "30 9 * * *", // 9:30 AM daily
    enabled: true,
    maxTokens: 1024,
    timeoutMs: 90_000,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const db = getDb();
    const artifacts: WorkerArtifact[] = [];
    let tokensUsed = 0;

    // 1. Find stalled goals
    const stalledGoals = await findStalledGoals();
    if (stalledGoals.length === 0) {
      log().info("[stall-recovery] No stalled goals found — all goals have recent activity");
      return {
        success: true,
        artifacts: [],
        alerts: [],
        tokensUsed: 0,
        durationMs: 0,
        summary: "No stalled goals found — everything has recent activity",
      };
    }

    log().info(`[stall-recovery] Found ${stalledGoals.length} stalled goals, triaging top ${MAX_GOALS_TO_RECOVER}`);

    // Sort by priority DESC (most important stalled goals first)
    const prioritized = stalledGoals
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_GOALS_TO_RECOVER);

    const recoveryResults: string[] = [];
    const discordLines: string[] = [];

    discordLines.push(`🔧 **Stall Recovery** — ${prioritized.length} goal${prioritized.length > 1 ? "s" : ""} stuck for ${STALL_THRESHOLD_DAYS}+ days`);
    discordLines.push("");

    for (const stalled of prioritized) {
      try {
        // 2. Diagnose and plan recovery via LLM
        const { data: plan, tokensUsed: tokens } = await callApiModelJSON<RecoveryPlan>(
          buildDiagnosisPrompt(stalled),
          { tier: "small", temperature: 0.3 },
        );
        tokensUsed += tokens;

        if (plan.skipReason) {
          log().info(`[stall-recovery] Skipping goal "${stalled.title}": ${plan.skipReason}`);
          discordLines.push(`⏭️ **${stalled.title}** — skipped: ${plan.skipReason}`);
          continue;
        }

        // 3. Create unblocking task in DB
        const taskId = randomUUID().slice(0, 8);
        await db.insert(tasks).values({
          id: taskId,
          title: plan.unblockerTitle.slice(0, 120),
          status: "inbox",
          owner: "lobs",
          goalId: stalled.id,
          priority: plan.priority,
          notes: [
            `**Auto-created by Stall Recovery** — Goal "${stalled.title}" has been stalled ${stalled.daysSinceActivity} days.`,
            "",
            `**Diagnosis:** ${plan.diagnosis}`,
            "",
            `**Context for agent:** ${plan.unblockerNotes}`,
          ].join("\n"),
          agent: "programmer",
          modelTier: "medium",
        });

        const msg = `✅ Unblocking task created for **${stalled.title}** (stalled ${stalled.daysSinceActivity}d)\n  → _${plan.unblockerTitle}_\n  💡 ${plan.diagnosis}`;
        recoveryResults.push(msg);
        discordLines.push(msg);

        artifacts.push({
          type: "draft",
          content: `Goal: ${stalled.title}\nDiagnosis: ${plan.diagnosis}\nUnblocker: ${plan.unblockerTitle}\nTask ID: ${taskId}`,
          metadata: { goalId: stalled.id, taskId, daysSinceActivity: stalled.daysSinceActivity },
        });

        log().info(`[stall-recovery] Created unblocking task ${taskId} for goal "${stalled.title}"`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log().error(`[stall-recovery] Failed to diagnose goal "${stalled.title}": ${errMsg}`);
        discordLines.push(`❌ **${stalled.title}** — diagnosis failed: ${errMsg.slice(0, 80)}`);
      }
    }

    // 4. Send Discord summary
    if (discordLines.length > 1) {
      try {
        await discordService.send(ALERTS_CHANNEL, discordLines.join("\n"));
      } catch (err) {
        log().warn(`[stall-recovery] Discord send failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const summary = recoveryResults.length > 0
      ? `Created ${recoveryResults.length} unblocking task${recoveryResults.length > 1 ? "s" : ""} for stalled goals: ${prioritized.map(g => g.title).join(", ")}`
      : "Diagnosed stalled goals but no unblocking tasks created";

    return {
      success: true,
      artifacts,
      alerts: [],
      tokensUsed,
      durationMs: 0,
      summary,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function findStalledGoals(): Promise<StalledGoal[]> {
  const db = getDb();
  const now = new Date();
  const stallCutoff = new Date(now.getTime() - STALL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
  const stallCutoffISO = stallCutoff.toISOString();

  // Get all active goals
  const activeGoals = await db
    .select({
      id: goals.id,
      title: goals.title,
      description: goals.description,
      priority: goals.priority,
    })
    .from(goals)
    .where(eq(goals.status, "active"));

  if (activeGoals.length === 0) return [];

  const goalIds = activeGoals.map(g => g.id);

  // Find goals with a completed task more recent than the stall threshold
  const recentlyActiveGoalIds = (
    await db
      .select({ goalId: tasks.goalId })
      .from(tasks)
      .where(
        and(
          inArray(tasks.goalId, goalIds),
          eq(tasks.status, "completed"),
          gte(tasks.finishedAt, stallCutoffISO),
        ),
      )
  ).map(r => r.goalId).filter((id): id is string => id !== null);

  const recentActiveSet = new Set(recentlyActiveGoalIds);
  const stalledGoalIds = activeGoals
    .filter(g => !recentActiveSet.has(g.id))
    .map(g => g.id);

  if (stalledGoalIds.length === 0) return [];

  // For each stalled goal, get recent tasks (last 10, any status)
  const result: StalledGoal[] = [];

  for (const goal of activeGoals.filter(g => stalledGoalIds.includes(g.id))) {
    const recentTasks = await db
      .select({
        title: tasks.title,
        status: tasks.status,
        notes: tasks.notes,
        finishedAt: tasks.finishedAt,
      })
      .from(tasks)
      .where(eq(tasks.goalId, goal.id))
      .orderBy(desc(tasks.finishedAt))
      .limit(8);

    // Calculate days since last completed task
    const lastCompletedTask = recentTasks.find(t => t.status === "completed" && t.finishedAt);
    const daysSince = lastCompletedTask?.finishedAt
      ? Math.floor((now.getTime() - new Date(lastCompletedTask.finishedAt).getTime()) / (1000 * 60 * 60 * 24))
      : 999; // Never had a completed task

    result.push({
      id: goal.id,
      title: goal.title,
      description: goal.description,
      priority: goal.priority,
      daysSinceActivity: daysSince,
      recentTasks: recentTasks.map(t => ({
        title: t.title,
        status: t.status,
        notes: t.notes ? t.notes.slice(0, 300) : null,
        finishedAt: t.finishedAt,
      })),
    });
  }

  return result;
}

function buildDiagnosisPrompt(goal: StalledGoal): string {
  const taskHistory = goal.recentTasks.length > 0
    ? goal.recentTasks
        .map(t => `  - [${t.status}] "${t.title}"${t.finishedAt ? ` (${t.finishedAt.slice(0, 10)})` : ""}${t.notes ? `\n    Notes: ${t.notes.slice(0, 200)}` : ""}`)
        .join("\n")
    : "  (no task history)";

  return `You are diagnosing a stalled software development goal and creating a concrete unblocking task.

Goal: "${goal.title}"
Description: ${goal.description ?? "(none)"}
Days since last completed task: ${goal.daysSinceActivity === 999 ? "never (no completed tasks)" : goal.daysSinceActivity}
Goal priority: ${goal.priority}/100

Recent task history:
${taskHistory}

Based on this history, determine:
1. WHY is this goal stalled? (Look for patterns: repeated failures, dependency waits, unclear scope, no tasks at all, etc.)
2. What is the SINGLE most useful concrete action to unblock it right now?
3. Should we skip creating a task? (Only skip if the goal is genuinely complete or permanently blocked by an external dependency we can't fix)

Respond as JSON:
{
  "diagnosis": "2-3 sentences explaining the root cause of the stall",
  "unblockerTitle": "Specific, actionable task title (e.g. 'Fix TypeScript errors blocking build' not 'Work on X')",
  "unblockerNotes": "2-4 sentences of context for the agent: what to look at, what the blocker is, where to start",
  "priority": "high" | "medium" | "low",
  "skipReason": null | "reason if we should skip"
}`;
}
