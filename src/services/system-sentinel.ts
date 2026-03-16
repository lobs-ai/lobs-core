/**
 * System Sentinel — lightweight local-model-powered monitor that
 * periodically scans system state and prompts the main agent
 * when something needs attention.
 *
 * Uses the local Qwen model via LM Studio — fast, free, always running.
 * Every check is logged as training data for future fine-tuning.
 *
 * Sentinel tasks:
 * 1. Calendar check — upcoming events that need prep
 * 2. Task health — stale/blocked tasks, overdue items
 * 3. Daily brief generation — AI narrative for the dashboard
 */

import { log } from "../util/logger.js";
import { isLocalModelAvailable } from "../runner/local-classifier.js";
import { assembleDailyBriefContext, assembleSystemStateContext } from "./context-assembler.js";
import { logTrainingExample } from "./training-data.js";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { eq, inArray, lte, and } from "drizzle-orm";
import { getLocalConfig } from "../config/models.js";

const LM_STUDIO_BASE = process.env.LM_STUDIO_URL ?? getLocalConfig().baseUrl;
const DEFAULT_MODEL = process.env.LOCAL_MODEL ?? getLocalConfig().chatModel;

// ─── Local Model Call ──────────────────────────────────────────────────

async function callLocalModel(
  system: string,
  user: string,
  options?: { maxTokens?: number; temperature?: number },
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000); // 60s — thinking models need more time

  try {
    const response = await fetch(`${LM_STUDIO_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // Thinking models (Qwen3.5) use lots of tokens for reasoning before
        // producing output. We need a much higher budget so the actual JSON
        // answer isn't truncated.
        max_tokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LM Studio returned ${response.status}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";

    // Strip thinking/reasoning prefix from Qwen3.5-style models.
    // The model outputs "Thinking Process:\n..." before the actual answer.
    // We extract just the JSON portion since all sentinel tasks expect JSON.
    return raw;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Task Health Sentinel ──────────────────────────────────────────────

export interface TaskHealthResult {
  alerts: Array<{ type: string; severity: "low" | "medium" | "high"; message: string; taskId?: string }>;
  summary: string;
}

export async function checkTaskHealth(): Promise<TaskHealthResult | null> {
  const available = await isLocalModelAvailable();
  if (!available) {
    log().warn("[SENTINEL] Local model unavailable, skipping task health check");
    return null;
  }

  const context = assembleSystemStateContext();

  const systemPrompt = `You are a task health monitor for a software engineering project management system.
Analyze the system state and identify any issues that need attention.

Output JSON only:
{
  "alerts": [
    { "type": "stale_task|blocked|overdue|workload", "severity": "low|medium|high", "message": "description" }
  ],
  "summary": "one sentence overall status"
}

If everything looks fine, return empty alerts and a positive summary.`;

  const userPrompt = `Current system state:

Stale tasks (no update in 7+ days):
${context.staleTasks.length > 0
    ? context.staleTasks.map(t => `- "${t.title}" (last updated: ${t.lastUpdated}, status: ${t.status})`).join("\n")
    : "None"}

Blocked tasks:
${context.blockedTasks.length > 0
    ? context.blockedTasks.map(t => `- "${t.title}" (blocked by: ${t.blockedBy ?? "unknown"})`).join("\n")
    : "None"}

Active worker runs: ${context.activeWorkerRuns}

Recent errors:
${context.recentErrors.length > 0
    ? context.recentErrors.map(e => `- ${e}`).join("\n")
    : "None"}`;

  try {
    const raw = await callLocalModel(systemPrompt, userPrompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log().warn("[SENTINEL] Task health check returned non-JSON response");
      return null;
    }

    const result = JSON.parse(jsonMatch[0]) as TaskHealthResult;

    // Log as training data
    logTrainingExample({
      taskType: "system_state",
      systemPrompt,
      userPrompt,
      context: context as unknown as Record<string, unknown>,
      modelOutput: JSON.stringify(result),
      modelUsed: "local",
    });

    log().info(`[SENTINEL] Task health: ${result.summary} (${result.alerts.length} alerts)`);
    return result;
  } catch (err) {
    log().warn(`[SENTINEL] Task health check failed: ${err}`);
    return null;
  }
}

// ─── Daily Brief AI Summary ───────────────────────────────────────────

export interface AiBriefResult {
  narrative: string;
  topPriorities: string[];
  concerns: string[];
  suggestedActions: string[];
}

export async function generateDailyBriefSummary(): Promise<AiBriefResult | null> {
  const available = await isLocalModelAvailable();
  if (!available) {
    log().warn("[SENTINEL] Local model unavailable, skipping daily brief generation");
    return null;
  }

  const context = assembleDailyBriefContext();

  const systemPrompt = `You are a personal assistant generating a daily brief for a grad student/software engineer.
Be concise, direct, and actionable. No fluff.

Output JSON only:
{
  "narrative": "2-3 sentence summary of the day ahead",
  "topPriorities": ["top 3 things to focus on today"],
  "concerns": ["anything that needs attention or could go wrong"],
  "suggestedActions": ["specific actions to take today"]
}`;

  const userPrompt = `Today's date: ${context.date}

Active tasks (${context.activeTasks.length}):
${context.activeTasks.map(t =>
    `- [${t.priority ?? "medium"}] "${t.title}" (${t.status}) — ${t.projectTitle ?? "no project"}`
  ).join("\n")}

Completed today (${context.completedToday.length}):
${context.completedToday.map(t => `- "${t.title}"`).join("\n") || "None yet"}

Blocked (${context.blockedTasks.length}):
${context.blockedTasks.map(t => `- "${t.title}" (blocked by: ${t.blockedBy ?? "unknown"})`).join("\n") || "None"}

Overdue (${context.overdueItems.length}):
${context.overdueItems.map(t => `- "${t.title}" (due: ${t.dueDate})`).join("\n") || "None"}

Today's calendar events:
${context.todayEvents.length > 0
    ? context.todayEvents.map(e => `- ${e.summary} (${e.start} - ${e.end})`).join("\n")
    : "No events loaded yet"}`;

  try {
    const raw = await callLocalModel(systemPrompt, userPrompt, { maxTokens: 2048 });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log().warn("[SENTINEL] Daily brief returned non-JSON");
      return null;
    }

    const result = JSON.parse(jsonMatch[0]) as AiBriefResult;

    // Log as training data
    logTrainingExample({
      taskType: "daily_brief",
      systemPrompt,
      userPrompt,
      context: context as unknown as Record<string, unknown>,
      modelOutput: JSON.stringify(result),
      modelUsed: "local",
    });

    log().info(`[SENTINEL] Daily brief generated: ${result.narrative.slice(0, 80)}...`);
    return result;
  } catch (err) {
    log().warn(`[SENTINEL] Daily brief generation failed: ${err}`);
    return null;
  }
}

// ─── Main Sentinel Loop ───────────────────────────────────────────────

let lastBriefDate = "";
let cachedBrief: AiBriefResult | null = null;
let cachedHealth: TaskHealthResult | null = null;
let lastHealthCheck = 0;

/**
 * Run the sentinel check. Called by cron every 15 minutes.
 * Returns alerts that should be forwarded to the main agent.
 */
export async function runSentinelCheck(): Promise<{
  taskHealth: TaskHealthResult | null;
  brief: AiBriefResult | null;
  shouldAlert: boolean;
  alertMessage?: string;
}> {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // Generate daily brief once per day (or refresh if stale)
  if (today !== lastBriefDate) {
    cachedBrief = await generateDailyBriefSummary();
    lastBriefDate = today;
  }

  // Task health every 15 min
  cachedHealth = await checkTaskHealth();
  lastHealthCheck = now;

  // Determine if we should alert the main agent
  const highAlerts = cachedHealth?.alerts.filter(a => a.severity === "high") ?? [];
  const shouldAlert = highAlerts.length > 0;

  return {
    taskHealth: cachedHealth,
    brief: cachedBrief,
    shouldAlert,
    alertMessage: shouldAlert
      ? `🚨 Sentinel detected ${highAlerts.length} high-severity issue(s):\n${highAlerts.map(a => `- ${a.message}`).join("\n")}`
      : undefined,
  };
}

/**
 * Get the cached daily brief (for API serving).
 */
export function getCachedBrief(): AiBriefResult | null {
  return cachedBrief;
}

/**
 * Get the cached task health (for API serving).
 */
export function getCachedHealth(): TaskHealthResult | null {
  return cachedHealth;
}
