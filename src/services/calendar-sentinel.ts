/**
 * Calendar Sentinel Service
 *
 * Runs every 15 minutes via the cron system. Fetches upcoming Google Calendar
 * events (next 2 hours), analyses each one with the local LM Studio model,
 * and alerts the main agent when preparation or action is required.
 *
 * Every analysis is logged as a training example for future fine-tuning.
 *
 * Flow per tick:
 *  1. getUpcomingEvents(2)          — fetch next-2-hour events
 *  2. assembleCalendarCheckContext() — enrich with tasks, memory
 *  3. callLocalModel()               — "does this need action?"
 *  4. if action needed → emit to main agent via globalThis.__lobsMainAgent
 *  5. logTrainingExample()           — always log for fine-tuning
 */

import { log } from "../util/logger.js";
import { isLocalModelAvailable } from "../runner/local-classifier.js";
import {
  getUpcomingEvents,
  getTodayEvents,
  formatEventForContext,
  isAllDayEvent,
  isGoogleCalendarAvailable,
  type CalendarEvent,
} from "./google-calendar.js";
import {
  assembleCalendarCheckContext,
  formatCalendarContext,
} from "./context-assembler.js";
import { logTrainingExample } from "./training-data.js";
import { getLocalConfig } from "../config/models.js";

const LM_STUDIO_BASE = process.env.LM_STUDIO_URL ?? getLocalConfig().baseUrl;
const DEFAULT_MODEL = process.env.LOCAL_MODEL ?? getLocalConfig().chatModel;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CalendarActionItem {
  eventId: string;
  eventSummary: string;
  eventStart: string;
  requiresAction: boolean;
  actionDescription: string;
  urgency: "low" | "medium" | "high";
  suggestedSteps: string[];
  trainingExampleId: string;
}

export interface CalendarSentinelResult {
  checkedAt: string;
  eventsAnalyzed: number;
  actionItems: CalendarActionItem[];
  shouldAlert: boolean;
  alertMessage?: string;
}

// ─── In-memory state ────────────────────────────────────────────────────────

let _lastResult: CalendarSentinelResult | null = null;
let _cachedTodayEvents: CalendarEvent[] = [];
let _lastTodayCacheDate = "";

// ─── Local Model Call ────────────────────────────────────────────────────────

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
        // Thinking models (Qwen3.5) use lots of tokens reasoning before output.
        // Need higher budget so the actual JSON answer isn't truncated.
        max_tokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LM Studio returned ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const CALENDAR_SYSTEM_PROMPT = `You are a personal assistant reviewing calendar events to determine whether any preparation or action is needed before the event.

Analyse the upcoming event in context of the person's active tasks, memory, and other events. Focus on:
- Is there anything they need to prepare (slides, agenda, notes, code, documents)?
- Is there a task directly related to this event that should be completed first?
- Does this event conflict with or depend on another task/event?
- Is there someone they should message or coordinate with beforehand?

Output ONLY valid JSON (no markdown, no explanation):
{
  "requiresAction": true|false,
  "actionDescription": "short description of what's needed, or 'None' if no action",
  "urgency": "low|medium|high",
  "suggestedSteps": ["step 1", "step 2"]
}

If no action is needed, set requiresAction to false, actionDescription to "None", urgency to "low", suggestedSteps to [].`;

// ─── Per-event Analysis ──────────────────────────────────────────────────────

async function analyseEvent(
  event: CalendarEvent,
  allUpcomingEvents: CalendarEvent[],
): Promise<CalendarActionItem | null> {
  const eventStart = event.start.dateTime ?? event.start.date ?? "";
  const eventEnd = event.end.dateTime ?? event.end.date ?? "";

  // Build context
  const ctx = await assembleCalendarCheckContext({
    summary: event.summary,
    start: eventStart,
    end: eventEnd,
    description: event.description,
  });

  // Fill in upcoming events from what we already fetched (avoid duplicate API call)
  ctx.upcomingEvents = allUpcomingEvents
    .filter(e => e.id !== event.id)
    .map(e => ({
      summary: e.summary,
      start: e.start.dateTime ?? e.start.date ?? "",
    }));

  const contextStr = formatCalendarContext(ctx);

  const userPrompt = `Upcoming event:
${formatEventForContext(event)}

${contextStr}

Does this event require any preparation or action in the next 2 hours?`;

  try {
    const raw = await callLocalModel(CALENDAR_SYSTEM_PROMPT, userPrompt);

    // Extract JSON (model sometimes wraps in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log().warn(`[calendar-sentinel] Non-JSON response for "${event.summary}": ${raw.slice(0, 100)}`);
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      requiresAction: boolean;
      actionDescription: string;
      urgency: "low" | "medium" | "high";
      suggestedSteps: string[];
    };

    // Log training example
    const trainingExampleId = logTrainingExample({
      taskType: "calendar_check",
      systemPrompt: CALENDAR_SYSTEM_PROMPT,
      userPrompt,
      context: ctx as unknown as Record<string, unknown>,
      modelOutput: JSON.stringify(parsed),
      modelUsed: DEFAULT_MODEL,
    });

    log().info(
      `[calendar-sentinel] "${event.summary}" — action=${parsed.requiresAction} urgency=${parsed.urgency}`,
    );

    return {
      eventId: event.id,
      eventSummary: event.summary,
      eventStart,
      requiresAction: parsed.requiresAction,
      actionDescription: parsed.actionDescription,
      urgency: parsed.urgency,
      suggestedSteps: Array.isArray(parsed.suggestedSteps) ? parsed.suggestedSteps : [],
      trainingExampleId,
    };
  } catch (err) {
    log().warn(`[calendar-sentinel] Analysis failed for "${event.summary}": ${err}`);
    return null;
  }
}

// ─── Main Sentinel Run ────────────────────────────────────────────────────────

/**
 * Run the calendar sentinel check. Called every 15 minutes by cron.
 */
export async function runCalendarSentinel(): Promise<CalendarSentinelResult> {
  const checkedAt = new Date().toISOString();
  const empty: CalendarSentinelResult = {
    checkedAt,
    eventsAnalyzed: 0,
    actionItems: [],
    shouldAlert: false,
  };

  // Guard: token file must exist
  if (!isGoogleCalendarAvailable()) {
    log().warn("[calendar-sentinel] Google token not found, skipping");
    return empty;
  }

  // Guard: local model must be up
  const modelAvailable = await isLocalModelAvailable();
  if (!modelAvailable) {
    log().warn("[calendar-sentinel] Local model unavailable, skipping");
    return empty;
  }

  // Fetch upcoming events (next 2 hours)
  let upcoming: CalendarEvent[];
  try {
    upcoming = await getUpcomingEvents(2);
  } catch (err) {
    log().warn(`[calendar-sentinel] Failed to fetch upcoming events: ${err}`);
    return empty;
  }

  // Skip all-day events — they're informational, not timed actions
  const timedEvents = upcoming.filter(e => !isAllDayEvent(e));

  if (timedEvents.length === 0) {
    log().info("[calendar-sentinel] No timed events in next 2 hours");
    _lastResult = { ...empty, checkedAt };
    return _lastResult;
  }

  log().info(`[calendar-sentinel] Analysing ${timedEvents.length} event(s)`);

  // Analyse each event in sequence (rate-limit local model)
  const actionItems: CalendarActionItem[] = [];
  for (const event of timedEvents) {
    const item = await analyseEvent(event, upcoming);
    if (item) actionItems.push(item);
  }

  // Determine whether to alert the main agent
  const urgentItems = actionItems.filter(
    i => i.requiresAction && (i.urgency === "high" || i.urgency === "medium"),
  );
  const shouldAlert = urgentItems.length > 0;

  let alertMessage: string | undefined;
  if (shouldAlert) {
    const lines = urgentItems.map(
      i => `• "${i.eventSummary}" at ${i.eventStart.slice(11, 16)}: ${i.actionDescription}` +
           (i.suggestedSteps.length > 0
             ? `\n  Steps: ${i.suggestedSteps.slice(0, 2).join(" → ")}`
             : ""),
    );
    alertMessage =
      `📅 Calendar Sentinel: ${urgentItems.length} event(s) need attention:\n${lines.join("\n")}`;
  }

  const result: CalendarSentinelResult = {
    checkedAt,
    eventsAnalyzed: timedEvents.length,
    actionItems,
    shouldAlert,
    alertMessage,
  };

  _lastResult = result;

  // Refresh today's event cache for daily brief
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== _lastTodayCacheDate) {
      _cachedTodayEvents = await getTodayEvents();
      _lastTodayCacheDate = today;
    }
  } catch {
    // Non-fatal
  }

  log().info(
    `[calendar-sentinel] Done — ${actionItems.length} analysed, ` +
    `${urgentItems.length} need action`,
  );

  return result;
}

// ─── Accessors ────────────────────────────────────────────────────────────────

/**
 * Get the latest sentinel result (for API serving).
 */
export function getLastCalendarSentinelResult(): CalendarSentinelResult | null {
  return _lastResult;
}

/**
 * Get today's events from the sentinel cache (for daily brief).
 * Returns empty array if not yet fetched or unavailable.
 */
export function getCachedTodayEvents(): CalendarEvent[] {
  return _cachedTodayEvents;
}

/**
 * Format calendar action items as a concise string for the main agent.
 */
export function formatActionItems(items: CalendarActionItem[]): string {
  if (items.length === 0) return "No calendar action items.";
  return items
    .filter(i => i.requiresAction)
    .map(
      i =>
        `📅 ${i.eventSummary} (${i.eventStart.slice(11, 16)}) — ${i.actionDescription}` +
        (i.suggestedSteps.length > 0
          ? `\n   → ${i.suggestedSteps.slice(0, 3).join(" → ")}`
          : ""),
    )
    .join("\n");
}
