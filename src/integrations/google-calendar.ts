/**
 * Google Calendar Integration — native googleapis implementation
 * Replaces the Python bridge with direct API calls.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { google } from "googleapis";
import { getDb } from "../db/connection.js";
import { scheduledEvents } from "../db/schema.js";
import { log } from "../util/logger.js";

const LOBS_SERVER_DIR = process.env.LOBS_SERVER_DIR ?? `${process.env.HOME}/lobs-server`;
const CREDENTIALS_FILE = process.env.GOOGLE_CALENDAR_CREDENTIALS_FILE
  ?? join(LOBS_SERVER_DIR, "credentials/google_calendar.json");
const TOKEN_FILE = process.env.GOOGLE_CALENDAR_TOKEN_FILE
  ?? join(LOBS_SERVER_DIR, "credentials/google_calendar_token.json");

const RAFE_CALENDAR_ID = process.env.RAFE_CALENDAR_ID ?? "primary";
let LOBS_CALENDAR_ID: string | null = process.env.LOBS_CALENDAR_ID ?? null;

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
  isConfigured(): boolean {
    return existsSync(TOKEN_FILE) || existsSync(CREDENTIALS_FILE);
  }

  private async _getAuth() {
    if (!existsSync(TOKEN_FILE)) throw new Error("No token file at " + TOKEN_FILE);
    if (!existsSync(CREDENTIALS_FILE)) throw new Error("No credentials file at " + CREDENTIALS_FILE);

    const creds = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
    const installed = creds.installed ?? creds.web;
    const oAuth2Client = new google.auth.OAuth2(
      installed.client_id,
      installed.client_secret,
      installed.redirect_uris[0],
    );

    const token = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    oAuth2Client.setCredentials({
      access_token: token.token ?? token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type ?? "Bearer",
      expiry_date: token.expiry ? new Date(token.expiry).getTime() : undefined,
    });

    oAuth2Client.on("tokens", (newTokens) => {
      const existing = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
      const merged = {
        ...existing,
        token: newTokens.access_token,
        access_token: newTokens.access_token,
        expiry: newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : existing.expiry,
      };
      writeFileSync(TOKEN_FILE, JSON.stringify(merged, null, 2));
      log().info("[GCAL] Token refreshed and saved");
    });

    return oAuth2Client;
  }

  async _discoverLobsCalendar(auth: any): Promise<string> {
    if (LOBS_CALENDAR_ID) return LOBS_CALENDAR_ID;
    const cal = google.calendar({ version: "v3", auth });
    const res = await cal.calendarList.list();
    const calendars = res.data.items ?? [];
    log().info(`[GCAL] Available calendars: ${calendars.map((c: any) => c.summary + " (" + c.id + ")").join(", ")}`);

    const lobs = calendars.find((c: any) =>
      c.summary?.toLowerCase().includes("lobs") ||
      c.id?.toLowerCase().includes("lobs")
    );
    if (lobs?.id) {
      LOBS_CALENDAR_ID = lobs.id;
      log().info(`[GCAL] Using Lobs calendar: ${lobs.summary} (${lobs.id})`);
      return lobs.id;
    }

    log().warn("[GCAL] Could not find a Lobs calendar; falling back to primary for writes");
    LOBS_CALENDAR_ID = "primary";
    return "primary";
  }

  async fetchUpcoming(days = 7): Promise<CalendarEvent[]> {
    if (!this.isConfigured()) {
      log().warn("[GCAL] Not configured — missing credentials");
      return [];
    }
    try {
      const auth = await this._getAuth();
      const cal = google.calendar({ version: "v3", auth });
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + days * 86400_000).toISOString();

      const res = await cal.events.list({
        calendarId: RAFE_CALENDAR_ID,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
      });

      return (res.data.items ?? []).map((e: any) => this._mapEvent(e));
    } catch (err) {
      log().warn(`[GCAL] fetchUpcoming failed: ${String(err)}`);
      return [];
    }
  }

  async createEvent(calendarId: string | null, event: Partial<CalendarEvent> & { title: string; startAt: string }): Promise<string | null> {
    try {
      const auth = await this._getAuth();
      const targetCal = calendarId ?? await this._discoverLobsCalendar(auth);
      const cal = google.calendar({ version: "v3", auth });
      const res = await cal.events.insert({
        calendarId: targetCal,
        requestBody: {
          summary: event.title,
          description: event.description,
          start: event.allDay
            ? { date: event.startAt.split("T")[0] }
            : { dateTime: event.startAt },
          end: event.endAt
            ? (event.allDay ? { date: event.endAt.split("T")[0] } : { dateTime: event.endAt })
            : undefined,
        },
      });
      return res.data.id ?? null;
    } catch (err) {
      log().warn(`[GCAL] createEvent failed: ${String(err)}`);
      return null;
    }
  }

  async getFreeBusy(timeMin: string, timeMax: string, calendarIds?: string[]): Promise<Record<string, { busy: { start: string; end: string }[] }>> {
    try {
      const auth = await this._getAuth();
      const cal = google.calendar({ version: "v3", auth });
      const ids = calendarIds ?? [RAFE_CALENDAR_ID];
      const res = await cal.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          items: ids.map(id => ({ id })),
        },
      });
      const result: Record<string, { busy: { start: string; end: string }[] }> = {};
      for (const [id, info] of Object.entries(res.data.calendars ?? {})) {
        result[id] = { busy: ((info as any).busy ?? []).map((b: any) => ({ start: b.start!, end: b.end! })) };
      }
      return result;
    } catch (err) {
      log().warn(`[GCAL] getFreeBusy failed: ${String(err)}`);
      return {};
    }
  }

  async syncToDb(daysAhead = 14): Promise<{ created: number; updated: number; errors: number }> {
    const events = await this.fetchUpcoming(daysAhead);
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

  private _mapEvent(e: any): CalendarEvent {
    const allDay = Boolean(e.start?.date && !e.start?.dateTime);
    return {
      id: e.id,
      title: e.summary ?? "(no title)",
      description: e.description ?? undefined,
      startAt: e.start?.dateTime ?? e.start?.date ?? "",
      endAt: e.end?.dateTime ?? e.end?.date ?? undefined,
      allDay,
      recurrenceRule: e.recurrence?.[0] ?? undefined,
      externalId: `gcal:${e.id}`,
      externalSource: "google_calendar",
    };
  }
}
