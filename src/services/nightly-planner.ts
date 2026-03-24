/**
 * Nightly Planner Service
 *
 * Runs at 10pm ET every night. Reads the user's calendar for tomorrow,
 * fetches active tasks, computes free slots, and creates planning events
 * on the Lobs calendar (thelobsbot@gmail.com).
 */

import { inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { log } from "../util/logger.js";

import { getEventsForDateRange, type CalendarEvent } from "./google-calendar.js";
import {
  buildFreeSlots,
  mergeBusyBlocks,
  getFixedBusyBlocks,
  scoreTask,
  normalizeEstimate,
  MIN_SLOT_MINUTES,
  SLOT_BUFFER_MINUTES,
  type BusyBlock,
} from "./scheduler-intelligence.js";
import { GoogleCalendarService } from "../integrations/google-calendar.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TZ = "America/New_York";
const MAX_WORK_BLOCKS = 6;
const BREATHING_ROOM_MINUTES = 90;
const PLANNER_TAG = "[lobs-planner]";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface NightlyPlannerResult {
  plannedAt: string;
  targetDate: string; // YYYY-MM-DD
  eventsCreated: number;
  eventsCleared: number; // old planning events removed
  plannedBlocks: Array<{
    taskId: string;
    taskTitle: string;
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
  tomorrowEvents: number; // how many events are on the calendar tomorrow
  freeMinutes: number; // total free minutes tomorrow
  summary: string; // human-readable summary for Discord notification
}

// ─── Emoji Helpers ────────────────────────────────────────────────────────────

function pickEmoji(title: string, shape: string | null): string {
  const lower = title.toLowerCase();
  if (/fix|bug|patch|debug/.test(lower)) return "🐛";
  if (/deploy|release|launch|ship/.test(lower)) return "🚀";
  if (/test|verify|qa/.test(lower)) return "🧪";
  if (/build|implement|create|develop|feature|api|code|coding/.test(lower)) return "🔨";
  if (/design|architect|outline/.test(lower)) return "🎨";
  if (/plan|planning/.test(lower)) return "📋";
  if (/review|audit|check|grade/.test(lower)) return "🔍";
  if (/doc|write|draft|essay|paper/.test(lower)) return "📝";
  if (/study|read|lecture|homework|hw|exam|quiz|eecs|class|course/.test(lower)) return "📚";
  if (/research|investigate|explore/.test(lower)) return "🔍";
  if (/meet|sync|call|discuss/.test(lower)) return "🤝";

  // Fallback by shape
  if (shape === "spike") return "🔍";
  if (shape === "feature") return "🔨";
  if (shape === "fix") return "🐛";

  return "📌";
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

/** Get tomorrow's date as a Date object representing midnight local time */
function getTomorrowET(): Date {
  const now = new Date();
  // Format in ET to get the correct local date
  const etDateStr = now.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
  const parts = etDateStr.split("-").map(Number);
  const todayET = new Date(parts[0], parts[1] - 1, parts[2]);
  todayET.setDate(todayET.getDate() + 1);
  return todayET;
}

/** Format a Date as YYYY-MM-DD */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Get ET offset string (handles DST) for a given date */
function getETOffset(d: Date): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(d);
  const tzPart = parts.find((p) => p.type === "timeZoneName");
  if (tzPart?.value) {
    const match = tzPart.value.match(/GMT([+-]\d+)/);
    if (match) {
      const offset = parseInt(match[1], 10);
      const sign = offset >= 0 ? "+" : "-";
      const abs = Math.abs(offset);
      return `${sign}${String(abs).padStart(2, "0")}:00`;
    }
  }
  return "-05:00"; // fallback to EST
}

/** Create ISO datetime string with ET offset */
function toETIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  const d = new Date(year, month - 1, day, hour, minute, 0);
  const offset = getETOffset(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${offset}`;
}

/** Format an ISO time string to a human-readable ET time like "2:30 PM" */
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

// ─── Core Logic ───────────────────────────────────────────────────────────────

export async function runNightlyPlanner(): Promise<NightlyPlannerResult> {
  const startTime = Date.now();
  log().info("[nightly-planner] Starting nightly planning run");

  const tomorrow = getTomorrowET();
  const targetDate = formatDate(tomorrow);
  const year = tomorrow.getFullYear();
  const month = tomorrow.getMonth() + 1;
  const day = tomorrow.getDate();

  // Build time range for tomorrow in ET
  const timeMin = toETIso(year, month, day, 0, 0);
  const timeMax = toETIso(year, month, day, 23, 59);

  log().info(`[nightly-planner] Planning for ${targetDate} (${timeMin} to ${timeMax})`);

  // ── Step 1: Fetch tomorrow's calendar events (Rafe's calendar) ────────

  let tomorrowEvents: CalendarEvent[] = [];
  try {
    tomorrowEvents = await getEventsForDateRange(timeMin, timeMax);
    log().info(
      `[nightly-planner] Found ${tomorrowEvents.length} calendar events for tomorrow`,
    );
  } catch (err) {
    log().warn(`[nightly-planner] Failed to fetch calendar events: ${err}`);
  }

  // Also check both calendars for conflicts via FreeBusy
  const gcalService = new GoogleCalendarService();
  const lobsCalBusy: Array<{ start: string; end: string }> = [];
  try {
    const freeBusyResult = await gcalService.getFreeBusy(timeMin, timeMax, [
      "primary",
      "thelobsbot@gmail.com",
    ]);
    if (freeBusyResult) {
      for (const calId of Object.keys(freeBusyResult)) {
        const busy = freeBusyResult[calId]?.busy ?? [];
        lobsCalBusy.push(...busy);
      }
    }
  } catch (err) {
    log().warn(`[nightly-planner] FreeBusy check failed: ${err}`);
  }

  // ── Step 2: Get active tasks ──────────────────────────────────────────

  let taskRows: Array<{
    id: string;
    title: string;
    status: string;
    priority: string | null;
    dueDate: string | null;
    estimatedMinutes: number | null;
    shape: string | null;
    agent: string | null;
    blockedBy: unknown;
    workState: string | null;
    projectId: string | null;
    updatedAt: string;
  }> = [];

  try {
    const db = getDb();
    taskRows = db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["active", "in_progress"]))
      .all()
      .filter((t) => !t.agent) // human tasks only
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority ?? null,
        dueDate: t.dueDate ?? null,
        estimatedMinutes: t.estimatedMinutes ?? null,
        shape: t.shape ?? null,
        agent: t.agent ?? null,
        blockedBy: t.blockedBy ?? null,
        workState: t.workState ?? null,
        projectId: t.projectId ?? null,
        updatedAt: t.updatedAt,
      }));
    log().info(`[nightly-planner] Found ${taskRows.length} active human tasks`);
  } catch (err) {
    log().warn(`[nightly-planner] Failed to fetch tasks: ${err}`);
  }

  if (taskRows.length === 0) {
    log().info("[nightly-planner] No active tasks — skipping planning");
    return {
      plannedAt: new Date().toISOString(),
      targetDate,
      eventsCreated: 0,
      eventsCleared: 0,
      plannedBlocks: [],
      unscheduledTasks: [],
      tomorrowEvents: tomorrowEvents.length,
      freeMinutes: 0,
      summary: `📅 **Nightly Planner** — ${targetDate}\nNo active tasks to schedule.`,
    };
  }

  // Score and rank tasks (highest score first)
  const rankedTasks = taskRows
    .map((t) => ({
      ...t,
      score: scoreTask(t),
      estimatedMinutes: normalizeEstimate(t),
    }))
    .sort((a, b) => b.score - a.score);

  log().info(
    `[nightly-planner] Top tasks: ${rankedTasks
      .slice(0, 5)
      .map((t) => `${t.title} (${t.score})`)
      .join(", ")}`,
  );

  // ── Step 3: Calculate free slots for tomorrow ─────────────────────────

  // Busy blocks from Rafe's calendar events
  const calendarBusyBlocks: BusyBlock[] = tomorrowEvents
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({
      title: e.summary ?? "Calendar Event",
      start: new Date(e.start.dateTime!),
      end: new Date(e.end.dateTime!),
      source: "google" as const,
    }));

  // Busy blocks from FreeBusy (Lobs calendar)
  const freeBusyBlocks: BusyBlock[] = lobsCalBusy.map((b) => ({
    title: "Lobs Calendar Busy",
    start: new Date(b.start),
    end: new Date(b.end),
    source: "google" as const,
  }));

  // Fixed recurring blocks (habits, recurring commitments)
  const fixedBlocks = getFixedBusyBlocks(tomorrow);

  // Merge all busy blocks
  const allBusy = mergeBusyBlocks([
    ...calendarBusyBlocks,
    ...freeBusyBlocks,
    ...fixedBlocks,
  ]);

  log().info(`[nightly-planner] ${allBusy.length} merged busy blocks for tomorrow`);

  // Build free slots
  const freeSlots = buildFreeSlots(tomorrow, allBusy);
  const totalFreeMinutes = freeSlots.reduce((sum, s) => sum + s.minutes, 0);

  log().info(
    `[nightly-planner] ${freeSlots.length} free slots, ${totalFreeMinutes} total free minutes`,
  );

  if (freeSlots.length === 0) {
    log().info("[nightly-planner] No free slots tomorrow — skipping");
    return {
      plannedAt: new Date().toISOString(),
      targetDate,
      eventsCreated: 0,
      eventsCleared: 0,
      plannedBlocks: [],
      unscheduledTasks: rankedTasks.map((t) => ({
        taskId: t.id,
        taskTitle: t.title,
        reason: "no free slots",
      })),
      tomorrowEvents: tomorrowEvents.length,
      freeMinutes: totalFreeMinutes,
      summary: `📅 **Nightly Planner** — ${targetDate}\nNo free slots available. ${tomorrowEvents.length} events on calendar.`,
    };
  }

  // ── Step 4: Generate work plan (greedy fit, highest priority first) ───

  interface PlannedBlock {
    taskId: string;
    taskTitle: string;
    start: string;
    end: string;
    minutes: number;
    calendarEventId: string | null;
    emoji: string;
  }

  const planned: PlannedBlock[] = [];
  const scheduledTaskIds = new Set<string>();

  // Reserve breathing room: protect the largest slot if it's big enough
  const sortedBySize = [...freeSlots].sort((a, b) => b.minutes - a.minutes);
  let protectedSlotIdx: number | null = null;
  if (sortedBySize.length > 1 && sortedBySize[0].minutes >= BREATHING_ROOM_MINUTES) {
    const protectedSlot = sortedBySize[0];
    protectedSlotIdx = freeSlots.findIndex(
      (s) => s.start === protectedSlot.start && s.end === protectedSlot.end,
    );
  }

  // Track remaining capacity per slot
  const slotState = freeSlots.map((s) => ({
    ...s,
    startDate: new Date(s.start),
    usedMinutes: 0,
  }));

  for (const task of rankedTasks) {
    if (planned.length >= MAX_WORK_BLOCKS) break;

    const taskMinutes = task.estimatedMinutes;
    if (taskMinutes < MIN_SLOT_MINUTES) continue;

    let assigned = false;

    for (let i = 0; i < slotState.length; i++) {
      // Skip protected breathing room slot on first pass
      if (protectedSlotIdx !== null && i === protectedSlotIdx) continue;

      const slot = slotState[i];
      const available = slot.minutes - slot.usedMinutes;

      if (available >= taskMinutes) {
        const blockStart = new Date(
          slot.startDate.getTime() + slot.usedMinutes * 60_000,
        );
        const blockEnd = new Date(blockStart.getTime() + taskMinutes * 60_000);

        planned.push({
          taskId: task.id,
          taskTitle: task.title,
          start: toETIso(
            year,
            month,
            day,
            blockStart.getHours(),
            blockStart.getMinutes(),
          ),
          end: toETIso(
            year,
            month,
            day,
            blockEnd.getHours(),
            blockEnd.getMinutes(),
          ),
          minutes: taskMinutes,
          calendarEventId: null,
          emoji: pickEmoji(task.title, task.shape),
        });

        slot.usedMinutes += taskMinutes + SLOT_BUFFER_MINUTES;
        scheduledTaskIds.add(task.id);
        assigned = true;
        break;
      }
    }

    // If not assigned, try the protected slot as a fallback
    if (!assigned && protectedSlotIdx !== null && planned.length < MAX_WORK_BLOCKS) {
      const slot = slotState[protectedSlotIdx];
      const available = slot.minutes - slot.usedMinutes;

      if (available >= taskMinutes) {
        const blockStart = new Date(
          slot.startDate.getTime() + slot.usedMinutes * 60_000,
        );
        const blockEnd = new Date(blockStart.getTime() + taskMinutes * 60_000);

        planned.push({
          taskId: task.id,
          taskTitle: task.title,
          start: toETIso(
            year,
            month,
            day,
            blockStart.getHours(),
            blockStart.getMinutes(),
          ),
          end: toETIso(
            year,
            month,
            day,
            blockEnd.getHours(),
            blockEnd.getMinutes(),
          ),
          minutes: taskMinutes,
          calendarEventId: null,
          emoji: pickEmoji(task.title, task.shape),
        });

        slot.usedMinutes += taskMinutes + SLOT_BUFFER_MINUTES;
        scheduledTaskIds.add(task.id);
        protectedSlotIdx = null; // No longer protected
      }
    }
  }

  // Collect unscheduled tasks
  const unscheduledTasks = rankedTasks
    .filter((t) => !scheduledTaskIds.has(t.id))
    .map((t) => {
      const taskMin = t.estimatedMinutes;
      const maxAvailable = Math.max(
        ...slotState.map((s) => s.minutes - s.usedMinutes),
        0,
      );
      let reason = "no free slots";
      if (planned.length >= MAX_WORK_BLOCKS) {
        reason = `max ${MAX_WORK_BLOCKS} blocks per day reached`;
      } else if (taskMin > maxAvailable) {
        reason = `task needs ${taskMin}min but largest available slot is ${maxAvailable}min`;
      }
      return { taskId: t.id, taskTitle: t.title, reason };
    });

  log().info(
    `[nightly-planner] Planned ${planned.length} blocks, ${unscheduledTasks.length} unscheduled`,
  );

  // ── Step 5: Clear old planning events from Lobs calendar ──────────────

  let eventsCleared = 0;
  try {
    const existingLobsEvents = await gcalService.listEvents(null, timeMin, timeMax);
    const plannerEvents = existingLobsEvents.filter((e) =>
      e.description?.includes(PLANNER_TAG),
    );

    for (const evt of plannerEvents) {
      const deleted = await gcalService.deleteEvent(null, evt.id);
      if (deleted) eventsCleared++;
    }

    if (eventsCleared > 0) {
      log().info(`[nightly-planner] Cleared ${eventsCleared} old planning events`);
    }
  } catch (err) {
    log().warn(`[nightly-planner] Failed to clear old events: ${err}`);
  }

  // ── Step 6: Write new events to Lobs calendar ────────────────────────

  let eventsCreated = 0;
  for (const block of planned) {
    try {
      const task = rankedTasks.find((t) => t.id === block.taskId);
      const description = [
        PLANNER_TAG,
        `Task: ${block.taskTitle}`,
        `Task ID: ${block.taskId}`,
        `Duration: ${block.minutes}min`,
        `Priority: ${task?.priority ?? "normal"}`,
        task?.dueDate ? `Due: ${task.dueDate}` : null,
        task?.projectId ? `Project: ${task.projectId}` : null,
        "",
        "Auto-generated by Lobs Nightly Planner",
      ]
        .filter(Boolean)
        .join("\n");

      const eventId = await gcalService.createEvent(null, {
        title: `${block.emoji} ${block.taskTitle}`,
        startAt: block.start,
        endAt: block.end,
        description,
      });

      if (eventId) {
        block.calendarEventId = eventId;
        eventsCreated++;
        log().info(
          `[nightly-planner] Created: ${block.emoji} ${block.taskTitle} (${block.start} → ${block.end})`,
        );
      }
    } catch (err) {
      log().warn(
        `[nightly-planner] Failed to create event for ${block.taskTitle}: ${err}`,
      );
    }
  }

  // ── Step 7: Build result ──────────────────────────────────────────────

  const elapsed = Date.now() - startTime;
  log().info(
    `[nightly-planner] Completed in ${elapsed}ms — ${eventsCreated} events created`,
  );

  // Discord-friendly summary
  const summaryLines: string[] = [
    `📅 **Nightly Planner** — ${targetDate}`,
    "",
  ];

  if (planned.length > 0) {
    summaryLines.push(`**${planned.length} work blocks scheduled:**`);
    for (const block of planned) {
      summaryLines.push(
        `• ${block.emoji} **${block.taskTitle}** — ${formatTimeET(block.start)} → ${formatTimeET(block.end)} (${block.minutes}min)`,
      );
    }
  }

  if (unscheduledTasks.length > 0) {
    summaryLines.push("");
    summaryLines.push(
      `**${unscheduledTasks.length} tasks couldn't be scheduled:**`,
    );
    for (const t of unscheduledTasks.slice(0, 5)) {
      summaryLines.push(`• ${t.taskTitle} — ${t.reason}`);
    }
    if (unscheduledTasks.length > 5) {
      summaryLines.push(`• ...and ${unscheduledTasks.length - 5} more`);
    }
  }

  summaryLines.push("");
  summaryLines.push(
    `📊 ${tomorrowEvents.length} calendar events | ${totalFreeMinutes}min free | ${eventsCleared} old plans cleared`,
  );

  const summary = summaryLines.join("\n");

  return {
    plannedAt: new Date().toISOString(),
    targetDate,
    eventsCreated,
    eventsCleared,
    plannedBlocks: planned.map((b) => ({
      taskId: b.taskId,
      taskTitle: b.taskTitle,
      start: b.start,
      end: b.end,
      minutes: b.minutes,
      calendarEventId: b.calendarEventId,
    })),
    unscheduledTasks,
    tomorrowEvents: tomorrowEvents.length,
    freeMinutes: totalFreeMinutes,
    summary,
  };
}
