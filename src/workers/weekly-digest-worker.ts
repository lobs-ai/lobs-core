/**
 * Weekly Goal Progress Digest Worker
 *
 * Runs every Friday at 5pm. Reflects on the week's goal progress and posts
 * a structured digest to Discord — closing the autonomy feedback loop.
 *
 * Data gathered:
 *   - All active goals from the DB
 *   - Tasks completed this week (status=done, updatedAt in last 7 days)
 *   - Memory files from the past 7 days
 *
 * Output: A markdown-formatted Discord message summarising accomplishments,
 * goal progress, next-week priorities, and patterns noticed.
 *
 * Channel: 1466921249421660415 (alerts/digest)
 * Schedule: 0 17 * * 5 (5pm Fridays)
 */

import { readFileSync } from "fs";
import { eq, and, gte, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { goals, tasks } from "../db/schema.js";
import { log } from "../util/logger.js";
import { getLobsRoot } from "../config/lobs.js";
import { discordService } from "../services/discord.js";
import {
  BaseWorker,
  callApiModelJSON,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
  type WorkerArtifact,
} from "./base-worker.js";

// ── Constants ─────────────────────────────────────────────────────────────

const DIGEST_CHANNEL = "1466921249421660415";

// ── Types ─────────────────────────────────────────────────────────────────

interface DigestLLMOutput {
  accomplished: string[];       // bullet list: what was done this week
  goalProgress: {               // per-goal assessment
    title: string;
    status: "progress" | "stalled" | "no_change";
    note: string;               // 1-sentence assessment
  }[];
  nextWeekPriorities: string[]; // top 3 suggestions
  patterns: string[];           // observations about how work flowed
  openingLine: string;          // 1 sentence framing the week
}

// ── Worker ────────────────────────────────────────────────────────────────

export class WeeklyDigestWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "weekly-digest",
    name: "Weekly Digest",
    description: "Friday EOD digest: reflects on goal progress and posts to Discord",
    schedule: "0 17 * * 5", // 5pm Fridays
    enabled: true,
    maxTokens: 2048,
    timeoutMs: 90_000,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const startMs = Date.now();
    const db = getDb();
    const artifacts: WorkerArtifact[] = [];

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
        status: goals.status,
      })
      .from(goals)
      .where(eq(goals.status, "active"));

    // 2. Load tasks completed this week
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const completedTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        updatedAt: tasks.updatedAt,
        goalId: tasks.goalId,
        agent: tasks.agent,
      })
      .from(tasks)
      .where(and(eq(tasks.status, "done"), gte(tasks.updatedAt, oneWeekAgo)))
      .orderBy(desc(tasks.updatedAt))
      .limit(50);

    // 3. Read memory files for the past 7 days
    const memorySnippets: string[] = [];
    const lobsRoot = getLobsRoot();
    const memoryDir = `${lobsRoot}/agents/main/context/memory`;

    for (let daysBack = 0; daysBack < 7; daysBack++) {
      const date = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
      const filePath = `${memoryDir}/${dateStr}.md`;

      try {
        const content = readFileSync(filePath, "utf8");
        const trimmed = content.trim();
        if (trimmed) {
          memorySnippets.push(`### ${dateStr}\n${trimmed.slice(0, 800)}`);
        }
      } catch {
        // File doesn't exist for this day — skip silently
      }
    }

    // 4. Build prompt
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const weekEnd = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const goalsText = activeGoals.length > 0
      ? activeGoals
          .map(
            (g) =>
              `- [${g.id}] "${g.title}" (priority: ${g.priority}, last worked: ${g.lastWorked ?? "unknown"})${g.description ? `\n  ${g.description.slice(0, 120)}` : ""}`,
          )
          .join("\n")
      : "(no active goals)";

    const tasksText = completedTasks.length > 0
      ? completedTasks
          .map((t) => `- "${t.title}" (completed ${t.updatedAt?.slice(0, 10) ?? "this week"}, agent: ${t.agent ?? "unknown"})`)
          .join("\n")
      : "(no tasks completed this week)";

    const memoryText = memorySnippets.length > 0
      ? memorySnippets.join("\n\n")
      : "(no memory entries found for this week)";

    const prompt = `You are Lobs, an AI research assistant reflecting on the week's progress. Today is ${today}.

Generate a concise weekly digest covering ${weekStart}–${weekEnd}. Be honest and specific — don't pad. If a goal stalled, say so plainly.

ACTIVE GOALS:
${goalsText}

TASKS COMPLETED THIS WEEK (${completedTasks.length} total):
${tasksText}

MEMORY / NOTES FROM THIS WEEK:
${memoryText}

Produce a weekly digest as JSON. Be specific and grounded in the data above.

Rules:
- accomplished: 3-6 bullet strings describing concrete things done (not goals, actual work)
- goalProgress: one entry per active goal — "progress" if tasks were completed or lastWorked is recent, "stalled" if nothing happened, "no_change" if expected dormancy
- nextWeekPriorities: exactly 3 action-oriented suggestions (not just goal names)
- patterns: 1-3 observations about how work flowed (e.g. "deadline pressure dominated", "good research velocity", "context-switching cost visible")
- openingLine: one sentence framing the week's overall character

Respond with valid JSON only:
{
  "openingLine": "string",
  "accomplished": ["string", ...],
  "goalProgress": [
    { "title": "string", "status": "progress|stalled|no_change", "note": "string" },
    ...
  ],
  "nextWeekPriorities": ["string", "string", "string"],
  "patterns": ["string", ...]
}`;

    const { data: output, tokensUsed } = await callApiModelJSON<DigestLLMOutput>(prompt, {
      tier: "small",
      maxTokens: 1500,
    });

    // 5. Format Discord message
    const message = formatDigest(output, weekStart, weekEnd, completedTasks.length, activeGoals.length);

    // 6. Post to Discord
    await discordService.send(DIGEST_CHANNEL, message);
    log().info(`[worker:weekly-digest] Posted weekly digest to Discord (${completedTasks.length} tasks, ${activeGoals.length} goals)`);

    artifacts.push({
      type: "draft",
      content: message,
      metadata: {
        tasksCompleted: completedTasks.length,
        goalsReviewed: activeGoals.length,
        memoryDaysRead: memorySnippets.length,
      },
    });

    return {
      success: true,
      artifacts,
      alerts: [],
      tokensUsed,
      durationMs: Date.now() - startMs,
      summary: `Weekly digest posted — ${completedTasks.length} tasks completed, ${activeGoals.length} goals reviewed`,
    };
  }
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatDigest(
  output: DigestLLMOutput,
  weekStart: string,
  weekEnd: string,
  taskCount: number,
  goalCount: number,
): string {
  const lines: string[] = [];

  lines.push(`📊 **Weekly Digest — ${weekStart}–${weekEnd}**`);
  lines.push("");

  if (output.openingLine) {
    lines.push(`_${output.openingLine}_`);
    lines.push("");
  }

  // Accomplished
  lines.push(`**✅ Accomplished this week** (${taskCount} tasks done)`);
  for (const item of output.accomplished ?? []) {
    lines.push(`• ${item}`);
  }
  lines.push("");

  // Goal progress
  if ((output.goalProgress ?? []).length > 0) {
    lines.push(`**🎯 Goal progress** (${goalCount} active)`);
    for (const g of output.goalProgress) {
      const icon = g.status === "progress" ? "🟢" : g.status === "stalled" ? "🔴" : "⚪";
      lines.push(`${icon} **${g.title}** — ${g.note}`);
    }
    lines.push("");
  }

  // Next week
  lines.push("**📌 Priorities for next week**");
  for (const item of output.nextWeekPriorities ?? []) {
    lines.push(`• ${item}`);
  }
  lines.push("");

  // Patterns
  if ((output.patterns ?? []).length > 0) {
    lines.push("**🔍 Patterns noticed**");
    for (const p of output.patterns) {
      lines.push(`• ${p}`);
    }
  }

  return lines.join("\n");
}
