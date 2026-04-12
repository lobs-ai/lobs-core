/**
 * Goals Worker — autonomous execution loop for active goals.
 *
 * Runs every 30 minutes. For each active goal, spawns a full agent session
 * to assess the current state and do real work toward the goal. Does not
 * just create inbox tasks — it launches a medium-tier session that can
 * look around, make decisions, and execute.
 *
 * Cap: max 2 active goal sessions in flight at once per goal.
 */

import { eq, and, inArray, desc, sql, lt, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/connection.js";
import { goals, tasks } from "../db/schema.js";
import { log } from "../util/logger.js";
import { executeSpawnAgent } from "../runner/tools/agent-control.js";
import {
  BaseWorker,
  type WorkerArtifact,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
} from "./base-worker.js";

// ── Worker ───────────────────────────────────────────────────────────────

export class GoalsWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "goals-worker",
    name: "Goals Worker",
    description: "Spawns full agent sessions to work toward active goals",
    schedule: "*/30 * * * *",
    enabled: true,
    maxTokens: 1024,
    timeoutMs: 120_000,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const db = getDb();
    const artifacts: WorkerArtifact[] = [];
    const alerts: WorkerResult["alerts"] = [];
    let sessionsSpawned = 0;
    let goalsSkipped = 0;

    // 0. Reap stale tracking tasks — goals-worker tasks stuck "active" for > 2h
    //    are orphaned from crashed/restarted sessions and will block future runs.
    const staleThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleTracking = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "active"),
          eq(tasks.agent, "programmer"),
          sql`${tasks.goalId} IS NOT NULL`,
          like(tasks.notes, "Agent session in progress%"),
          lt(tasks.updatedAt, staleThreshold),
        ),
      );

    // Also reap legacy-format tracking tasks (pre-title-fix format "[goals-worker] Working on: ...")
    const legacyStale = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "active"),
          like(tasks.title, "[goals-worker]%"),
          lt(tasks.updatedAt, staleThreshold),
        ),
      );
    if (legacyStale.length > 0) {
      await db
        .update(tasks)
        .set({
          status: "rejected",
          notes: "Reaped by goals-worker: legacy tracking task (orphaned)",
          updatedAt: new Date().toISOString(),
        })
        .where(inArray(tasks.id, legacyStale.map((t) => t.id)));
      log().info(
        `[goals-worker] Reaped ${legacyStale.length} legacy tracking task(s)`,
      );
    }

    if (staleTracking.length > 0) {
      const staleIds = staleTracking.map((t) => t.id);
      await db
        .update(tasks)
        .set({
          status: "rejected",
          notes: "Reaped by goals-worker: session orphaned (server restarted or timed out)",
          updatedAt: new Date().toISOString(),
        })
        .where(inArray(tasks.id, staleIds));
      log().info(
        `[goals-worker] Reaped ${staleTracking.length} stale tracking task(s): ${staleIds.join(", ")}`,
      );
    }

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
        // Check if there's already an active agent session tracking task for this goal.
        // We only skip if a session is actively in-flight — not just because Rafe has open tasks.
        const activeSessionResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(tasks)
          .where(
            and(
              eq(tasks.goalId, goal.id),
              eq(tasks.status, "active"),
              eq(tasks.agent, "programmer"),
              like(tasks.notes, "Agent session in progress%"),
            ),
          );

        const openCount = Number(activeSessionResult[0]?.count ?? 0);

        if (openCount >= 1) {
          goalsSkipped++;
          log().info(
            `[goals-worker] Goal "${goal.title}" already has an active agent session — skipping`,
          );
          continue;
        }

        // Load recent completed tasks for context
        const recentCompleted = await db
          .select({ title: tasks.title, notes: tasks.notes })
          .from(tasks)
          .where(
            and(eq(tasks.goalId, goal.id), eq(tasks.status, "completed")),
          )
          .orderBy(desc(tasks.updatedAt))
          .limit(5);

        // Build the agent prompt
        const prompt = buildGoalSessionPrompt(goal, recentCompleted, openCount);

        // Create a tracking task so we know a session is in flight
        const trackingTaskId = randomUUID().slice(0, 8);
        await db.insert(tasks).values({
          id: trackingTaskId,
          title: goal.title.slice(0, 120),
          status: "active",
          owner: "lobs",
          goalId: goal.id,
          notes: `Agent session in progress (spawned ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC). Will be updated on completion.`,
          agent: "programmer",
          modelTier: "medium",
        });

        // Spawn a full agent session — fire and forget, it runs async
        const now = new Date().toISOString();

        executeSpawnAgent(
          {
            prompt,
            subagent_type: "programmer",
            model_tier: "medium",
            cwd: process.cwd(),
          },
          undefined,
          undefined,
          async (result) => {
            // On completion: mark tracking task done or failed
            const db2 = getDb();
            await db2
              .update(tasks)
              .set({
                status: result.succeeded ? "completed" : "rejected",
                notes: result.output?.slice(0, 2000) ?? result.error ?? "No output",
                updatedAt: new Date().toISOString(),
              })
              .where(eq(tasks.id, trackingTaskId));

            // Update goal metadata
            await db2
              .update(goals)
              .set({
                lastWorked: new Date().toISOString(),
                taskCount: (goal.taskCount ?? 0) + 1,
              })
              .where(eq(goals.id, goal.id));

            log().info(
              `[goals-worker] Session for goal "${goal.title}" ${result.succeeded ? "succeeded" : "failed"}`,
            );
          },
        ).catch((err) => {
          log().error(
            `[goals-worker] Failed to spawn session for goal "${goal.title}": ${String(err)}`,
          );
        });

        // Update lastWorked immediately so next run doesn't double-spawn
        await db
          .update(goals)
          .set({ lastWorked: now })
          .where(eq(goals.id, goal.id));

        sessionsSpawned++;

        artifacts.push({
          type: "db_record",
          content: `Spawned session for goal "${goal.title}" (tracking task: ${trackingTaskId})`,
          metadata: { trackingTaskId, goalId: goal.id },
        });

        log().info(
          `[goals-worker] Spawned session for goal "${goal.title}"`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log().error(
          `[goals-worker] Failed processing goal "${goal.title}": ${msg}`,
        );
        alerts.push({
          severity: "warning",
          title: `Goals Worker: Error processing goal "${goal.title}"`,
          message: msg,
          actionRequired: false,
        });
      }
    }

    const parts: string[] = [];
    if (sessionsSpawned > 0)
      parts.push(
        `${sessionsSpawned} session${sessionsSpawned !== 1 ? "s" : ""} spawned`,
      );
    if (goalsSkipped > 0)
      parts.push(
        `${goalsSkipped} goal${goalsSkipped !== 1 ? "s" : ""} skipped (enough in flight)`,
      );

    return {
      success: true,
      artifacts,
      alerts,
      tokensUsed: 0,
      durationMs: 0,
      summary:
        parts.length > 0
          ? parts.join(" · ")
          : `Processed ${activeGoals.length} active goal${activeGoals.length !== 1 ? "s" : ""}, nothing to do`,
    };
  }
}

// ── Prompt Builder ────────────────────────────────────────────────────────

function buildGoalSessionPrompt(
  goal: typeof goals.$inferSelect,
  recentCompleted: Array<{ title: string; notes: string | null }>,
  openCount: number,
): string {
  const completedSection =
    recentCompleted.length > 0
      ? recentCompleted
          .map(
            (t) =>
              `- ${t.title}${t.notes ? `: ${t.notes.slice(0, 300)}` : ""}`,
          )
          .join("\n")
      : "none yet — this is fresh territory";

  const openSection =
    openCount > 0
      ? `${openCount} task${openCount !== 1 ? "s" : ""} currently in progress`
      : "none — you have a clear runway";

  return `You are an autonomous agent working on behalf of Rafe's personal AI system (Lobs).

## Your goal
**${goal.title}**

${goal.description ?? "No description provided."}

Priority: ${goal.priority}/100

## Current state
Recent completed work:
${completedSection}

Open tasks in flight:
${openSection}

## Instructions

Your job is to make real, concrete progress on this goal RIGHT NOW. This is a full working session — not planning, not summarizing. Act.

Start by looking around: check the relevant repos, read recent code or docs, understand what's actually been done and what hasn't. Then identify the single most valuable thing you can do in this session and do it.

**Be proactive and novel.** Don't just continue existing work mechanically — ask yourself what would actually move the needle. If the obvious next step is boring or incremental, consider whether there's a higher-leverage angle you're missing. Surprise us with something good.

**Bias toward action over planning.** If you find something broken, fix it. If you find something missing, build it. If you find something that needs research, do the research and write up the findings. Leave the codebase, docs, or task list in a better state than you found it.

**When you're done:** Use the task_create tool to log what you accomplished as a completed task (status: "completed") linked to goal_id \`${goal.id}\`. If you found important next steps, create them as inbox tasks (status: "inbox") with goal_id \`${goal.id}\` so they get picked up next session. If the goal's description is outdated or needs updating based on what you discovered, use goal_update to refine it.

The lobs-core repo is at ~/lobs/lobs-core/. Other relevant repos may be in ~/lobs/ or ~/paw/. Use your judgment on where to look.`;
}
