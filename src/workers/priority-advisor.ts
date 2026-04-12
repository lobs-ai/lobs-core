/**
 * Priority Advisor Worker
 *
 * Runs daily. Reads active goals, recent Discord activity, upcoming calendar
 * events, and recent memory — then uses an LLM to re-score goal priorities
 * so Lobs self-directs based on real context rather than static numbers.
 *
 * Goal priorities (1-100) are updated in the DB. The goals-worker picks up
 * the new scores on its next cycle, naturally shifting what gets worked on.
 *
 * Schedule: 8:00 AM daily (before morning brief and goals-worker peak hours)
 */

import { eq, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { goals, chatMessages } from "../db/schema.js";
import { log } from "../util/logger.js";
import { isGoogleCalendarAvailable, getEventsForDateRange } from "../services/google-calendar.js";
import {
  BaseWorker,
  callApiModelJSON,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
  type WorkerArtifact,
} from "./base-worker.js";

// ── Types ─────────────────────────────────────────────────────────────────

interface GoalInput {
  id: string;
  title: string;
  description: string | null;
  currentPriority: number;
  lastWorked: string | null;
  taskCount: number;
  tags: string[] | null;
}

interface PriorityAdvice {
  goalId: string;
  newPriority: number;    // 1-100
  reasoning: string;      // 1-2 sentence explanation
  signals: string[];      // which signals drove this
}

interface PriorityAdvisorLLMOutput {
  advice: PriorityAdvice[];
  summary: string;        // 2-3 sentence overall summary
}

// ── Worker ────────────────────────────────────────────────────────────────

export class PriorityAdvisorWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "priority-advisor",
    name: "Priority Advisor",
    description: "Re-scores goal priorities daily based on Discord activity, calendar deadlines, and recent context",
    schedule: "0 8 * * *", // 8am daily
    enabled: true,
    maxTokens: 2048,
    timeoutMs: 60_000,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const db = getDb();
    const artifacts: WorkerArtifact[] = [];
    let tokensUsed = 0;

    // 1. Load active goals
    const activeGoals = await db
      .select({
        id: goals.id,
        title: goals.title,
        description: goals.description,
        priority: goals.priority,
        lastWorked: goals.lastWorked,
        taskCount: goals.taskCount,
        tags: goals.tags,
      })
      .from(goals)
      .where(eq(goals.status, "active"));

    if (activeGoals.length === 0) {
      return {
        success: true,
        artifacts: [],
        alerts: [],
        tokensUsed: 0,
        durationMs: 0,
        summary: "No active goals — nothing to advise",
      };
    }

    const goalInputs: GoalInput[] = activeGoals.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      currentPriority: g.priority,
      lastWorked: g.lastWorked,
      taskCount: g.taskCount ?? 0,
      tags: g.tags,
    }));

    // 2. Load recent user chat messages (last 24h) to detect what Rafe is focused on
    // role="user" messages are Rafe's inputs — best signal for current focus
    const recentMsgs = await db
      .select({ content: chatMessages.content, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(eq(chatMessages.role, "user"))
      .orderBy(desc(chatMessages.createdAt))
      .limit(30);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const discordContext = recentMsgs
      .filter((m) => m.createdAt > yesterday)
      .slice(0, 20)
      .map((m) => m.content.slice(0, 200))
      .join("\n");

    // 3. Load upcoming calendar events (next 7 days) for deadline signals
    let calendarContext = "";
    try {
      if (await isGoogleCalendarAvailable()) {
        const now = new Date();
        const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const events = await getEventsForDateRange(now.toISOString(), in7Days.toISOString());
        calendarContext = events
          .slice(0, 15)
          .map((e) => `- ${e.summary ?? "Untitled"} (${e.start?.dateTime ?? e.start?.date ?? "??"})`)
          .join("\n");
      }
    } catch (err) {
      log().warn(`[priority-advisor] Calendar fetch failed: ${String(err)}`);
    }

    // 4. Build prompt and ask haiku to re-score priorities
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const prompt = `You are Lobs's Priority Advisor. Today is ${today}.

Your job is to re-score the priorities of Lobs's active goals (scale 1-100) based on real signals.
Higher priority = worked on sooner. Keep scores spread out — don't cluster everything at 50.

ACTIVE GOALS:
${goalInputs
  .map(
    (g) =>
      `- [${g.id}] "${g.title}" (current: ${g.currentPriority}, last worked: ${g.lastWorked ?? "never"}, tasks done: ${g.taskCount})${g.description ? `\n  Description: ${g.description.slice(0, 150)}` : ""}`,
  )
  .join("\n")}

RECENT CHAT ACTIVITY (Rafe's messages, last 24h):
${discordContext || "(no recent messages)"}

UPCOMING CALENDAR EVENTS (next 7 days):
${calendarContext || "(calendar unavailable or no events)"}

SCORING GUIDANCE:
- Boost goals related to upcoming deadlines by +15 to +30
- Boost goals Rafe mentioned/asked about recently by +10 to +20
- Reduce priority of goals not touched in >7 days unless deadline-driven
- Never set all goals to the same score — create meaningful separation
- Keep scores in range 10-95
- If a goal has no signals suggesting urgency, keep it near its current priority (small drift only)

Respond with valid JSON only:
{
  "advice": [
    {
      "goalId": "string",
      "newPriority": number,
      "reasoning": "1-2 sentence explanation",
      "signals": ["signal1", "signal2"]
    }
  ],
  "summary": "2-3 sentence overall summary of priority shifts"
}`;

    const { data: output, tokensUsed: llmTokens } =
      await callApiModelJSON<PriorityAdvisorLLMOutput>(prompt, {
        tier: "small",
        maxTokens: 1024,
      });
    tokensUsed += llmTokens;

    // 5. Apply priority updates
    let updatedCount = 0;
    const changes: string[] = [];

    for (const advice of output.advice ?? []) {
      const goal = goalInputs.find((g) => g.id === advice.goalId);
      if (!goal) continue;

      const newPriority = Math.max(10, Math.min(95, Math.round(advice.newPriority)));
      const delta = newPriority - goal.currentPriority;

      // Only update if there's a meaningful change (avoid noise)
      if (Math.abs(delta) < 3) continue;

      await db
        .update(goals)
        .set({ priority: newPriority })
        .where(eq(goals.id, advice.goalId));

      updatedCount++;
      const arrow = delta > 0 ? `↑+${delta}` : `↓${delta}`;
      changes.push(`"${goal.title}": ${goal.currentPriority} → ${newPriority} (${arrow})`);
      log().info(
        `[priority-advisor] ${goal.title}: ${goal.currentPriority} → ${newPriority} (${delta > 0 ? "+" : ""}${delta})`,
      );
    }

    if (changes.length > 0) {
      artifacts.push({
        type: "draft",
        content: `Priority updates:\n${changes.join("\n")}\n\n${output.summary ?? ""}`,
        metadata: { updatedCount, totalGoals: activeGoals.length },
      });
    }

    const summary =
      updatedCount > 0
        ? `Updated ${updatedCount}/${activeGoals.length} goal priorities. ${output.summary ?? ""}`
        : `No significant priority changes needed (${activeGoals.length} goals reviewed).`;

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
