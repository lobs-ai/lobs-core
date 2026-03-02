/**
 * Google Calendar Integration
 * Port of lobs-server/app/services/google_calendar.py
 * Syncs events to scheduled_events table.
 * Uses child_process to call python helper or googleapis if available.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { scheduledEvents } from "../db/schema.js";
import { log } from "../util/logger.js";

const LOBS_SERVER_DIR = process.env.LOBS_SERVER_DIR ?? `${process.env.HOME}/lobs-server`;
const CREDENTIALS_FILE = process.env.GOOGLE_CALENDAR_CREDENTIALS_FILE
  ?? join(LOBS_SERVER_DIR, "credentials/google_calendar.json");
const TOKEN_FILE = process.env.GOOGLE_CALENDAR_TOKEN_FILE
  ?? join(LOBS_SERVER_DIR, "credentials/google_calendar_token.json");
const RAFE_CALENDAR_ID = process.env.RAFE_CALENDAR_ID ?? "";

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startAt: string;
  endAt?: string;
  allDay: boolean;
  recurrenceRule?: string;
  externalId: string;
  externalSource: "google_calendar";
}

export class GoogleCalendarService {
  /**
   * Check if credentials are available.
   */
  isConfigured(): boolean {
    return existsSync(TOKEN_FILE) || existsSync(CREDENTIALS_FILE);
  }

  /**
   * Fetch upcoming events from Google Calendar via Python bridge.
   * Falls back to reading a cached JSON file if Python is unavailable.
   */
  fetchUpcoming(days = 7): CalendarEvent[] {
    if (!this.isConfigured()) {
      log().warn("[GCAL] Not configured — missing credentials");
      return [];
    }

    try {
      // Use the Python helper from lobs-server if available
      const pyScript = join(LOBS_SERVER_DIR, "bin/fetch_calendar_events.py");
      if (existsSync(pyScript)) {
        const result = spawnSync("python3", [pyScript, "--days", String(days), "--json"], {
          encoding: "utf8", timeout: 30_000,
        });
        if (result.status === 0 && result.stdout) {
          const events = JSON.parse(result.stdout) as CalendarEvent[];
          return events;
        }
      }

      // Try inline google-auth via node if googleapis is installed
      return this._fetchViaNodeGoogleapis(days);
    } catch (e) {
      log().warn(`[GCAL] fetchUpcoming failed: ${String(e)}`);
      return [];
    }
  }

  /**
   * Sync calendar events to the scheduled_events table.
   */
  syncToDb(daysAhead = 14): { created: number; updated: number; errors: number } {
    const events = this.fetchUpcoming(daysAhead);
    const db = getDb();
    let created = 0, updated = 0, errors = 0;

    for (const evt of events) {
      try {
        const existing = db.select().from(scheduledEvents)
          .where(eq(scheduledEvents.externalId, evt.externalId))
          .get();
        const now = new Date().toISOString();

        if (existing) {
          db.update(scheduledEvents).set({
            title: evt.title,
            description: evt.description ?? null,
            scheduledAt: evt.startAt,
            endAt: evt.endAt ?? null,
            allDay: evt.allDay,
            updatedAt: now,
          }).where(eq(scheduledEvents.externalId, evt.externalId)).run();
          updated++;
        } else {
          db.insert(scheduledEvents).values({
            id: randomUUID(),
            title: evt.title,
            description: evt.description ?? null,
            eventType: "calendar",
            scheduledAt: evt.startAt,
            endAt: evt.endAt ?? null,
            allDay: evt.allDay,
            targetType: "user",
            status: "pending",
            externalId: evt.externalId,
            externalSource: "google_calendar",
            createdAt: now,
            updatedAt: now,
          }).run();
          created++;
        }
      } catch (e) {
        log().warn(`[GCAL] Failed to sync event ${evt.externalId}: ${String(e)}`);
        errors++;
      }
    }

    log().info(`[GCAL] Sync done: created=${created} updated=${updated} errors=${errors}`);
    return { created, updated, errors };
  }

  /**
   * Get upcoming events from DB within the next N hours.
   */
  getUpcomingFromDb(withinHours = 24): typeof scheduledEvents.$inferSelect[] {
    const db = getDb();
    const now = new Date().toISOString();
    const until = new Date(Date.now() + withinHours * 3600 * 1000).toISOString();
    return db.select().from(scheduledEvents)
      .where(eq(scheduledEvents.externalSource, "google_calendar"))
      .all()
      .filter(e => e.scheduledAt >= now && e.scheduledAt <= until)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  private _fetchViaNodeGoogleapis(_days: number): CalendarEvent[] {
    // If googleapis npm package is available, use it
    // Otherwise return empty (token refresh requires interactive auth)
    try {
      // Check if token file exists and is readable
      if (!existsSync(TOKEN_FILE)) return [];
      const token = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
      // Token present but googleapis not bundled — log and skip
      log().info("[GCAL] Token available but googleapis not bundled. Run python3 bridge.");
    } catch (_) {}
    return [];
  }
}
