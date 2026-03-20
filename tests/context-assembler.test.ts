/**
 * Tests for src/services/context-assembler.ts
 *
 * Covers:
 *   - assembleBrainDumpContext: project found / not found, active tasks, completed tasks
 *   - assembleCalendarCheckContext: active tasks, project title enrichment, no-throw on network failure
 *   - assembleDailyBriefContext: active/blocked/completed/overdue tasks, project map
 *   - assembleSystemStateContext: stale tasks, blocked tasks, active worker runs, recent errors
 *   - formatBrainDumpContext: correct markdown output
 *   - formatCalendarContext: event details, tasks, memory snippets
 *   - formatDailyBriefContext: completed, active, blocked, today events sections
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getDb, getRawDb } from "../src/db/connection.js";
import {
  assembleBrainDumpContext,
  assembleCalendarCheckContext,
  assembleDailyBriefContext,
  assembleSystemStateContext,
  formatBrainDumpContext,
  formatCalendarContext,
  formatDailyBriefContext,
  type BrainDumpContext,
} from "../src/services/context-assembler.js";

// ── Seed helpers ─────────────────────────────────────────────────────────────

function seedProject(overrides: Partial<{
  id: string; title: string; notes: string | null; type: string;
}> = {}) {
  const raw = getRawDb();
  const id = overrides.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  raw.prepare(`
    INSERT INTO projects (id, title, notes, type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.title ?? "Test Project",
    overrides.notes ?? null,
    overrides.type ?? "kanban",
    now, now,
  );
  return id;
}

function seedTask(overrides: Partial<{
  id: string; title: string; status: string; projectId: string | null;
  notes: string | null; priority: string | null; dueDate: string | null;
  blockedBy: string | null; updatedAt: string;
}> = {}) {
  const raw = getRawDb();
  const id = overrides.id ?? crypto.randomUUID();
  const now = overrides.updatedAt ?? new Date().toISOString();
  // blockedBy is mode:"json" — must be stored as a JSON-serialised string
  const blockedByJson = overrides.blockedBy != null
    ? JSON.stringify(overrides.blockedBy)
    : null;
  raw.prepare(`
    INSERT INTO tasks (id, title, status, project_id, notes, priority, due_date, blocked_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.title ?? "Test Task",
    overrides.status ?? "active",
    overrides.projectId ?? null,
    overrides.notes ?? null,
    overrides.priority ?? null,
    overrides.dueDate ?? null,
    blockedByJson,
    now, now,
  );
  return id;
}

function seedWorkerRun(overrides: Partial<{
  agentType: string; succeeded: boolean; endedAt: string | null;
  summary: string | null; failureType: string | null; model: string;
}> = {}) {
  const raw = getRawDb();
  const now = new Date().toISOString();
  // succeeded is boolean mode in drizzle — store as 0/1
  const succeededInt = overrides.succeeded === true ? 1 : 0;
  raw.prepare(`
    INSERT INTO worker_runs (agent_type, succeeded, ended_at, summary, failure_type, model, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.agentType ?? "programmer",
    succeededInt,
    "endedAt" in overrides ? overrides.endedAt : now,
    overrides.summary ?? null,
    overrides.failureType ?? null,
    overrides.model ?? "claude-3-haiku",
    now,
  );
}

function clearTables() {
  const raw = getRawDb();
  raw.exec("DELETE FROM tasks");
  raw.exec("DELETE FROM projects");
  raw.exec("DELETE FROM worker_runs");
}

beforeEach(() => clearTables());

// ── assembleBrainDumpContext ─────────────────────────────────────────────────

describe("assembleBrainDumpContext", () => {
  it("returns placeholder context when project doesn't exist", () => {
    const ctx = assembleBrainDumpContext("non-existent-id");
    expect(ctx.project.id).toBe("non-existent-id");
    expect(ctx.project.title).toBe("Unknown");
    expect(ctx.project.notes).toBeNull();
    expect(ctx.project.type).toBe("kanban");
    expect(ctx.recentlyCompleted).toHaveLength(0);
    expect(ctx.activeTasks).toHaveLength(0);
  });

  it("returns project details when project exists", () => {
    const id = seedProject({ title: "My Project", notes: "Important project", type: "linear" });
    const ctx = assembleBrainDumpContext(id);
    expect(ctx.project.title).toBe("My Project");
    expect(ctx.project.notes).toBe("Important project");
    expect(ctx.project.type).toBe("linear");
  });

  it("includes active tasks for the project", () => {
    const pid = seedProject();
    seedTask({ title: "Active 1", status: "active", projectId: pid });
    seedTask({ title: "In Progress", status: "in_progress", projectId: pid });
    seedTask({ title: "Blocked", status: "blocked", projectId: pid });
    seedTask({ title: "Done", status: "completed", projectId: pid });

    const ctx = assembleBrainDumpContext(pid);
    expect(ctx.activeTasks).toHaveLength(3);
    expect(ctx.activeTasks.map(t => t.status)).toContain("active");
    expect(ctx.activeTasks.map(t => t.status)).toContain("in_progress");
    expect(ctx.activeTasks.map(t => t.status)).toContain("blocked");
  });

  it("excludes tasks from other projects", () => {
    const pid = seedProject({ title: "Project A" });
    const other = seedProject({ title: "Project B" });
    seedTask({ title: "Mine", status: "active", projectId: pid });
    seedTask({ title: "Not Mine", status: "active", projectId: other });

    const ctx = assembleBrainDumpContext(pid);
    expect(ctx.activeTasks).toHaveLength(1);
    expect(ctx.activeTasks[0].title).toBe("Mine");
  });

  it("includes recently completed tasks (within 14 days)", () => {
    const pid = seedProject();
    const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    seedTask({ title: "Recent Done", status: "completed", projectId: pid, updatedAt: recentDate });
    seedTask({ title: "Old Done", status: "completed", projectId: pid, updatedAt: oldDate });

    const ctx = assembleBrainDumpContext(pid);
    expect(ctx.recentlyCompleted).toHaveLength(1);
    expect(ctx.recentlyCompleted[0].title).toBe("Recent Done");
  });

  it("active tasks include notes", () => {
    const pid = seedProject();
    seedTask({ title: "Task with notes", status: "active", projectId: pid, notes: "some notes here" });
    const ctx = assembleBrainDumpContext(pid);
    expect(ctx.activeTasks[0].notes).toBe("some notes here");
  });

  it("caps active tasks at 30", () => {
    const pid = seedProject();
    for (let i = 0; i < 35; i++) {
      seedTask({ title: `Task ${i}`, status: "active", projectId: pid });
    }
    const ctx = assembleBrainDumpContext(pid);
    expect(ctx.activeTasks.length).toBeLessThanOrEqual(30);
  });
});

// ── assembleCalendarCheckContext ─────────────────────────────────────────────

describe("assembleCalendarCheckContext", () => {
  it("returns the event verbatim", async () => {
    const event = {
      summary: "Team standup",
      start: "2025-01-15T09:00:00",
      end: "2025-01-15T09:30:00",
      description: "Daily sync",
    };
    const ctx = await assembleCalendarCheckContext(event);
    expect(ctx.event.summary).toBe("Team standup");
    expect(ctx.event.description).toBe("Daily sync");
    expect(ctx.upcomingEvents).toEqual([]);
    // relevantMemory is always an array (memory search may or may not be running)
    expect(Array.isArray(ctx.relevantMemory)).toBe(true);
  });

  it("includes active tasks with project titles", async () => {
    const pid = seedProject({ title: "WebApp" });
    seedTask({ title: "Deploy", status: "active", projectId: pid });
    seedTask({ title: "Review PR", status: "in_progress", projectId: pid });
    seedTask({ title: "Write docs", status: "blocked" }); // no project

    const ctx = await assembleCalendarCheckContext({
      summary: "Sprint review",
      start: "2025-01-15T14:00:00",
      end: "2025-01-15T15:00:00",
    });

    expect(ctx.activeTasks.length).toBeGreaterThanOrEqual(2);
    const deploy = ctx.activeTasks.find(t => t.title === "Deploy");
    expect(deploy?.projectTitle).toBe("WebApp");
    const docs = ctx.activeTasks.find(t => t.title === "Write docs");
    expect(docs?.projectTitle).toBeNull();
  });

  it("does not throw when memory search is called (no error propagates outward)", async () => {
    // The assembler calls http://localhost:7420/search — in test env this may
    // succeed (if the memory service is running) or fail (connection refused).
    // Either way, the function must not throw.
    await expect(assembleCalendarCheckContext({
      summary: "Memory test event",
      start: "2025-01-15T10:00:00",
      end: "2025-01-15T10:30:00",
    })).resolves.toMatchObject({
      event: expect.objectContaining({ summary: "Memory test event" }),
      upcomingEvents: [],
      relevantMemory: expect.any(Array),
    });
  });

  it("caps active tasks at 30", async () => {
    const pid = seedProject();
    for (let i = 0; i < 35; i++) {
      seedTask({ title: `Task ${i}`, status: "active", projectId: pid });
    }
    const ctx = await assembleCalendarCheckContext({
      summary: "Big review",
      start: "2025-01-15T10:00:00",
      end: "2025-01-15T11:00:00",
    });
    expect(ctx.activeTasks.length).toBeLessThanOrEqual(30);
  });
});

// ── assembleDailyBriefContext ─────────────────────────────────────────────────

describe("assembleDailyBriefContext", () => {
  it("returns today's date string", () => {
    const ctx = assembleDailyBriefContext();
    expect(ctx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ctx.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("includes active and in_progress tasks", () => {
    const pid = seedProject({ title: "Alpha" });
    seedTask({ title: "Active T", status: "active", projectId: pid, priority: "high" });
    seedTask({ title: "IP T", status: "in_progress", projectId: pid });
    seedTask({ title: "Done T", status: "completed" });

    const ctx = assembleDailyBriefContext();
    expect(ctx.activeTasks).toHaveLength(2);
    const active = ctx.activeTasks.find(t => t.title === "Active T");
    expect(active?.projectTitle).toBe("Alpha");
    expect(active?.priority).toBe("high");
  });

  it("includes tasks completed today", () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const recentlyDone = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const yesterdayDone = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    seedTask({ title: "Done Today", status: "completed", updatedAt: recentlyDone });
    seedTask({ title: "Done Yesterday", status: "completed", updatedAt: yesterdayDone });

    const ctx = assembleDailyBriefContext();
    expect(ctx.completedToday.map(t => t.title)).toContain("Done Today");
    expect(ctx.completedToday.map(t => t.title)).not.toContain("Done Yesterday");
  });

  it("includes blocked tasks with blockedBy info", () => {
    seedTask({ title: "Blocked Task", status: "blocked", blockedBy: "Waiting for API" });
    seedTask({ title: "Blocked NoReason", status: "blocked" });

    const ctx = assembleDailyBriefContext();
    expect(ctx.blockedTasks).toHaveLength(2);
    const blocked = ctx.blockedTasks.find(t => t.title === "Blocked Task");
    expect(blocked?.blockedBy).toBe("Waiting for API");
    const noReason = ctx.blockedTasks.find(t => t.title === "Blocked NoReason");
    expect(noReason?.blockedBy).toBeNull();
  });

  it("includes overdue items (past due date, still active)", () => {
    const pastDate = "2020-01-01";
    const futureDate = "2099-12-31";
    seedTask({ title: "Overdue", status: "active", dueDate: pastDate });
    seedTask({ title: "Not Due Yet", status: "active", dueDate: futureDate });
    seedTask({ title: "No Due Date", status: "active" });

    const ctx = assembleDailyBriefContext();
    const overdueTitles = ctx.overdueItems.map(t => t.title);
    expect(overdueTitles).toContain("Overdue");
    expect(overdueTitles).not.toContain("Not Due Yet");
    expect(overdueTitles).not.toContain("No Due Date");
  });

  it("todayEvents defaults to empty array (filled by caller)", () => {
    const ctx = assembleDailyBriefContext();
    expect(ctx.todayEvents).toEqual([]);
  });
});

// ── assembleSystemStateContext ───────────────────────────────────────────────

describe("assembleSystemStateContext", () => {
  it("returns stale active tasks (not updated in > 7 days)", () => {
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const freshDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    seedTask({ title: "Stale Task", status: "active", updatedAt: staleDate });
    seedTask({ title: "Fresh Task", status: "active", updatedAt: freshDate });

    const ctx = assembleSystemStateContext();
    const staleTitles = ctx.staleTasks.map(t => t.title);
    expect(staleTitles).toContain("Stale Task");
    expect(staleTitles).not.toContain("Fresh Task");
  });

  it("does not include completed tasks in stale list", () => {
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    seedTask({ title: "Stale Done", status: "completed", updatedAt: staleDate });
    const ctx = assembleSystemStateContext();
    expect(ctx.staleTasks.map(t => t.title)).not.toContain("Stale Done");
  });

  it("includes blocked tasks", () => {
    seedTask({ title: "Blocked X", status: "blocked", blockedBy: "upstream" });
    const ctx = assembleSystemStateContext();
    expect(ctx.blockedTasks).toHaveLength(1);
    expect(ctx.blockedTasks[0].blockedBy).toBe("upstream");
  });

  it("counts active worker runs (no endedAt)", () => {
    const raw = getRawDb();
    const now = new Date().toISOString();
    raw.prepare(`
      INSERT INTO worker_runs (agent_type, model, started_at) VALUES (?, ?, ?)
    `).run("programmer", "claude", now);
    raw.prepare(`
      INSERT INTO worker_runs (agent_type, model, started_at) VALUES (?, ?, ?)
    `).run("researcher", "claude", now);
    // This one has ended
    raw.prepare(`
      INSERT INTO worker_runs (agent_type, model, started_at, ended_at) VALUES (?, ?, ?, ?)
    `).run("writer", "claude", now, now);

    const ctx = assembleSystemStateContext();
    expect(ctx.activeWorkerRuns).toBe(2);
  });

  it("includes recent errors from last 3 hours", () => {
    const recentTime = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    const oldTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago

    seedWorkerRun({ agentType: "programmer", succeeded: false, endedAt: recentTime, summary: "OOM error in build" });
    seedWorkerRun({ agentType: "researcher", succeeded: false, endedAt: oldTime, summary: "Old error" });

    const ctx = assembleSystemStateContext();
    const errorTexts = ctx.recentErrors.join("\n");
    expect(errorTexts).toContain("OOM error in build");
    expect(errorTexts).not.toContain("Old error");
  });

  it("filters out reflection timeouts from recent errors", () => {
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    seedWorkerRun({
      agentType: "reflector",
      succeeded: false,
      endedAt: recentTime,
      summary: "Reflect: timed out",
      failureType: "timeout",
    });

    const ctx = assembleSystemStateContext();
    // Should not appear because failureType=timeout + summary contains "reflect"
    expect(ctx.recentErrors).toHaveLength(0);
  });

  it("filters out orphaned reflection runs from recent errors", () => {
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    seedWorkerRun({
      agentType: "reflector",
      succeeded: false,
      endedAt: recentTime,
      summary: "Reflect: orphaned on restart",
      failureType: "orphaned",
    });

    const ctx = assembleSystemStateContext();
    expect(ctx.recentErrors).toHaveLength(0);
  });
});

// ── formatBrainDumpContext ───────────────────────────────────────────────────

describe("formatBrainDumpContext", () => {
  it("includes project title", () => {
    const ctx: BrainDumpContext = {
      project: { id: "p1", title: "Big Project", notes: null, type: "kanban" },
      activeTasks: [],
      recentlyCompleted: [],
    };
    const output = formatBrainDumpContext(ctx);
    expect(output).toContain("Big Project");
  });

  it("includes project notes when present", () => {
    const ctx: BrainDumpContext = {
      project: { id: "p1", title: "Project X", notes: "Key notes here", type: "kanban" },
      activeTasks: [],
      recentlyCompleted: [],
    };
    const output = formatBrainDumpContext(ctx);
    expect(output).toContain("Key notes here");
  });

  it("shows active tasks with status and notes", () => {
    const ctx: BrainDumpContext = {
      project: { id: "p1", title: "P", notes: null, type: "kanban" },
      activeTasks: [
        { title: "Fix login", status: "blocked", notes: "Waiting on backend" },
      ],
      recentlyCompleted: [],
    };
    const output = formatBrainDumpContext(ctx);
    expect(output).toContain("Fix login");
    expect(output).toContain("blocked");
    expect(output).toContain("Waiting on backend");
  });

  it("shows recently completed tasks", () => {
    const ctx: BrainDumpContext = {
      project: { id: "p1", title: "P", notes: null, type: "kanban" },
      activeTasks: [],
      recentlyCompleted: [{ title: "Launched feature X", completedAt: "2025-01-10T12:00:00Z" }],
    };
    const output = formatBrainDumpContext(ctx);
    expect(output).toContain("Launched feature X");
    expect(output).toContain("2025-01-10");
  });

  it("truncates task notes at 100 chars", () => {
    const longNotes = "a".repeat(200);
    const ctx: BrainDumpContext = {
      project: { id: "p1", title: "P", notes: null, type: "kanban" },
      activeTasks: [{ title: "T", status: "active", notes: longNotes }],
      recentlyCompleted: [],
    };
    const output = formatBrainDumpContext(ctx);
    // Notes are sliced at 100 chars in the format function
    expect(output.length).toBeLessThan(300 + longNotes.length);
    // The note in output should be shorter than original
    const noteInOutput = output.split("— ")[1]?.slice(0, 150) ?? "";
    expect(noteInOutput.length).toBeLessThanOrEqual(101); // 100 + maybe newline
  });

  it("omits sections when arrays are empty", () => {
    const ctx: BrainDumpContext = {
      project: { id: "p1", title: "Empty", notes: null, type: "kanban" },
      activeTasks: [],
      recentlyCompleted: [],
    };
    const output = formatBrainDumpContext(ctx);
    expect(output).not.toContain("Active Tasks");
    expect(output).not.toContain("Recently Completed");
  });
});

// ── formatCalendarContext ────────────────────────────────────────────────────

describe("formatCalendarContext", () => {
  it("shows event summary, start/end times", () => {
    const ctx = {
      event: { summary: "Design Review", start: "2025-01-15T14:00:00", end: "2025-01-15T15:00:00" },
      activeTasks: [],
      upcomingEvents: [],
      relevantMemory: [],
    };
    const output = formatCalendarContext(ctx);
    expect(output).toContain("Design Review");
    expect(output).toContain("2025-01-15T14:00:00");
    expect(output).toContain("2025-01-15T15:00:00");
  });

  it("includes description if present", () => {
    const ctx = {
      event: { summary: "Standup", start: "T09:00", end: "T09:30", description: "Discuss blockers" },
      activeTasks: [],
      upcomingEvents: [],
      relevantMemory: [],
    };
    const output = formatCalendarContext(ctx);
    expect(output).toContain("Discuss blockers");
  });

  it("shows relevant memory snippets", () => {
    const ctx = {
      event: { summary: "Standup", start: "T09:00", end: "T09:30" },
      activeTasks: [],
      upcomingEvents: [],
      relevantMemory: ["Previous meeting noted issue X", "Deployment was delayed"],
    };
    const output = formatCalendarContext(ctx);
    expect(output).toContain("Previous meeting noted issue X");
    expect(output).toContain("Deployment was delayed");
  });

  it("shows active tasks with project titles", () => {
    const ctx = {
      event: { summary: "Sprint", start: "T10:00", end: "T11:00" },
      activeTasks: [
        { title: "Build auth", status: "active", projectTitle: "Portal", notes: null },
      ],
      upcomingEvents: [],
      relevantMemory: [],
    };
    const output = formatCalendarContext(ctx);
    expect(output).toContain("Build auth");
    expect(output).toContain("Portal");
  });
});

// ── formatDailyBriefContext ──────────────────────────────────────────────────

describe("formatDailyBriefContext", () => {
  it("includes the date in header", () => {
    const ctx = {
      date: "2025-01-15",
      activeTasks: [],
      completedToday: [],
      blockedTasks: [],
      todayEvents: [],
      overdueItems: [],
    };
    const output = formatDailyBriefContext(ctx);
    expect(output).toContain("2025-01-15");
  });

  it("shows completed today section", () => {
    const ctx = {
      date: "2025-01-15",
      activeTasks: [],
      completedToday: [{ title: "Deploy API" }, { title: "Review PR" }],
      blockedTasks: [],
      todayEvents: [],
      overdueItems: [],
    };
    const output = formatDailyBriefContext(ctx);
    expect(output).toContain("Completed Today");
    expect(output).toContain("Deploy API");
    expect(output).toContain("Review PR");
  });

  it("shows active tasks with project and priority", () => {
    const ctx = {
      date: "2025-01-15",
      activeTasks: [{ title: "Ship feature", status: "active", projectTitle: "Backend", priority: "critical" }],
      completedToday: [],
      blockedTasks: [],
      todayEvents: [],
      overdueItems: [],
    };
    const output = formatDailyBriefContext(ctx);
    expect(output).toContain("Ship feature");
    expect(output).toContain("Backend");
    expect(output).toContain("critical");
  });

  it("shows blocked tasks with blockedBy", () => {
    const ctx = {
      date: "2025-01-15",
      activeTasks: [],
      completedToday: [],
      blockedTasks: [{ title: "Auth service", blockedBy: "design finalization" }],
      todayEvents: [],
      overdueItems: [],
    };
    const output = formatDailyBriefContext(ctx);
    expect(output).toContain("Blocked");
    expect(output).toContain("Auth service");
    expect(output).toContain("design finalization");
  });

  it("shows today's calendar events with times", () => {
    const ctx = {
      date: "2025-01-15",
      activeTasks: [],
      completedToday: [],
      blockedTasks: [],
      todayEvents: [
        { summary: "Standup", start: "2025-01-15T09:00:00", end: "2025-01-15T09:30:00" },
      ],
      overdueItems: [],
    };
    const output = formatDailyBriefContext(ctx);
    expect(output).toContain("Calendar");
    expect(output).toContain("Standup");
    expect(output).toContain("09:00");
  });

  it("omits empty sections", () => {
    const ctx = {
      date: "2025-01-15",
      activeTasks: [],
      completedToday: [],
      blockedTasks: [],
      todayEvents: [],
      overdueItems: [],
    };
    const output = formatDailyBriefContext(ctx);
    expect(output).not.toContain("Active Tasks");
    expect(output).not.toContain("Completed Today");
    expect(output).not.toContain("Blocked");
    expect(output).not.toContain("Calendar");
  });
});
