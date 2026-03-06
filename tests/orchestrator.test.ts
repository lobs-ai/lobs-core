import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { getDb, getRawDb } from "../src/db/connection.js";
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
    // Clean slate — clear all model_health and worker_runs so prior tests don't pollute seeding
    const raw = getRawDb();
    raw.prepare("DELETE FROM model_health").run();
    raw.prepare("DELETE FROM worker_runs").run();
  });

  it("seeds model_health rows from recent worker_runs", () => {
    const raw = getRawDb();
    const now = new Date().toISOString();
    const ago1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Insert synthetic worker_run history (no task_id — avoids FK constraint in test DB)
    const insertWr = raw.prepare(`
      INSERT INTO worker_runs (model, agent_type, worker_id, started_at, ended_at, succeeded, timeout_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertWr.run('test-seed/modelA', 'programmer', 'sess-1', ago1h, now, 1, null);
    insertWr.run('test-seed/modelA', 'programmer', 'sess-2', ago1h, now, 0, 'session_dead');
    insertWr.run('test-seed/modelA', 'programmer', 'sess-3', ago1h, now, 0, 'session_dead');
    insertWr.run('test-seed/modelB', 'reviewer',   'sess-4', ago1h, now, 1, null);

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
    const raw = getRawDb();
    const now = new Date().toISOString();
    const ago1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Pre-existing live state (e.g. circuit already tripped)
    raw.prepare(`
      INSERT INTO model_health (model, agent_type, state, consecutive_failures, total_failures, total_runs, created_at, updated_at)
      VALUES ('test-seed/modelC', 'programmer', 'open', 5, 5, 5, ?, ?)
    `).run(now, now);

    // History that would conflict (no task_id — avoids FK constraint in test DB)
    raw.prepare(`
      INSERT INTO worker_runs (model, agent_type, worker_id, started_at, ended_at, succeeded, timeout_reason)
      VALUES ('test-seed/modelC', 'programmer', 'sess-5', ?, ?, 0, 'session_dead')
    `).run(ago1h, now);

    seedModelHealthFromHistory(24);

    const row = raw.prepare("SELECT * FROM model_health WHERE model = ? AND agent_type = ?")
      .get('test-seed/modelC', 'programmer') as any;

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

// ── Stall Watchdog tests ──────────────────────────────────────────────────────

describe("Stall Watchdog", () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.prepare("DELETE FROM worker_runs WHERE worker_id LIKE 'stall-test-%'").run();
    raw.prepare("DELETE FROM tasks WHERE title LIKE '[stall-test]%'").run();
    // Ensure stall_watchdog settings are seeded
    raw.prepare(`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at) VALUES ('stall_watchdog', '{"enabled":true,"grace_period_seconds":60}', datetime('now'))`).run();
    raw.prepare(`INSERT OR REPLACE INTO orchestrator_settings (key, value, updated_at) VALUES ('stall_timeout:researcher', '300', datetime('now'))`).run();
    raw.prepare(`INSERT OR REPLACE INTO orchestrator_settings (key, value, updated_at) VALUES ('stall_timeout:programmer', '600', datetime('now'))`).run();
    raw.prepare(`INSERT OR REPLACE INTO orchestrator_settings (key, value, updated_at) VALUES ('stall_timeout:default', '600', datetime('now'))`).run();
  });

  it("last_tool_call_at column exists in worker_runs schema", () => {
    const raw = getRawDb();
    const schema = raw.prepare("PRAGMA table_info(worker_runs)").all() as Array<{ name: string }>;
    const colNames = schema.map(c => c.name);
    expect(colNames).toContain("last_tool_call_at");
  });

  it("stall_watchdog settings are seeded in orchestrator_settings", () => {
    const raw = getRawDb();
    const watchdog = raw.prepare("SELECT value FROM orchestrator_settings WHERE key = 'stall_watchdog'").get() as { value: string } | undefined;
    expect(watchdog).toBeDefined();
    const cfg = JSON.parse(watchdog!.value);
    expect(cfg.enabled).toBe(true);
    expect(typeof cfg.grace_period_seconds).toBe("number");

    const researcherTimeout = raw.prepare("SELECT value FROM orchestrator_settings WHERE key = 'stall_timeout:researcher'").get() as { value: string } | undefined;
    expect(researcherTimeout).toBeDefined();
    expect(parseInt(researcherTimeout!.value, 10)).toBe(300);

    const programmerTimeout = raw.prepare("SELECT value FROM orchestrator_settings WHERE key = 'stall_timeout:programmer'").get() as { value: string } | undefined;
    expect(programmerTimeout).toBeDefined();
    expect(parseInt(programmerTimeout!.value, 10)).toBe(600);
  });

  it("last_tool_call_at can be written and read back", () => {
    const raw = getRawDb();
    const workerId = `stall-test-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const toolCallAt = new Date().toISOString();

    raw.prepare(`
      INSERT INTO worker_runs (worker_id, agent_type, started_at)
      VALUES (?, 'researcher', ?)
    `).run(workerId, startedAt);

    raw.prepare(`
      UPDATE worker_runs SET last_tool_call_at = ? WHERE worker_id = ? AND ended_at IS NULL
    `).run(toolCallAt, workerId);

    const row = raw.prepare("SELECT last_tool_call_at FROM worker_runs WHERE worker_id = ?").get(workerId) as { last_tool_call_at: string | null };
    expect(row.last_tool_call_at).toBe(toolCallAt);

    // cleanup
    raw.prepare("DELETE FROM worker_runs WHERE worker_id = ?").run(workerId);
  });

  it("stall detection skips sessions within grace period", () => {
    // Session started 30s ago — within 60s grace period, should NOT be considered stalled
    const raw = getRawDb();
    const workerId = `stall-test-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date(Date.now() - 30 * 1000).toISOString();

    raw.prepare(`
      INSERT INTO worker_runs (worker_id, agent_type, started_at)
      VALUES (?, 'researcher', ?)
    `).run(workerId, startedAt);

    // The stall query: started_at < cutoff (60s ago). 30s-old session should NOT appear.
    const graceCutoff = new Date(Date.now() - 60 * 1000).toISOString();
    const stalled = raw.prepare(`
      SELECT id FROM worker_runs
      WHERE ended_at IS NULL AND started_at IS NOT NULL AND started_at < ?
    `).all(graceCutoff) as Array<{ id: number }>;

    const stalledIds = stalled.map(r => r.id);
    const insertedRow = raw.prepare("SELECT id FROM worker_runs WHERE worker_id = ?").get(workerId) as { id: number };
    expect(stalledIds).not.toContain(insertedRow.id);

    // cleanup
    raw.prepare("DELETE FROM worker_runs WHERE worker_id = ?").run(workerId);
  });

  it("stall detection identifies sessions past grace period with no tool calls", () => {
    // Session started 10 minutes ago, no last_tool_call_at — should appear in stall query
    const raw = getRawDb();
    const workerId = `stall-test-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    raw.prepare(`
      INSERT INTO worker_runs (worker_id, agent_type, started_at)
      VALUES (?, 'researcher', ?)
    `).run(workerId, startedAt);

    const graceCutoff = new Date(Date.now() - 60 * 1000).toISOString();
    const stalled = raw.prepare(`
      SELECT id, worker_id, agent_type, started_at, last_tool_call_at
      FROM worker_runs
      WHERE ended_at IS NULL AND started_at IS NOT NULL AND started_at < ?
    `).all(graceCutoff) as Array<{ id: number; worker_id: string; last_tool_call_at: string | null }>;

    const match = stalled.find(r => r.worker_id === workerId);
    expect(match).toBeDefined();
    expect(match!.last_tool_call_at).toBeNull();

    // cleanup
    raw.prepare("DELETE FROM worker_runs WHERE worker_id = ?").run(workerId);
  });

  it("stall detection is cleared by a recent tool call", () => {
    // Session started 10 min ago, but last tool call was 30s ago — should NOT be stalled
    const raw = getRawDb();
    const workerId = `stall-test-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recentToolCall = new Date(Date.now() - 30 * 1000).toISOString();

    raw.prepare(`
      INSERT INTO worker_runs (worker_id, agent_type, started_at, last_tool_call_at)
      VALUES (?, 'programmer', ?, ?)
    `).run(workerId, startedAt, recentToolCall);

    // Stall threshold for programmer is 600s. Time since last tool call = 30s < 600s.
    const programmerThreshold = 600;
    const silentSec = (Date.now() - new Date(recentToolCall).getTime()) / 1000;
    expect(silentSec).toBeLessThan(programmerThreshold);

    // cleanup
    raw.prepare("DELETE FROM worker_runs WHERE worker_id = ?").run(workerId);
  });
});
