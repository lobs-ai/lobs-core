/**
 * Tests for src/orchestrator/scheduler.ts
 *
 * Covers:
 * - getSchedulerConfig() — defaults and DB override
 * - getDailyCost() / recordTaskCost() — cost tracking
 * - getNextTasks() — priority scoring, capacity limits, budget enforcement
 * - Type exports
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getRawDb } from "../src/db/connection.js";

// ── File-system mock ──────────────────────────────────────────────────────────
// The scheduler module stores COST_TRACKER_PATH as a module-level const
// computed at load time (join(HOME, ".lobs/config/daily-cost.json")).
// We mock node:fs so we can control what the module reads/writes without
// touching the real filesystem.

const mockFiles: Record<string, string> = {};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p in mockFiles) return true;
      return actual.existsSync(p);
    },
    readFileSync: (p: string, enc?: BufferEncoding | { encoding: BufferEncoding }) => {
      if (p in mockFiles) return mockFiles[p];
      return actual.readFileSync(p, enc as BufferEncoding);
    },
    writeFileSync: (p: string, data: string) => {
      if (typeof p === "string" && p.includes("daily-cost")) {
        mockFiles[p] = data;
        return;
      }
      return actual.writeFileSync(p, data);
    },
    mkdirSync: actual.mkdirSync,
    readdirSync: actual.readdirSync,
    rmSync: actual.rmSync,
  };
});

// Import module under test AFTER vi.mock declarations are hoisted
import {
  getSchedulerConfig,
  getDailyCost,
  recordTaskCost,
  getNextTasks,
  type SchedulerConfig,
  type Task,
  type DailyCostTracker,
} from "../src/orchestrator/scheduler.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get the actual COST_TRACKER_PATH the module uses (derived from real HOME) */
function getCostTrackerPath(): string {
  return Object.keys(mockFiles).find((k) => k.includes("daily-cost")) ??
    `${process.env.HOME}/.lobs/config/daily-cost.json`;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function yesterday(): string {
  return new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
}

function writeMockCostTracker(data: DailyCostTracker): void {
  // We need to write to the path the module resolves.
  // The module constant is: join(process.env.HOME ?? "", ".lobs/config/daily-cost.json")
  const path = `${process.env.HOME ?? ""}/.lobs/config/daily-cost.json`;
  mockFiles[path] = JSON.stringify(data, null, 2);
}

function readMockCostTracker(): DailyCostTracker {
  const path = `${process.env.HOME ?? ""}/.lobs/config/daily-cost.json`;
  return JSON.parse(mockFiles[path]) as DailyCostTracker;
}

function clearMockCostTracker(): void {
  const path = `${process.env.HOME ?? ""}/.lobs/config/daily-cost.json`;
  // Overwrite with today's date, zero cost — so every test starts clean
  // without falling through to the real filesystem file.
  mockFiles[path] = JSON.stringify({ date: today(), totalCostUsd: 0, taskCount: 0 }, null, 2);
}

function makeConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    maxConcurrentWorkers: 5,
    maxDailyCostUsd: 50.0,
    priorityWeights: {
      urgency: 10,
      age: 0.1,
      costEfficiency: 2,
    },
    ...overrides,
  };
}

function insertTask(opts: {
  id?: string;
  title?: string;
  priority?: string;
  agent?: string;
  modelTier?: string;
  workState?: string;
  status?: string;
  createdAt?: string;
} = {}): string {
  const db = getRawDb();
  const id = opts.id ?? randomUUID();
  db.prepare(`
    INSERT INTO tasks (id, title, priority, agent, model_tier, work_state, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    opts.title ?? "Test task",
    opts.priority ?? "medium",
    opts.agent ?? "programmer",
    opts.modelTier ?? null,
    opts.workState ?? "not_started",
    opts.status ?? "active",
    opts.createdAt ?? new Date().toISOString(),
  );
  return id;
}

// ── beforeEach / afterEach ────────────────────────────────────────────────────

beforeEach(() => {
  // Clear mock filesystem
  clearMockCostTracker();

  // Clean up test tasks from previous runs
  const raw = getRawDb();
  raw.prepare("DELETE FROM tasks WHERE title LIKE '[sched-test]%'").run();

  // Close any open worker runs so capacity checks start fresh
  raw.prepare("UPDATE worker_runs SET ended_at = datetime('now') WHERE ended_at IS NULL").run();
});

afterEach(() => {
  // Nothing to do — beforeEach resets the mock file before the next test
});

// ── Type exports ──────────────────────────────────────────────────────────────

describe("Type exports", () => {
  it("SchedulerConfig type is usable", () => {
    const cfg: SchedulerConfig = makeConfig();
    expect(cfg.maxConcurrentWorkers).toBe(5);
    expect(cfg.priorityWeights.urgency).toBe(10);
  });

  it("Task type is usable", () => {
    const task: Task = {
      id: randomUUID(),
      title: "Type test",
      priority: "high",
      agent: "programmer",
      createdAt: new Date().toISOString(),
    };
    expect(task.priority).toBe("high");
  });

  it("DailyCostTracker type is usable", () => {
    const tracker: DailyCostTracker = {
      date: today(),
      totalCostUsd: 1.5,
      taskCount: 3,
    };
    expect(tracker.taskCount).toBe(3);
  });
});

// ── getSchedulerConfig ────────────────────────────────────────────────────────

describe("getSchedulerConfig()", () => {
  it("returns valid defaults when no DB row exists", () => {
    const cfg = getSchedulerConfig();
    expect(cfg.maxConcurrentWorkers).toBeGreaterThan(0);
    expect(cfg.maxDailyCostUsd).toBeGreaterThan(0);
    expect(typeof cfg.priorityWeights.urgency).toBe("number");
    expect(typeof cfg.priorityWeights.age).toBe("number");
    expect(typeof cfg.priorityWeights.costEfficiency).toBe("number");
  });

  it("default maxConcurrentWorkers is 5", () => {
    const cfg = getSchedulerConfig();
    expect(cfg.maxConcurrentWorkers).toBe(5);
  });

  it("default maxDailyCostUsd is 50", () => {
    const cfg = getSchedulerConfig();
    expect(cfg.maxDailyCostUsd).toBe(50.0);
  });

  it("default urgency weight is 10", () => {
    const cfg = getSchedulerConfig();
    expect(cfg.priorityWeights.urgency).toBe(10);
  });

  it("default age weight is 0.1", () => {
    const cfg = getSchedulerConfig();
    expect(cfg.priorityWeights.age).toBe(0.1);
  });

  it("default costEfficiency weight is 2", () => {
    const cfg = getSchedulerConfig();
    expect(cfg.priorityWeights.costEfficiency).toBe(2);
  });

  it("reads overridden config from orchestrator_settings", () => {
    const raw = getRawDb();
    const customCfg: SchedulerConfig = {
      maxConcurrentWorkers: 3,
      maxDailyCostUsd: 20.0,
      priorityWeights: { urgency: 5, age: 0.5, costEfficiency: 1 },
    };
    raw.prepare(`
      INSERT OR REPLACE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('scheduler_config', ?, datetime('now'))
    `).run(JSON.stringify(customCfg));

    const cfg = getSchedulerConfig();
    expect(cfg.maxConcurrentWorkers).toBe(3);
    expect(cfg.maxDailyCostUsd).toBe(20.0);
    expect(cfg.priorityWeights.urgency).toBe(5);

    // Cleanup
    raw.prepare("DELETE FROM orchestrator_settings WHERE key = 'scheduler_config'").run();
  });

  it("falls back to defaults when DB row has invalid JSON", () => {
    const raw = getRawDb();
    raw.prepare(`
      INSERT OR REPLACE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('scheduler_config', ?, datetime('now'))
    `).run('"not-an-object"');

    const cfg = getSchedulerConfig();
    expect(cfg.maxConcurrentWorkers).toBe(5); // default

    // Cleanup
    raw.prepare("DELETE FROM orchestrator_settings WHERE key = 'scheduler_config'").run();
  });

  it("falls back to defaults for partial DB config (missing fields)", () => {
    const raw = getRawDb();
    raw.prepare(`
      INSERT OR REPLACE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('scheduler_config', '{"maxConcurrentWorkers":8}', datetime('now'))
    `).run();

    const cfg = getSchedulerConfig();
    expect(cfg.maxConcurrentWorkers).toBe(8);
    expect(cfg.maxDailyCostUsd).toBe(50.0); // default
    expect(cfg.priorityWeights.urgency).toBe(10); // default

    raw.prepare("DELETE FROM orchestrator_settings WHERE key = 'scheduler_config'").run();
  });
});

// ── getDailyCost ──────────────────────────────────────────────────────────────

describe("getDailyCost()", () => {
  it("returns 0 when tracker file has zero cost for today", () => {
    // clearMockCostTracker() pre-seeds with { date: today, totalCostUsd: 0 }
    expect(getDailyCost()).toBe(0);
  });

  it("returns stored cost when date matches today", () => {
    writeMockCostTracker({ date: today(), totalCostUsd: 7.5, taskCount: 3 });
    expect(getDailyCost()).toBe(7.5);
  });

  it("returns 0 when stored date is yesterday (new day reset)", () => {
    writeMockCostTracker({ date: yesterday(), totalCostUsd: 42.0, taskCount: 10 });
    expect(getDailyCost()).toBe(0);
  });

  it("returns 0 for tracker with malformed JSON (parse error)", () => {
    const path = `${process.env.HOME ?? ""}/.lobs/config/daily-cost.json`;
    mockFiles[path] = "not-json!!!";
    expect(getDailyCost()).toBe(0);
  });

  it("returns 0 for corrupted (empty string) tracker file", () => {
    const path = `${process.env.HOME ?? ""}/.lobs/config/daily-cost.json`;
    mockFiles[path] = ""; // overwrite with empty — malformed, same as parse error
    expect(getDailyCost()).toBe(0);
  });

  it("returns exact value for fractional costs", () => {
    writeMockCostTracker({ date: today(), totalCostUsd: 0.0042, taskCount: 1 });
    expect(getDailyCost()).toBeCloseTo(0.0042);
  });
});

// ── recordTaskCost ────────────────────────────────────────────────────────────

describe("recordTaskCost()", () => {
  it("creates tracker file (writes to mock) if it doesn't exist", () => {
    expect(() => recordTaskCost(1.0)).not.toThrow();
    // After writing, the path should exist in mockFiles
    const path = `${process.env.HOME ?? ""}/.lobs/config/daily-cost.json`;
    expect(mockFiles[path]).toBeDefined();
  });

  it("accumulates cost across multiple calls", () => {
    recordTaskCost(1.0);
    recordTaskCost(0.5);
    recordTaskCost(2.25);
    expect(getDailyCost()).toBeCloseTo(3.75);
  });

  it("increments taskCount on each call", () => {
    recordTaskCost(1.0);
    recordTaskCost(1.0);
    const tracker = readMockCostTracker();
    expect(tracker.taskCount).toBe(2);
  });

  it("resets and starts fresh on a new day", () => {
    // Seed with yesterday's data
    writeMockCostTracker({ date: yesterday(), totalCostUsd: 99.0, taskCount: 50 });

    recordTaskCost(0.25);

    const tracker = readMockCostTracker();
    expect(tracker.date).toBe(today());
    expect(tracker.totalCostUsd).toBeCloseTo(0.25);
    expect(tracker.taskCount).toBe(1);
  });

  it("records zero cost without error", () => {
    // Pre-seeded file has { totalCostUsd: 0, taskCount: 0 }; adding 0 → still 0
    expect(() => recordTaskCost(0)).not.toThrow();
    const tracker = readMockCostTracker();
    expect(tracker.totalCostUsd).toBe(0);
    expect(tracker.taskCount).toBe(1); // count increments even for $0
  });

  it("saves correct date field", () => {
    recordTaskCost(0.1);
    const tracker = readMockCostTracker();
    expect(tracker.date).toBe(today());
  });

  it("starting from existing balance accumulates correctly", () => {
    writeMockCostTracker({ date: today(), totalCostUsd: 5.0, taskCount: 3 });
    recordTaskCost(2.5);
    const tracker = readMockCostTracker();
    expect(tracker.totalCostUsd).toBeCloseTo(7.5);
    expect(tracker.taskCount).toBe(4);
  });
});

// ── getNextTasks ──────────────────────────────────────────────────────────────

describe("getNextTasks()", () => {
  const cfg = makeConfig({ maxConcurrentWorkers: 5, maxDailyCostUsd: 50.0 });

  it("returns an array", () => {
    const result = getNextTasks(cfg);
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns tasks with required fields", () => {
    insertTask({ title: "[sched-test] Field check", priority: "medium" });
    const result = getNextTasks(cfg);
    const found = result.find((t) => t.title === "[sched-test] Field check");
    expect(found).toBeDefined();
    expect(found).toHaveProperty("id");
    expect(found).toHaveProperty("title");
    expect(found).toHaveProperty("priority");
    expect(found).toHaveProperty("agent");
    expect(found).toHaveProperty("createdAt");
  });

  it("returns tasks sorted by priority score (high before low)", () => {
    // Insert at same age so urgency score dominates
    const baseTime = new Date(Date.now() - 60_000).toISOString();
    const highId = insertTask({ title: "[sched-test] High prio", priority: "high", createdAt: baseTime });
    const lowId = insertTask({ title: "[sched-test] Low prio", priority: "low", createdAt: baseTime });

    const result = getNextTasks(cfg);
    const highIdx = result.findIndex((t) => t.id === highId);
    const lowIdx = result.findIndex((t) => t.id === lowId);

    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("does not return tasks with status != active", () => {
    const doneId = insertTask({ title: "[sched-test] Done task", status: "completed" });
    const result = getNextTasks(cfg);
    expect(result.some((t) => t.id === doneId)).toBe(false);
  });

  it("does not return tasks with work_state != not_started", () => {
    const inProgressId = insertTask({ title: "[sched-test] In-progress task", workState: "in_progress" });
    const result = getNextTasks(cfg);
    expect(result.some((t) => t.id === inProgressId)).toBe(false);
  });

  it("returns empty array when daily budget is exceeded", () => {
    // Seed the mock file so getDailyCost() returns > maxDailyCostUsd
    writeMockCostTracker({ date: today(), totalCostUsd: 100.0, taskCount: 20 });

    insertTask({ title: "[sched-test] Budget blocked task" });
    const result = getNextTasks(cfg);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when no worker slots are available", () => {
    const raw = getRawDb();
    // Fill all slots with active workers
    for (let i = 0; i < cfg.maxConcurrentWorkers; i++) {
      raw.prepare(`
        INSERT INTO worker_runs (worker_id, agent_type, started_at)
        VALUES (?, 'programmer', datetime('now'))
      `).run(`sched-cap-worker-${i}-${randomUUID().slice(0, 6)}`);
    }

    insertTask({ title: "[sched-test] Capacity blocked task" });
    const result = getNextTasks(makeConfig({ maxConcurrentWorkers: cfg.maxConcurrentWorkers }));
    expect(result).toHaveLength(0);

    // Cleanup workers
    raw.prepare("UPDATE worker_runs SET ended_at = datetime('now') WHERE ended_at IS NULL").run();
  });

  it("respects maxConcurrentWorkers limit on returned task count", () => {
    for (let i = 0; i < 10; i++) {
      insertTask({ title: `[sched-test] Batch task ${i}` });
    }
    const limitedCfg = makeConfig({ maxConcurrentWorkers: 3 });
    const result = getNextTasks(limitedCfg);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("returns tasks with correct priority field", () => {
    insertTask({ title: "[sched-test] Priority field check", priority: "high" });
    const result = getNextTasks(cfg);
    const found = result.find((t) => t.title === "[sched-test] Priority field check");
    if (found) {
      expect(found.priority).toBe("high");
    }
  });

  it("assigns default agent 'programmer' for null DB columns", () => {
    const raw = getRawDb();
    const taskId = randomUUID();
    raw.prepare(`
      INSERT INTO tasks (id, title, status, work_state, created_at, updated_at)
      VALUES (?, '[sched-test] Null fields task', 'active', 'not_started', datetime('now'), datetime('now'))
    `).run(taskId);

    const result = getNextTasks(cfg);
    const found = result.find((t) => t.id === taskId);
    if (found) {
      expect(found.agent).toBe("programmer"); // default for null
      expect(found.priority).toBe("medium"); // default for null
    }
  });

  it("older tasks score higher than newer tasks of same priority when age weight dominates", () => {
    const oldTime = new Date(Date.now() - 180 * 60_000).toISOString(); // 3h ago
    const newTime = new Date().toISOString();

    const oldId = insertTask({ title: "[sched-test] Old medium task", priority: "medium", createdAt: oldTime });
    const newId = insertTask({ title: "[sched-test] New medium task", priority: "medium", createdAt: newTime });

    // Heavily weight age, zero out urgency & cost so age dominates
    const ageCfg = makeConfig({ priorityWeights: { urgency: 0, age: 10, costEfficiency: 0 } });
    const result = getNextTasks(ageCfg);

    const oldIdx = result.findIndex((t) => t.id === oldId);
    const newIdx = result.findIndex((t) => t.id === newId);

    if (oldIdx >= 0 && newIdx >= 0) {
      expect(oldIdx).toBeLessThan(newIdx);
    }
  });

  it("allows tasks up to (but not including) the budget limit", () => {
    // Budget used = 49.9 < 50.0 → tasks should still flow
    writeMockCostTracker({ date: today(), totalCostUsd: 49.9, taskCount: 10 });

    insertTask({ title: "[sched-test] Just under budget" });
    const result = getNextTasks(cfg);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("returns tasks with valid createdAt timestamp", () => {
    insertTask({ title: "[sched-test] Timestamp check" });
    const result = getNextTasks(cfg);
    const found = result.find((t) => t.title === "[sched-test] Timestamp check");
    if (found) {
      expect(() => new Date(found.createdAt)).not.toThrow();
      expect(isNaN(new Date(found.createdAt).getTime())).toBe(false);
    }
  });
});
