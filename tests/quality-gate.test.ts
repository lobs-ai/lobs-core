/**
 * Quality Gate Tests
 *
 * Tests checkQualityGate(), getQualityGateConfig(), and the parseReviewOutput
 * logic (exercised through checkQualityGate with a top-level mocked runAgent).
 *
 * Strategy: mock the runner at the top of the file so the DB remains intact.
 * We control the review output by mutating the mock's resolved value.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getRawDb } from "../src/db/connection.js";

// ── mock runAgent BEFORE importing quality-gate so the import sees the mock ───
vi.mock("../src/runner/index.js", () => ({
  runAgent: vi.fn(),
}));

import {
  checkQualityGate,
  getQualityGateConfig,
  type QualityGate,
  type ReviewResult,
} from "../src/orchestrator/quality-gate.js";
import { runAgent } from "../src/runner/index.js";

const mockRunAgent = vi.mocked(runAgent);

// ── DB helpers ────────────────────────────────────────────────────────────────

function insertTask(
  id: string,
  opts: {
    title?: string;
    notes?: string;
    agent?: string;
    retry_count?: number;
    status?: string;
  } = {},
): void {
  getRawDb()
    .prepare(
      `INSERT OR REPLACE INTO tasks
         (id, title, status, notes, agent, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(
      id,
      opts.title ?? "Test task",
      opts.status ?? "active",
      opts.notes ?? null,
      opts.agent ?? "programmer",
      opts.retry_count ?? 0,
    );
}

function upsertSetting(key: string, value: unknown): void {
  getRawDb()
    .prepare(`INSERT OR REPLACE INTO orchestrator_settings (key, value) VALUES (?, ?)`)
    .run(key, typeof value === "string" ? value : JSON.stringify(value));
}

function deleteSetting(key: string): void {
  getRawDb().prepare(`DELETE FROM orchestrator_settings WHERE key = ?`).run(key);
}

// ── getQualityGateConfig — defaults ──────────────────────────────────────────

describe("getQualityGateConfig — defaults", () => {
  beforeEach(() => deleteSetting("quality_gate"));

  it("returns enabled=true by default", () => {
    expect(getQualityGateConfig().enabled).toBe(true);
  });

  it("returns autoApprove=true by default", () => {
    expect(getQualityGateConfig().autoApprove).toBe(true);
  });

  it("returns maxRevisions=2 by default", () => {
    expect(getQualityGateConfig().maxRevisions).toBe(2);
  });

  it("returns reviewModel=undefined by default", () => {
    expect(getQualityGateConfig().reviewModel).toBeUndefined();
  });
});

describe("getQualityGateConfig — DB overrides", () => {
  beforeEach(() => deleteSetting("quality_gate"));

  it("reads enabled=false", () => {
    upsertSetting("quality_gate", { enabled: false });
    expect(getQualityGateConfig().enabled).toBe(false);
  });

  it("reads maxRevisions=5", () => {
    upsertSetting("quality_gate", { maxRevisions: 5 });
    expect(getQualityGateConfig().maxRevisions).toBe(5);
  });

  it("reads reviewModel", () => {
    upsertSetting("quality_gate", { reviewModel: "anthropic/claude-3-haiku" });
    expect(getQualityGateConfig().reviewModel).toBe("anthropic/claude-3-haiku");
  });

  it("reads autoApprove=false", () => {
    upsertSetting("quality_gate", { autoApprove: false });
    expect(getQualityGateConfig().autoApprove).toBe(false);
  });

  it("falls back to defaults when value is empty object {}", () => {
    upsertSetting("quality_gate", {});
    const cfg = getQualityGateConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxRevisions).toBe(2);
    expect(cfg.autoApprove).toBe(true);
  });

  it("falls back to defaults when JSON is malformed", () => {
    getRawDb()
      .prepare(`INSERT OR REPLACE INTO orchestrator_settings (key, value) VALUES (?, ?)`)
      .run("quality_gate", "NOT-JSON{{{");
    const cfg = getQualityGateConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxRevisions).toBe(2);
  });

  it("merges partial overrides with defaults", () => {
    upsertSetting("quality_gate", { maxRevisions: 7 });
    const cfg = getQualityGateConfig();
    expect(cfg.maxRevisions).toBe(7);
    expect(cfg.enabled).toBe(true);
    expect(cfg.autoApprove).toBe(true);
  });
});

// ── QualityGate type shape ────────────────────────────────────────────────────

describe("QualityGate type shape", () => {
  it("accepts all optional fields", () => {
    const gate: QualityGate = {
      enabled: true,
      reviewModel: "some-model",
      autoApprove: false,
      maxRevisions: 3,
    };
    expect(gate.enabled).toBe(true);
    expect(gate.reviewModel).toBe("some-model");
    expect(gate.autoApprove).toBe(false);
    expect(gate.maxRevisions).toBe(3);
  });

  it("enabled=false gate with only required field", () => {
    const gate: QualityGate = { enabled: false };
    expect(gate.enabled).toBe(false);
    expect(gate.reviewModel).toBeUndefined();
    expect(gate.maxRevisions).toBeUndefined();
  });
});

// ── checkQualityGate — disabled gate (no DB needed) ──────────────────────────

describe("checkQualityGate — gate disabled", () => {
  it("returns pass immediately without calling runAgent", async () => {
    mockRunAgent.mockClear();
    const result: ReviewResult = await checkQualityGate(
      "id-never-in-db",
      "some output",
      { enabled: false },
      "/tmp",
    );
    expect(result.verdict).toBe("pass");
    expect(result.shouldComplete).toBe(true);
    expect(result.needsHumanReview).toBe(false);
    expect(result.issues).toHaveLength(0);
    expect(result.feedback).toMatch(/disabled/i);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("disabled gate with any task id — never errors", async () => {
    const result = await checkQualityGate("any", "out", { enabled: false }, "/tmp");
    expect(result.verdict).toBe("pass");
  });
});

// ── checkQualityGate — task not found ────────────────────────────────────────

describe("checkQualityGate — missing task", () => {
  it("returns fail when task not found in DB", async () => {
    const result = await checkQualityGate(
      "absolutely-no-such-task-9999",
      "output",
      { enabled: true },
      "/tmp",
    );
    expect(result.verdict).toBe("fail");
    expect(result.needsHumanReview).toBe(true);
    expect(result.shouldComplete).toBe(false);
    expect(result.feedback).toMatch(/not found/i);
  });
});

// ── checkQualityGate — runner error ──────────────────────────────────────────

describe("checkQualityGate — runner throws", () => {
  it("returns fail + needsHumanReview when runAgent throws", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("runner exploded"));
    insertTask("task-runner-error", { title: "Runner error task" });

    const result = await checkQualityGate(
      "task-runner-error",
      "some output",
      { enabled: true },
      "/tmp",
    );

    expect(result.verdict).toBe("fail");
    expect(result.needsHumanReview).toBe(true);
    expect(result.feedback).toMatch(/runner exploded/i);
  });
});

// ── checkQualityGate — PASS verdict ──────────────────────────────────────────

describe("checkQualityGate — PASS verdict", () => {
  it("returns pass when reviewer emits VERDICT: PASS", async () => {
    mockRunAgent.mockResolvedValueOnce({
      succeeded: true,
      output: "VERDICT: PASS\n\nISSUES:\n\nFEEDBACK:\nGreat work, no issues found.",
      error: null,
    } as any);

    insertTask("task-pass-gate", { title: "Passing task" });

    const result = await checkQualityGate(
      "task-pass-gate",
      "agent output here",
      { enabled: true, autoApprove: true },
      "/tmp",
    );

    expect(result.verdict).toBe("pass");
    expect(result.shouldComplete).toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });

  it("PASS verdict returns empty issues", async () => {
    mockRunAgent.mockResolvedValueOnce({
      succeeded: true,
      output: "VERDICT: PASS\n\nISSUES:\n\nFEEDBACK:\nAll good.",
      error: null,
    } as any);

    insertTask("task-pass-empty-issues", { title: "Empty issues task" });

    const result = await checkQualityGate(
      "task-pass-empty-issues",
      "output",
      { enabled: true, autoApprove: true },
      "/tmp",
    );

    expect(result.issues).toHaveLength(0);
  });
});

// ── checkQualityGate — FAIL verdict ──────────────────────────────────────────

describe("checkQualityGate — FAIL verdict", () => {
  it("returns fail when reviewer emits VERDICT: FAIL", async () => {
    mockRunAgent.mockResolvedValueOnce({
      succeeded: true,
      output:
        "VERDICT: FAIL\n\nISSUES:\n- Missing error handling\n- No tests\n\nFEEDBACK:\nPlease add error handling.",
      error: null,
    } as any);

    insertTask("task-fail-gate", { title: "Failing task" });

    const result = await checkQualityGate(
      "task-fail-gate",
      "agent output",
      { enabled: true, autoApprove: true },
      "/tmp",
    );

    expect(result.verdict).toBe("fail");
    expect(result.shouldComplete).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("FAIL extracts issue list", async () => {
    mockRunAgent.mockResolvedValueOnce({
      succeeded: true,
      output:
        "VERDICT: FAIL\n\nISSUES:\n- Issue one\n- Issue two\n- Issue three\n\nFEEDBACK:\nFix these.",
      error: null,
    } as any);

    insertTask("task-fail-issues", { title: "Issues task" });

    const result = await checkQualityGate(
      "task-fail-issues",
      "output",
      { enabled: true, autoApprove: true },
      "/tmp",
    );

    expect(result.issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ── checkQualityGate — NEEDS_CHANGES verdict ─────────────────────────────────

describe("checkQualityGate — NEEDS_CHANGES verdict", () => {
  it("returns needs-changes verdict and shouldComplete=false", async () => {
    mockRunAgent.mockResolvedValueOnce({
      succeeded: true,
      output:
        "VERDICT: NEEDS_CHANGES\n\nISSUES:\n- Missing tests\n\nFEEDBACK:\nAdd unit tests.",
      error: null,
    } as any);

    insertTask("task-needs-changes", { title: "Needs changes task" });

    const result = await checkQualityGate(
      "task-needs-changes",
      "agent output",
      { enabled: true, autoApprove: true },
      "/tmp",
    );

    expect(result.verdict).toBe("needs-changes");
    expect(result.shouldComplete).toBe(false);
    expect(result.feedback).toMatch(/unit tests/i);
  });

  it("unknown verdict token defaults to fail", async () => {
    // The regex only captures PASS|NEEDS_CHANGES|FAIL — anything else falls through to "fail"
    mockRunAgent.mockResolvedValueOnce({
      succeeded: true,
      output: "VERDICT: UNKNOWN_TOKEN\n\nISSUES:\n\nFEEDBACK:\nUnknown verdict.",
      error: null,
    } as any);

    insertTask("task-unknown-verdict", { title: "Unknown verdict task" });

    const result = await checkQualityGate(
      "task-unknown-verdict",
      "output",
      { enabled: true, autoApprove: true },
      "/tmp",
    );

    expect(result.verdict).toBe("fail");
    expect(result.shouldComplete).toBe(false);
  });
});

// ── checkQualityGate — maxRevisions exhausted ────────────────────────────────

describe("checkQualityGate — maxRevisions exhausted", () => {
  it("escalates to human when revision count exceeds maxRevisions", async () => {
    // Reviewer still says FAIL, but task has used 3 revisions > maxRevisions=2
    mockRunAgent.mockResolvedValueOnce({
      succeeded: true,
      output: "VERDICT: FAIL\n\nISSUES:\n- Still broken\n\nFEEDBACK:\nPlease fix.",
      error: null,
    } as any);

    insertTask("task-maxrevisions", { title: "Retry exhausted", retry_count: 3 });

    const result = await checkQualityGate(
      "task-maxrevisions",
      "agent output",
      { enabled: true, autoApprove: true, maxRevisions: 2 },
      "/tmp",
    );

    // After maxRevisions exceeded, escalate to human
    expect(result.needsHumanReview).toBe(true);
    expect(result.shouldComplete).toBe(false);
  });
});

// ── DB side-effect: revision count ───────────────────────────────────────────

describe("DB integrity", () => {
  it("retry_count increments correctly in DB", () => {
    const db = getRawDb();
    db.prepare(
      `INSERT OR REPLACE INTO tasks (id, title, status, retry_count, created_at, updated_at)
       VALUES ('task-db-incr', 'Inc test', 'active', 0, datetime('now'), datetime('now'))`,
    ).run();

    db.prepare(
      `UPDATE tasks SET retry_count = COALESCE(retry_count, 0) + 1, updated_at = datetime('now') WHERE id = ?`,
    ).run("task-db-incr");

    const row = db
      .prepare(`SELECT retry_count FROM tasks WHERE id = 'task-db-incr'`)
      .get() as { retry_count: number };
    expect(row.retry_count).toBe(1);
  });

  it("multiple increments accumulate", () => {
    const db = getRawDb();
    db.prepare(
      `INSERT OR REPLACE INTO tasks (id, title, status, retry_count, created_at, updated_at)
       VALUES ('task-db-incr2', 'Inc test 2', 'active', 5, datetime('now'), datetime('now'))`,
    ).run();

    db.prepare(
      `UPDATE tasks SET retry_count = COALESCE(retry_count, 0) + 1, updated_at = datetime('now') WHERE id = ?`,
    ).run("task-db-incr2");
    db.prepare(
      `UPDATE tasks SET retry_count = COALESCE(retry_count, 0) + 1, updated_at = datetime('now') WHERE id = ?`,
    ).run("task-db-incr2");

    const row = db
      .prepare(`SELECT retry_count FROM tasks WHERE id = 'task-db-incr2'`)
      .get() as { retry_count: number };
    expect(row.retry_count).toBe(7);
  });
});
