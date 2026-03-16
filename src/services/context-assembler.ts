/**
 * Context Assembler — builds task-specific context packages for LLM calls.
 * 
 * Each sentinel task type needs different context. This module
 * assembles the right data for each task type so the LLM
 * (whether Claude or fine-tuned Qwen) gets exactly what it needs.
 * 
 * The intelligence is in the retrieval, not the model.
 */

import { eq, and, desc, inArray, gte } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, projects } from "../db/schema.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface BrainDumpContext {
  project: { id: string; title: string; notes: string | null; type: string };
  recentlyCompleted: Array<{ title: string; completedAt: string }>;
  activeTasks: Array<{ title: string; status: string; notes: string | null }>;
}

export interface CalendarCheckContext {
  event: { summary: string; start: string; end: string; description?: string };
  activeTasks: Array<{ title: string; status: string; projectTitle: string | null; notes: string | null }>;
  upcomingEvents: Array<{ summary: string; start: string }>;
  relevantMemory: string[];  // snippets from memory search
}

export interface DailyBriefContext {
  date: string;
  activeTasks: Array<{ title: string; status: string; projectTitle: string | null; priority: string | null }>;
  completedToday: Array<{ title: string }>;
  blockedTasks: Array<{ title: string; blockedBy: string | null }>;
  todayEvents: Array<{ summary: string; start: string; end: string }>;
  overdueItems: Array<{ title: string; dueDate: string }>;
}

export interface SystemStateContext {
  staleTasks: Array<{ title: string; lastUpdated: string; status: string }>;
  blockedTasks: Array<{ title: string; blockedBy: string | null }>;
  activeWorkerRuns: number;
  recentErrors: string[];
}

// ─── Brain Dump Context ────────────────────────────────────────────────

export function assembleBrainDumpContext(projectId: string): BrainDumpContext {
  const db = getDb();

  const project = db.select().from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    return {
      project: { id: projectId, title: "Unknown", notes: null, type: "kanban" },
      recentlyCompleted: [],
      activeTasks: [],
    };
  }

  // Tasks completed in last 14 days for this project
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const completed = db.select({ title: tasks.title, completedAt: tasks.updatedAt })
    .from(tasks)
    .where(and(
      eq(tasks.projectId, projectId),
      eq(tasks.status, "completed"),
      gte(tasks.updatedAt, twoWeeksAgo),
    ))
    .orderBy(desc(tasks.updatedAt))
    .limit(20)
    .all();

  // Active tasks for this project
  const active = db.select({
    title: tasks.title,
    status: tasks.status,
    notes: tasks.notes,
  })
    .from(tasks)
    .where(and(
      eq(tasks.projectId, projectId),
      inArray(tasks.status, ["active", "in_progress", "blocked"]),
    ))
    .orderBy(desc(tasks.updatedAt))
    .limit(30)
    .all();

  return {
    project: {
      id: project.id,
      title: project.title,
      notes: project.notes,
      type: project.type,
    },
    recentlyCompleted: completed,
    activeTasks: active,
  };
}

// ─── Calendar Check Context ────────────────────────────────────────────

export async function assembleCalendarCheckContext(event: {
  summary: string;
  start: string;
  end: string;
  description?: string;
}): Promise<CalendarCheckContext> {
  const db = getDb();

  // All active tasks with project titles
  const active = db.select({
    title: tasks.title,
    status: tasks.status,
    notes: tasks.notes,
    projectId: tasks.projectId,
  })
    .from(tasks)
    .where(inArray(tasks.status, ["active", "in_progress", "blocked"]))
    .orderBy(desc(tasks.updatedAt))
    .limit(30)
    .all();

  // Enrich with project titles
  const projectMap = new Map<string, string>();
  const projectIds = [...new Set(active.map(t => t.projectId).filter(Boolean))];
  for (const pid of projectIds) {
    const p = db.select({ title: projects.title }).from(projects).where(eq(projects.id, pid as string)).get();
    if (p) projectMap.set(pid as string, p.title);
  }

  const activeTasks = active.map(t => ({
    title: t.title,
    status: t.status,
    projectTitle: t.projectId ? projectMap.get(t.projectId) ?? null : null,
    notes: t.notes,
  }));

  // Try to get relevant memory snippets via memory search
  let relevantMemory: string[] = [];
  try {
    const res = await fetch("http://localhost:7420/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: event.summary, limit: 5 }),
    });
    if (res.ok) {
      const data = await res.json() as { results?: Array<{ content: string }> };
      relevantMemory = (data.results ?? []).map(r => r.content).slice(0, 5);
    }
  } catch {
    // Memory search unavailable, continue without
  }

  return {
    event,
    activeTasks,
    upcomingEvents: [], // filled by caller from Google Calendar
    relevantMemory,
  };
}

// ─── Daily Brief Context ───────────────────────────────────────────────

export function assembleDailyBriefContext(): DailyBriefContext {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const todayStart = `${today}T00:00:00`;

  // Active tasks with project info
  const active = db.select({
    title: tasks.title,
    status: tasks.status,
    projectId: tasks.projectId,
    priority: tasks.priority,
  })
    .from(tasks)
    .where(inArray(tasks.status, ["active", "in_progress"]))
    .orderBy(desc(tasks.updatedAt))
    .limit(30)
    .all();

  // Project map
  const projectMap = new Map<string, string>();
  const projectIds = [...new Set(active.map(t => t.projectId).filter(Boolean))];
  for (const pid of projectIds) {
    const p = db.select({ title: projects.title }).from(projects).where(eq(projects.id, pid as string)).get();
    if (p) projectMap.set(pid as string, p.title);
  }

  // Completed today
  const completedToday = db.select({ title: tasks.title })
    .from(tasks)
    .where(and(
      eq(tasks.status, "completed"),
      gte(tasks.updatedAt, todayStart),
    ))
    .all();

  // Blocked
  const blocked = db.select({
    title: tasks.title,
    blockedBy: tasks.blockedBy,
  })
    .from(tasks)
    .where(eq(tasks.status, "blocked"))
    .all();

  return {
    date: today,
    activeTasks: active.map(t => ({
      title: t.title,
      status: t.status,
      projectTitle: t.projectId ? projectMap.get(t.projectId) ?? null : null,
      priority: t.priority,
    })),
    completedToday,
    blockedTasks: blocked.map(b => ({
      title: b.title,
      blockedBy: b.blockedBy as string | null,
    })),
    todayEvents: [], // filled by caller from Google Calendar
    overdueItems: [], // TODO: check due dates
  };
}

// ─── System State Context ──────────────────────────────────────────────

export function assembleSystemStateContext(): SystemStateContext {
  const db = getDb();
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Tasks not updated in > 7 days that are still active
  const stale = db.select({
    title: tasks.title,
    updatedAt: tasks.updatedAt,
    status: tasks.status,
  })
    .from(tasks)
    .where(and(
      inArray(tasks.status, ["active", "in_progress"]),
    ))
    .all()
    .filter(t => t.updatedAt < oneWeekAgo);

  const blocked = db.select({
    title: tasks.title,
    blockedBy: tasks.blockedBy,
  })
    .from(tasks)
    .where(eq(tasks.status, "blocked"))
    .all();

  return {
    staleTasks: stale.map(t => ({
      title: t.title,
      lastUpdated: t.updatedAt,
      status: t.status,
    })),
    blockedTasks: blocked.map(b => ({
      title: b.title,
      blockedBy: b.blockedBy as string | null,
    })),
    activeWorkerRuns: 0, // TODO: check worker_runs table
    recentErrors: [], // TODO: pull from logs
  };
}

// ─── Format helpers ────────────────────────────────────────────────────

/**
 * Format brain dump context into a string for the LLM prompt.
 */
export function formatBrainDumpContext(ctx: BrainDumpContext): string {
  let out = `## Project: ${ctx.project.title}\n`;
  if (ctx.project.notes) out += `${ctx.project.notes}\n`;
  
  if (ctx.activeTasks.length > 0) {
    out += `\n### Active Tasks (${ctx.activeTasks.length})\n`;
    for (const t of ctx.activeTasks) {
      out += `- [${t.status}] ${t.title}${t.notes ? ` — ${t.notes.slice(0, 100)}` : ""}\n`;
    }
  }

  if (ctx.recentlyCompleted.length > 0) {
    out += `\n### Recently Completed (${ctx.recentlyCompleted.length})\n`;
    for (const t of ctx.recentlyCompleted) {
      out += `- ${t.title} (${t.completedAt.slice(0, 10)})\n`;
    }
  }

  return out;
}

export function formatCalendarContext(ctx: CalendarCheckContext): string {
  let out = `## Event: ${ctx.event.summary}\n`;
  out += `Time: ${ctx.event.start} — ${ctx.event.end}\n`;
  if (ctx.event.description) out += `Description: ${ctx.event.description}\n`;

  if (ctx.activeTasks.length > 0) {
    out += `\n### Active Tasks\n`;
    for (const t of ctx.activeTasks) {
      out += `- [${t.status}] ${t.title}${t.projectTitle ? ` (${t.projectTitle})` : ""}\n`;
    }
  }

  if (ctx.relevantMemory.length > 0) {
    out += `\n### Relevant Notes\n`;
    for (const m of ctx.relevantMemory) {
      out += `- ${m.slice(0, 200)}\n`;
    }
  }

  return out;
}

export function formatDailyBriefContext(ctx: DailyBriefContext): string {
  let out = `## Daily Brief — ${ctx.date}\n`;

  if (ctx.completedToday.length > 0) {
    out += `\n### Completed Today\n`;
    for (const t of ctx.completedToday) out += `- ${t.title}\n`;
  }

  if (ctx.activeTasks.length > 0) {
    out += `\n### Active Tasks (${ctx.activeTasks.length})\n`;
    for (const t of ctx.activeTasks) {
      out += `- ${t.title}${t.projectTitle ? ` (${t.projectTitle})` : ""}${t.priority ? ` [${t.priority}]` : ""}\n`;
    }
  }

  if (ctx.blockedTasks.length > 0) {
    out += `\n### Blocked\n`;
    for (const t of ctx.blockedTasks) {
      out += `- ${t.title}${t.blockedBy ? ` — blocked by: ${t.blockedBy}` : ""}\n`;
    }
  }

  if (ctx.todayEvents.length > 0) {
    out += `\n### Today's Calendar\n`;
    for (const e of ctx.todayEvents) {
      out += `- ${e.start.slice(11, 16)} — ${e.end.slice(11, 16)}: ${e.summary}\n`;
    }
  }

  return out;
}
