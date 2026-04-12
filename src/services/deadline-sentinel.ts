/**
 * Deadline Sentinel — scans Google Calendar for upcoming deadlines
 * and produces structured alerts for Discord delivery.
 *
 * Classification: cheap keyword check first; LLM (micro) only for ambiguous titles.
 * Deduplication: in-memory Set keyed by `${eventId}:${warningLevel}`, cleared of stale entries each run.
 */

import { getEventsForDateRange, isGoogleCalendarAvailable, type CalendarEvent } from "./google-calendar.js";
import { callApiModelJSON } from "../workers/base-worker.js";
import { log } from "../util/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeadlineAlert {
  eventId: string;
  title: string;
  deadlineAt: Date;
  daysUntil: number;
  warningLevel: "week" | "three-day" | "day-of";
  category: "conference" | "assignment" | "exam" | "paper" | "other";
  message: string;
}

export interface DeadlineSentinelResult {
  checkedAt: string;
  eventsScanned: number;
  alertsFired: number;
  alerts: DeadlineAlert[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Keywords that cheaply identify a deadline without an LLM call */
const DEADLINE_KEYWORDS = [
  "deadline", "due", "submission", "submit", "conference",
  "abstract", "paper", "exam", "final", "assignment", "homework", "project",
];

/** Keywords strongly associated with a specific category */
const CATEGORY_KEYWORDS: Record<DeadlineAlert["category"], string[]> = {
  conference: ["conference", "submission", "abstract", "icml", "neurips", "iclr", "acl", "emnlp", "cvpr", "eccv", "iccv"],
  paper: ["paper", "preprint", "arxiv", "manuscript", "draft"],
  assignment: ["assignment", "homework", "hw", "problem set", "pset", "lab"],
  exam: ["exam", "midterm", "final", "quiz", "test"],
  other: [],
};

/** In-memory deduplication store: `${eventId}:${warningLevel}` → deadline Date */
const firedAlerts = new Map<string, Date>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEventDate(event: CalendarEvent): Date | null {
  const raw = event.start.dateTime ?? event.start.date;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function daysUntil(deadline: Date, now: Date): number {
  const diffMs = deadline.getTime() - now.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function warningLevel(days: number): "week" | "three-day" | "day-of" | null {
  if (days >= 6 && days <= 8) return "week";
  if (days >= 2 && days <= 4) return "three-day";
  if (days >= 0 && days <= 1) return "day-of";
  return null;
}

function hasDeadlineKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return DEADLINE_KEYWORDS.some((kw) => lower.includes(kw));
}

function classifyCategory(title: string, description?: string): DeadlineAlert["category"] {
  const text = `${title} ${description ?? ""}`.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS) as [DeadlineAlert["category"], string[]][]) {
    if (cat === "other") continue;
    if (keywords.some((kw) => text.includes(kw))) return cat;
  }
  return "other";
}

function formatWarningLabel(level: "week" | "three-day" | "day-of", days: number): string {
  if (level === "week") return `in ${days} days`;
  if (level === "three-day") return `in ${days} day${days === 1 ? "" : "s"}`;
  return days === 0 ? "TODAY" : "tomorrow";
}

function categoryLabel(cat: DeadlineAlert["category"]): string {
  switch (cat) {
    case "conference": return "Conference deadline";
    case "paper": return "Paper deadline";
    case "assignment": return "Assignment due";
    case "exam": return "Exam";
    default: return "Deadline";
  }
}

function formatAlertMessage(
  title: string,
  deadline: Date,
  days: number,
  level: "week" | "three-day" | "day-of",
  category: DeadlineAlert["category"],
): string {
  const dueDate = deadline.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const warningStr = formatWarningLabel(level, days);
  return [
    `⏰ **Deadline ${warningStr}**: ${title}`,
    `📅 Due: ${dueDate}`,
    `🏷️ ${categoryLabel(category)}`,
  ].join("\n");
}

function pruneStaleEntries(now: Date): void {
  for (const [key, deadline] of firedAlerts.entries()) {
    if (deadline < now) {
      firedAlerts.delete(key);
    }
  }
}

// ── LLM classification ───────────────────────────────────────────────────────

interface ClassifyResult {
  isDeadline: boolean;
}

async function classifyWithLLM(title: string, description?: string): Promise<boolean> {
  const prompt = `Classify this calendar event. Is it a deadline, due date, or submission cutoff?

Event title: "${title}"
${description ? `Description: "${description.slice(0, 300)}"` : ""}

Respond ONLY with valid JSON: {"isDeadline": true} or {"isDeadline": false}`;

  try {
    const { data } = await callApiModelJSON<ClassifyResult>(prompt, { tier: "micro" });
    return data.isDeadline === true;
  } catch (err) {
    log().warn(`[deadline-sentinel] LLM classification failed for "${title}": ${err}`);
    return false;
  }
}

// ── Main scan ────────────────────────────────────────────────────────────────

export async function scanDeadlines(): Promise<DeadlineSentinelResult> {
  const now = new Date();
  const checkedAt = now.toISOString();

  if (!isGoogleCalendarAvailable()) {
    log().warn("[deadline-sentinel] Google Calendar not available — skipping scan");
    return { checkedAt, eventsScanned: 0, alertsFired: 0, alerts: [] };
  }

  // Prune stale dedupe entries
  pruneStaleEntries(now);

  // Fetch events for the next 14 days
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  let events: CalendarEvent[];
  try {
    events = await getEventsForDateRange(timeMin, timeMax);
  } catch (err) {
    log().error(`[deadline-sentinel] Failed to fetch calendar events: ${err}`);
    return { checkedAt, eventsScanned: 0, alertsFired: 0, alerts: [] };
  }

  log().info(`[deadline-sentinel] Scanning ${events.length} events in next 14 days`);

  const alerts: DeadlineAlert[] = [];

  for (const event of events) {
    const deadline = getEventDate(event);
    if (!deadline) continue;

    const days = daysUntil(deadline, now);
    const level = warningLevel(days);
    if (level === null) continue; // Not in a warning window

    const title = event.summary ?? "(no title)";
    const description = event.description;

    // Step 1: cheap keyword check
    let isDeadline = hasDeadlineKeyword(`${title} ${description ?? ""}`);

    // Step 2: LLM only for ambiguous cases
    if (!isDeadline) {
      isDeadline = await classifyWithLLM(title, description);
    }

    if (!isDeadline) continue;

    // Deduplication check
    const dedupeKey = `${event.id}:${level}`;
    if (firedAlerts.has(dedupeKey)) {
      log().info(`[deadline-sentinel] Skipping duplicate alert: ${dedupeKey}`);
      continue;
    }

    const category = classifyCategory(title, description);
    const message = formatAlertMessage(title, deadline, days, level, category);

    const alert: DeadlineAlert = {
      eventId: event.id,
      title,
      deadlineAt: deadline,
      daysUntil: days,
      warningLevel: level,
      category,
      message,
    };

    alerts.push(alert);
    firedAlerts.set(dedupeKey, deadline);
    log().info(`[deadline-sentinel] Alert: ${level} warning for "${title}" (${days} days)`);
  }

  return {
    checkedAt,
    eventsScanned: events.length,
    alertsFired: alerts.length,
    alerts,
  };
}
