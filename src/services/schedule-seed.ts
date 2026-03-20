/**
 * Schedule Seed — Inserts Rafe's recurring weekly schedule into scheduledEvents.
 *
 * These blocks are used by scheduler-intelligence.ts to mark unavailable time.
 * Run ensureScheduleSeeded() at startup — it is fully idempotent.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { scheduledEvents } from "../db/schema.js";
import { log } from "../util/logger.js";

/**
 * Recurring block definition (America/New_York local time).
 * We store a fixed reference date (2000-01-03, a Monday) in UTC equivalent
 * so that consumers can extract HH:MM and apply to any target date.
 *
 * recurrenceRule: "WEEKLY:<dayOfWeek>" where 0=Sunday … 6=Saturday
 * All times are in America/New_York (EST = UTC-5 / EDT = UTC-4).
 * We store the UTC equivalent using EST offset (-05:00) so the stored ISO
 * string always reflects the intended local clock time.
 */

interface RecurringBlockDef {
  title: string;
  dayOfWeek: number; // 0 = Sunday
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

const RECURRING_BLOCKS: RecurringBlockDef[] = [
  // Monday (1)
  { title: "EECS 545",      dayOfWeek: 1, startHour: 9,  startMinute: 0,  endHour: 10, endMinute: 30 },
  { title: "EECS 491",      dayOfWeek: 1, startHour: 12, startMinute: 0,  endHour: 13, endMinute: 30 },
  { title: "CSE 590",       dayOfWeek: 1, startHour: 13, startMinute: 30, endHour: 15, endMinute: 0  },
  { title: "Flock Meeting", dayOfWeek: 1, startHour: 20, startMinute: 0,  endHour: 21, endMinute: 0  },
  // Tuesday (2)
  { title: "Office Hours",      dayOfWeek: 2, startHour: 8,  startMinute: 30, endHour: 10, endMinute: 30 },
  { title: "EECS 281 Lecture",  dayOfWeek: 2, startHour: 10, startMinute: 30, endHour: 12, endMinute: 0  },
  // Wednesday (3)
  { title: "EECS 545",    dayOfWeek: 3, startHour: 9,  startMinute: 0,  endHour: 10, endMinute: 30 },
  { title: "EECS 491",    dayOfWeek: 3, startHour: 12, startMinute: 0,  endHour: 13, endMinute: 30 },
  { title: "CSE 590",     dayOfWeek: 3, startHour: 13, startMinute: 30, endHour: 15, endMinute: 0  },
  // Thursday (4)
  { title: "Office Hours",      dayOfWeek: 4, startHour: 8,  startMinute: 30, endHour: 10, endMinute: 30 },
  { title: "EECS 281 Lecture",  dayOfWeek: 4, startHour: 10, startMinute: 30, endHour: 12, endMinute: 0  },
  // Friday (5)
  { title: "Staff Meeting",         dayOfWeek: 5, startHour: 8,  startMinute: 30, endHour: 9,  endMinute: 30 },
  { title: "EECS 491 Discussion",   dayOfWeek: 5, startHour: 9,  startMinute: 30, endHour: 10, endMinute: 30 },
  { title: "EECS 291 Lab",          dayOfWeek: 5, startHour: 10, startMinute: 30, endHour: 12, endMinute: 30 },
];

/**
 * Build a stable reference-date ISO string for a given day-of-week and local time.
 *
 * We use the week of 2000-01-03 (Monday) as a stable anchor:
 *   2000-01-03 = Monday  (dayOfWeek 1)
 *   2000-01-04 = Tuesday (dayOfWeek 2)
 *   …
 *   2000-01-02 = Sunday  (dayOfWeek 0)
 *
 * Times are stored as America/New_York (EST, UTC-5).
 * Consumer code reads back startHour/startMinute via Date methods and maps
 * them to today's date — it does NOT use the date portion.
 */
function buildReferenceIso(dayOfWeek: number, hour: number, minute: number): string {
  // Monday 2000-01-03 is our anchor for dayOfWeek=1
  // Sunday is 2000-01-02 (one day before)
  const mondayDate = 3; // January 3 2000
  const dayOffset = dayOfWeek === 0 ? -1 : dayOfWeek - 1;
  const day = mondayDate + dayOffset;

  // Pad to 2 digits
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const dd = String(day).padStart(2, "0");

  // Store with EST offset (-05:00) — this is a fixed reference, not wall-clock UTC
  return `2000-01-${dd}T${hh}:${mm}:00-05:00`;
}

/**
 * Seed Rafe's recurring weekly schedule into scheduledEvents.
 * Idempotent: checks for existing rows with externalSource = 'fixed_schedule'
 * before inserting. If already present, skips silently.
 */
export async function ensureScheduleSeeded(): Promise<void> {
  try {
    const db = getDb();

    // Check if already seeded
    const existing = db
      .select({ id: scheduledEvents.id })
      .from(scheduledEvents)
      .where(eq(scheduledEvents.externalSource, "fixed_schedule"))
      .all();

    if (existing.length > 0) {
      log().debug?.(`[schedule-seed] Already seeded (${existing.length} blocks present), skipping.`);
      return;
    }

    log().info("[schedule-seed] Seeding recurring schedule blocks...");

    const rows = RECURRING_BLOCKS.map(block => ({
      id: crypto.randomUUID(),
      title: block.title,
      description: `Recurring weekly block — ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][block.dayOfWeek]}`,
      eventType: "recurring_block",
      scheduledAt: buildReferenceIso(block.dayOfWeek, block.startHour, block.startMinute),
      endAt: buildReferenceIso(block.dayOfWeek, block.endHour, block.endMinute),
      allDay: false,
      recurrenceRule: `WEEKLY:${block.dayOfWeek}`,
      recurrenceEnd: null,
      targetType: "busy",
      targetAgent: null,
      taskProjectId: null,
      taskNotes: null,
      taskPriority: null,
      status: "pending",
      lastFiredAt: null,
      nextFireAt: null,
      fireCount: 0,
      externalId: `fixed_schedule_${block.dayOfWeek}_${block.startHour}_${block.startMinute}`,
      externalSource: "fixed_schedule",
    }));

    db.insert(scheduledEvents).values(rows).run();

    log().info(`[schedule-seed] Seeded ${rows.length} recurring schedule blocks.`);
  } catch (err) {
    log().warn(`[schedule-seed] Error seeding schedule: ${err}`);
  }
}
