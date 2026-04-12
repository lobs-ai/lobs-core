/**
 * Goals Worker — autonomous execution loop for active goals.
 *
 * Runs every 30 minutes. Picks the SINGLE highest-priority goal that:
 *   - has no session currently in flight
 *   - hasn't been worked in the last MIN_COOLDOWN_MINUTES
 *
 * Global cap: MAX_CONCURRENT_SESSIONS across ALL goals at once.
 * This prevents burning money by running 6+ parallel sessions.
 * Goals rotate by least-recently-worked so nothing starves.
 */

// ── Scheduling constants ─────────────────────────────────────────────────
/** Only one goal session spawned per cycle (to keep costs controlled). */
const MAX_SESSIONS_PER_CYCLE = 1;
/** Don't re-work the same goal within this window (in minutes). */
const MIN_COOLDOWN_MINUTES = 60;
/** Abort if this many sessions are already in-flight across all goals. */
const MAX_CONCURRENT_SESSIONS = 2;

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

    // 1a. Auto-complete goals that have 0 open tasks and ≥2 completed tasks.
    //     This prevents the worker from repeatedly spawning sessions for goals
    //     that are already done (which just wastes money confirming nothing to do).
    //     Goals with 0 completed tasks are left active — they haven't started yet.
    for (const goal of activeGoals) {
      const taskStats = await db
        .select({
          total: sql<number>`count(*)`,
          open: sql<number>`sum(case when ${tasks.status} in ('inbox','active','waiting_on') then 1 else 0 end)`,
          done: sql<number>`sum(case when ${tasks.status} = 'completed' then 1 else 0 end)`,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.goalId, goal.id),
            sql`${tasks.notes} NOT LIKE 'Agent session in progress%'`,
          ),
        );

      const open = Number(taskStats[0]?.open ?? 0);
      const done = Number(taskStats[0]?.done ?? 0);

      if (open === 0 && done >= 2) {
        log().info(
          `[goals-worker] Auto-completing goal "${goal.title}" — 0 open tasks, ${done} completed`,
        );
        await db
          .update(goals)
          .set({
            status: "completed",
            updatedAt: new Date().toISOString(),
          })
          .where(eq(goals.id, goal.id));
      }
    }

    // Reload after auto-completion
    const remainingGoals = await db
      .select()
      .from(goals)
      .where(eq(goals.status, "active"))
      .orderBy(desc(goals.priority));

    if (remainingGoals.length === 0) {
      return {
        success: true,
        artifacts: [],
        alerts: [],
        tokensUsed: 0,
        durationMs: 0,
        summary: "No active goals found",
      };
    }

    // 2. Count globally how many agent sessions are currently in-flight
    //    across ALL goals. If at cap, skip this cycle entirely.
    const globalActiveResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "active"),
          eq(tasks.agent, "programmer"),
          sql`${tasks.goalId} IS NOT NULL`,
          like(tasks.notes, "Agent session in progress%"),
        ),
      );
    const globalActiveSessions = Number(globalActiveResult[0]?.count ?? 0);

    if (globalActiveSessions >= MAX_CONCURRENT_SESSIONS) {
      log().info(
        `[goals-worker] ${globalActiveSessions} sessions in-flight — at global cap (${MAX_CONCURRENT_SESSIONS}), skipping cycle`,
      );
      return {
        success: true,
        artifacts: [],
        alerts: [],
        tokensUsed: 0,
        durationMs: 0,
        summary: `${globalActiveSessions} sessions already in-flight — skipping cycle (cap: ${MAX_CONCURRENT_SESSIONS})`,
      };
    }

    // 3. Find the single best goal to work on this cycle:
    //    - no active session already in-flight for it
    //    - cooled down (lastWorked > MIN_COOLDOWN_MINUTES ago)
    //    - sorted by priority DESC, then by least-recently-worked (null = never = highest priority)
    const cooldownThreshold = new Date(
      Date.now() - MIN_COOLDOWN_MINUTES * 60 * 1000,
    ).toISOString();

    // Get the set of goalIds that currently have an active session
    const activeGoalSessionRows = await db
      .select({ goalId: tasks.goalId })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "active"),
          eq(tasks.agent, "programmer"),
          sql`${tasks.goalId} IS NOT NULL`,
          like(tasks.notes, "Agent session in progress%"),
        ),
      );
    const activeGoalIds = new Set(
      activeGoalSessionRows.map((r) => r.goalId).filter(Boolean),
    );

    // Pick the best eligible goal
    const eligibleGoal = remainingGoals.find((goal) => {
      // Skip if already has a session in-flight
      if (activeGoalIds.has(goal.id)) {
        goalsSkipped++;
        return false;
      }
      // Skip if worked too recently (null lastWorked = never worked = always eligible)
      if (goal.lastWorked && goal.lastWorked > cooldownThreshold) {
        goalsSkipped++;
        log().info(
          `[goals-worker] Goal "${goal.title}" cooled down (worked ${goal.lastWorked}) — skipping`,
        );
        return false;
      }
      return true;
    });

    if (!eligibleGoal) {
      const reasons =
        globalActiveSessions > 0
          ? `${globalActiveSessions} in-flight, ${goalsSkipped} cooling down`
          : `all ${goalsSkipped} goals cooling down`;
      return {
        success: true,
        artifacts: [],
        alerts: [],
        tokensUsed: 0,
        durationMs: 0,
        summary: `Nothing to spawn this cycle (${reasons})`,
      };
    }

    // 4. Spawn a single session for the chosen goal
    const goal = eligibleGoal;

    {
      try {
        // Load recent completed tasks for context
        const recentCompleted = await db
          .select({ title: tasks.title, notes: tasks.notes })
          .from(tasks)
          .where(
            and(eq(tasks.goalId, goal.id), eq(tasks.status, "completed")),
          )
          .orderBy(desc(tasks.updatedAt))
          .limit(5);

        // Load queued (inbox) tasks for this goal so agent knows what's next
        const inboxTasks = await db
          .select({ title: tasks.title, notes: tasks.notes, priority: tasks.priority })
          .from(tasks)
          .where(
            and(eq(tasks.goalId, goal.id), eq(tasks.status, "inbox")),
          )
          .orderBy(desc(tasks.priority))
          .limit(10);

        // Load active (in-flight) tasks for this goal so agent doesn't duplicate
        const activeTasks = await db
          .select({ title: tasks.title })
          .from(tasks)
          .where(
            and(
              eq(tasks.goalId, goal.id),
              eq(tasks.status, "active"),
              sql`${tasks.notes} NOT LIKE 'Agent session in progress%'`,
            ),
          )
          .limit(5);

        // Build the agent prompt
        const prompt = buildGoalSessionPrompt(goal, recentCompleted, inboxTasks, activeTasks);

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
            // On completion: mark tracking task done or failed.
            // Extract the "## Session Summary" section if present — that's the
            // structured summary the agent was asked to write. Fall back to the
            // last 800 chars of output (agents usually conclude with a summary),
            // then full output truncated.
            const rawOutput = result.output ?? result.error ?? "No output";
            const sessionNotes = extractSessionSummary(rawOutput);

            const db2 = getDb();
            await db2
              .update(tasks)
              .set({
                status: result.succeeded ? "completed" : "rejected",
                notes: sessionNotes,
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

    const skippedNote =
      goalsSkipped > 0
        ? ` (${goalsSkipped} cooling down)`
        : "";
    const summary =
      sessionsSpawned > 0
        ? `Spawned 1 session for goal "${goal.title}"${skippedNote}`
        : `Nothing spawned${skippedNote}`;

    return {
      success: true,
      artifacts,
      alerts,
      tokensUsed: 0,
      durationMs: 0,
      summary,
    };
  }
}

// ── Session Summary Extractor ─────────────────────────────────────────────

/**
 * Extract a clean summary from raw agent output.
 *
 * Priority:
 * 1. Text after a "## Session Summary" or "## Summary" header (agent explicitly wrote one)
 * 2. Last 1200 chars of output (agents usually wrap up at the end)
 * 3. First 800 chars as fallback
 */
function extractSessionSummary(rawOutput: string): string {
  if (!rawOutput) return "No output";

  // Look for explicit summary section
  const summaryMatch = rawOutput.match(
    /##\s+(?:Session\s+)?Summary\s*\n([\s\S]+?)(?=\n##\s|\n---|\n===|$)/i,
  );
  if (summaryMatch) {
    return summaryMatch[1].trim().slice(0, 2000);
  }

  // Look for "Done." or "Done:" followed by substantive text (agent sign-off pattern)
  const doneMatch = rawOutput.match(
    /\bDone[.:]\s*([\s\S]{50,})/i,
  );
  if (doneMatch) {
    return doneMatch[1].trim().slice(0, 1500);
  }

  // Fall back to last 1200 chars (agents typically summarise at the end)
  const trimmed = rawOutput.trim();
  if (trimmed.length > 1200) {
    return "…" + trimmed.slice(-1200);
  }
  return trimmed;
}

// ── Prompt Builder ────────────────────────────────────────────────────────

function buildGoalSessionPrompt(
  goal: typeof goals.$inferSelect,
  recentCompleted: Array<{ title: string; notes: string | null }>,
  inboxTasks: Array<{ title: string; notes: string | null; priority: string | null }>,
  activeTasks: Array<{ title: string }>,
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

  const inboxSection =
    inboxTasks.length > 0
      ? inboxTasks
          .map((t) => `- [${t.priority ?? "medium"}] ${t.title}`)
          .join("\n")
      : "none queued — use your judgment to decide what to work on";

  const activeSection =
    activeTasks.length > 0
      ? activeTasks.map((t) => `- ${t.title}`).join("\n")
      : "none";

  return `You are an autonomous agent working on behalf of Rafe's personal AI system (Lobs).

## Your goal
**${goal.title}**

${goal.description ?? "No description provided."}

Priority: ${goal.priority}/100

## Current state

**Recently completed:**
${completedSection}

**Queued for this session (inbox tasks — work these first if relevant):**
${inboxSection}

**Currently in progress (don't duplicate):**
${activeSection}

## Instructions

Your job is to make real, concrete progress on this goal RIGHT NOW. This is a full working session — not planning, not summarizing. Act.

If there are queued inbox tasks above, start with the highest-priority one. Otherwise, look around: check the relevant repos, read recent code or docs, understand what's actually been done and what hasn't. Then identify the single most valuable thing you can do in this session and do it.

**Before starting work**, run a quick memory search for "${goal.title}" — this will surface relevant learnings, prior decisions, and known gotchas that could save you time.

**Be proactive and novel.** Don't just continue existing work mechanically — ask yourself what would actually move the needle. If the obvious next step is boring or incremental, consider whether there's a higher-leverage angle you're missing. Surprise us with something good.

**Bias toward action over planning.** If you find something broken, fix it. If you find something missing, build it. If you find something that needs research, do the research and write up the findings. Leave the codebase, docs, or task list in a better state than you found it.

**When you're done:** Use the task_create tool to log what you accomplished as a completed task (status: "completed") linked to goal_id \`${goal.id}\`. If you found important next steps, create them as inbox tasks (status: "inbox") with goal_id \`${goal.id}\` so they get picked up next session. If the goal's description is outdated or needs updating based on what you discovered, use goal_update to refine it.

**Write a Session Summary:** At the very end of your final response, write a \`## Session Summary\` section with a concise bullet-list of what you actually built, fixed, or researched. This is shown directly in the Nexus dashboard so Rafe can see what happened between conversations. Keep it factual — ✅ for completed items, ❌ for things that didn't work out.

The lobs-core repo is at ~/lobs/lobs-core/. Other relevant repos may be in ~/lobs/ or ~/paw/. Use your judgment on where to look.`;
}
