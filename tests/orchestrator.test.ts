import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../src/db/connection.js";
import { tasks, projects, workerRuns, agentStatus as agentStatusTable } from "../src/db/schema.js";
import {
  hasCapacity,
  countActiveWorkers,
  getActiveWorkers,
  projectHasActiveWorker,
  recordWorkerStart,
  recordWorkerEnd,
  detectStaleWorkers,
  forceTerminateWorker,
} from "../src/orchestrator/worker-manager.js";
import { findReadyTasks, findRetryableTasks } from "../src/orchestrator/scanner.js";
import {
  chooseModel,
  resolveTaskTier,
  escalationModel,
  type ModelTier,
} from "../src/orchestrator/model-chooser.js";

describe("Worker Manager", () => {
  it("should report capacity when no workers active", () => {
    expect(hasCapacity(3)).toBe(true);
    expect(countActiveWorkers()).toBeGreaterThanOrEqual(0);
  });

  it("should track worker start and end", () => {
    const workerId = `worker-${randomUUID().slice(0, 8)}`;
    const taskId = randomUUID();
    const db = getDb();
    db.insert(tasks).values({ id: taskId, title: "Tracked task", status: "active" }).run();

    recordWorkerStart({
      workerId,
      agentType: "programmer",
      taskId,
      model: "anthropic/claude-sonnet-4-5",
    });

    const active = getActiveWorkers();
    expect(active.some(w => w.workerId === workerId)).toBe(true);

    // Agent status should be busy
    const status = db.select().from(agentStatusTable)
      .where(eq(agentStatusTable.agentType, "programmer")).get();
    expect(status?.status).toBe("busy");

    recordWorkerEnd({
      workerId,
      agentType: "programmer",
      succeeded: true,
      taskId,
      summary: "Fixed it",
      durationSeconds: 120,
    });

    // Worker should no longer be active
    const run = db.select().from(workerRuns)
      .where(eq(workerRuns.workerId, workerId)).get()!;
    expect(run.endedAt).toBeDefined();
    expect(run.succeeded).toBe(true);
  });

  it("should enforce project domain lock", () => {
    const projId = randomUUID();
    const db = getDb();
    db.insert(projects).values({ id: projId, title: "Locked Project", type: "kanban" }).run();

    const workerId = `lock-${randomUUID().slice(0, 8)}`;
    db.insert(workerRuns).values({
      workerId,
      agentType: "programmer",
      projectId: projId,
      startedAt: new Date().toISOString(),
    }).run();

    expect(projectHasActiveWorker(projId)).toBe(true);
  });

  it("should detect stale workers", () => {
    const db = getDb();
    const staleId = `stale-${randomUUID().slice(0, 8)}`;
    const oldTime = new Date(Date.now() - 3 * 60 * 60_000).toISOString(); // 3h ago

    db.insert(workerRuns).values({
      workerId: staleId,
      agentType: "writer",
      startedAt: oldTime,
    }).run();

    const stale = detectStaleWorkers(120); // 2h max
    expect(stale).toContain(staleId);
  });

  it("should force-terminate a worker", () => {
    const db = getDb();
    const workerId = `term-${randomUUID().slice(0, 8)}`;
    db.insert(workerRuns).values({
      workerId,
      agentType: "researcher",
      startedAt: new Date().toISOString(),
    }).run();

    forceTerminateWorker(workerId, "test_timeout");

    const run = db.select().from(workerRuns)
      .where(eq(workerRuns.workerId, workerId)).get()!;
    expect(run.endedAt).toBeDefined();
    expect(run.succeeded).toBe(false);
    expect(run.timeoutReason).toBe("test_timeout");
  });
});

describe("Scanner", () => {
  it("should find ready tasks", () => {
    const db = getDb();
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Ready task",
      status: "active",
      workState: "not_started",
      agent: "programmer",
    }).run();

    const ready = findReadyTasks(10);
    expect(ready.some(t => t.id === taskId)).toBe(true);
  });

  it("should not include tasks without agents", () => {
    const db = getDb();
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "No agent",
      status: "active",
      workState: "not_started",
      // No agent assigned
    }).run();

    const ready = findReadyTasks(100);
    expect(ready.some(t => t.id === taskId)).toBe(false);
  });

  it("should find retryable tasks", () => {
    const db = getDb();
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Blocked task",
      status: "active",
      workState: "blocked",
      agent: "programmer",
      retryCount: 1,
    }).run();

    const retryable = findRetryableTasks(10);
    expect(retryable.some(t => t.id === taskId)).toBe(true);
  });

  it("should not retry tasks with 3+ retries", () => {
    const db = getDb();
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Too many retries",
      status: "active",
      workState: "blocked",
      agent: "programmer",
      retryCount: 3,
    }).run();

    const retryable = findRetryableTasks(100);
    expect(retryable.some(t => t.id === taskId)).toBe(false);
  });
});

describe("Model Chooser", () => {
  it("should resolve model for each tier", () => {
    const tiers: ModelTier[] = ["micro", "small", "medium", "standard", "strong"];
    for (const tier of tiers) {
      const choice = chooseModel(tier);
      expect(choice.model).toBeDefined();
      expect(choice.tier).toBe(tier);
    }
  });

  it("should use agent default when no tier specified", () => {
    const choice = chooseModel(undefined, "architect");
    expect(choice.tier).toBe("strong");
  });

  it("should fallback to standard for unknown agent", () => {
    const choice = chooseModel(undefined, "unknown-agent");
    expect(choice.tier).toBe("standard");
  });

  it("should resolve task tier from task metadata", () => {
    expect(resolveTaskTier({ model_tier: "micro" })).toBe("micro");
    expect(resolveTaskTier({ agent: "architect" })).toBe("strong");
    expect(resolveTaskTier({})).toBe("standard");
  });

  it("should escalate to next tier", () => {
    const escalated = escalationModel("small");
    expect(escalated.tier).toBe("medium");
  });

  it("should not escalate beyond strong", () => {
    const escalated = escalationModel("strong");
    expect(escalated.tier).toBe("strong");
  });
});
