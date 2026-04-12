/**
 * Morning Brief Worker — sends a daily Discord summary at 7:30am.
 *
 * Reads DB directly (no HTTP round-trip) and formats a compact Discord message
 * Rafe would actually read. No LLM dependency — pure data formatting.
 *
 * Channel: 1466921249421660415 (alerts)
 * Schedule: 30 7 * * * (7:30am daily)
 */

import { eq, and, gte, inArray, desc, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, goals, workerRuns } from "../db/schema.js";
import { discordService } from "../services/discord.js";
import { log } from "../util/logger.js";
import {
  BaseWorker,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
} from "./base-worker.js";

const ALERTS_CHANNEL = "1466921249421660415";
const BRIEF_URL = "http://localhost:9420";
const STAGNANT_DAYS_THRESHOLD = 3;

export class MorningBriefWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "morning-brief",
    name: "Morning Brief",
    description: "Sends a daily Discord summary of goals, tasks, and agent activity",
    schedule: "30 7 * * *",
    enabled: true,
  };

  /**
   * Override run() to skip the LM Studio availability check — this worker
   * does pure data formatting with no LLM calls and should always succeed.
   */
  async run(): Promise<WorkerResult> {
    const startedAt = new Date();
    try {
      const result = await this.execute({
        startedAt,
        model: "",
        baseUrl: "",
      });
      result.durationMs = Date.now() - startedAt.getTime();
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log().error(`[worker:morning-brief] Failed: ${errorMsg}`);
      return {
        success: false,
        artifacts: [],
        alerts: [{
          severity: "warning",
          title: "Morning Brief: Execution failed",
          message: errorMsg,
          actionRequired: false,
        }],
        tokensUsed: 0,
        durationMs: Date.now() - startedAt.getTime(),
        error: errorMsg,
      };
    }
  }

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    try {
      const message = await buildBriefMessage();
      await sendBrief(message);

      return {
        success: true,
        artifacts: [{
          type: "draft",
          content: message,
          metadata: { channel: ALERTS_CHANNEL },
        }],
        alerts: [],
        tokensUsed: 0,
        durationMs: 0,
        summary: "Morning brief sent to Discord",
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log().error(`[morning-brief] ${errorMsg}`);
      return {
        success: false,
        artifacts: [],
        alerts: [{
          severity: "warning",
          title: "Morning Brief failed",
          message: errorMsg,
          actionRequired: false,
        }],
        tokensUsed: 0,
        durationMs: 0,
        error: errorMsg,
      };
    }
  }
}

// ── Data + Formatting ────────────────────────────────────────────────────

async function buildBriefMessage(): Promise<string> {
  const db = getDb();

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartISO = todayStart.toISOString();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // ── Tasks ────────────────────────────────────────────────────────────────

  const activeTasks = db
    .select({ id: tasks.id, title: tasks.title, priority: tasks.priority })
    .from(tasks)
    .where(inArray(tasks.status, ["active", "in_progress"]))
    .all();

  const highPriority = activeTasks.filter(
    t => t.priority === "high" || t.priority === "urgent" || t.priority === "critical",
  );

  const blockedTasks = db
    .select({ id: tasks.id, title: tasks.title, blockedBy: tasks.blockedBy })
    .from(tasks)
    .where(inArray(tasks.status, ["blocked", "waiting_on"]))
    .all()
    .map(t => ({ ...t, blockedByStr: resolveBlockedBy(t.blockedBy) }));

  const completedToday = db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(
      eq(tasks.status, "completed"),
      gte(tasks.finishedAt, todayStartISO),
    ))
    .all();

  // ── Goals ────────────────────────────────────────────────────────────────

  const activeGoals = db
    .select({ id: goals.id, title: goals.title, priority: goals.priority })
    .from(goals)
    .where(eq(goals.status, "active"))
    .orderBy(goals.priority)
    .all();

  const goalIds = activeGoals.map(g => g.id);

  interface GoalSummary {
    id: string;
    title: string;
    priority: number;
    openTaskCount: number;
    daysSinceActivity: number | null;
  }

  const goalSummaries: GoalSummary[] = [];

  if (goalIds.length > 0) {
    const openTaskRows = db
      .select({ goalId: tasks.goalId, count: sql<number>`COUNT(*)` })
      .from(tasks)
      .where(and(
        inArray(tasks.goalId, goalIds),
        inArray(tasks.status, ["inbox", "active", "in_progress"]),
      ))
      .groupBy(tasks.goalId)
      .all();

    const lastActivityRows = db
      .select({ goalId: tasks.goalId, lastAt: sql<string>`MAX(finished_at)` })
      .from(tasks)
      .where(and(
        inArray(tasks.goalId, goalIds),
        eq(tasks.status, "completed"),
      ))
      .groupBy(tasks.goalId)
      .all();

    const openByGoal = new Map(openTaskRows.map(r => [r.goalId, Number(r.count)]));
    const lastActivityByGoal = new Map(lastActivityRows.map(r => [r.goalId, r.lastAt as string | null]));

    const nowMs = now.getTime();
    for (const g of activeGoals) {
      const lastAt = lastActivityByGoal.get(g.id) ?? null;
      const daysSince = lastAt
        ? Math.floor((nowMs - new Date(lastAt).getTime()) / (1000 * 60 * 60 * 24))
        : null;
      goalSummaries.push({
        id: g.id,
        title: g.title,
        priority: g.priority,
        openTaskCount: openByGoal.get(g.id) ?? 0,
        daysSinceActivity: daysSince,
      });
    }
  }

  // ── Agent Stats ──────────────────────────────────────────────────────────

  const recentRunRows = db
    .select({
      id: workerRuns.id,
      agentType: workerRuns.agentType,
      summary: workerRuns.summary,
      succeeded: workerRuns.succeeded,
      totalCostUsd: workerRuns.totalCostUsd,
    })
    .from(workerRuns)
    .where(gte(workerRuns.startedAt, since24h))
    .orderBy(desc(workerRuns.startedAt))
    .limit(50)
    .all();

  const totalRuns = recentRunRows.length;
  const succeededRuns = recentRunRows.filter(r => r.succeeded).length;
  const failedRuns = totalRuns - succeededRuns;
  const totalCost = recentRunRows.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0);

  // Pick up to 2 highlights from recent successful agent work
  const highlights = recentRunRows
    .filter(r => r.succeeded && r.summary && r.agentType === "programmer")
    .slice(0, 2)
    .map(r => `  • ${truncate(r.summary ?? "", 80)}`);

  // Identify repeatedly-failing workers (3+ failures in last 24h)
  const failedRows = recentRunRows.filter(r => !r.succeeded);
  const failCountByWorker = new Map<string, number>();
  for (const r of failedRows) {
    const key = r.agentType ?? "unknown";
    failCountByWorker.set(key, (failCountByWorker.get(key) ?? 0) + 1);
  }
  const repeatedFailures = [...failCountByWorker.entries()]
    .filter(([, count]) => count >= 3)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);

  // ── Format Message ───────────────────────────────────────────────────────

  const dayLabel = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const lines: string[] = [];

  // Header
  lines.push(`📋 **Daily Brief — ${dayLabel}**`);
  lines.push("");

  // Goals section
  lines.push(`**Goals** (${activeGoals.length} active)`);
  if (goalSummaries.length === 0) {
    lines.push("• No active goals");
  } else {
    for (const g of goalSummaries) {
      const stagnant =
        g.daysSinceActivity !== null && g.daysSinceActivity >= STAGNANT_DAYS_THRESHOLD
          ? ` ⏸️ stagnant ${g.daysSinceActivity}d`
          : "";
      const taskLabel = g.openTaskCount === 1 ? "1 open task" : `${g.openTaskCount} open tasks`;
      lines.push(`• ${g.title} — ${taskLabel}${stagnant}`);
    }
  }
  lines.push("");

  // Agent activity section
  lines.push(`**Agent Activity** (last 24h)`);
  if (totalRuns === 0) {
    lines.push("No agent runs in the last 24h");
  } else {
    const costStr = totalCost > 0 ? ` · 💰 $${totalCost.toFixed(4)}` : "";
    lines.push(`✅ ${succeededRuns} succeeded · ❌ ${failedRuns} failed${costStr}`);
    if (highlights.length > 0) {
      lines.push(...highlights);
    }
    if (repeatedFailures.length > 0) {
      lines.push(`⚠️ Repeated failures:`);
      for (const [worker, count] of repeatedFailures) {
        lines.push(`  ❌ ${worker}: ${count}x in last 24h`);
      }
    }
  }
  lines.push("");

  // Tasks section
  lines.push("**Tasks**");
  lines.push(
    `🔴 ${highPriority.length} high-priority  🚧 ${blockedTasks.length} blocked  ✅ ${completedToday.length} done today`,
  );

  // Blocked task callouts (up to 2)
  if (blockedTasks.length > 0) {
    for (const t of blockedTasks.slice(0, 2)) {
      const reason = t.blockedBy ? ` (${truncate(String(t.blockedBy), 40)})` : "";
      lines.push(`  🚧 ${truncate(t.title, 60)}${reason}`);
    }
    if (blockedTasks.length > 2) {
      lines.push(`  _…and ${blockedTasks.length - 2} more_`);
    }
  }

  // High-priority callouts (up to 2)
  if (highPriority.length > 0) {
    for (const t of highPriority.slice(0, 2)) {
      lines.push(`  🔴 ${truncate(t.title, 70)}`);
    }
    if (highPriority.length > 2) {
      lines.push(`  _…and ${highPriority.length - 2} more_`);
    }
  }

  lines.push("");
  lines.push(`_View full brief: ${BRIEF_URL}_`);

  return lines.join("\n");
}

/** Extracts a displayable string from the json-mode blockedBy field. */
function resolveBlockedBy(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const text = obj["text"] ?? obj["reason"] ?? obj["message"] ?? obj["description"];
    if (typeof text === "string") return text;
    return JSON.stringify(value).slice(0, 60);
  }
  return String(value);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

async function sendBrief(message: string): Promise<void> {
  const DISCORD_LIMIT = 2000;

  if (message.length <= DISCORD_LIMIT) {
    await discordService.send(ALERTS_CHANNEL, message);
    return;
  }

  // Split at the last newline before the limit
  let remaining = message;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_LIMIT) {
      await discordService.send(ALERTS_CHANNEL, remaining);
      break;
    }
    const splitAt = remaining.lastIndexOf("\n", DISCORD_LIMIT);
    const chunk = splitAt > 0 ? remaining.slice(0, splitAt) : remaining.slice(0, DISCORD_LIMIT);
    await discordService.send(ALERTS_CHANNEL, chunk);
    remaining = remaining.slice(chunk.length).replace(/^\n/, "");
  }
}
