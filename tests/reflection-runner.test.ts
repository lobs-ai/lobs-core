import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeMemoryDb, getMemoryDb, initMemoryDb } from "../src/memory/db.js";

const extractMemoriesMock = vi.fn();
const reconcileMock = vi.fn();
const autoResolveConflictsMock = vi.fn();
const checkCrossTypeConflictsMock = vi.fn();
const getTotalTokensUsedMock = vi.fn();
const resetTokenCounterMock = vi.fn();

vi.mock("../src/memory/extractor.js", () => ({
  extractMemories: extractMemoriesMock,
  getTotalTokensUsed: getTotalTokensUsedMock,
  resetTokenCounter: resetTokenCounterMock,
}));

vi.mock("../src/memory/reconciler.js", () => ({
  reconcile: reconcileMock,
}));

vi.mock("../src/memory/conflicts.js", () => ({
  autoResolveConflicts: autoResolveConflictsMock,
  checkCrossTypeConflicts: checkCrossTypeConflictsMock,
}));

beforeAll(() => {
  initMemoryDb(":memory:");
});

afterAll(() => {
  closeMemoryDb();
});

beforeEach(() => {
  const db = getMemoryDb();
  db.exec("DELETE FROM retrieval_log");
  db.exec("DELETE FROM evidence");
  db.exec("DELETE FROM conflicts");
  db.exec("DELETE FROM memory_embeddings");
  db.exec("DELETE FROM gc_log");
  db.exec("DELETE FROM memories_fts");
  db.exec("DELETE FROM memories");
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM reflection_runs");

  extractMemoriesMock.mockReset();
  reconcileMock.mockReset();
  autoResolveConflictsMock.mockReset();
  checkCrossTypeConflictsMock.mockReset();
  getTotalTokensUsedMock.mockReset();
  resetTokenCounterMock.mockReset();

  extractMemoriesMock.mockResolvedValue([]);
  reconcileMock.mockResolvedValue({
    newMemories: [],
    reinforcedMemories: [],
    conflicts: [],
  });
  autoResolveConflictsMock.mockResolvedValue({ resolved: 0, escalated: 0, dismissed: 0 });
  checkCrossTypeConflictsMock.mockResolvedValue(0);
  getTotalTokensUsedMock.mockReturnValue(0);
});

function insertEvent(sessionId: string | null, offsetMs: number): void {
  const db = getMemoryDb();
  const ts = new Date(Date.now() + offsetMs).toISOString();
  db.prepare(
    `INSERT INTO events (
      timestamp, agent_id, agent_type, session_id,
      event_type, content, metadata, scope, project_id, signal_score, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ts,
    "agent-1",
    "main",
    sessionId,
    "observation",
    `event ${offsetMs}`,
    null,
    "session",
    null,
    0.8,
    ts,
  );
}

describe("runReflection", () => {
  it("skips session_end runs without a sessionId", async () => {
    for (let i = 0; i < 6; i++) insertEvent(null, i * 1000);

    const { runReflection } = await import("../src/memory/reflection.js");
    const result = await runReflection({ trigger: "session_end" });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("requires a sessionId");
    expect(extractMemoriesMock).not.toHaveBeenCalled();
  });

  it("marks events reflected even when extraction returns no memories", async () => {
    const sessionId = "session-123";
    for (let i = 0; i < 6; i++) insertEvent(sessionId, i * 1000);

    const { runReflection } = await import("../src/memory/reflection.js");

    const first = await runReflection({ trigger: "session_end", sessionId });
    expect(first.skipped).toBe(false);
    expect(extractMemoriesMock).toHaveBeenCalledTimes(1);

    const db = getMemoryDb();
    const reflected = db.prepare(
      "SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND reflected_at IS NOT NULL",
    ).get(sessionId) as { c: number };
    expect(reflected.c).toBe(6);

    const second = await runReflection({ trigger: "session_end", sessionId });
    expect(second.skipped).toBe(true);
    expect(second.skipReason).toMatch(/only 0 events in scope|cooldown active/);
    expect(extractMemoriesMock).toHaveBeenCalledTimes(1);
  });

  it("applies a cooldown between session_end reflections", async () => {
    const sessionId = "session-cooldown";
    for (let i = 0; i < 6; i++) insertEvent(sessionId, i * 1000);

    const db = getMemoryDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO reflection_runs (
        id, trigger, started_at, completed_at, tier, status, skip_reason,
        events_processed, clusters_processed, memories_created, memories_reinforced,
        conflicts_detected, tokens_used
      ) VALUES (?, ?, ?, ?, 'local', 'completed', NULL, 6, 1, 0, 0, 0, 100)`,
    ).run("recent-run", "session_end", now, now);

    const { runReflection } = await import("../src/memory/reflection.js");
    const result = await runReflection({ trigger: "session_end", sessionId });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("cooldown active");
    expect(extractMemoriesMock).not.toHaveBeenCalled();
  });

  it("stops after the per-run cluster cap and leaves later clusters pending", async () => {
    const sessionId = "session-cap";
    for (let cluster = 0; cluster < 4; cluster++) {
      const base = cluster * 31 * 60 * 1000;
      for (let i = 0; i < 6; i++) insertEvent(sessionId, base + i * 1000);
    }

    const tokenSequence = [1000, 2000, 3000];
    getTotalTokensUsedMock.mockImplementation(() => {
      if (tokenSequence.length === 0) return 3000;
      return tokenSequence.shift() ?? 3000;
    });

    const { runReflection } = await import("../src/memory/reflection.js");
    const result = await runReflection({ trigger: "session_end", sessionId });

    expect(result.skipped).toBe(false);
    expect(extractMemoriesMock).toHaveBeenCalledTimes(3);

    const db = getMemoryDb();
    const reflected = db.prepare(
      "SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND reflected_at IS NOT NULL",
    ).get(sessionId) as { c: number };
    const pending = db.prepare(
      "SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND reflected_at IS NULL",
    ).get(sessionId) as { c: number };

    expect(reflected.c).toBe(18);
    expect(pending.c).toBe(6);
  });
});
