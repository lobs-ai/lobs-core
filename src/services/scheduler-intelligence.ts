import { and, asc, desc, inArray, lte, gte } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, scheduledEvents } from "../db/schema.js";
import {
  getLocalConfig,
  getModelConfig,
  getModelForTier,
  saveModelConfig,
  type ModelConfig,
} from "../config/models.js";
import { getTodayEvents, isGoogleCalendarAvailable, type CalendarEvent } from "./google-calendar.js";
import { isLocalModelAvailable } from "../runner/local-classifier.js";
import { log } from "../util/logger.js";

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 23;
const MIN_SLOT_MINUTES = 30;
const SLOT_BUFFER_MINUTES = 10;

const FIXED_BLOCKS = [
  { days: [1, 3, 5], startHour: 10, startMinute: 0, endHour: 11, endMinute: 30, label: "Class" },
  { days: [2, 4], startHour: 14, startMinute: 0, endHour: 15, endMinute: 30, label: "Class" },
  { days: [2], startHour: 17, startMinute: 0, endHour: 19, endMinute: 0, label: "GSI Office Hours" },
  { days: [4], startHour: 16, startMinute: 0, endHour: 18, endMinute: 0, label: "Esports" },
  { days: [5], startHour: 20, startMinute: 0, endHour: 22, endMinute: 0, label: "Esports Match Window" },
];

export interface SchedulerModelSettings {
  enabled: boolean;
  localOnly: boolean;
  tier: "micro" | "small" | "medium" | "standard" | "strong";
  overrideModel: string | null;
  temperature: number;
  maxTokens: number;
}

export interface PlannerSlot {
  start: string;
  end: string;
  minutes: number;
  source: "free";
}

export interface PlannerTask {
  id: string;
  title: string;
  priority: string | null;
  dueDate: string | null;
  estimatedMinutes: number;
  score: number;
  status: string;
  workState: string | null;
  projectId: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
}

export interface PlannerSuggestion {
  taskId: string;
  title: string;
  start: string;
  end: string;
  minutes: number;
  score: number;
  reason: string;
}

export interface PlannerConflict {
  type: "deadline" | "calendar_overlap" | "capacity" | "blocked";
  severity: "low" | "medium" | "high";
  title: string;
  description: string;
}

export interface SchedulerIntelligenceSnapshot {
  generatedAt: string;
  date: string;
  model: {
    enabled: boolean;
    available: boolean;
    localOnly: boolean;
    tier: string;
    selectedModel: string;
    source: "local" | "tier" | "override";
  };
  calendar: {
    available: boolean;
    events: Array<{ id: string; title: string; start: string; end: string; location?: string; source: "google" | "db" }>;
    fixedBlocks: Array<{ title: string; start: string; end: string }>;
    freeSlots: PlannerSlot[];
  };
  tasks: {
    ranked: PlannerTask[];
    scheduledCount: number;
    blockedCount: number;
    overdueCount: number;
  };
  suggestions: PlannerSuggestion[];
  conflicts: PlannerConflict[];
  briefing: {
    headline: string;
    summary: string;
    topActions: string[];
  };
}

interface BusyBlock {
  title: string;
  start: Date;
  end: Date;
  source: "google" | "db" | "fixed";
  location?: string;
}

function getDefaultSchedulerModelSettings(): SchedulerModelSettings {
  return {
    enabled: true,
    localOnly: true,
    tier: "micro",
    overrideModel: null,
    temperature: 0.2,
    maxTokens: 900,
  };
}

export function getSchedulerModelSettings(): SchedulerModelSettings {
  const cfg = getModelConfig() as ModelConfig & { scheduler?: Partial<SchedulerModelSettings> };
  return { ...getDefaultSchedulerModelSettings(), ...(cfg.scheduler ?? {}) };
}

export function updateSchedulerModelSettings(
  updates: Partial<SchedulerModelSettings>,
): SchedulerModelSettings {
  const cfg = getModelConfig() as ModelConfig & { scheduler?: Partial<SchedulerModelSettings> };
  const next = {
    ...cfg,
    scheduler: {
      ...getDefaultSchedulerModelSettings(),
      ...(cfg.scheduler ?? {}),
      ...updates,
    },
  } as ModelConfig & { scheduler: SchedulerModelSettings };

  saveModelConfig(next);
  return next.scheduler;
}

function startOfLocalDay(base = new Date()): Date {
  const day = new Date(base);
  day.setHours(0, 0, 0, 0);
  return day;
}

function endOfLocalDay(base = new Date()): Date {
  const day = new Date(base);
  day.setHours(23, 59, 59, 999);
  return day;
}

function dateAt(base: Date, hour: number, minute: number): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function clampToWindow(start: Date, end: Date): { start: Date; end: Date } | null {
  const dayStart = dateAt(start, DAY_START_HOUR, 0);
  const dayEnd = dateAt(start, DAY_END_HOUR, 0);
  const clampedStart = start > dayStart ? start : dayStart;
  const clampedEnd = end < dayEnd ? end : dayEnd;
  if (clampedEnd <= clampedStart) return null;
  return { start: clampedStart, end: clampedEnd };
}

function durationMinutes(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function normalizeEstimate(task: {
  estimatedMinutes: number | null;
  shape: string | null;
  title: string;
}): number {
  if (task.estimatedMinutes && task.estimatedMinutes > 0) {
    return Math.min(task.estimatedMinutes, 180);
  }
  const title = task.title.toLowerCase();
  if (task.shape === "spike" || /research|investigate|explore/.test(title)) return 60;
  if (task.shape === "feature" || /build|implement|create/.test(title)) return 90;
  if (task.shape === "fix" || /fix|bug|patch/.test(title)) return 45;
  if (task.shape === "review" || /review|audit|check/.test(title)) return 30;
  if (task.shape === "write" || /doc|write|draft/.test(title)) return 60;
  return 45;
}

function scoreTask(task: {
  priority: string | null;
  dueDate: string | null;
  updatedAt: string;
  workState: string | null;
  blockedBy: unknown;
}): number {
  const priorityWeight =
    task.priority === "urgent" ? 1000 :
    task.priority === "high" ? 500 :
    task.priority === "medium" ? 200 :
    50;

  let score = priorityWeight;
  const now = Date.now();

  if (task.dueDate) {
    const due = new Date(task.dueDate).getTime();
    const days = Math.floor((due - now) / 86400_000);
    if (days < 0) score += 1000;
    else if (days === 0) score += 800;
    else if (days === 1) score += 400;
    else if (days <= 3) score += 200;
    else if (days <= 7) score += 100;
  }

  const updated = new Date(task.updatedAt).getTime();
  if (task.workState === "in_progress" && now - updated > 3 * 86400_000) {
    score -= 50;
  }

  const blocked = Array.isArray(task.blockedBy) ? task.blockedBy.length > 0 : Boolean(task.blockedBy);
  if (blocked) score -= 1000;
  return score;
}

function toBusyBlockFromGoogle(event: CalendarEvent): BusyBlock | null {
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

function toBusyBlockFromDb(event: typeof scheduledEvents.$inferSelect): BusyBlock | null {
  const start = new Date(event.scheduledAt);
  const end = new Date(event.endAt ?? new Date(start.getTime() + 30 * 60000).toISOString());
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const clamped = clampToWindow(start, end);
  if (!clamped) return null;
  return {
    title: event.title,
    start: clamped.start,
    end: clamped.end,
    source: "db",
  };
}

function getFixedBusyBlocks(baseDate: Date): BusyBlock[] {
  const dayOfWeek = baseDate.getDay();
  return FIXED_BLOCKS
    .filter(block => block.days.includes(dayOfWeek))
    .map(block => ({
      title: block.label,
      start: dateAt(baseDate, block.startHour, block.startMinute),
      end: dateAt(baseDate, block.endHour, block.endMinute),
      source: "fixed" as const,
    }));
}

function mergeBusyBlocks(blocks: BusyBlock[]): BusyBlock[] {
  const sorted = [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: BusyBlock[] = [];
  for (const block of sorted) {
    const last = merged[merged.length - 1];
    if (!last || block.start.getTime() > last.end.getTime()) {
      merged.push({ ...block });
      continue;
    }
    if (block.end.getTime() > last.end.getTime()) {
      last.end = new Date(block.end);
    }
    last.title = last.title === block.title ? last.title : `${last.title} + ${block.title}`;
  }
  return merged;
}

function buildFreeSlots(baseDate: Date, busyBlocks: BusyBlock[]): PlannerSlot[] {
  const dayStart = dateAt(baseDate, DAY_START_HOUR, 0);
  const dayEnd = dateAt(baseDate, DAY_END_HOUR, 0);
  const merged = mergeBusyBlocks(busyBlocks);
  const slots: PlannerSlot[] = [];
  let cursor = dayStart;

  for (const busy of merged) {
    const candidateEnd = new Date(busy.start.getTime() - SLOT_BUFFER_MINUTES * 60000);
    if (candidateEnd > cursor) {
      const minutes = durationMinutes(cursor, candidateEnd);
      if (minutes >= MIN_SLOT_MINUTES) {
        slots.push({ start: cursor.toISOString(), end: candidateEnd.toISOString(), minutes, source: "free" });
      }
    }
    const nextCursor = new Date(busy.end.getTime() + SLOT_BUFFER_MINUTES * 60000);
    if (nextCursor > cursor) cursor = nextCursor;
  }

  if (cursor < dayEnd) {
    const minutes = durationMinutes(cursor, dayEnd);
    if (minutes >= MIN_SLOT_MINUTES) {
      slots.push({ start: cursor.toISOString(), end: dayEnd.toISOString(), minutes, source: "free" });
    }
  }

  return slots;
}

function scheduleTasks(slots: PlannerSlot[], rankedTasks: PlannerTask[]): PlannerSuggestion[] {
  const remainingSlots = slots.map(slot => ({ ...slot }));
  const suggestions: PlannerSuggestion[] = [];

  for (const task of rankedTasks) {
    const index = remainingSlots.findIndex(slot => slot.minutes >= MIN_SLOT_MINUTES);
    if (index === -1) break;

    let targetIndex = remainingSlots.findIndex(slot => slot.minutes >= task.estimatedMinutes);
    if (targetIndex === -1) targetIndex = index;

    const slot = remainingSlots[targetIndex];
    const start = new Date(slot.start);
    const allocation = Math.min(slot.minutes, task.estimatedMinutes);
    const end = new Date(start.getTime() + allocation * 60000);

    suggestions.push({
      taskId: task.id,
      title: task.title,
      start: start.toISOString(),
      end: end.toISOString(),
      minutes: allocation,
      score: task.score,
      reason: task.score >= 1000
        ? "deadline pressure"
        : task.score >= 500
          ? "high priority"
          : "best available fit",
    });

    const leftoverMinutes = slot.minutes - allocation - SLOT_BUFFER_MINUTES;
    if (leftoverMinutes >= MIN_SLOT_MINUTES) {
      remainingSlots[targetIndex] = {
        start: new Date(end.getTime() + SLOT_BUFFER_MINUTES * 60000).toISOString(),
        end: slot.end,
        minutes: leftoverMinutes,
        source: "free",
      };
    } else {
      remainingSlots.splice(targetIndex, 1);
    }
  }

  return suggestions;
}

async function maybeGenerateAiSummary(
  settings: SchedulerModelSettings,
  snapshot: Omit<SchedulerIntelligenceSnapshot, "briefing" | "model">,
): Promise<{ summary: string; topActions: string[]; available: boolean; selectedModel: string; source: "local" | "tier" | "override" }> {
  const localCfg = getLocalConfig();
  const rawSelectedModel = settings.overrideModel?.trim()
    ? settings.overrideModel.trim()
    : settings.localOnly
      ? localCfg.chatModel
      : getModelForTier(settings.tier);
  // Strip lmstudio/ prefix — LM Studio API expects the bare model ID
  const selectedModel = rawSelectedModel.replace(/^lmstudio\//, "");
  const source = settings.overrideModel?.trim()
    ? "override"
    : settings.localOnly
      ? "local"
      : "tier";

  const localAvailable = await isLocalModelAvailable();
  if (!settings.enabled || !localAvailable) {
    return {
      summary: buildFallbackSummary(snapshot.suggestions, snapshot.conflicts),
      topActions: buildFallbackActions(snapshot.suggestions, snapshot.conflicts),
      available: localAvailable,
      selectedModel,
      source,
    };
  }

  try {
    const prompt = [
      "You are a scheduling assistant. Be concise, practical, and literal.",
      "Summarize the day and recommend the next actions.",
      "Return JSON only: {\"summary\":\"...\",\"topActions\":[\"...\"]}",
      `Calendar events: ${snapshot.calendar.events.map(e => `${e.title} @ ${e.start}`).join("; ") || "none"}`,
      `Free slots: ${snapshot.calendar.freeSlots.map(s => `${s.start}-${s.end} (${s.minutes}m)`).join("; ") || "none"}`,
      `Suggested work blocks: ${snapshot.suggestions.map(s => `${s.title} ${s.start}-${s.end}`).join("; ") || "none"}`,
      `Conflicts: ${snapshot.conflicts.map(c => `${c.severity}:${c.title}`).join("; ") || "none"}`,
    ].join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const response = await fetch(`${localCfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`LM Studio returned ${response.status}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("non-JSON scheduler summary");
    const parsed = JSON.parse(match[0]) as { summary?: string; topActions?: string[] };
    return {
      summary: parsed.summary?.trim() || buildFallbackSummary(snapshot.suggestions, snapshot.conflicts),
      topActions: Array.isArray(parsed.topActions) && parsed.topActions.length > 0
        ? parsed.topActions.slice(0, 4)
        : buildFallbackActions(snapshot.suggestions, snapshot.conflicts),
      available: true,
      selectedModel,
      source,
    };
  } catch (err) {
    log().warn(`[scheduler-intelligence] local summary failed: ${err}`);
    return {
      summary: buildFallbackSummary(snapshot.suggestions, snapshot.conflicts),
      topActions: buildFallbackActions(snapshot.suggestions, snapshot.conflicts),
      available: localAvailable,
      selectedModel,
      source,
    };
  }
}

function buildFallbackSummary(suggestions: PlannerSuggestion[], conflicts: PlannerConflict[]): string {
  if (conflicts.some(c => c.severity === "high")) {
    return "Today is overcommitted. Protect the highest-pressure work, then replan the rest.";
  }
  if (suggestions.length === 0) {
    return "No viable work blocks were found. The day is calendar-bound unless tasks or events change.";
  }
  return `You have ${suggestions.length} recommended work block${suggestions.length === 1 ? "" : "s"} with capacity for focused progress before the day closes.`;
}

function buildFallbackActions(suggestions: PlannerSuggestion[], conflicts: PlannerConflict[]): string[] {
  const actions = suggestions.slice(0, 3).map(s => `Block ${s.minutes}m for ${s.title}`);
  for (const conflict of conflicts.slice(0, 2)) {
    actions.push(conflict.title);
  }
  return actions.slice(0, 4);
}

export async function getSchedulerIntelligenceSnapshot(): Promise<SchedulerIntelligenceSnapshot> {
  const db = getDb();
  const now = new Date();
  const todayStart = startOfLocalDay(now);
  const todayEnd = endOfLocalDay(now);
  const settings = getSchedulerModelSettings();

  const googleEvents = isGoogleCalendarAvailable() ? await getTodayEvents() : [];
  const dbEvents = db.select().from(scheduledEvents)
    .where(and(
      gte(scheduledEvents.scheduledAt, todayStart.toISOString()),
      lte(scheduledEvents.scheduledAt, todayEnd.toISOString()),
    ))
    .orderBy(asc(scheduledEvents.scheduledAt))
    .all();

  const busyBlocks = [
    ...googleEvents.map(toBusyBlockFromGoogle).filter(Boolean) as BusyBlock[],
    ...dbEvents.map(toBusyBlockFromDb).filter(Boolean) as BusyBlock[],
    ...getFixedBusyBlocks(todayStart),
  ];

  const freeSlots = buildFreeSlots(todayStart, busyBlocks);

  const taskRows = db.select({
    id: tasks.id,
    title: tasks.title,
    priority: tasks.priority,
    dueDate: tasks.dueDate,
    estimatedMinutes: tasks.estimatedMinutes,
    status: tasks.status,
    workState: tasks.workState,
    projectId: tasks.projectId,
    scheduledStart: tasks.scheduledStart,
    scheduledEnd: tasks.scheduledEnd,
    updatedAt: tasks.updatedAt,
    blockedBy: tasks.blockedBy,
    shape: tasks.shape,
  })
    .from(tasks)
    .where(and(
      inArray(tasks.status, ["active", "in_progress", "blocked", "waiting_on"]),
    ))
    .orderBy(desc(tasks.priority), asc(tasks.dueDate), desc(tasks.updatedAt))
    .all();

  const rankedTasks = taskRows
    .map(row => ({
      id: row.id,
      title: row.title,
      priority: row.priority,
      dueDate: row.dueDate,
      estimatedMinutes: normalizeEstimate(row),
      score: scoreTask(row),
      status: row.status,
      workState: row.workState,
      projectId: row.projectId,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      blockedBy: row.blockedBy,
    }))
    .sort((a, b) => b.score - a.score);

  const eligibleTasks = rankedTasks.filter(task => task.status !== "blocked" && task.status !== "waiting_on");
  const suggestions = scheduleTasks(freeSlots, eligibleTasks);

  const conflicts: PlannerConflict[] = [];
  const blockedTasks = rankedTasks.filter(task => task.status === "blocked" || task.status === "waiting_on");
  if (blockedTasks.length > 0) {
    conflicts.push({
      type: "blocked",
      severity: blockedTasks.length > 2 ? "medium" : "low",
      title: `${blockedTasks.length} blocked task${blockedTasks.length === 1 ? "" : "s"} need follow-up`,
      description: blockedTasks.slice(0, 3).map(t => t.title).join(", "),
    });
  }

  const overdueTasks = rankedTasks.filter(task => task.dueDate && new Date(task.dueDate).getTime() < now.getTime());
  if (overdueTasks.length > 0) {
    conflicts.push({
      type: "deadline",
      severity: "high",
      title: `${overdueTasks.length} overdue task${overdueTasks.length === 1 ? "" : "s"}`,
      description: overdueTasks.slice(0, 3).map(t => t.title).join(", "),
    });
  }

  const scheduledMinutes = suggestions.reduce((sum, item) => sum + item.minutes, 0);
  const freeMinutes = freeSlots.reduce((sum, slot) => sum + slot.minutes, 0);
  const requiredMinutes = eligibleTasks.slice(0, 5).reduce((sum, task) => sum + task.estimatedMinutes, 0);
  if (requiredMinutes > freeMinutes) {
    conflicts.push({
      type: "capacity",
      severity: requiredMinutes - freeMinutes > 120 ? "high" : "medium",
      title: "Not enough focused time for the current queue",
      description: `${requiredMinutes}m of near-term work versus ${freeMinutes}m of free time today`,
    });
  }

  const sortedBusyBlocks = [...busyBlocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  const overlappingEvents = sortedBusyBlocks.filter((block, idx, arr) => {
    const next = arr[idx + 1];
    return Boolean(next && next.start.getTime() < block.end.getTime());
  });
  if (overlappingEvents.length > 0) {
    conflicts.push({
      type: "calendar_overlap",
      severity: "medium",
      title: "Calendar contains overlapping busy windows",
      description: overlappingEvents.map(event => event.title).join(", "),
    });
  }

  const baseSnapshot = {
    generatedAt: new Date().toISOString(),
    date: todayStart.toISOString().slice(0, 10),
    calendar: {
      available: isGoogleCalendarAvailable(),
      events: [
        ...googleEvents.map(event => ({
          id: event.id,
          title: event.summary || "(untitled)",
          start: event.start.dateTime ?? event.start.date ?? "",
          end: event.end.dateTime ?? event.end.date ?? "",
          location: event.location,
          source: "google" as const,
        })),
        ...dbEvents.map(event => ({
          id: event.id,
          title: event.title,
          start: event.scheduledAt,
          end: event.endAt ?? "",
          source: "db" as const,
        })),
      ].sort((a, b) => a.start.localeCompare(b.start)),
      fixedBlocks: getFixedBusyBlocks(todayStart).map(block => ({
        title: block.title,
        start: block.start.toISOString(),
        end: block.end.toISOString(),
      })),
      freeSlots,
    },
    tasks: {
      ranked: rankedTasks.map(task => ({
        id: task.id,
        title: task.title,
        priority: task.priority,
        dueDate: task.dueDate,
        estimatedMinutes: task.estimatedMinutes,
        score: task.score,
        status: task.status,
        workState: task.workState,
        projectId: task.projectId,
        scheduledStart: task.scheduledStart,
        scheduledEnd: task.scheduledEnd,
      })),
      scheduledCount: suggestions.length,
      blockedCount: blockedTasks.length,
      overdueCount: overdueTasks.length,
    },
    suggestions,
    conflicts,
  };

  const ai = await maybeGenerateAiSummary(settings, baseSnapshot);

  return {
    ...baseSnapshot,
    model: {
      enabled: settings.enabled,
      available: ai.available,
      localOnly: settings.localOnly,
      tier: settings.tier,
      selectedModel: ai.selectedModel,
      source: ai.source,
    },
    briefing: {
      headline: conflicts.some(c => c.severity === "high")
        ? "Scheduling attention needed"
        : suggestions.length > 0
          ? "Daily plan ready"
          : "No work blocks available",
      summary: ai.summary,
      topActions: ai.topActions,
    },
  };
}
