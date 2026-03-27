/**
 * Tests for src/memory/conflicts.ts
 *
 * Covers auto-resolution rules, manual resolution strategies, conflict
 * surfacing, and memory promotion. Uses an in-memory SQLite database so
 * every test starts from a clean, isolated state.
 */

import { initMemoryDb, closeMemoryDb, getMemoryDb } from "../src/memory/db.js";
import {
  autoResolveConflicts,
  resolveConflict,
  getUnresolvedConflicts,
  promoteMemory,
} from "../src/memory/conflicts.js";
import type {
  ConflictResolutionResult,
  ConflictWithMemories,
} from "../src/memory/conflicts.js";
import type { Conflict, Memory } from "../src/memory/types.js";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(() => {
  initMemoryDb(":memory:");
});

afterAll(() => {
  closeMemoryDb();
});

beforeEach(() => {
  const db = getMemoryDb();
  // Order matters: delete child tables before parent tables to satisfy FK constraints
  db.exec("DELETE FROM retrieval_log");
  db.exec("DELETE FROM evidence");
  db.exec("DELETE FROM conflicts");
  db.exec("DELETE FROM memory_embeddings");
  db.exec("DELETE FROM gc_log");
  db.exec("DELETE FROM memories_fts");
  db.exec("DELETE FROM memories");
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM reflection_runs");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function insertMemory(
  overrides: Partial<{
    memory_type: string;
    content: string;
    confidence: number;
    scope: string;
    source_authority: number;
    status: string;
    derived_at: string;
    last_accessed: string | null;
    access_count: number;
  }> = {},
): number {
  const db = getMemoryDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO memories (memory_type, content, confidence, scope, source_authority, status, derived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.memory_type ?? "fact",
      overrides.content ?? "test memory",
      overrides.confidence ?? 0.8,
      overrides.scope ?? "system",
      overrides.source_authority ?? 1,
      overrides.status ?? "active",
      overrides.derived_at ?? now,
      now,
      now,
    );
  return result.lastInsertRowid as number;
}

function insertConflict(
  memoryA: number,
  memoryB: number,
  description = "test conflict",
): number {
  const db = getMemoryDb();
  const result = db
    .prepare("INSERT INTO conflicts (memory_a, memory_b, description) VALUES (?, ?, ?)")
    .run(memoryA, memoryB, description);
  return result.lastInsertRowid as number;
}

function insertEvent(): number {
  const db = getMemoryDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO events (timestamp, agent_id, agent_type, event_type, content, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(now, "test-agent", "programmer", "message", "event content", "system", now);
  return result.lastInsertRowid as number;
}

function insertEvidence(memoryId: number, eventId: number): number {
  const db = getMemoryDb();
  const result = db
    .prepare(
      "INSERT INTO evidence (memory_id, event_id, relationship, strength) VALUES (?, ?, ?, ?)",
    )
    .run(memoryId, eventId, "derived_from", 1.0);
  return result.lastInsertRowid as number;
}

function getMemory(id: number): Memory {
  const db = getMemoryDb();
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory;
}

function getConflict(id: number): Conflict {
  const db = getMemoryDb();
  return db.prepare("SELECT * FROM conflicts WHERE id = ?").get(id) as Conflict;
}

function getEvidenceForMemory(memoryId: number): { event_id: number; relationship: string }[] {
  const db = getMemoryDb();
  return db
    .prepare("SELECT event_id, relationship FROM evidence WHERE memory_id = ?")
    .all(memoryId) as { event_id: number; relationship: string }[];
}

/** ISO timestamp in the past by `offsetSeconds` */
function past(offsetSeconds: number): string {
  return new Date(Date.now() - offsetSeconds * 1000).toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// autoResolveConflicts()
// ════════════════════════════════════════════════════════════════════════════

describe("autoResolveConflicts()", () => {
  // ── Rule 1: User preference (authority=3) always wins ──────────────────

  describe("Rule 1: user preference (authority=3) always wins", () => {
    it("supersedes B when A has authority=3 and B has authority=1", async () => {
      const idA = insertMemory({ source_authority: 3, confidence: 0.8 });
      const idB = insertMemory({ source_authority: 1, confidence: 0.8 });
      const conflictId = insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      expect(result.resolved).toBe(1);
      expect(result.escalated).toBe(0);
      expect(result.dismissed).toBe(0);

      expect(getMemory(idB).status).toBe("superseded");
      expect(getMemory(idA).status).toBe("active");

      const conflict = getConflict(conflictId);
      expect(conflict.resolved_at).not.toBeNull();
      expect(conflict.resolution).toBe("auto: user preference supersedes");
    });

    it("supersedes A when B has authority=3 and A has authority=1", async () => {
      const idA = insertMemory({ source_authority: 1, confidence: 0.8 });
      const idB = insertMemory({ source_authority: 3, confidence: 0.8 });
      const conflictId = insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      expect(result.resolved).toBe(1);
      expect(getMemory(idA).status).toBe("superseded");
      expect(getMemory(idB).status).toBe("active");
      expect(getConflict(conflictId).resolution).toBe("auto: user preference supersedes");
    });

    it("falls through to Rule 3 when both have authority=3 (different timestamps)", async () => {
      const idA = insertMemory({ source_authority: 3, confidence: 0.8, derived_at: past(60) });
      const idB = insertMemory({ source_authority: 3, confidence: 0.8, derived_at: past(10) });
      insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      // Rule 3 applies (same scope, B is newer) → A superseded
      expect(result.resolved).toBe(1);
      expect(getMemory(idA).status).toBe("superseded");
      expect(getMemory(idB).status).toBe("active");
    });
  });

  // ── Rule 2: Higher authority supersedes lower ──────────────────────────

  describe("Rule 2: higher authority supersedes lower", () => {
    it("supersedes B when A has authority=2 and B has authority=1", async () => {
      const idA = insertMemory({ source_authority: 2, confidence: 0.6 });
      const idB = insertMemory({ source_authority: 1, confidence: 0.6 });
      const conflictId = insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      expect(result.resolved).toBe(1);
      expect(getMemory(idB).status).toBe("superseded");
      expect(getMemory(idA).status).toBe("active");
      expect(getConflict(conflictId).resolution).toBe("auto: higher authority supersedes");
    });

    it("supersedes A when B has authority=2 and A has authority=0", async () => {
      const idA = insertMemory({ source_authority: 0, confidence: 0.6 });
      const idB = insertMemory({ source_authority: 2, confidence: 0.6 });
      const conflictId = insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      expect(result.resolved).toBe(1);
      expect(getMemory(idA).status).toBe("superseded");
      expect(getMemory(idB).status).toBe("active");
      expect(getConflict(conflictId).resolution).toBe("auto: higher authority supersedes");
    });
  });

  // ── Rule 3: Same authority + same scope → newer wins ──────────────────

  describe("Rule 3: same authority, same scope — newer wins", () => {
    it("supersedes B when A is newer (same authority, same scope)", async () => {
      const idA = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: past(10),
        confidence: 0.6,
      });
      const idB = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: past(60),
        confidence: 0.6,
      });
      const conflictId = insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      expect(result.resolved).toBe(1);
      expect(getMemory(idB).status).toBe("superseded");
      expect(getMemory(idA).status).toBe("active");
      expect(getConflict(conflictId).resolution).toBe(
        "auto: newer supersedes (same/higher authority)",
      );
    });

    it("supersedes A when B is newer (same authority, same scope)", async () => {
      const idA = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: past(120),
        confidence: 0.6,
      });
      const idB = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: past(5),
        confidence: 0.6,
      });
      const conflictId = insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      expect(result.resolved).toBe(1);
      expect(getMemory(idA).status).toBe("superseded");
      expect(getMemory(idB).status).toBe("active");
    });

    it("does NOT apply Rule 3 when scopes differ — falls through to escalate", async () => {
      // Same authority, different scopes, both mid-confidence → escalated
      const idA = insertMemory({
        source_authority: 1,
        scope: "session",
        derived_at: past(120),
        confidence: 0.6,
      });
      const idB = insertMemory({
        source_authority: 1,
        scope: "project",
        derived_at: past(5),
        confidence: 0.6,
      });
      insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      // Neither memory should be superseded
      expect(result.resolved).toBe(0);
      expect(getMemory(idA).status).toBe("active");
      expect(getMemory(idB).status).toBe("active");
    });
  });

  // ── Rule 4: Both low confidence → mark both contested ─────────────────

  describe("Rule 4: both low confidence (<0.5) — mark both contested", () => {
    it("marks both memories as contested and counts as dismissed", async () => {
      const idA = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: past(60),
        confidence: 0.3,
      });
      const idB = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: past(60), // same timestamp so Rule 3 doesn't apply
        confidence: 0.4,
      });
      const conflictId = insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      expect(result.dismissed).toBe(1);
      expect(result.resolved).toBe(0);
      expect(result.escalated).toBe(0);

      expect(getMemory(idA).status).toBe("contested");
      expect(getMemory(idB).status).toBe("contested");

      const conflict = getConflict(conflictId);
      expect(conflict.resolved_at).not.toBeNull();
      expect(conflict.resolution).toBe("auto: both disputed");
    });
  });

  // ── Rule 5: High confidence → escalate ────────────────────────────────

  describe("Rule 5: high confidence (>0.7) — escalate", () => {
    it("escalates when one memory has confidence > 0.7", async () => {
      // Same authority, same scope, same timestamp → Rule 3 ties, falls to Rule 4/5
      const ts = past(60);
      const idA = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: ts,
        confidence: 0.8,
      });
      const idB = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: ts,
        confidence: 0.6,
      });
      insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      expect(result.escalated).toBe(1);
      expect(result.resolved).toBe(0);
      expect(result.dismissed).toBe(0);

      // Memories remain untouched — unresolved
      expect(getMemory(idA).status).toBe("active");
      expect(getMemory(idB).status).toBe("active");
    });

    it("escalates when both memories have confidence > 0.7", async () => {
      const ts = past(60);
      const idA = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: ts,
        confidence: 0.9,
      });
      const idB = insertMemory({
        source_authority: 1,
        scope: "system",
        derived_at: ts,
        confidence: 0.85,
      });
      insertConflict(idA, idB);

      const result = await autoResolveConflicts();

      expect(result.escalated).toBe(1);
      expect(getMemory(idA).status).toBe("active");
      expect(getMemory(idB).status).toBe("active");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns zeroed result when there are no unresolved conflicts", async () => {
      const result = await autoResolveConflicts();
      expect(result).toEqual({ resolved: 0, escalated: 0, dismissed: 0 });
    });

    it("dismisses a conflict when memory A has been deleted from the table", async () => {
      const db = getMemoryDb();
      const idA = insertMemory({ source_authority: 1 });
      const idB = insertMemory({ source_authority: 2 });
      const conflictId = insertConflict(idA, idB);

      // Forcibly delete memory A (bypassing FK so we can test missing-memory path)
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM memories WHERE id = ?").run(idA);
      db.pragma("foreign_keys = ON");

      const result = await autoResolveConflicts();

      expect(result.dismissed).toBe(1);
      expect(result.resolved).toBe(0);

      const conflict = getConflict(conflictId);
      expect(conflict.resolved_at).not.toBeNull();
      expect(conflict.resolution).toBe("auto: memory not found, dismissed");
    });

    it("dismisses a conflict when memory B has been deleted from the table", async () => {
      const db = getMemoryDb();
      const idA = insertMemory({ source_authority: 1 });
      const idB = insertMemory({ source_authority: 1 });
      const conflictId = insertConflict(idA, idB);

      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM memories WHERE id = ?").run(idB);
      db.pragma("foreign_keys = ON");

      const result = await autoResolveConflicts();

      expect(result.dismissed).toBe(1);
      expect(getConflict(conflictId).resolution).toBe("auto: memory not found, dismissed");
    });

    it("resolves multiple conflicts in a single call and tallies correctly", async () => {
      // Conflict 1 → Rule 1 (resolved)
      const a1 = insertMemory({ source_authority: 3, confidence: 0.8 });
      const b1 = insertMemory({ source_authority: 1, confidence: 0.8 });
      insertConflict(a1, b1);

      // Conflict 2 → Rule 2 (resolved)
      const a2 = insertMemory({ source_authority: 2, confidence: 0.6 });
      const b2 = insertMemory({ source_authority: 0, confidence: 0.6 });
      insertConflict(a2, b2);

      // Conflict 3 → Rule 5 (escalated — same authority, same scope, same ts, high conf)
      const ts = past(60);
      const a3 = insertMemory({ source_authority: 1, scope: "system", derived_at: ts, confidence: 0.9 });
      const b3 = insertMemory({ source_authority: 1, scope: "system", derived_at: ts, confidence: 0.8 });
      insertConflict(a3, b3);

      const result = await autoResolveConflicts();

      expect(result.resolved).toBe(2);
      expect(result.escalated).toBe(1);
      expect(result.dismissed).toBe(0);
    });

    it("does not re-process already-resolved conflicts", async () => {
      const db = getMemoryDb();
      const idA = insertMemory({ source_authority: 2 });
      const idB = insertMemory({ source_authority: 1 });
      const conflictId = insertConflict(idA, idB);

      // Pre-resolve the conflict
      db.prepare(
        "UPDATE conflicts SET resolved_at = datetime('now'), resolution = 'manual: chose A' WHERE id = ?",
      ).run(conflictId);

      const result = await autoResolveConflicts();

      expect(result).toEqual({ resolved: 0, escalated: 0, dismissed: 0 });
    });

    it("sets resolved_at and resolution text when auto-resolving a conflict", async () => {
      const idA = insertMemory({ source_authority: 2, confidence: 0.8 });
      const idB = insertMemory({ source_authority: 1, confidence: 0.8 });
      const conflictId = insertConflict(idA, idB);

      await autoResolveConflicts();

      const conflict = getConflict(conflictId);
      expect(conflict.resolved_at).not.toBeNull();
      // SQLite datetime('now') returns a valid datetime string
      expect(typeof conflict.resolved_at).toBe("string");
      expect(conflict.resolution).toBeTruthy();
    });

    it("superseded memory has status set to 'superseded' after auto-resolution", async () => {
      const idA = insertMemory({ source_authority: 2, confidence: 0.8 });
      const idB = insertMemory({ source_authority: 1, confidence: 0.8 });
      insertConflict(idA, idB);

      await autoResolveConflicts();

      expect(getMemory(idB).status).toBe("superseded");
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resolveConflict()
// ════════════════════════════════════════════════════════════════════════════

describe("resolveConflict()", () => {
  // ── choose_a ──────────────────────────────────────────────────────────

  describe("choose_a", () => {
    it("supersedes B and keeps A active", async () => {
      const idA = insertMemory({ content: "memory A" });
      const idB = insertMemory({ content: "memory B" });
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "choose_a");

      expect(getMemory(idA).status).toBe("active");
      expect(getMemory(idB).status).toBe("superseded");
    });

    it("records resolved_at and resolution='manual: chose A'", async () => {
      const idA = insertMemory();
      const idB = insertMemory();
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "choose_a");

      const conflict = getConflict(conflictId);
      expect(conflict.resolved_at).not.toBeNull();
      expect(conflict.resolution).toBe("manual: chose A");
    });
  });

  // ── choose_b ──────────────────────────────────────────────────────────

  describe("choose_b", () => {
    it("supersedes A and keeps B active", async () => {
      const idA = insertMemory({ content: "memory A" });
      const idB = insertMemory({ content: "memory B" });
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "choose_b");

      expect(getMemory(idA).status).toBe("superseded");
      expect(getMemory(idB).status).toBe("active");
    });

    it("records resolution='manual: chose B'", async () => {
      const idA = insertMemory();
      const idB = insertMemory();
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "choose_b");

      expect(getConflict(conflictId).resolution).toBe("manual: chose B");
    });
  });

  // ── merge ─────────────────────────────────────────────────────────────

  describe("merge", () => {
    it("supersedes both A and B", async () => {
      const idA = insertMemory({ content: "memory A" });
      const idB = insertMemory({ content: "memory B" });
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "merge", "merged content");

      expect(getMemory(idA).status).toBe("superseded");
      expect(getMemory(idB).status).toBe("superseded");
    });

    it("creates a new active merged memory with the provided content", async () => {
      const db = getMemoryDb();
      const idA = insertMemory({ content: "memory A" });
      const idB = insertMemory({ content: "memory B" });
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "merge", "the merged content");

      // New memory should exist with the merged content
      const merged = db
        .prepare("SELECT * FROM memories WHERE content = ? AND status = 'active'")
        .get("the merged content") as Memory | undefined;

      expect(merged).toBeDefined();
      expect(merged!.content).toBe("the merged content");
      expect(merged!.status).toBe("active");
    });

    it("new merged memory inherits the higher authority of the two memories", async () => {
      const db = getMemoryDb();
      const idA = insertMemory({ content: "A", source_authority: 1 });
      const idB = insertMemory({ content: "B", source_authority: 2 });
      insertConflict(idA, idB);

      await resolveConflict(
        getConflict((db.prepare("SELECT id FROM conflicts").get() as Conflict).id).id,
        "merge",
        "merged",
      );

      const merged = db
        .prepare("SELECT * FROM memories WHERE content = 'merged'")
        .get() as Memory | undefined;

      expect(merged).toBeDefined();
      expect(merged!.source_authority).toBe(2);
    });

    it("new merged memory inherits the higher confidence of the two memories", async () => {
      const db = getMemoryDb();
      const idA = insertMemory({ content: "A", confidence: 0.6 });
      const idB = insertMemory({ content: "B", confidence: 0.9 });
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "merge", "merged");

      const merged = db
        .prepare("SELECT * FROM memories WHERE content = 'merged'")
        .get() as Memory | undefined;

      expect(merged).toBeDefined();
      expect(merged!.confidence).toBe(0.9);
    });

    it("copies evidence from both A and B to the new merged memory", async () => {
      const db = getMemoryDb();
      const eventId1 = insertEvent();
      const eventId2 = insertEvent();

      const idA = insertMemory({ content: "A" });
      const idB = insertMemory({ content: "B" });
      insertEvidence(idA, eventId1);
      insertEvidence(idB, eventId2);

      const conflictId = insertConflict(idA, idB);
      await resolveConflict(conflictId, "merge", "merged");

      const merged = db
        .prepare("SELECT * FROM memories WHERE content = 'merged'")
        .get() as Memory | undefined;

      expect(merged).toBeDefined();

      const evidence = getEvidenceForMemory(merged!.id);
      const eventIds = evidence.map((e) => e.event_id);
      expect(eventIds).toContain(eventId1);
      expect(eventIds).toContain(eventId2);
    });

    it("conflict resolution text references the new merged memory ID", async () => {
      const db = getMemoryDb();
      const idA = insertMemory({ content: "A" });
      const idB = insertMemory({ content: "B" });
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "merge", "merged");

      const conflict = getConflict(conflictId);
      expect(conflict.resolution).toMatch(/^manual: merged into memory #\d+$/);

      // Extract the ID from the resolution string and verify the memory exists
      const match = conflict.resolution!.match(/#(\d+)/);
      expect(match).not.toBeNull();
      const newId = parseInt(match![1], 10);
      const mergedMemory = db
        .prepare("SELECT * FROM memories WHERE id = ?")
        .get(newId) as Memory | undefined;
      expect(mergedMemory).toBeDefined();
      expect(mergedMemory!.content).toBe("merged");
    });

    it("throws an error when mergedContent is not provided", async () => {
      const idA = insertMemory();
      const idB = insertMemory();
      const conflictId = insertConflict(idA, idB);

      await expect(resolveConflict(conflictId, "merge")).rejects.toThrow(
        "mergedContent is required for 'merge' resolution",
      );
    });
  });

  // ── dismiss ───────────────────────────────────────────────────────────

  describe("dismiss", () => {
    it("supersedes both A and B", async () => {
      const idA = insertMemory({ content: "memory A" });
      const idB = insertMemory({ content: "memory B" });
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "dismiss");

      expect(getMemory(idA).status).toBe("superseded");
      expect(getMemory(idB).status).toBe("superseded");
    });

    it("records resolution='manual: dismissed both'", async () => {
      const idA = insertMemory();
      const idB = insertMemory();
      const conflictId = insertConflict(idA, idB);

      await resolveConflict(conflictId, "dismiss");

      const conflict = getConflict(conflictId);
      expect(conflict.resolved_at).not.toBeNull();
      expect(conflict.resolution).toBe("manual: dismissed both");
    });
  });

  // ── Error cases ────────────────────────────────────────────────────────

  describe("error cases", () => {
    it("throws when the conflict ID does not exist", async () => {
      await expect(resolveConflict(99999, "choose_a")).rejects.toThrow(
        "Conflict #99999 not found",
      );
    });

    it("throws when memory A has been deleted", async () => {
      const db = getMemoryDb();
      const idA = insertMemory();
      const idB = insertMemory();
      const conflictId = insertConflict(idA, idB);

      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM memories WHERE id = ?").run(idA);
      db.pragma("foreign_keys = ON");

      await expect(resolveConflict(conflictId, "choose_a")).rejects.toThrow(
        `One or both memories for conflict #${conflictId} not found`,
      );
    });

    it("throws when memory B has been deleted", async () => {
      const db = getMemoryDb();
      const idA = insertMemory();
      const idB = insertMemory();
      const conflictId = insertConflict(idA, idB);

      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM memories WHERE id = ?").run(idB);
      db.pragma("foreign_keys = ON");

      await expect(resolveConflict(conflictId, "choose_b")).rejects.toThrow(
        `One or both memories for conflict #${conflictId} not found`,
      );
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// getUnresolvedConflicts()
// ════════════════════════════════════════════════════════════════════════════

describe("getUnresolvedConflicts()", () => {
  it("returns an empty array when there are no conflicts", () => {
    expect(getUnresolvedConflicts()).toEqual([]);
  });

  it("returns only conflicts where resolved_at IS NULL", () => {
    const db = getMemoryDb();
    const idA = insertMemory();
    const idB = insertMemory();
    const idC = insertMemory();

    const unresolvedId = insertConflict(idA, idB, "unresolved");
    const resolvedId = insertConflict(idA, idC, "already resolved");

    // Mark the second conflict as resolved
    db.prepare(
      "UPDATE conflicts SET resolved_at = datetime('now'), resolution = 'manual: chose A' WHERE id = ?",
    ).run(resolvedId);

    const results = getUnresolvedConflicts();

    expect(results).toHaveLength(1);
    expect(results[0].conflict.id).toBe(unresolvedId);
  });

  it("returns conflicts with their associated memories populated", () => {
    const idA = insertMemory({ content: "memory A content" });
    const idB = insertMemory({ content: "memory B content" });
    insertConflict(idA, idB, "describe it");

    const results = getUnresolvedConflicts();

    expect(results).toHaveLength(1);
    const { conflict, memoryA, memoryB } = results[0];

    expect(conflict.description).toBe("describe it");
    expect(memoryA.id).toBe(idA);
    expect(memoryA.content).toBe("memory A content");
    expect(memoryB.id).toBe(idB);
    expect(memoryB.content).toBe("memory B content");
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      const a = insertMemory({ content: `memory ${i}a` });
      const b = insertMemory({ content: `memory ${i}b` });
      insertConflict(a, b);
    }

    const results = getUnresolvedConflicts(3);
    expect(results).toHaveLength(3);
  });

  it("defaults to returning at most 10 results", () => {
    for (let i = 0; i < 15; i++) {
      const a = insertMemory({ content: `mem ${i}a` });
      const b = insertMemory({ content: `mem ${i}b` });
      insertConflict(a, b);
    }

    const results = getUnresolvedConflicts();
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it("skips conflicts where one memory is missing (no memA)", () => {
    const db = getMemoryDb();
    const idA = insertMemory();
    const idB = insertMemory();
    insertConflict(idA, idB);

    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM memories WHERE id = ?").run(idA);
    db.pragma("foreign_keys = ON");

    const results = getUnresolvedConflicts();
    expect(results).toHaveLength(0);
  });

  it("skips conflicts where one memory is missing (no memB)", () => {
    const db = getMemoryDb();
    const idA = insertMemory();
    const idB = insertMemory();
    insertConflict(idA, idB);

    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM memories WHERE id = ?").run(idB);
    db.pragma("foreign_keys = ON");

    const results = getUnresolvedConflicts();
    expect(results).toHaveLength(0);
  });

  it("returns conflicts ordered newest first (ORDER BY created_at DESC)", () => {
    const db = getMemoryDb();
    // SQLite datetime('now') has second-level granularity, so we pin created_at
    // explicitly to guarantee strict ordering without relying on wall-clock sleeps.
    const timestamps = [
      "2026-01-01 10:00:00",
      "2026-01-01 10:00:01",
      "2026-01-01 10:00:02",
    ];

    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = insertMemory({ content: `mem${i}a` });
      const b = insertMemory({ content: `mem${i}b` });
      // Insert conflict with an explicit created_at so ordering is deterministic
      const result = db
        .prepare(
          "INSERT INTO conflicts (memory_a, memory_b, description, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(a, b, `conflict ${i}`, timestamps[i]);
      ids.push(result.lastInsertRowid as number);
    }

    const results = getUnresolvedConflicts();

    // Newest timestamp first
    expect(results[0].conflict.id).toBe(ids[2]);
    expect(results[1].conflict.id).toBe(ids[1]);
    expect(results[2].conflict.id).toBe(ids[0]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// promoteMemory()
// ════════════════════════════════════════════════════════════════════════════

describe("promoteMemory()", () => {
  it("updates source_authority to the specified value", () => {
    const id = insertMemory({ source_authority: 0 });

    promoteMemory(id, 3);

    expect(getMemory(id).source_authority).toBe(3);
  });

  it("can set authority to any valid level (0–3)", () => {
    const id = insertMemory({ source_authority: 3 });

    promoteMemory(id, 0);
    expect(getMemory(id).source_authority).toBe(0);

    promoteMemory(id, 1);
    expect(getMemory(id).source_authority).toBe(1);

    promoteMemory(id, 2);
    expect(getMemory(id).source_authority).toBe(2);

    promoteMemory(id, 3);
    expect(getMemory(id).source_authority).toBe(3);
  });

  it("updates updated_at timestamp", () => {
    const db = getMemoryDb();
    const id = insertMemory({ source_authority: 0 });

    // Record the original timestamp
    const before = getMemory(id).updated_at;

    // Wait a tick then promote
    db.prepare(
      "UPDATE memories SET updated_at = datetime('now', '-1 second') WHERE id = ?",
    ).run(id);

    promoteMemory(id, 2);

    const after = getMemory(id).updated_at;
    // updated_at should have changed (SQLite datetime('now') is second-granularity)
    expect(after).not.toBeNull();
    // The column type is a string in SQLite — it should look like a datetime
    expect(after).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("does not affect other memory fields", () => {
    const id = insertMemory({
      content: "original content",
      confidence: 0.75,
      scope: "project",
      status: "active",
    });

    promoteMemory(id, 3);

    const mem = getMemory(id);
    expect(mem.content).toBe("original content");
    expect(mem.confidence).toBe(0.75);
    expect(mem.scope).toBe("project");
    expect(mem.status).toBe("active");
  });

  it("silently does nothing for a non-existent memory ID (no error thrown)", () => {
    // SQLite UPDATE with no matching row is not an error
    expect(() => promoteMemory(999999, 2)).not.toThrow();
  });
});
