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
import { queueReviewerFollowup } from "../src/hooks/subagent.js";
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



describe("Reviewer auto-followup", () => {
  it("queues a reviewer task for completed programmer output", () => {
    const db = getDb();
    const projectId = randomUUID();
    const sourceTaskId = randomUUID();

    db.insert(projects).values({
      id: projectId,
      title: "PAW",
      type: "kanban",
      repoPath: "/tmp/paw-output",
    }).run();

    db.insert(tasks).values({
      id: sourceTaskId,
      title: "Implement feature X",
      status: "completed",
      workState: "done",
      agent: "programmer",
      projectId,
    }).run();

    queueReviewerFollowup(sourceTaskId);

    const reviewTask = db.select().from(tasks).where(and(
      eq(tasks.externalSource, "auto-review"),
      eq(tasks.externalId, sourceTaskId),
    )).get();

    expect(reviewTask).toBeDefined();
    expect(reviewTask?.agent).toBe("reviewer");
    expect(reviewTask?.status).toBe("active");
    expect(reviewTask?.artifactPath).toBe("/tmp/paw-output");
    expect(reviewTask?.notes).toContain("Scope directory: /tmp/paw-output");
  });

  it("does not create duplicate reviewer follow-up tasks", () => {
    const db = getDb();
    const sourceTaskId = randomUUID();

    db.insert(tasks).values({
      id: sourceTaskId,
      title: "Fix bug Y",
      status: "completed",
      workState: "done",
      agent: "programmer",
    }).run();

    queueReviewerFollowup(sourceTaskId);
    queueReviewerFollowup(sourceTaskId);

    const reviewTasks = db.select().from(tasks).where(and(
      eq(tasks.externalSource, "auto-review"),
      eq(tasks.externalId, sourceTaskId),
    )).all();

    expect(reviewTasks.length).toBe(1);
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

import {
  seedModelHealthFromHistory,
  recordRunOutcome,
  getHealthSnapshot,
  resetCircuit,
} from "../src/orchestrator/model-health.js";

describe("seedModelHealthFromHistory (Phase 4 boot seed)", () => {
  beforeEach(() => {
    // Clean slate
    const db = getDb() as any;
    db.prepare("DELETE FROM model_health").run();
    db.prepare("DELETE FROM worker_runs WHERE model LIKE 'test-seed/%'").run();
  });

  it("seeds model_health rows from recent worker_runs", () => {
    const db = getDb() as any;
    const now = new Date().toISOString();
    const ago1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Insert synthetic worker_run history
    db.prepare(`
      INSERT INTO worker_runs (id, model, agent_type, task_id, worker_id, started_at, ended_at, succeeded, timeout_reason)
      VALUES
        ('wr-seed-1', 'test-seed/modelA', 'programmer', 'task-1', 'sess-1', ?, ?, 1, NULL),
        ('wr-seed-2', 'test-seed/modelA', 'programmer', 'task-2', 'sess-2', ?, ?, 0, 'session_dead'),
        ('wr-seed-3', 'test-seed/modelA', 'programmer', 'task-3', 'sess-3', ?, ?, 0, 'session_dead'),
        ('wr-seed-4', 'test-seed/modelB', 'reviewer',   'task-4', 'sess-4', ?, ?, 1, NULL)
    `).run(ago1h, now, ago1h, now, ago1h, now, ago1h, now);

    seedModelHealthFromHistory(24);

    const snapshot = getHealthSnapshot();
    const modelA = snapshot.find(r => r.model === 'test-seed/modelA' && r.agentType === 'programmer');
    const modelB = snapshot.find(r => r.model === 'test-seed/modelB' && r.agentType === 'reviewer');

    expect(modelA).toBeDefined();
    expect(modelA!.totalRuns).toBe(3);
    expect(modelA!.totalFailures).toBe(2);
    expect(modelA!.consecutiveFailures).toBe(0); // boot seed never sets consecutive failures
    expect(modelA!.state).toBe('closed');         // starts closed; circuit engages from new runs

    expect(modelB).toBeDefined();
    expect(modelB!.totalRuns).toBe(1);
    expect(modelB!.totalFailures).toBe(0);
    expect(modelB!.state).toBe('closed');
  });

  it("does not overwrite existing model_health rows", () => {
    const db = getDb() as any;
    const now = new Date().toISOString();
    const ago1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Pre-existing live state (e.g. circuit already tripped)
    db.prepare(`
      INSERT INTO model_health (model, agent_type, state, consecutive_failures, total_failures, total_runs, created_at, updated_at)
      VALUES ('test-seed/modelC', 'programmer', 'open', 5, 5, 5, ?, ?)
    `).run(now, now);

    // History that would conflict
    db.prepare(`
      INSERT INTO worker_runs (id, model, agent_type, task_id, worker_id, started_at, ended_at, succeeded, timeout_reason)
      VALUES ('wr-seed-5', 'test-seed/modelC', 'programmer', 'task-5', 'sess-5', ?, ?, 0, 'session_dead')
    `).run(ago1h, now);

    seedModelHealthFromHistory(24);

    const row = db.prepare("SELECT * FROM model_health WHERE model = ? AND agent_type = ?")
      .get('test-seed/modelC', 'programmer');

    // Should NOT have been overwritten
    expect(row.state).toBe('open');
    expect(row.consecutive_failures).toBe(5);
  });

  it("is a no-op when worker_runs table is empty", () => {
    seedModelHealthFromHistory(24);
    const snapshot = getHealthSnapshot();
    expect(snapshot.length).toBe(0);
  });
});
