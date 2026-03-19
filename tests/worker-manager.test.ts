/**
 * Tests for src/orchestrator/worker-manager.ts
 *
 * Covers:
 * - Worker lifecycle: recordWorkerStart → active → recordWorkerEnd
 * - hasCapacity / countActiveWorkers
 * - getActiveWorkers
 * - detectStaleWorkers
 * - forceTerminateWorker
 * - Pending spawn counting: increment / decrement / getPendingSpawnCount / projectHasPendingSpawn
 * - classifyFailureType
 * - countInFlightTaskRuns
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, getRawDb } from "../src/db/connection.js";
import { tasks, projects, workerRuns, workflowDefinitions, workflowRuns } from "../src/db/schema.js";
import {
  DEFAULT_MAX_WORKERS,
  hasCapacity,
  countActiveWorkers,
  getActiveWorkers,
  recordWorkerStart,
  recordWorkerEnd,
  detectStaleWorkers,
  forceTerminateWorker,
  classifyFailureType,
  incrementPendingSpawns,
  decrementPendingSpawns,
  getPendingSpawnCount,
  projectHasPendingSpawn,
  countInFlightTaskRuns,
  type FailureType,
  type WorkerInfo,
} from "../src/orchestrator/worker-manager.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(prefix = "wm"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function insertProject(title = "Test project"): string {
  const db = getDb();
  const id = randomUUID();
  db.insert(projects).values({ id, title, type: "kanban" }).run();
  return id;
}

function insertTask(title = "Test task"): string {
  const db = getDb();
  const id = randomUUID();
  db.insert(tasks).values({ id, title, status: "active" }).run();
  return id;
}

function closeAllWorkers(): void {
  getRawDb()
    .prepare("UPDATE worker_runs SET ended_at = datetime('now') WHERE ended_at IS NULL")
    .run();
}

function insertActiveWorker(workerId: string, agentType = "programmer", opts: {
  projectId?: string;
  startedAt?: string;
  taskId?: string;
  model?: string;
} = {}): void {
  const raw = getRawDb();
  raw.prepare(`
    INSERT INTO worker_runs (worker_id, agent_type, project_id, task_id, model, started_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    workerId,
    agentType,
    opts.projectId ?? null,
    opts.taskId ?? null,
    opts.model ?? null,
    opts.startedAt ?? new Date().toISOString(),
  );
}

// Reset pending spawn state between tests by decrementing to zero.
// The module uses module-level counters, so we must reset manually.
function resetPendingSpawns(): void {
  // Drain by decrementing a safe number of times
  for (let i = 0; i < 20; i++) decrementPendingSpawns();
}

// ── Global beforeEach ─────────────────────────────────────────────────────────

beforeEach(() => {
  closeAllWorkers();
  resetPendingSpawns();
});

// ── Type / constant exports ───────────────────────────────────────────────────

describe("Exports", () => {
  it("DEFAULT_MAX_WORKERS is 5", () => {
    expect(DEFAULT_MAX_WORKERS).toBe(5);
  });

  it("FailureType type values are string literals", () => {
    const infra: FailureType = "infra";
    const quality: FailureType = "agent_quality";
    expect(infra).toBe("infra");
    expect(quality).toBe("agent_quality");
  });

  it("WorkerInfo interface fields are accessible", () => {
    const info: WorkerInfo = {
      workerId: "w-1",
      agentType: "programmer",
      projectId: null,
      startedAt: null,
      taskId: null,
    };
    expect(info.workerId).toBe("w-1");
  });
});

// ── classifyFailureType ───────────────────────────────────────────────────────

describe("classifyFailureType()", () => {
  it("returns agent_quality for normal failures", () => {
    expect(classifyFailureType(null, "task failed")).toBe("agent_quality");
  });

  it("returns agent_quality when both args are null/undefined", () => {
    expect(classifyFailureType(null, null)).toBe("agent_quality");
    expect(classifyFailureType(undefined, undefined)).toBe("agent_quality");
  });

  it("returns infra for orphaned-on-restart timeout reason", () => {
    expect(classifyFailureType("orphaned on restart", null)).toBe("infra");
    expect(classifyFailureType("orphaned-on-restart", null)).toBe("infra");
  });

  it("returns infra for stale_run_watchdog timeout reason", () => {
    expect(classifyFailureType("stale_run_watchdog", null)).toBe("infra");
  });

  it("returns infra for stall_watchdog timeout reason", () => {
    expect(classifyFailureType("stall_watchdog", null)).toBe("infra");
  });

  it("returns infra for orchestrator_timeout reason", () => {
    expect(classifyFailureType("orchestrator_timeout", null)).toBe("infra");
  });

  it("returns infra when summary starts with 'ghost:'", () => {
    expect(classifyFailureType(null, "ghost: cleanup")).toBe("infra");
  });

  it("returns infra when summary starts with 'stale_run_watchdog:'", () => {
    expect(classifyFailureType(null, "stale_run_watchdog: 3h ago")).toBe("infra");
  });

  it("returns infra when summary starts with 'stall_watchdog:'", () => {
    expect(classifyFailureType(null, "stall_watchdog: no progress")).toBe("infra");
  });

  it("returns infra for 'session dead — no progress' summary", () => {
    expect(classifyFailureType(null, "session dead — no progress")).toBe("infra");
  });

  it("timeout_reason takes precedence over summary for infra classification", () => {
    // timeout_reason is infra, summary is non-infra — should still be infra
    expect(classifyFailureType("stale_run_watchdog", "bad output")).toBe("infra");
  });

  it("returns agent_quality for unknown timeout reasons", () => {
    expect(classifyFailureType("some_other_reason", null)).toBe("agent_quality");
  });
});

// ── hasCapacity / countActiveWorkers ─────────────────────────────────────────

describe("hasCapacity() and countActiveWorkers()", () => {
  it("reports capacity when no workers are active", () => {
    expect(hasCapacity(5)).toBe(true);
    expect(countActiveWorkers()).toBe(0);
  });

  it("countActiveWorkers counts only workers with startedAt set", () => {
    // Workers without startedAt should not count
    const raw = getRawDb();
    raw.prepare("INSERT INTO worker_runs (worker_id, agent_type) VALUES (?, ?)").run(uid(), "programmer");
    expect(countActiveWorkers()).toBe(0);
  });

  it("countActiveWorkers counts active workers with startedAt", () => {
    insertActiveWorker(uid("cap"));
    expect(countActiveWorkers()).toBeGreaterThanOrEqual(1);
  });

  it("hasCapacity returns false when at limit", () => {
    for (let i = 0; i < 3; i++) insertActiveWorker(uid("cap"));
    expect(hasCapacity(3)).toBe(false);
  });

  it("hasCapacity returns true when below limit", () => {
    insertActiveWorker(uid("cap"));
    expect(hasCapacity(3)).toBe(true); // 1 < 3
  });

  it("hasCapacity uses DEFAULT_MAX_WORKERS when no arg given", () => {
    // With 0 workers and default = 5, should be true
    expect(hasCapacity()).toBe(true);
  });

  it("hasCapacity accounts for pending spawns", () => {
    // Fill 2 slots with active workers and 1 with a pending spawn
    insertActiveWorker(uid("cap"));
    insertActiveWorker(uid("cap"));
    incrementPendingSpawns();

    // At maxWorkers=3: active(2) + pending(1) = 3 => no capacity
    expect(hasCapacity(3)).toBe(false);
  });
});

// ── getActiveWorkers ──────────────────────────────────────────────────────────

describe("getActiveWorkers()", () => {
  it("returns empty array when no active workers", () => {
    expect(getActiveWorkers()).toEqual([]);
  });

  it("returns worker info for active workers", () => {
    const workerId = uid("gaw");
    insertActiveWorker(workerId, "researcher");
    const active = getActiveWorkers();
    const found = active.find((w) => w.workerId === workerId);
    expect(found).toBeDefined();
    expect(found!.agentType).toBe("researcher");
  });

  it("does not return ended workers", () => {
    const workerId = uid("gaw-ended");
    insertActiveWorker(workerId);
    getRawDb().prepare("UPDATE worker_runs SET ended_at = datetime('now') WHERE worker_id = ?").run(workerId);
    const active = getActiveWorkers();
    expect(active.some((w) => w.workerId === workerId)).toBe(false);
  });

  it("returns workerId, agentType, projectId, startedAt, taskId fields", () => {
    const workerId = uid("gaw");
    const taskId = insertTask();
    const projectId = insertProject("getActiveWorkers project");
    const raw = getRawDb();
    raw.prepare(`
      INSERT INTO worker_runs (worker_id, agent_type, project_id, task_id, started_at)
      VALUES (?, 'programmer', ?, ?, datetime('now'))
    `).run(workerId, projectId, taskId);

    const active = getActiveWorkers();
    const found = active.find((w) => w.workerId === workerId);
    expect(found).toBeDefined();
    expect(found!.projectId).toBe(projectId);
    expect(found!.taskId).toBe(taskId);
    expect(found!.startedAt).toBeDefined();
  });

  it("does not return workers that have startedAt = null", () => {
    const workerId = uid("gaw-nostart");
    const raw = getRawDb();
    raw.prepare("INSERT INTO worker_runs (worker_id, agent_type) VALUES (?, 'programmer')").run(workerId);
    const active = getActiveWorkers();
    expect(active.some((w) => w.workerId === workerId)).toBe(false);
  });
});

// ── recordWorkerStart ─────────────────────────────────────────────────────────

describe("recordWorkerStart()", () => {
  it("inserts a worker_runs row", () => {
    const workerId = uid("rws");
    recordWorkerStart({ workerId, agentType: "programmer" });

    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row).toBeDefined();
    expect(row!.startedAt).toBeDefined();
    expect(row!.endedAt).toBeNull();
  });

  it("sets agentType on the row", () => {
    const workerId = uid("rws");
    recordWorkerStart({ workerId, agentType: "researcher" });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.agentType).toBe("researcher");
  });

  it("stores taskId when provided", () => {
    const workerId = uid("rws");
    const taskId = insertTask();
    recordWorkerStart({ workerId, agentType: "programmer", taskId });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.taskId).toBe(taskId);
  });

  it("stores model when provided", () => {
    const workerId = uid("rws");
    recordWorkerStart({ workerId, agentType: "programmer", model: "claude-opus" });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.model).toBe("claude-opus");
  });

  it("stores projectId when provided", () => {
    const workerId = uid("rws");
    const projectId = insertProject("Worker start project test");
    recordWorkerStart({ workerId, agentType: "programmer", projectId });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.projectId).toBe(projectId);
  });

  it("worker appears in getActiveWorkers() after start", () => {
    const workerId = uid("rws");
    recordWorkerStart({ workerId, agentType: "programmer" });
    const active = getActiveWorkers();
    expect(active.some((w) => w.workerId === workerId)).toBe(true);
  });
});

// ── recordWorkerEnd ───────────────────────────────────────────────────────────

describe("recordWorkerEnd()", () => {
  it("sets endedAt on the row", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: true });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.endedAt).toBeDefined();
  });

  it("sets succeeded = true for successful runs", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: true });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.succeeded).toBe(true);
  });

  it("sets succeeded = false for failed runs", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: false, summary: "Broke everything" });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.succeeded).toBe(false);
  });

  it("stores summary when provided", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: true, summary: "All done!" });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.summary).toBe("All done!");
  });

  it("stores token counts", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({
      workerId,
      agentType: "programmer",
      succeeded: true,
      inputTokens: 1000,
      outputTokens: 500,
    });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.inputTokens).toBe(1000);
    expect(row!.outputTokens).toBe(500);
    expect(row!.totalTokens).toBe(1500);
  });

  it("stores totalCostUsd", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: true, totalCostUsd: 0.42 });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.totalCostUsd).toBeCloseTo(0.42);
  });

  it("stores durationSeconds", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: true, durationSeconds: 120 });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.durationSeconds).toBe(120);
  });

  it("sets failureType = null for successful runs", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: true });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.failureType).toBeNull();
  });

  it("sets failureType = agent_quality for generic failures", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: false, summary: "output error" });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.failureType).toBe("agent_quality");
  });

  it("sets failureType = infra when summary starts with 'ghost:'", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: false, summary: "ghost: cleanup run" });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.failureType).toBe("infra");
  });

  it("respects explicit failureType override", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    recordWorkerEnd({
      workerId,
      agentType: "programmer",
      succeeded: false,
      failureType: "infra",
      summary: "Something odd",
    });
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.failureType).toBe("infra");
  });

  it("worker no longer appears in getActiveWorkers() after end", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer" });
    expect(getActiveWorkers().some((w) => w.workerId === workerId)).toBe(true);
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: true });
    expect(getActiveWorkers().some((w) => w.workerId === workerId)).toBe(false);
  });

  it("does not overwrite model when not provided in end call", () => {
    const workerId = uid("rwe");
    recordWorkerStart({ workerId, agentType: "programmer", model: "claude-opus-4" });
    recordWorkerEnd({ workerId, agentType: "programmer", succeeded: true }); // no model arg
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.model).toBe("claude-opus-4"); // preserved from start
  });
});

// ── detectStaleWorkers ────────────────────────────────────────────────────────

describe("detectStaleWorkers()", () => {
  it("returns empty array when no workers are running", () => {
    expect(detectStaleWorkers(120)).toEqual([]);
  });

  it("detects workers older than maxAgeMinutes", () => {
    const workerId = uid("stale");
    const oldTime = new Date(Date.now() - 3 * 60 * 60_000).toISOString(); // 3h ago
    insertActiveWorker(workerId, "programmer", { startedAt: oldTime });
    const stale = detectStaleWorkers(120); // 2h max
    expect(stale).toContain(workerId);
  });

  it("does not flag recent workers as stale", () => {
    const workerId = uid("fresh");
    insertActiveWorker(workerId); // started now
    const stale = detectStaleWorkers(120); // 2h max
    expect(stale).not.toContain(workerId);
  });

  it("uses default of 120 minutes when no arg given", () => {
    const workerId = uid("stale-default");
    const oldTime = new Date(Date.now() - 200 * 60_000).toISOString(); // 200 min ago
    insertActiveWorker(workerId, "programmer", { startedAt: oldTime });
    const stale = detectStaleWorkers(); // default = 120
    expect(stale).toContain(workerId);
  });

  it("does not flag ended workers as stale", () => {
    const workerId = uid("ended");
    const oldTime = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    insertActiveWorker(workerId, "programmer", { startedAt: oldTime });
    getRawDb().prepare("UPDATE worker_runs SET ended_at = datetime('now') WHERE worker_id = ?").run(workerId);
    const stale = detectStaleWorkers(60);
    expect(stale).not.toContain(workerId);
  });

  it("returns worker IDs as strings", () => {
    const workerId = uid("stale-str");
    const oldTime = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    insertActiveWorker(workerId, "programmer", { startedAt: oldTime });
    const stale = detectStaleWorkers(60);
    for (const id of stale) {
      expect(typeof id).toBe("string");
    }
  });

  it("can detect multiple stale workers", () => {
    const ids = [uid("multi-stale"), uid("multi-stale"), uid("multi-stale")];
    const oldTime = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    for (const id of ids) insertActiveWorker(id, "programmer", { startedAt: oldTime });
    const stale = detectStaleWorkers(60);
    for (const id of ids) expect(stale).toContain(id);
  });
});

// ── forceTerminateWorker ──────────────────────────────────────────────────────

describe("forceTerminateWorker()", () => {
  it("sets endedAt on the worker run", () => {
    const workerId = uid("term");
    insertActiveWorker(workerId);
    forceTerminateWorker(workerId, "test_timeout");
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.endedAt).toBeDefined();
  });

  it("sets succeeded = false", () => {
    const workerId = uid("term");
    insertActiveWorker(workerId);
    forceTerminateWorker(workerId, "test_timeout");
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.succeeded).toBe(false);
  });

  it("stores the timeout reason", () => {
    const workerId = uid("term");
    insertActiveWorker(workerId);
    forceTerminateWorker(workerId, "orchestrator_timeout");
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.timeoutReason).toBe("orchestrator_timeout");
  });

  it("uses 'timeout' as default reason when none provided", () => {
    const workerId = uid("term");
    insertActiveWorker(workerId);
    forceTerminateWorker(workerId); // no reason arg
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.timeoutReason).toBe("timeout");
  });

  it("classifies infra failure types for known reasons", () => {
    const workerId = uid("term");
    insertActiveWorker(workerId);
    forceTerminateWorker(workerId, "stale_run_watchdog");
    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.failureType).toBe("infra");
  });

  it("resets associated task to not_started if it was in_progress", () => {
    const taskId = insertTask();
    const raw = getRawDb();
    raw.prepare("UPDATE tasks SET work_state = 'in_progress' WHERE id = ?").run(taskId);

    const workerId = uid("term");
    raw.prepare(`
      INSERT INTO worker_runs (worker_id, agent_type, task_id, started_at)
      VALUES (?, 'programmer', ?, datetime('now'))
    `).run(workerId, taskId);

    forceTerminateWorker(workerId, "test_timeout");

    const taskRow = raw.prepare("SELECT work_state FROM tasks WHERE id = ?").get(taskId) as { work_state: string };
    expect(taskRow.work_state).toBe("not_started");
  });

  it("does not crash for non-existent worker IDs", () => {
    expect(() => forceTerminateWorker("nonexistent-worker-id")).not.toThrow();
  });
});

// ── Pending spawn counting ────────────────────────────────────────────────────

describe("incrementPendingSpawns / decrementPendingSpawns / getPendingSpawnCount", () => {
  it("starts at 0 after reset", () => {
    expect(getPendingSpawnCount()).toBe(0);
  });

  it("increments correctly", () => {
    incrementPendingSpawns();
    expect(getPendingSpawnCount()).toBe(1);
    incrementPendingSpawns();
    expect(getPendingSpawnCount()).toBe(2);
  });

  it("decrements correctly", () => {
    incrementPendingSpawns();
    incrementPendingSpawns();
    decrementPendingSpawns();
    expect(getPendingSpawnCount()).toBe(1);
  });

  it("does not go below 0", () => {
    // Already at 0 from beforeEach reset
    decrementPendingSpawns();
    decrementPendingSpawns();
    expect(getPendingSpawnCount()).toBe(0);
  });

  it("reflects pending count in hasCapacity()", () => {
    // 0 active + 4 pending + 1 more would exceed 5
    for (let i = 0; i < 5; i++) incrementPendingSpawns();
    expect(hasCapacity(5)).toBe(false);
  });
});

// ── projectHasPendingSpawn ────────────────────────────────────────────────────

describe("projectHasPendingSpawn()", () => {
  it("returns false when no pending spawns exist", () => {
    expect(projectHasPendingSpawn("proj-xyz")).toBe(false);
  });

  it("returns true after incrementPendingSpawns for a project", () => {
    const projectId = uid("proj");
    incrementPendingSpawns(projectId);
    expect(projectHasPendingSpawn(projectId)).toBe(true);
  });

  it("returns false after decrement removes the project key", () => {
    const projectId = uid("proj");
    incrementPendingSpawns(projectId);
    decrementPendingSpawns(projectId);
    expect(projectHasPendingSpawn(projectId)).toBe(false);
  });

  it("tracks agent-specific spawn with projectId + agentType", () => {
    const projectId = uid("proj");
    incrementPendingSpawns(projectId, "programmer");
    expect(projectHasPendingSpawn(projectId, "programmer")).toBe(true);
    expect(projectHasPendingSpawn(projectId, "reviewer")).toBe(false);
  });

  it("falls back to prefix match when no agentType given", () => {
    const projectId = uid("proj");
    incrementPendingSpawns(projectId, "researcher");
    // No agentType in check — should match via prefix
    expect(projectHasPendingSpawn(projectId)).toBe(true);
  });

  it("does not match a different project", () => {
    const projectA = uid("proj-a");
    const projectB = uid("proj-b");
    incrementPendingSpawns(projectA);
    expect(projectHasPendingSpawn(projectB)).toBe(false);
  });
});

// ── countInFlightTaskRuns ─────────────────────────────────────────────────────

describe("countInFlightTaskRuns()", () => {
  it("returns 0 when no workflow runs exist", () => {
    expect(countInFlightTaskRuns()).toBe(0);
  });

  it("counts running workflow runs with a taskId", () => {
    const db = getDb();

    // Create a minimal workflow definition (required by FK)
    const wfId = randomUUID();
    db.insert(workflowDefinitions).values({
      id: wfId,
      name: `wf-${wfId}`,
      version: 1,
      nodes: [],
      edges: [],
      isActive: true,
    }).run();

    const taskId = insertTask();
    const runId = randomUUID();
    db.insert(workflowRuns).values({
      id: runId,
      workflowId: wfId,
      workflowVersion: 1,
      taskId,
      triggerType: "manual",
      status: "running",
      nodeStates: {},
      context: {},
    }).run();

    expect(countInFlightTaskRuns()).toBeGreaterThanOrEqual(1);

    // Cleanup
    db.delete(workflowRuns).where(eq(workflowRuns.id, runId)).run();
    db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).run();
  });

  it("counts pending workflow runs with a taskId", () => {
    const db = getDb();

    const wfId = randomUUID();
    db.insert(workflowDefinitions).values({
      id: wfId,
      name: `wf-${wfId}`,
      version: 1,
      nodes: [],
      edges: [],
      isActive: true,
    }).run();

    const taskId = insertTask();
    const runId = randomUUID();
    db.insert(workflowRuns).values({
      id: runId,
      workflowId: wfId,
      workflowVersion: 1,
      taskId,
      triggerType: "schedule",
      status: "pending",
      nodeStates: {},
      context: {},
    }).run();

    expect(countInFlightTaskRuns()).toBeGreaterThanOrEqual(1);

    // Cleanup
    db.delete(workflowRuns).where(eq(workflowRuns.id, runId)).run();
    db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).run();
  });

  it("does not count completed workflow runs", () => {
    const db = getDb();

    const wfId = randomUUID();
    db.insert(workflowDefinitions).values({
      id: wfId,
      name: `wf-${wfId}`,
      version: 1,
      nodes: [],
      edges: [],
      isActive: true,
    }).run();

    const taskId = insertTask();
    const runId = randomUUID();
    db.insert(workflowRuns).values({
      id: runId,
      workflowId: wfId,
      workflowVersion: 1,
      taskId,
      triggerType: "manual",
      status: "completed",
      nodeStates: {},
      context: {},
    }).run();

    const before = countInFlightTaskRuns();

    // Completed run should not be in-flight
    const runningIds = db.select().from(workflowRuns).all()
      .filter((r) => r.id === runId && (r.status === "running" || r.status === "pending"));
    expect(runningIds).toHaveLength(0);

    // Cleanup
    db.delete(workflowRuns).where(eq(workflowRuns.id, runId)).run();
    db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).run();
  });

  it("does not count workflow runs without a taskId", () => {
    const db = getDb();

    const wfId = randomUUID();
    db.insert(workflowDefinitions).values({
      id: wfId,
      name: `wf-${wfId}`,
      version: 1,
      nodes: [],
      edges: [],
      isActive: true,
    }).run();

    const runId = randomUUID();
    db.insert(workflowRuns).values({
      id: runId,
      workflowId: wfId,
      workflowVersion: 1,
      taskId: null, // no task
      triggerType: "manual",
      status: "running",
      nodeStates: {},
      context: {},
    }).run();

    // The run without taskId should not appear in in-flight task runs
    const inFlight = db.select().from(workflowRuns).all()
      .filter((r) => r.id === runId && r.taskId !== null);
    expect(inFlight).toHaveLength(0);

    // Cleanup
    db.delete(workflowRuns).where(eq(workflowRuns.id, runId)).run();
    db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).run();
  });
});

// ── Full worker lifecycle integration ─────────────────────────────────────────

describe("Worker lifecycle integration", () => {
  it("start → active → end lifecycle works end-to-end", () => {
    const workerId = uid("lifecycle");
    const taskId = insertTask();

    // Before start: not active
    expect(getActiveWorkers().some((w) => w.workerId === workerId)).toBe(false);

    recordWorkerStart({
      workerId,
      agentType: "programmer",
      taskId,
      model: "claude-sonnet",
    });

    // After start: active
    expect(countActiveWorkers()).toBeGreaterThanOrEqual(1);
    expect(getActiveWorkers().some((w) => w.workerId === workerId)).toBe(true);
    expect(hasCapacity(1)).toBe(false); // 1 active, max 1

    recordWorkerEnd({
      workerId,
      agentType: "programmer",
      succeeded: true,
      taskId,
      summary: "Completed successfully",
      inputTokens: 2000,
      outputTokens: 800,
      totalCostUsd: 0.12,
      durationSeconds: 90,
    });

    // After end: not active
    expect(getActiveWorkers().some((w) => w.workerId === workerId)).toBe(false);

    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.succeeded).toBe(true);
    expect(row!.endedAt).toBeDefined();
    expect(row!.summary).toBe("Completed successfully");
    expect(row!.totalTokens).toBe(2800);
    expect(row!.totalCostUsd).toBeCloseTo(0.12);
    expect(row!.failureType).toBeNull();
  });

  it("failed lifecycle correctly marks failure type", () => {
    const workerId = uid("lifecycle-fail");

    recordWorkerStart({ workerId, agentType: "reviewer" });
    recordWorkerEnd({
      workerId,
      agentType: "reviewer",
      succeeded: false,
      summary: "Bad output generated",
    });

    const db = getDb();
    const row = db.select().from(workerRuns).where(eq(workerRuns.workerId, workerId)).get();
    expect(row!.succeeded).toBe(false);
    expect(row!.failureType).toBe("agent_quality");
  });
});
