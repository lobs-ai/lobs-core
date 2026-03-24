/**
 * Nightly Planner — runs at 10pm ET every night
 *
 * Plans the next 7 days by:
 * 1. Reading Rafe's calendar for the week ahead
 * 2. Fetching active/in-progress human tasks, scored by priority + deadlines
 * 3. Calculating free slots per day
 * 4. Assigning tasks to slots (highest priority first, deadline-aware)
 * 5. Clearing old planner events from the Lobs Planning calendar
 * 6. Writing new events with descriptive emoji-prefixed titles
 * 7. Returning a summary for Discord notification
 */

import { and, asc, desc, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { getEventsForDateRange, type CalendarEvent } from "./google-calendar.js";
import { GoogleCalendarService } from "../integrations/google-calendar.js";
import {
  buildFreeSlots,
  getFixedBusyBlocks,
  scoreTask,
  normalizeEstimate,
  clampToWindow,
  MIN_SLOT_MINUTES,
  SLOT_BUFFER_MINUTES,
  type BusyBlock,
  type PlannerSlot,
} from "./scheduler-intelligence.js";
import { log } from "../util/logger.js";

// ─── Configuration ────────────────────────────────────────────────────────────

/** How many days ahead to plan */
const PLANNING_HORIZON_DAYS = 7;

/** Max work blocks to schedule per day */
const MAX_BLOCKS_PER_DAY = 6;

/** Try to leave at least one free slot of this size (minutes) per day */
const BREATHING_ROOM_MINUTES = 90;

/** Marker in event descriptions so we can identify & clear planner events */
const PLANNER_TAG = "[lobs-planner]";

/** Timezone for all scheduling */
const TZ = "America/New_York";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NightlyPlannerResult {
  plannedAt: string;
  targetDateRange: { start: string; end: string }; // YYYY-MM-DD
  eventsCreated: number;
  eventsCleared: number;
  plannedBlocks: Array<{
    taskId: string;
    taskTitle: string;
    day: string; // YYYY-MM-DD
    start: string;
    end: string;
    minutes: number;
    calendarEventId: string | null;
  }>;
  unscheduledTasks: Array<{
    taskId: string;
    taskTitle: string;
    reason: string;
  }>;
  dayBreakdown: Array<{
    date: string;
    existingEvents: number;
    freeMinutes: number;
    blocksScheduled: number;
  }>;
  summary: string;
}

interface RankedTask {
  id: string;
  title: string;
  priority: string | null;
  dueDate: string | null;
  estimatedMinutes: number;
  score: number;
  status: string;
  workState: string | null;
  projectId: string | null;
  shape: string | null;
  remainingMinutes: number; // tracks how much is left to schedule
}

// ─── Emoji mapping ────────────────────────────────────────────────────────────

function getTaskEmoji(task: RankedTask): string {
  const title = task.title.toLowerCase();
  if (/review|audit|check|grade/.test(title)) return "🔍";
  if (/doc|write|draft|essay|paper/.test(title)) return "📝";
  if (/study|read|lecture|homework|hw|exam|quiz/.test(title)) return "📚";
  if (/research|investigate|explore/.test(title)) return "🔬";
  if (/fix|bug|patch|debug/.test(title)) return "🔧";
  if (/build|implement|create|develop|feature|ship/.test(title)) return "🔨";
  if (/meet|sync|call|discuss/.test(title)) return "🗣️";
  if (/plan|design|architect|outline/.test(title)) return "📐";
  if (/test|verify|qa/.test(title)) return "✅";
  if (/deploy|release|launch/.test(title)) return "🚀";

  // Fallback by shape
  if (task.shape === "spike") return "🔬";
  if (task.shape === "feature") return "🔨";
  if (task.shape === "fix") return "🔧";
  if (task.shape === "review") return "🔍";
  if (task.shape === "write") return "📝";

  return "📋";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTimeET(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(11, 16);
  }
}

function formatDayLabel(date: Date): string {
  return date.toLocaleDateString("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function toBusyBlockFromRafeCalendar(event: CalendarEvent): BusyBlock | null {
  const startRaw = event.start.dateTime ?? event.start.date;
  const endRaw = event.end.dateTime ?? event.end.date;
  if (!startRaw || !endRaw) return null;
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const clamped = clampToWindow(start, end);
  if (!clamped) return null;
  return {
    title: event.summary || "(untitled)",
    start: clamped.start,
    end: clamped.end,
    source: "google",
    location: event.location,
  };
}

// ─── Core planner ─────────────────────────────────────────────────────────────

export async function runNightlyPlanner(): Promise<NightlyPlannerResult> {
  const now = new Date();
  const gcal = new GoogleCalendarService();

  log().info("[nightly-planner] Starting nightly planning run");

  // ── 1. Determine date range ──────────────────────────────────────────────
  const tomorrow = addDays(startOfDay(now), 1);
  const rangeEnd = addDays(tomorrow, PLANNING_HORIZON_DAYS);

  // ── 2. Fetch Rafe's calendar for the full range ─────────────────────────
  let rafeEvents: CalendarEvent[] = [];
  try {
    rafeEvents = await getEventsForDateRange(
      startOfDay(tomorrow).toISOString(),
      endOfDay(addDays(rangeEnd, -1)).toISOString(),
    );
    log().info(`[nightly-planner] Fetched ${rafeEvents.length} events from Rafe's calendar`);
  } catch (err) {
    log().warn(`[nightly-planner] Failed to fetch Rafe's calendar: ${err}`);
  }

  // ── 3. Fetch active human tasks ─────────────────────────────────────────
  const db = getDb();
  const taskRows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      estimatedMinutes: tasks.estimatedMinutes,
      status: tasks.status,
      workState: tasks.workState,
      projectId: tasks.projectId,
      shape: tasks.shape,
      updatedAt: tasks.updatedAt,
      blockedBy: tasks.blockedBy,
      agent: tasks.agent,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["active", "in_progress"]),
      ),
    )
    .orderBy(desc(tasks.priority), asc(tasks.dueDate))
    .all()
    .filter((row) => !row.agent); // human tasks only

  const rankedTasks: RankedTask[] = taskRows
    .map((row) => ({
      id: row.id,
      title: row.title,
      priority: row.priority,
      dueDate: row.dueDate,
      estimatedMinutes: normalizeEstimate(row),
      score: scoreTask(row),
      status: row.status,
      workState: row.workState,
      projectId: row.projectId,
      shape: row.shape,
      remainingMinutes: normalizeEstimate(row),
    }))
    .sort((a, b) => b.score - a.score);

  log().info(`[nightly-planner] ${rankedTasks.length} active human tasks, ranked by score`);

  // ── 4. Clear old planner events from Lobs calendar ──────────────────────
  let eventsCleared = 0;
  try {
    const existingPlannerEvents = await gcal.listEvents(
      null, // auto-discover Lobs calendar
      startOfDay(tomorrow).toISOString(),
      endOfDay(addDays(rangeEnd, -1)).toISOString(),
    );

    const plannerEvents = existingPlannerEvents.filter(
      (e) => e.description?.includes(PLANNER_TAG),
    );

    for (const event of plannerEvents) {
      const deleted = await gcal.deleteEvent(null, event.id);
      if (deleted) eventsCleared++;
    }

    log().info(`[nightly-planner] Cleared ${eventsCleared} old planner events`);
  } catch (err) {
    log().warn(`[nightly-planner] Failed to clear old events: ${err}`);
  }

  // ── 5. Plan each day ────────────────────────────────────────────────────
  const allPlannedBlocks: NightlyPlannerResult["plannedBlocks"] = [];
  const dayBreakdown: NightlyPlannerResult["dayBreakdown"] = [];

  for (let dayOffset = 0; dayOffset < PLANNING_HORIZON_DAYS; dayOffset++) {
    const dayDate = addDays(tomorrow, dayOffset);
    const dayStr = formatDate(dayDate);

    // Events for this specific day
    const dayEvents = rafeEvents.filter((e) => {
      const start = e.start.dateTime ?? e.start.date ?? "";
      return start.startsWith(dayStr);
    });

    // Build busy blocks from calendar events + recurring blocks
    const busyBlocks: BusyBlock[] = [
      ...dayEvents.map(toBusyBlockFromRafeCalendar).filter(Boolean) as BusyBlock[],
      ...getFixedBusyBlocks(dayDate),
    ];

    // Calculate free slots
    const freeSlots = buildFreeSlots(dayDate, busyBlocks);
    const totalFreeMinutes = freeSlots.reduce((sum, s) => sum + s.minutes, 0);

    // Reserve breathing room — remove the largest slot from scheduling if possible
    const slotsForScheduling = reserveBreathingRoom(freeSlots);

    // Schedule tasks into this day's slots
    const dayBlocks = scheduleTasksForDay(
      slotsForScheduling,
      rankedTasks,
      dayStr,
      MAX_BLOCKS_PER_DAY - allPlannedBlocks.filter((b) => b.day === dayStr).length,
    );

    allPlannedBlocks.push(...dayBlocks);
    dayBreakdown.push({
      date: dayStr,
      existingEvents: dayEvents.length,
      freeMinutes: totalFreeMinutes,
      blocksScheduled: dayBlocks.length,
    });
  }

  log().info(
    `[nightly-planner] Planned ${allPlannedBlocks.length} work blocks across ${PLANNING_HORIZON_DAYS} days`,
  );

  // ── 6. Write events to Lobs Planning calendar ──────────────────────────
  let eventsCreated = 0;
  for (const block of allPlannedBlocks) {
    const task = rankedTasks.find((t) => t.id === block.taskId);
    const emoji = task ? getTaskEmoji(task) : "📋";
    const title = `${emoji} ${block.taskTitle}`;

    const description = [
      PLANNER_TAG,
      `Task: ${block.taskTitle}`,
      `Task ID: ${block.taskId}`,
      `Duration: ${block.minutes}min`,
      task?.priority ? `Priority: ${task.priority}` : null,
      task?.dueDate ? `Due: ${task.dueDate}` : null,
      task?.projectId ? `Project: ${task.projectId}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const eventId = await gcal.createEvent(null, {
        title,
        description,
        startAt: block.start,
        endAt: block.end,
        allDay: false,
      });

      if (eventId) {
        block.calendarEventId = eventId;
        eventsCreated++;
      }
    } catch (err) {
      log().warn(`[nightly-planner] Failed to create event for ${block.taskTitle}: ${err}`);
    }
  }

  log().info(`[nightly-planner] Created ${eventsCreated} calendar events`);

  // ── 7. Identify unscheduled tasks ───────────────────────────────────────
  const scheduledTaskIds = new Set(allPlannedBlocks.map((b) => b.taskId));
  const unscheduledTasks = rankedTasks
    .filter((t) => !scheduledTaskIds.has(t.id) && t.remainingMinutes > 0)
    .map((t) => ({
      taskId: t.id,
      taskTitle: t.title,
      reason:
        t.score < 0
          ? "blocked by dependencies"
          : t.remainingMinutes > 180
            ? "task too large — break it down"
            : "no free slots available in the planning window",
    }));

  // ── 8. Build summary ───────────────────────────────────────────────────
  const summary = buildSummary(allPlannedBlocks, unscheduledTasks, dayBreakdown, rankedTasks);

  const result: NightlyPlannerResult = {
    plannedAt: now.toISOString(),
    targetDateRange: {
      start: formatDate(tomorrow),
      end: formatDate(addDays(rangeEnd, -1)),
    },
    eventsCreated,
    eventsCleared,
    plannedBlocks: allPlannedBlocks,
    unscheduledTasks,
    dayBreakdown,
    summary,
  };

  log().info(`[nightly-planner] Run complete: ${eventsCreated} created, ${eventsCleared} cleared`);
  return result;
}

// ─── Scheduling logic ─────────────────────────────────────────────────────────

function reserveBreathingRoom(slots: PlannerSlot[]): PlannerSlot[] {
  if (slots.length <= 1) return slots;

  // Find the largest slot
  const sorted = [...slots].sort((a, b) => b.minutes - a.minutes);
  const largest = sorted[0];

  // If the largest slot is big enough for breathing room, partially reserve it
  if (largest.minutes >= BREATHING_ROOM_MINUTES + MIN_SLOT_MINUTES) {
    // Shrink the slot to leave breathing room at the end
    return slots.map((s) => {
      if (s.start === largest.start && s.end === largest.end) {
        const newEnd = new Date(
          new Date(s.end).getTime() - BREATHING_ROOM_MINUTES * 60000,
        );
        return {
          ...s,
          end: newEnd.toISOString(),
          minutes: s.minutes - BREATHING_ROOM_MINUTES,
        };
      }
      return s;
    });
  }

  // If we have a slot that's exactly breathing-room sized, skip it entirely
  if (largest.minutes <= BREATHING_ROOM_MINUTES) {
    return slots.filter(
      (s) => !(s.start === largest.start && s.end === largest.end),
    );
  }

  return slots;
}

function scheduleTasksForDay(
  slots: PlannerSlot[],
  rankedTasks: RankedTask[],
  dayStr: string,
  maxBlocks: number,
): NightlyPlannerResult["plannedBlocks"] {
  const blocks: NightlyPlannerResult["plannedBlocks"] = [];
  const remainingSlots = slots.map((s) => ({ ...s }));
  let blocksUsed = 0;

  for (const task of rankedTasks) {
    if (blocksUsed >= maxBlocks) break;
    if (task.remainingMinutes <= 0) continue;

    // If task has a due date, prefer scheduling it closer to the due date
    // but still before it — don't schedule future-due tasks on day 1 if there's time
    if (task.dueDate) {
      const dueDate = task.dueDate.slice(0, 10);
      const daysBefore = daysDiff(dayStr, dueDate);
      // Skip if due date is more than 5 days away and this is a near day
      // (let nearer-due tasks take priority on near days)
      if (daysBefore > 5 && task.score < 500) continue;
    }

    // Find a slot that fits
    const slotIdx = remainingSlots.findIndex((s) => s.minutes >= MIN_SLOT_MINUTES);
    if (slotIdx === -1) break;

    // Prefer a slot that fits the full task; fall back to partial
    let targetIdx = remainingSlots.findIndex(
      (s) => s.minutes >= task.remainingMinutes,
    );
    if (targetIdx === -1) targetIdx = slotIdx;

    const slot = remainingSlots[targetIdx];
    const allocation = Math.min(slot.minutes, task.remainingMinutes);
    const start = new Date(slot.start);
    const end = new Date(start.getTime() + allocation * 60000);

    blocks.push({
      taskId: task.id,
      taskTitle: task.title,
      day: dayStr,
      start: start.toISOString(),
      end: end.toISOString(),
      minutes: allocation,
      calendarEventId: null,
    });

    // Deduct from task's remaining time
    task.remainingMinutes -= allocation;

    // Update or remove slot
    const leftoverMinutes = slot.minutes - allocation - SLOT_BUFFER_MINUTES;
    if (leftoverMinutes >= MIN_SLOT_MINUTES) {
      remainingSlots[targetIdx] = {
        start: new Date(end.getTime() + SLOT_BUFFER_MINUTES * 60000).toISOString(),
        end: slot.end,
        minutes: leftoverMinutes,
        source: "free",
      };
    } else {
      remainingSlots.splice(targetIdx, 1);
    }

    blocksUsed++;
  }

  return blocks;
}

function daysDiff(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00");
  const b = new Date(dateB + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / 86400_000);
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary(
  blocks: NightlyPlannerResult["plannedBlocks"],
  unscheduled: NightlyPlannerResult["unscheduledTasks"],
  days: NightlyPlannerResult["dayBreakdown"],
  rankedTasks: RankedTask[],
): string {
  const lines: string[] = [];

  lines.push(`**📅 Weekly Plan** (${days[0]?.date} → ${days[days.length - 1]?.date})`);
  lines.push("");

  // Group blocks by day
  for (const day of days) {
    if (day.blocksScheduled === 0) continue;
    const dayBlocks = blocks.filter((b) => b.day === day.date);
    const dayLabel = formatDayLabel(new Date(day.date + "T12:00:00"));
    lines.push(`**${dayLabel}** — ${day.blocksScheduled} block${day.blocksScheduled === 1 ? "" : "s"}, ${day.freeMinutes}min free`);
    for (const block of dayBlocks) {
      const task = rankedTasks.find((t) => t.id === block.taskId);
      const emoji = task ? getTaskEmoji(task) : "📋";
      lines.push(
        `  ${emoji} ${block.taskTitle} (${formatTimeET(block.start)} – ${formatTimeET(block.end)}, ${block.minutes}min)`,
      );
    }
  }

  if (unscheduled.length > 0) {
    lines.push("");
    lines.push(`⚠️ ${unscheduled.length} task${unscheduled.length === 1 ? "" : "s"} couldn't be scheduled:`);
    for (const t of unscheduled.slice(0, 5)) {
      lines.push(`  • ${t.taskTitle} — ${t.reason}`);
    }
  }

  // Deadline warnings
  const upcoming = rankedTasks.filter((t) => {
    if (!t.dueDate) return false;
    const days = daysDiff(formatDate(new Date()), t.dueDate.slice(0, 10));
    return days >= 0 && days <= 3;
  });
  if (upcoming.length > 0) {
    lines.push("");
    lines.push("🔴 **Deadlines this week:**");
    for (const t of upcoming) {
      lines.push(`  • ${t.title} — due ${t.dueDate!.slice(0, 10)}`);
    }
  }

  return lines.join("\n");
}
