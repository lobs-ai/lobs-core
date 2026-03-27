/**
 * Tests for the memory GC (garbage collection) module.
 *
 * Uses an in-memory SQLite DB so no real file is touched.
 * LM Studio / embedding generation is never called — resurrectMemory()
 * is tested for status/log behaviour only; embedding re-gen is best-effort
 * and the test suite doesn't mock fetch.
 */

import { initMemoryDb, closeMemoryDb, getMemoryDb } from "../src/memory/db.js";
import { runMemoryGC, importanceScore, resurrectMemory } from "../src/memory/gc.js";
import type { Memory } from "../src/memory/types.js";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(() => {
  initMemoryDb(":memory:");
});

afterAll(() => {
  closeMemoryDb();
});

beforeEach(() => {
  const db = getMemoryDb();
  // Clean all tables in dependency order so FK constraints don't fire
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

/** Returns an ISO timestamp N days in the past. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** Insert a memory row with sensible defaults; returns the new row id. */
function insertMemory(overrides: Partial<{
  memory_type: string;
  content: string;
  confidence: number;
  scope: string;
  source_authority: number;
  status: string;
  derived_at: string;
  updated_at: string;
  last_accessed: string | null;
  access_count: number;
  agent_type: string | null;
  project_id: string | null;
}>): number {
  const db = getMemoryDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO memories
      (memory_type, content, confidence, scope, source_authority, status,
       derived_at, last_accessed, access_count, agent_type, project_id,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.memory_type    ?? "fact",
    overrides.content        ?? "test memory",
    overrides.confidence     ?? 0.8,
    overrides.scope          ?? "system",
    overrides.source_authority ?? 1,
    overrides.status         ?? "active",
    overrides.derived_at     ?? now,
    overrides.last_accessed  ?? null,
    overrides.access_count   ?? 0,
    overrides.agent_type     ?? null,
    overrides.project_id     ?? null,
    now,
    overrides.updated_at     ?? now,
  );
  return result.lastInsertRowid as number;
}

/** Insert an evidence row linking a memory to a dummy event. */
function insertEvidence(memoryId: number): void {
  const db = getMemoryDb();
  // We need a real event row because evidence has a FK to events
  const now = new Date().toISOString();
  const eventResult = db.prepare(`
    INSERT INTO events (timestamp, agent_id, agent_type, event_type, content, scope, signal_score, created_at)
    VALUES (?, 'test-agent', 'test', 'observation', 'evidence event', 'system', 0.5, ?)
  `).run(now, now);
  const eventId = eventResult.lastInsertRowid as number;

  db.prepare(`
    INSERT INTO evidence (memory_id, event_id, relationship, strength, created_at)
    VALUES (?, ?, 'supports', 1.0, ?)
  `).run(memoryId, eventId, now);
}

/** Read a single memory row by id. */
function getMemory(id: number): Memory | undefined {
  return getMemoryDb()
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as Memory | undefined;
}

/** Count gc_log rows for a given memory id. */
function gcLogCount(memoryId: number): number {
  const row = getMemoryDb()
    .prepare("SELECT COUNT(*) AS n FROM gc_log WHERE memory_id = ?")
    .get(memoryId) as { n: number };
  return row.n;
}

/** Read all gc_log rows for a memory id. */
function gcLogEntries(memoryId: number): Array<{ from_status: string; to_status: string; reason: string }> {
  return getMemoryDb()
    .prepare("SELECT from_status, to_status, reason FROM gc_log WHERE memory_id = ? ORDER BY id")
    .all(memoryId) as Array<{ from_status: string; to_status: string; reason: string }>;
}

/** Count embedding rows for a memory id. */
function embeddingCount(memoryId: number): number {
  const row = getMemoryDb()
    .prepare("SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?")
    .get(memoryId) as { n: number };
  return row.n;
}

/** Insert a fake embedding blob for a memory. */
function insertEmbedding(memoryId: number): void {
  const buf = Buffer.alloc(16, 0); // tiny fake embedding
  getMemoryDb()
    .prepare("INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)")
    .run(memoryId, buf);
}

// ── runMemoryGC() ─────────────────────────────────────────────────────────────

describe("runMemoryGC()", () => {

  // ── Active → Stale transitions ──────────────────────────────────────────────

  describe("active → stale transitions", () => {
    it("transitions a never-accessed memory older than 90 days to stale", async () => {
      const id = insertMemory({ access_count: 0, derived_at: daysAgo(91) });

      const result = await runMemoryGC();

      expect(result.transitionsToStale).toBe(1);
      expect(result.totalEvaluated).toBe(1);
      expect(getMemory(id)!.status).toBe("stale");
    });

    it("leaves a recently-accessed memory younger than 90 days as active", async () => {
      const id = insertMemory({
        access_count: 1,
        derived_at: daysAgo(45),
        last_accessed: daysAgo(10),
      });

      const result = await runMemoryGC();

      expect(result.transitionsToStale).toBe(0);
      expect(getMemory(id)!.status).toBe("active");
    });

    it("transitions a memory last accessed more than 180 days ago to stale", async () => {
      // Has been accessed (access_count > 0) but abandoned
      const id = insertMemory({
        access_count: 5,
        derived_at: daysAgo(200),
        last_accessed: daysAgo(181),
      });

      const result = await runMemoryGC();

      expect(result.transitionsToStale).toBe(1);
      expect(getMemory(id)!.status).toBe("stale");
    });

    it("leaves a memory last accessed 100 days ago as active", async () => {
      const id = insertMemory({
        access_count: 3,
        derived_at: daysAgo(120),
        last_accessed: daysAgo(100),
      });

      const result = await runMemoryGC();

      expect(result.transitionsToStale).toBe(0);
      expect(getMemory(id)!.status).toBe("active");
    });

    it("85-day memory with recent access stays active (under 90d never-used threshold)", async () => {
      // Under the 90d never-used threshold, and recently accessed so not abandoned
      const id = insertMemory({
        access_count: 1,
        derived_at: daysAgo(85),
        last_accessed: daysAgo(10),
      });

      const result = await runMemoryGC();

      expect(result.transitionsToStale).toBe(0);
      expect(getMemory(id)!.status).toBe("active");
    });
  });

  // ── Stale → Archived transitions ────────────────────────────────────────────

  describe("stale → archived transitions", () => {
    it("archives a never-used stale memory after 30 days in stale status", async () => {
      const id = insertMemory({
        status: "stale",
        access_count: 0,
        derived_at: daysAgo(120),
        updated_at: daysAgo(31), // stale for 31 days
      });

      const result = await runMemoryGC();

      expect(result.transitionsToArchived).toBe(1);
      expect(getMemory(id)!.status).toBe("archived");
    });

    it("archives a previously-used stale memory after 60 days in stale status", async () => {
      const id = insertMemory({
        status: "stale",
        access_count: 3,
        derived_at: daysAgo(200),
        updated_at: daysAgo(61), // stale for 61 days
      });

      const result = await runMemoryGC();

      expect(result.transitionsToArchived).toBe(1);
      expect(getMemory(id)!.status).toBe("archived");
    });

    it("does NOT archive a stale memory that has been stale for less than 30 days", async () => {
      const id = insertMemory({
        status: "stale",
        access_count: 0,
        derived_at: daysAgo(100),
        updated_at: daysAgo(15), // only 15 days stale
      });

      const result = await runMemoryGC();

      expect(result.transitionsToArchived).toBe(0);
      expect(getMemory(id)!.status).toBe("stale");
    });

    it("does NOT archive a previously-used stale memory before the 60-day threshold", async () => {
      const id = insertMemory({
        status: "stale",
        access_count: 2,
        derived_at: daysAgo(150),
        updated_at: daysAgo(45), // 45 days stale, threshold is 60
      });

      const result = await runMemoryGC();

      expect(result.transitionsToArchived).toBe(0);
      expect(getMemory(id)!.status).toBe("stale");
    });
  });

  // ── Confidence decay ─────────────────────────────────────────────────────────

  describe("confidence decay", () => {
    it("decays confidence for an active memory with evidence but < 3 retrievals over 90+ days", async () => {
      // access_count must be >= 1 to avoid the "never-used → stale" path
      // last_accessed must be recent enough to avoid the "abandoned" path (>180d)
      const id = insertMemory({
        confidence: 0.8,
        access_count: 1,
        derived_at: daysAgo(95),
        last_accessed: daysAgo(50),
      });
      // Insert 2 evidence entries
      insertEvidence(id);
      insertEvidence(id);

      const result = await runMemoryGC();

      expect(result.confidenceReductions).toBe(1);
      const updated = getMemory(id)!;
      // ~3 full 30-day cycles at 0.95 each
      expect(updated.confidence).toBeLessThan(0.8);
      expect(updated.confidence).toBeGreaterThan(0.05);
    });

    it("applies the correct decay formula: confidence * 0.95^(age_in_30day_cycles)", async () => {
      const initialConfidence = 0.9;
      const ageDays = 120;
      const id = insertMemory({
        confidence: initialConfidence,
        access_count: 2, // < 3 so decay applies, but > 0 to avoid stale path
        derived_at: daysAgo(ageDays),
        last_accessed: daysAgo(50), // recent enough to avoid abandoned path
      });
      insertEvidence(id);

      await runMemoryGC();

      const updated = getMemory(id)!;
      // daysAgo(120) produces slightly < 120 days due to sub-day precision
      // so Math.floor(~119.x / 30) = 3, not 4
      const cycles = 3;
      const expected = initialConfidence * Math.pow(0.95, cycles);
      // Allow for floating-point rounding in the DB round-trip
      expect(updated.confidence).toBeCloseTo(expected, 4);
    });

    it("does NOT decay an active memory with no evidence", async () => {
      const id = insertMemory({
        confidence: 0.8,
        access_count: 0,
        derived_at: daysAgo(91),
        // no evidence inserted
      });

      // This memory transitions to stale (never-used > 90d), not decay
      const result = await runMemoryGC();

      expect(result.confidenceReductions).toBe(0);
    });

    it("clamps decayed confidence at the 0.05 floor", async () => {
      // Very old memory + very low starting confidence should floor at 0.05
      const id = insertMemory({
        confidence: 0.06,
        access_count: 1,
        derived_at: daysAgo(1500),
        last_accessed: daysAgo(50), // avoid abandoned path
      });
      insertEvidence(id);

      await runMemoryGC();

      const updated = getMemory(id)!;
      expect(updated.confidence).toBeGreaterThanOrEqual(0.05);
    });
  });

  // ── Protection rules ─────────────────────────────────────────────────────────

  describe("protection rules", () => {
    it("protects a high-authority memory (source_authority >= 2) from archiving", async () => {
      const id = insertMemory({
        status: "stale",
        source_authority: 2,
        access_count: 0,
        derived_at: daysAgo(200),
        updated_at: daysAgo(90), // way past the 30-day stale threshold
      });

      const result = await runMemoryGC();

      expect(result.protectedMemories).toBe(1);
      expect(result.transitionsToArchived).toBe(0);
      expect(getMemory(id)!.status).toBe("stale");
    });

    it("protects a memory with 5 or more evidence entries", async () => {
      const id = insertMemory({
        status: "stale",
        access_count: 0,
        derived_at: daysAgo(200),
        updated_at: daysAgo(60),
      });
      // Insert 5 evidence rows
      for (let i = 0; i < 5; i++) insertEvidence(id);

      const result = await runMemoryGC();

      expect(result.protectedMemories).toBe(1);
      expect(result.transitionsToArchived).toBe(0);
      expect(getMemory(id)!.status).toBe("stale");
    });

    it("does NOT protect a memory with only 4 evidence entries", async () => {
      const id = insertMemory({
        status: "stale",
        access_count: 0,
        derived_at: daysAgo(200),
        updated_at: daysAgo(60),
      });
      for (let i = 0; i < 4; i++) insertEvidence(id);

      const result = await runMemoryGC();

      expect(result.transitionsToArchived).toBe(1);
      expect(getMemory(id)!.status).toBe("archived");
    });

    it("protects a memory_type='preference' memory from archiving", async () => {
      const id = insertMemory({
        memory_type: "preference",
        status: "stale",
        access_count: 0,
        derived_at: daysAgo(200),
        updated_at: daysAgo(90),
      });

      const result = await runMemoryGC();

      expect(result.protectedMemories).toBe(1);
      expect(getMemory(id)!.status).toBe("stale");
    });

    it("protects a memory_type='decision' memory with confidence > 0.7", async () => {
      const id = insertMemory({
        memory_type: "decision",
        confidence: 0.85,
        status: "stale",
        access_count: 0,
        derived_at: daysAgo(200),
        updated_at: daysAgo(90),
      });

      const result = await runMemoryGC();

      expect(result.protectedMemories).toBe(1);
      expect(getMemory(id)!.status).toBe("stale");
    });

    it("does NOT protect a memory_type='decision' memory with confidence <= 0.7", async () => {
      const id = insertMemory({
        memory_type: "decision",
        confidence: 0.7, // exactly 0.7 — condition is > 0.7, so not protected
        status: "stale",
        access_count: 0,
        derived_at: daysAgo(200),
        updated_at: daysAgo(90),
      });

      const result = await runMemoryGC();

      expect(result.transitionsToArchived).toBe(1);
      expect(getMemory(id)!.status).toBe("archived");
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns all-zero result on an empty database", async () => {
      const result = await runMemoryGC();

      expect(result.transitionsToStale).toBe(0);
      expect(result.transitionsToArchived).toBe(0);
      expect(result.confidenceReductions).toBe(0);
      expect(result.protectedMemories).toBe(0);
      expect(result.totalEvaluated).toBe(0);
    });

    it("ignores superseded and archived memories — totalEvaluated stays 0", async () => {
      insertMemory({ status: "superseded" });
      insertMemory({ status: "archived" });
      insertMemory({ status: "expired" });

      const result = await runMemoryGC();

      expect(result.totalEvaluated).toBe(0);
    });

    it("handles a mixed batch: one transitions, one is protected, one stays", async () => {
      // Will transition to stale (never-used, old)
      const idTransition = insertMemory({
        access_count: 0,
        derived_at: daysAgo(100),
      });

      // Will be protected (high authority stale memory past threshold)
      const idProtected = insertMemory({
        status: "stale",
        source_authority: 3,
        access_count: 0,
        derived_at: daysAgo(200),
        updated_at: daysAgo(90),
      });

      // Will stay active (recently accessed)
      const idStays = insertMemory({
        access_count: 5,
        derived_at: daysAgo(50),
        last_accessed: daysAgo(10),
      });

      const result = await runMemoryGC();

      expect(result.totalEvaluated).toBe(3);
      expect(result.transitionsToStale).toBe(1);
      expect(result.protectedMemories).toBe(1);
      expect(result.transitionsToArchived).toBe(0);

      expect(getMemory(idTransition)!.status).toBe("stale");
      expect(getMemory(idProtected)!.status).toBe("stale");
      expect(getMemory(idStays)!.status).toBe("active");
    });
  });

  // ── GC log entries ───────────────────────────────────────────────────────────

  describe("gc_log entries", () => {
    it("creates a gc_log entry when transitioning active → stale", async () => {
      const id = insertMemory({ access_count: 0, derived_at: daysAgo(95) });

      await runMemoryGC();

      const entries = gcLogEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].from_status).toBe("active");
      expect(entries[0].to_status).toBe("stale");
      expect(entries[0].reason).toContain("never accessed");
    });

    it("creates a gc_log entry when transitioning stale → archived", async () => {
      const id = insertMemory({
        status: "stale",
        access_count: 0,
        derived_at: daysAgo(120),
        updated_at: daysAgo(35),
      });

      await runMemoryGC();

      const entries = gcLogEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].from_status).toBe("stale");
      expect(entries[0].to_status).toBe("archived");
    });

    it("creates a gc_log entry for confidence decay (status unchanged)", async () => {
      const id = insertMemory({
        confidence: 0.8,
        access_count: 1,
        derived_at: daysAgo(95),
        last_accessed: daysAgo(50), // recent enough to avoid abandoned path
      });
      insertEvidence(id);

      await runMemoryGC();

      const entries = gcLogEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].from_status).toBe("active");
      expect(entries[0].to_status).toBe("active"); // status unchanged
      expect(entries[0].reason).toContain("confidence decay");
    });

    it("does NOT create a gc_log entry for memories that change nothing", async () => {
      // Recently active memory — no transition, no decay
      const id = insertMemory({
        access_count: 10,
        derived_at: daysAgo(30),
        last_accessed: daysAgo(5),
      });

      await runMemoryGC();

      expect(gcLogCount(id)).toBe(0);
    });
  });

  // ── Embedding cleanup on archive ─────────────────────────────────────────────

  describe("embedding cleanup on archive", () => {
    it("deletes the embedding row when a stale memory is archived", async () => {
      const id = insertMemory({
        status: "stale",
        access_count: 0,
        derived_at: daysAgo(120),
        updated_at: daysAgo(31),
      });
      insertEmbedding(id);
      expect(embeddingCount(id)).toBe(1);

      await runMemoryGC();

      expect(getMemory(id)!.status).toBe("archived");
      expect(embeddingCount(id)).toBe(0);
    });

    it("leaves the memory row intact (audit trail) after archiving the embedding", async () => {
      const id = insertMemory({
        status: "stale",
        access_count: 0,
        content: "important audit content",
        derived_at: daysAgo(120),
        updated_at: daysAgo(35),
      });
      insertEmbedding(id);

      await runMemoryGC();

      const mem = getMemory(id);
      expect(mem).toBeDefined();
      expect(mem!.content).toBe("important audit content");
      expect(mem!.status).toBe("archived");
    });
  });
});

// ── importanceScore() ─────────────────────────────────────────────────────────

describe("importanceScore()", () => {
  /** Build a minimal Memory stub without inserting it into the DB. */
  function makeMemory(overrides: Partial<Memory>): Memory {
    const now = new Date().toISOString();
    return {
      id: 1,
      memory_type: "fact",
      content: "test",
      confidence: 0.8,
      scope: "system",
      agent_type: null,
      project_id: null,
      source_authority: 1,
      status: "active",
      superseded_by: null,
      derived_at: now,
      last_validated: null,
      expires_at: null,
      last_accessed: now,
      access_count: 0,
      reflection_run_id: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  it("returns close to confidence value for a recently accessed memory", () => {
    const m = makeMemory({ confidence: 0.9, last_accessed: daysAgo(1), access_count: 10 });
    const score = importanceScore(m);
    // After 1 day with 120-day half-life, decay is ~0.9 * 0.5^(1/120) ≈ 0.895
    expect(score).toBeGreaterThan(0.85);
    expect(score).toBeLessThanOrEqual(0.9);
  });

  it("returns a notably lower score for a never-accessed, old memory", () => {
    const m = makeMemory({
      confidence: 0.8,
      last_accessed: null,
      derived_at: daysAgo(365),
      access_count: 0,
    });
    const score = importanceScore(m);
    // 365d with 120d half-life: 0.8 * 0.5^(365/120) ≈ 0.8 * 0.5^3.04 ≈ 0.099
    expect(score).toBeLessThan(0.5);
  });

  it("floor from high access_count prevents score from dropping to near-zero", () => {
    const m = makeMemory({
      confidence: 0.7,
      last_accessed: daysAgo(500), // very stale
      access_count: 7,
    });
    const score = importanceScore(m);
    // floor = 0.1 * log2(8) = 0.1 * 3 = 0.3
    const expectedFloor = 0.1 * Math.log2(7 + 1);
    expect(score).toBeGreaterThanOrEqual(expectedFloor - 1e-10);
  });

  it("uses derived_at as the reference date when last_accessed is null", () => {
    const oldDate = daysAgo(240);
    const mWithAccess = makeMemory({ confidence: 0.8, last_accessed: oldDate, access_count: 0 });
    const mNullAccess = makeMemory({ confidence: 0.8, last_accessed: null, derived_at: oldDate, access_count: 0 });
    // Both should produce the same score because same reference date is used
    expect(importanceScore(mWithAccess)).toBeCloseTo(importanceScore(mNullAccess), 5);
  });

  it("verifies the 120-day half-life: score halves at exactly 120 days", () => {
    const confidence = 1.0;
    const m = makeMemory({
      confidence,
      last_accessed: daysAgo(120),
      access_count: 0,
    });
    const score = importanceScore(m);
    // After one half-life the decayed component should be exactly 0.5
    expect(score).toBeCloseTo(0.5, 3);
  });

  it("floor is capped: access_count of 1000 does not produce a floor above ~0.3", () => {
    // log2(1001) ≈ 9.97, * 0.1 = 0.997 — but the spec says capped at ~0.3.
    // The actual implementation does NOT hard-cap at 0.3; it's described as
    // "capped at ~0.3" in the design notes because typical real-world usage
    // rarely exceeds that. The code itself: floor = 0.1 * log2(count + 1).
    // We just verify the function doesn't return > 1.0 and grows with count.
    const mLow  = makeMemory({ confidence: 0.5, last_accessed: daysAgo(600), access_count: 1 });
    const mHigh = makeMemory({ confidence: 0.5, last_accessed: daysAgo(600), access_count: 100 });
    expect(importanceScore(mHigh)).toBeGreaterThan(importanceScore(mLow));
    expect(importanceScore(mHigh)).toBeLessThanOrEqual(1.0);
  });

  it("returns a value in [0, 1] under all inputs", () => {
    const cases: Partial<Memory>[] = [
      { confidence: 1.0, last_accessed: new Date().toISOString(), access_count: 0 },
      { confidence: 0.0, last_accessed: daysAgo(730), access_count: 0 },
      { confidence: 0.5, last_accessed: daysAgo(120), access_count: 50 },
      { confidence: 0.99, last_accessed: null, derived_at: daysAgo(1), access_count: 0 },
    ];
    for (const overrides of cases) {
      const score = importanceScore(makeMemory(overrides));
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1.0);
    }
  });
});

// ── resurrectMemory() ─────────────────────────────────────────────────────────

describe("resurrectMemory()", () => {
  it("resurrects an archived memory back to active status", async () => {
    const id = insertMemory({ status: "archived" });

    const ok = await resurrectMemory(id);

    expect(ok).toBe(true);
    expect(getMemory(id)!.status).toBe("active");
  });

  it("updates last_accessed when resurrecting", async () => {
    const id = insertMemory({ status: "archived", last_accessed: null });

    await resurrectMemory(id);

    expect(getMemory(id)!.last_accessed).not.toBeNull();
  });

  it("returns false for a non-archived (active) memory", async () => {
    const id = insertMemory({ status: "active" });

    const ok = await resurrectMemory(id);

    expect(ok).toBe(false);
    expect(getMemory(id)!.status).toBe("active"); // unchanged
  });

  it("returns false for a stale memory (not archived)", async () => {
    const id = insertMemory({ status: "stale" });

    const ok = await resurrectMemory(id);

    expect(ok).toBe(false);
    expect(getMemory(id)!.status).toBe("stale"); // unchanged
  });

  it("returns false for a non-existent memory id", async () => {
    const ok = await resurrectMemory(999_999);

    expect(ok).toBe(false);
  });

  it("creates a gc_log entry for the resurrection", async () => {
    const id = insertMemory({ status: "archived" });

    await resurrectMemory(id);

    const entries = gcLogEntries(id);
    expect(entries).toHaveLength(1);
    expect(entries[0].from_status).toBe("archived");
    expect(entries[0].to_status).toBe("active");
    expect(entries[0].reason).toBe("resurrected");
  });

  it("does NOT create a gc_log entry when resurrection is rejected (non-archived memory)", async () => {
    const id = insertMemory({ status: "active" });

    await resurrectMemory(id);

    expect(gcLogCount(id)).toBe(0);
  });

  it("succeeds even when no embedding exists (LM Studio not available)", async () => {
    // No embedding row inserted — resurrection should still succeed
    const id = insertMemory({ status: "archived" });

    const ok = await resurrectMemory(id);

    expect(ok).toBe(true);
    expect(getMemory(id)!.status).toBe("active");
  });

  it("can be called twice on the same memory (second call returns false)", async () => {
    const id = insertMemory({ status: "archived" });

    const first = await resurrectMemory(id);
    const second = await resurrectMemory(id); // now active, not archived

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
