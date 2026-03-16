/**
 * Google Calendar Sync Service
 *
 * Reads from Google Calendar API using the OAuth2 token stored at
 * ~/.openclaw/credentials/google_token.json.
 *
 * - No googleapis npm package needed — pure fetch with OAuth2 token refresh
 * - 5-minute event cache to avoid rate limits
 * - Exposes getTodayEvents(), getUpcomingEvents(hours), getEventDetails(eventId)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../util/logger.js";

// ─── Token management ───────────────────────────────────────────────────────

const HOME = process.env.HOME ?? "";
const TOKEN_PATH = resolve(HOME, ".openclaw/credentials/google_token.json");
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

interface GoogleToken {
  token: string;            // access token (field name in the file)
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes?: string[];
  expiry_date?: number;     // ms since epoch — may be absent in file
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;        // ms since epoch
  raw: GoogleToken;
}

let _tokenCache: TokenCache | null = null;

/**
 * Load + refresh the OAuth2 token as needed.
 * Token file field is `token` (not `access_token`).
 */
async function getAccessToken(): Promise<string> {
  const now = Date.now();

  // Use cached token if still valid (>60s remaining)
  if (_tokenCache && _tokenCache.expiresAt - now > 60_000) {
    return _tokenCache.accessToken;
  }

  // Read token file
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(`Google token file not found: ${TOKEN_PATH}`);
  }

  const raw = JSON.parse(readFileSync(TOKEN_PATH, "utf-8")) as GoogleToken;

  // If we have a cached token in memory that's still valid, use it
  if (_tokenCache && _tokenCache.expiresAt - now > 60_000) {
    return _tokenCache.accessToken;
  }

  // Refresh the token
  const refreshed = await refreshAccessToken(raw);

  // Cache it (token lasts 1 hour, cache for 55 minutes)
  _tokenCache = {
    accessToken: refreshed.access_token,
    expiresAt: now + 55 * 60 * 1000,
    raw: { ...raw, token: refreshed.access_token },
  };

  // Persist the new access token to disk so external tools see it
  try {
    const updated: GoogleToken = { ...raw, token: refreshed.access_token };
    if (refreshed.refresh_token) updated.refresh_token = refreshed.refresh_token;
    writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2));
  } catch {
    // Non-fatal — in-memory cache still works
  }

  return refreshed.access_token;
}

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  error?: string;
  error_description?: string;
}

async function refreshAccessToken(token: GoogleToken): Promise<RefreshResponse> {
  const body = new URLSearchParams({
    client_id: token.client_id,
    client_secret: token.client_secret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token",
  });

  const res = await fetch(token.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json() as RefreshResponse;

  if (!res.ok || data.error) {
    throw new Error(
      `Token refresh failed (${res.status}): ${data.error_description ?? data.error ?? "unknown"}`
    );
  }

  return data;
}

// ─── Calendar API types ──────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
  }>;
  organizer?: {
    email: string;
    displayName?: string;
    self?: boolean;
  };
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  recurringEventId?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType: string; uri: string }>;
  };
}

interface EventListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  error?: { message: string; code: number };
}

// ─── Event cache ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface EventsCache {
  key: string;
  events: CalendarEvent[];
  fetchedAt: number;
}

const _cache = new Map<string, EventsCache>();

function getCached(key: string): CalendarEvent[] | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.events;
}

function setCache(key: string, events: CalendarEvent[]): void {
  _cache.set(key, { key, events, fetchedAt: Date.now() });
}

/**
 * Invalidate all cached events (useful after writes).
 */
export function invalidateCalendarCache(): void {
  _cache.clear();
}

// ─── Core fetch helper ────────────────────────────────────────────────────────

async function fetchEvents(params: Record<string, string>): Promise<CalendarEvent[]> {
  const accessToken = await getAccessToken();
  const url = new URL(`${CALENDAR_BASE}/calendars/primary/events`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Calendar API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json() as EventListResponse;

    if (data.error) {
      throw new Error(`Calendar API error ${data.error.code}: ${data.error.message}`);
    }

    return data.items ?? [];
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all events for today (midnight to midnight in local time).
 * Results are cached for 5 minutes.
 */
export async function getTodayEvents(): Promise<CalendarEvent[]> {
  const today = new Date();
  const startOfDay = new Date(today);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today);
  endOfDay.setHours(23, 59, 59, 999);

  const cacheKey = `today:${startOfDay.toISOString().slice(0, 10)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const events = await fetchEvents({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });

    setCache(cacheKey, events);
    log().info(`[google-calendar] Fetched ${events.length} events for today`);
    return events;
  } catch (err) {
    log().warn(`[google-calendar] getTodayEvents failed: ${err}`);
    return [];
  }
}

/**
 * Get events in the next N hours from now.
 * Results are cached for 5 minutes.
 */
export async function getUpcomingEvents(hours: number = 2): Promise<CalendarEvent[]> {
  const now = new Date();
  const future = new Date(now.getTime() + hours * 60 * 60 * 1000);

  const cacheKey = `upcoming:${hours}h:${Math.floor(now.getTime() / CACHE_TTL_MS)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const events = await fetchEvents({
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "20",
    });

    setCache(cacheKey, events);
    log().info(`[google-calendar] Fetched ${events.length} events for next ${hours}h`);
    return events;
  } catch (err) {
    log().warn(`[google-calendar] getUpcomingEvents(${hours}) failed: ${err}`);
    return [];
  }
}

/**
 * Get full details for a specific event by ID.
 * Not cached (details rarely needed repeatedly).
 */
export async function getEventDetails(eventId: string): Promise<CalendarEvent | null> {
  const accessToken = await getAccessToken();
  const url = `${CALENDAR_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status === 404) return null;
      const text = await res.text();
      throw new Error(`Calendar API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const event = await res.json() as CalendarEvent;
    log().info(`[google-calendar] Fetched event details: ${event.summary}`);
    return event;
  } catch (err) {
    log().warn(`[google-calendar] getEventDetails(${eventId}) failed: ${err}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get a sortable ISO start time from a calendar event.
 * All-day events use date string (e.g. "2026-03-16"), timed events use dateTime.
 */
export function getEventStartTime(event: CalendarEvent): string {
  return event.start.dateTime ?? event.start.date ?? "";
}

/**
 * Get a sortable ISO end time from a calendar event.
 */
export function getEventEndTime(event: CalendarEvent): string {
  return event.end.dateTime ?? event.end.date ?? "";
}

/**
 * Check if an event is an all-day event.
 */
export function isAllDayEvent(event: CalendarEvent): boolean {
  return Boolean(event.start.date && !event.start.dateTime);
}

/**
 * Format an event into a compact string suitable for LLM context.
 */
export function formatEventForContext(event: CalendarEvent): string {
  const start = getEventStartTime(event);
  const end = getEventEndTime(event);
  const timeStr = isAllDayEvent(event)
    ? `(all day ${start})`
    : `(${start.slice(11, 16)} – ${end.slice(11, 16)})`;

  const parts = [`${event.summary} ${timeStr}`];

  if (event.location) parts.push(`📍 ${event.location}`);
  if (event.description) parts.push(`📝 ${event.description.slice(0, 150)}`);

  const attendees = (event.attendees ?? [])
    .filter(a => !a.self)
    .map(a => a.displayName ?? a.email)
    .slice(0, 5);
  if (attendees.length > 0) parts.push(`👥 ${attendees.join(", ")}`);

  const meetLink = event.conferenceData?.entryPoints
    ?.find(e => e.entryPointType === "video")?.uri;
  if (meetLink) parts.push(`🎥 ${meetLink}`);

  return parts.join(" | ");
}

/**
 * Check if google token file is available.
 */
export function isGoogleCalendarAvailable(): boolean {
  return existsSync(TOKEN_PATH);
}
