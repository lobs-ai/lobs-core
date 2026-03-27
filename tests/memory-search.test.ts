/**
 * Comprehensive Vitest tests for the memory search module.
 *
 * Covers:
 *  - decayedConfidence() — exponential decay by memory_type, facts exempt
 *  - searchMemoriesFast() — FTS5 path, filters, ranking, access tracking
 *  - searchMemoriesFull() — graceful fallback when vector search fails (no LM Studio)
 *  - importanceScore() (from gc.ts) — decay + access-count floor
 *
 * The default minConfidence filter is 0.3; tests that need to include low-confidence
 * memories explicitly pass { minConfidence: 0 }.
 *
 * FTS5 is populated via INSERT/DELETE/UPDATE triggers on the memories table, so
 * records are searchable immediately after insertMemory().
 */

import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
} from "vitest";
import { initMemoryDb, closeMemoryDb, getMemoryDb } from "../src/memory/db.js";
import {
  decayedConfidence,
  searchMemoriesFast,
  searchMemoriesFull,
} from "../src/memory/search.js";
import { importanceScore } from "../src/memory/gc.js";
import type { Memory } from "../src/memory/types.js";

// ── Test DB lifecycle ─────────────────────────────────────────────────────────

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
});

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    last_validated: string | null;
    project_id: string | null;
  }> = {},
): number {
  const db = getMemoryDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO memories (
        memory_type, content, confidence, scope, source_authority, status,
        derived_at, last_accessed, access_count, last_validated, project_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.memory_type ?? "fact",
      overrides.content ?? "test memory",
      overrides.confidence ?? 0.8,
      overrides.scope ?? "system",
      overrides.source_authority ?? 1,
      overrides.status ?? "active",
      overrides.derived_at ?? now,
      overrides.last_accessed ?? null,
      overrides.access_count ?? 0,
      overrides.last_validated ?? null,
      overrides.project_id ?? null,
      now,
      now,
    );
  return result.lastInsertRowid as number;
}

/** Insert a dummy event (required for evidence foreign keys). */
function insertEvent(): number {
  const db = getMemoryDb();
  const result = db
    .prepare(
      `INSERT INTO events (timestamp, agent_id, agent_type, event_type, content, signal_score)
       VALUES (datetime('now'), 'test', 'main', 'observation', 'test event', 0.5)`,
    )
    .run();
  return result.lastInsertRowid as number;
}

/** Link a memory to an event via the evidence table. */
function insertEvidence(memoryId: number, eventId: number): void {
  const db = getMemoryDb();
  db.prepare(
    `INSERT INTO evidence (memory_id, event_id, relationship, strength)
     VALUES (?, ?, 'derived_from', 1.0)`,
  ).run(memoryId, eventId);
}

/** Read a single memory back from the DB so all fields are resolved. */
function loadMemory(id: number): Memory {
  const db = getMemoryDb();
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory;
}

/** ISO timestamp for a point N days in the past. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Flush all pending setImmediate callbacks so fire-and-forget writes land. */
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. decayedConfidence()
//    Formula: confidence * 0.5^(daysSince / halfLife)
//    Half-lives: decision=365d, learning=180d, pattern=90d, preference=365d
//    Facts: no decay (returns confidence as-is)
//    Reference date: last_validated if set, otherwise derived_at
// ═══════════════════════════════════════════════════════════════════════════════

describe("decayedConfidence()", () => {
  it("fact memory — returns raw confidence regardless of age", () => {
    // Even 1000 days old, facts never decay
    const id = insertMemory({
      memory_type: "fact",
      confidence: 0.9,
      derived_at: daysAgo(1000),
    });
    expect(decayedConfidence(loadMemory(id))).toBeCloseTo(0.9, 6);
  });

  it("decision memory just created — confidence ≈ original (no elapsed time)", () => {
    const id = insertMemory({
      memory_type: "decision",
      confidence: 0.8,
      derived_at: new Date().toISOString(),
    });
    // 0 days elapsed → decay factor = 0.5^0 = 1
    expect(decayedConfidence(loadMemory(id))).toBeCloseTo(0.8, 2);
  });

  it("decision memory 365 days old — confidence ≈ half of original (half-life = 365d)", () => {
    const id = insertMemory({
      memory_type: "decision",
      confidence: 0.8,
      derived_at: daysAgo(365),
    });
    // 0.8 * 0.5^(365/365) = 0.8 * 0.5 = 0.4
    expect(decayedConfidence(loadMemory(id))).toBeCloseTo(0.4, 1);
  });

  it("learning memory 180 days old — confidence ≈ half of original (half-life = 180d)", () => {
    const id = insertMemory({
      memory_type: "learning",
      confidence: 0.9,
      derived_at: daysAgo(180),
    });
    // 0.9 * 0.5^(180/180) = 0.9 * 0.5 = 0.45
    expect(decayedConfidence(loadMemory(id))).toBeCloseTo(0.45, 1);
  });

  it("pattern memory 90 days old — confidence ≈ half of original (half-life = 90d)", () => {
    const id = insertMemory({
      memory_type: "pattern",
      confidence: 1.0,
      derived_at: daysAgo(90),
    });
    // 1.0 * 0.5^(90/90) = 0.5
    expect(decayedConfidence(loadMemory(id))).toBeCloseTo(0.5, 1);
  });

  it("preference memory 365 days old — confidence ≈ half of original (half-life = 365d)", () => {
    const id = insertMemory({
      memory_type: "preference",
      confidence: 0.6,
      derived_at: daysAgo(365),
    });
    // 0.6 * 0.5^(365/365) = 0.6 * 0.5 = 0.3
    expect(decayedConfidence(loadMemory(id))).toBeCloseTo(0.3, 1);
  });

  it("very old learning memory (10,000 days) — confidence approaches 0", () => {
    const id = insertMemory({
      memory_type: "learning",
      confidence: 0.9,
      derived_at: daysAgo(10_000),
    });
    // 0.9 * 0.5^(10000/180) — astronomically small
    expect(decayedConfidence(loadMemory(id))).toBeLessThan(1e-15);
  });

  it("uses last_validated in preference to derived_at when both are set", () => {
    // derived_at = 365 days ago (would give 50% decay for a decision)
    // last_validated = today (should give near-zero decay)
    const id = insertMemory({
      memory_type: "decision",
      confidence: 0.8,
      derived_at: daysAgo(365),
      last_validated: new Date().toISOString(),
    });
    // Reference date is last_validated (today) → 0 days elapsed → no decay
    expect(decayedConfidence(loadMemory(id))).toBeCloseTo(0.8, 2);
  });

  it("unknown memory_type falls back to 180-day half-life", () => {
    const id = insertMemory({
      memory_type: "custom_unknown",
      confidence: 1.0,
      derived_at: daysAgo(180),
    });
    // 1.0 * 0.5^(180/180) = 0.5
    expect(decayedConfidence(loadMemory(id))).toBeCloseTo(0.5, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. searchMemoriesFast()
//    Uses FTS5 porter-stemmed index; results fire-and-forget access tracking.
//    Default minConfidence = 0.3; default status filter = active only.
// ═══════════════════════════════════════════════════════════════════════════════

describe("searchMemoriesFast()", () => {
  // ── Basics ─────────────────────────────────────────────────────────────────

  it("empty database — returns empty array", async () => {
    const results = await searchMemoriesFast("anything");
    expect(results).toEqual([]);
  });

  it("query matches memory content — returns result with score > 0 and matchType fts", async () => {
    insertMemory({
      content: "TypeScript is a strongly typed programming language",
      memory_type: "fact",
      confidence: 0.8,
    });
    const results = await searchMemoriesFast("TypeScript");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].matchType).toBe("fts");
  });

  it("query doesn't match any memory — returns empty array", async () => {
    insertMemory({ content: "cats and dogs are common household pets" });
    const results = await searchMemoriesFast("quantum physics superconductor");
    expect(results).toEqual([]);
  });

  it("multiple matches — results are sorted by score descending", async () => {
    // Seed several memories that all match; scores must be non-increasing
    insertMemory({ content: "Vitest is a fast unit testing framework" });
    insertMemory({ content: "Vitest vitest testing vitest fast tests" }); // heavier repetition
    insertMemory({ content: "unrelated content about cooking recipes" });

    const results = await searchMemoriesFast("vitest", { minConfidence: 0 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  // ── Options / filters ──────────────────────────────────────────────────────

  it("maxResults — caps the returned array to the requested size", async () => {
    for (let i = 0; i < 8; i++) {
      insertMemory({ content: `memory about databases and SQL row ${i}` });
    }
    const results = await searchMemoriesFast("databases SQL", { maxResults: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("status filter — only active memories returned by default", async () => {
    insertMemory({ content: "active TypeScript types memory", status: "active" });
    insertMemory({ content: "superseded TypeScript types memory", status: "superseded" });
    insertMemory({ content: "stale TypeScript types memory", status: "stale" });

    const results = await searchMemoriesFast("TypeScript types");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.status === "active")).toBe(true);
  });

  it("includeSuperseded=true — includes superseded memories alongside active", async () => {
    insertMemory({ content: "active node knowledge base", status: "active" });
    insertMemory({ content: "superseded node knowledge base", status: "superseded" });

    const results = await searchMemoriesFast("node knowledge base", {
      includeSuperseded: true,
    });
    const statuses = results.map((r) => r.memory.status);
    expect(statuses).toContain("active");
    expect(statuses).toContain("superseded");
  });

  it("scope filter — only returns memories matching the specified scope", async () => {
    insertMemory({ content: "python system scope memory", scope: "system" });
    insertMemory({ content: "python user scope memory", scope: "user" });

    const results = await searchMemoriesFast("python", { scope: "system" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.scope === "system")).toBe(true);
  });

  it("projectId filter — only returns memories for the given project", async () => {
    insertMemory({
      content: "project alpha deployment strategy",
      project_id: "alpha",
    });
    insertMemory({
      content: "project beta deployment strategy",
      project_id: "beta",
    });

    const results = await searchMemoriesFast("deployment strategy", {
      projectId: "alpha",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.project_id === "alpha")).toBe(true);
  });

  it("memoryTypes filter — only returns memories of the specified types", async () => {
    insertMemory({ content: "async patterns learning", memory_type: "learning" });
    insertMemory({ content: "async patterns decision", memory_type: "decision" });
    insertMemory({ content: "async patterns pattern", memory_type: "pattern" });

    const results = await searchMemoriesFast("async patterns", {
      memoryTypes: ["learning"],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.memory_type === "learning")).toBe(true);
  });

  it("minConfidence filter — excludes memories below the threshold", async () => {
    insertMemory({ content: "caching strategy high confidence", confidence: 0.9 });
    insertMemory({ content: "caching strategy low confidence", confidence: 0.1 });

    // Explicitly set 0.5 so the 0.1-confidence memory is excluded
    const results = await searchMemoriesFast("caching strategy", {
      minConfidence: 0.5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.confidence >= 0.5)).toBe(true);
  });

  // ── Evidence count ─────────────────────────────────────────────────────────

  it("returns correct evidenceCount for memories linked to events", async () => {
    const memId = insertMemory({
      content: "refactoring strategy with evidence links",
    });
    const ev1 = insertEvent();
    const ev2 = insertEvent();
    insertEvidence(memId, ev1);
    insertEvidence(memId, ev2);

    const results = await searchMemoriesFast("refactoring strategy");
    expect(results.length).toBeGreaterThan(0);
    const match = results.find((r) => r.memory.id === memId);
    expect(match).toBeDefined();
    expect(match!.evidenceCount).toBe(2);
  });

  it("returns evidenceCount = 0 for memories with no linked events", async () => {
    insertMemory({ content: "isolated caching strategy memory" });
    const results = await searchMemoriesFast("isolated caching strategy");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].evidenceCount).toBe(0);
  });

  // ── Ranking ────────────────────────────────────────────────────────────────

  it("higher confidence memories rank above lower confidence ones (same FTS match)", async () => {
    // Both have identical content so FTS rank is equal; confidence drives importance score
    insertMemory({
      content: "identical linting rules memory text",
      confidence: 0.95,
    });
    insertMemory({
      content: "identical linting rules memory text",
      confidence: 0.35, // above default 0.3 floor but meaningfully lower
    });

    const results = await searchMemoriesFast("linting rules memory", {
      minConfidence: 0,
    });
    expect(results.length).toBe(2);
    expect(results[0].memory.confidence).toBeGreaterThan(
      results[1].memory.confidence,
    );
  });

  it("recently accessed memories rank higher than stale-access memories", async () => {
    // Same content + confidence; access recency drives importance score difference
    insertMemory({
      content: "redis cache usage patterns",
      confidence: 0.8,
      last_accessed: daysAgo(1),   // accessed yesterday — high importance
      access_count: 10,
    });
    insertMemory({
      content: "redis cache usage patterns",
      confidence: 0.8,
      last_accessed: daysAgo(600), // not touched in ~2 years — low importance
      access_count: 0,
    });

    const results = await searchMemoriesFast("redis cache usage", {
      minConfidence: 0,
    });
    expect(results.length).toBe(2);
    // The recently-accessed one must rank first
    expect(results[0].memory.access_count).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. searchMemoriesFull()
//    Vector search (LM Studio) won't be running in CI → falls back to FTS only.
//    matchType will always be "fts" in these tests.
// ═══════════════════════════════════════════════════════════════════════════════

describe("searchMemoriesFull()", () => {
  it("returns FTS results even when vector search is unavailable", async () => {
    insertMemory({ content: "GraphQL is a query language for APIs" });
    const results = await searchMemoriesFull("GraphQL API");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("matchType is 'fts' when no vector embeddings exist (FTS-only path)", async () => {
    insertMemory({ content: "functional programming with pure functions" });
    const results = await searchMemoriesFull("functional programming");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toBe("fts");
  });

  it("returns empty array when nothing matches", async () => {
    insertMemory({ content: "weather forecast sunny tomorrow" });
    const results = await searchMemoriesFull("blockchain consensus algorithm");
    expect(results).toEqual([]);
  });

  it("returns empty array from a completely empty database", async () => {
    const results = await searchMemoriesFull("anything at all");
    expect(results).toEqual([]);
  });

  it("maxResults option caps results", async () => {
    for (let i = 0; i < 6; i++) {
      insertMemory({ content: `containerisation and docker memory ${i}` });
    }
    const results = await searchMemoriesFull("containerisation docker", {
      maxResults: 2,
    });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("scope filter is respected", async () => {
    insertMemory({
      content: "kubernetes project scope memory",
      scope: "project",
    });
    insertMemory({ content: "kubernetes system scope memory", scope: "system" });

    const results = await searchMemoriesFull("kubernetes", { scope: "project" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.scope === "project")).toBe(true);
  });

  it("memoryTypes filter is respected", async () => {
    insertMemory({
      content: "CI pipeline tooling decision",
      memory_type: "decision",
    });
    insertMemory({
      content: "CI pipeline tooling learning",
      memory_type: "learning",
    });

    const results = await searchMemoriesFull("CI pipeline tooling", {
      memoryTypes: ["decision"],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.memory_type === "decision")).toBe(true);
  });

  it("minConfidence filter is respected", async () => {
    insertMemory({ content: "observability high confidence", confidence: 0.95 });
    insertMemory({ content: "observability low confidence", confidence: 0.15 });

    const results = await searchMemoriesFull("observability", {
      minConfidence: 0.8,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.confidence >= 0.8)).toBe(true);
  });

  it("projectId filter is respected", async () => {
    insertMemory({
      content: "event sourcing project lobs",
      project_id: "lobs",
    });
    insertMemory({ content: "event sourcing project paw", project_id: "paw" });

    const results = await searchMemoriesFull("event sourcing", {
      projectId: "lobs",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.project_id === "lobs")).toBe(true);
  });

  it("excludes superseded memories by default", async () => {
    insertMemory({ content: "active serverless memory", status: "active" });
    insertMemory({
      content: "superseded serverless memory",
      status: "superseded",
    });

    const results = await searchMemoriesFull("serverless memory");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.memory.status === "active")).toBe(true);
  });

  it("includeSuperseded=true returns superseded memories too", async () => {
    insertMemory({ content: "active message queue memory", status: "active" });
    insertMemory({
      content: "superseded message queue memory",
      status: "superseded",
    });

    const results = await searchMemoriesFull("message queue memory", {
      includeSuperseded: true,
    });
    const statuses = new Set(results.map((r) => r.memory.status));
    expect(statuses).toContain("active");
    expect(statuses).toContain("superseded");
  });

  it("deduplicates — each memory appears at most once in results", async () => {
    insertMemory({ content: "microservices architecture patterns" });

    const results = await searchMemoriesFull(
      "microservices architecture patterns",
    );
    const ids = results.map((r) => r.memory.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Access tracking (fire-and-forget via setImmediate)
//    Must flush with flushImmediate() before reading back from the DB.
// ═══════════════════════════════════════════════════════════════════════════════

describe("access tracking after search", () => {
  it("searchMemoriesFast — increments access_count by 1", async () => {
    const id = insertMemory({
      content: "access tracking increment test",
      access_count: 0,
    });
    await searchMemoriesFast("access tracking increment");
    await flushImmediate();

    const db = getMemoryDb();
    const row = db
      .prepare("SELECT access_count FROM memories WHERE id = ?")
      .get(id) as { access_count: number };
    expect(row.access_count).toBe(1);
  });

  it("searchMemoriesFast — creates a retrieval_log entry with the query", async () => {
    const id = insertMemory({ content: "retrieval log entry test memory" });
    await searchMemoriesFast("retrieval log entry");
    await flushImmediate();

    const db = getMemoryDb();
    const logs = db
      .prepare("SELECT * FROM retrieval_log WHERE memory_id = ?")
      .all(id) as Array<{ memory_id: number; query: string }>;

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].memory_id).toBe(id);
    expect(logs[0].query).toContain("retrieval");
  });

  it("searchMemoriesFull — increments access_count by 1", async () => {
    const id = insertMemory({
      content: "full search access count check",
      access_count: 0,
    });
    await searchMemoriesFull("full search access count");
    await flushImmediate();

    const db = getMemoryDb();
    const row = db
      .prepare("SELECT access_count FROM memories WHERE id = ?")
      .get(id) as { access_count: number };
    expect(row.access_count).toBe(1);
  });

  it("searchMemoriesFull — creates a retrieval_log entry", async () => {
    const id = insertMemory({ content: "full path log entry verification" });
    await searchMemoriesFull("full path log entry");
    await flushImmediate();

    const db = getMemoryDb();
    const count = (
      db
        .prepare(
          "SELECT COUNT(*) as cnt FROM retrieval_log WHERE memory_id = ?",
        )
        .get(id) as { cnt: number }
    ).cnt;
    expect(count).toBeGreaterThan(0);
  });

  it("repeated searches accumulate access_count correctly", async () => {
    const id = insertMemory({
      content: "repeated search accumulation test",
      access_count: 0,
    });

    for (let i = 0; i < 3; i++) {
      await searchMemoriesFast("repeated search accumulation");
      await flushImmediate();
    }

    const db = getMemoryDb();
    const row = db
      .prepare("SELECT access_count FROM memories WHERE id = ?")
      .get(id) as { access_count: number };
    expect(row.access_count).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. importanceScore() — from gc.ts
//    Formula: max(decayed, floor)
//    where decayed = confidence * 0.5^(daysSinceAccess / 120)
//    and   floor   = 0.1 * log2(access_count + 1)
//    Falls back to derived_at when last_accessed is null.
// ═══════════════════════════════════════════════════════════════════════════════

describe("importanceScore()", () => {
  it("high confidence, recently accessed — high importance score (near original confidence)", () => {
    const id = insertMemory({
      confidence: 0.95,
      last_accessed: daysAgo(1),
      access_count: 5,
    });
    // decayed: 0.95 * 0.5^(1/120) ≈ 0.945; floor: 0.1 * log2(6) ≈ 0.258
    expect(importanceScore(loadMemory(id))).toBeGreaterThan(0.85);
  });

  it("high confidence, never accessed, very old — low importance (access decay wins)", () => {
    const id = insertMemory({
      confidence: 0.9,
      last_accessed: null,
      access_count: 0,
      derived_at: daysAgo(1200), // ~3.3 years old
    });
    // decayed: 0.9 * 0.5^(1200/120) = 0.9 * 0.5^10 ≈ 0.000879; floor: 0
    expect(importanceScore(loadMemory(id))).toBeLessThan(0.01);
  });

  it("low confidence but high access_count — floor prevents score from falling too far", () => {
    // access_count = 31 → floor = 0.1 * log2(32) = 0.1 * 5 = 0.5
    const id = insertMemory({
      confidence: 0.1,
      last_accessed: daysAgo(600), // stale: 0.1 * 0.5^5 = 0.003
      access_count: 31,
    });
    expect(importanceScore(loadMemory(id))).toBeGreaterThanOrEqual(0.5);
  });

  it("uses last_accessed over derived_at for the decay baseline", () => {
    const id = insertMemory({
      confidence: 0.8,
      derived_at: daysAgo(500),   // old creation — would give ~0.8 * 2^-4.17 ≈ 0.053
      last_accessed: daysAgo(5),  // but recently touched → ~0.78
      access_count: 1,
    });
    // decayed from last_accessed=5d: 0.8 * 0.5^(5/120) ≈ 0.78
    expect(importanceScore(loadMemory(id))).toBeGreaterThan(0.7);
  });

  it("score is always in [0, 1] for typical inputs", () => {
    const id = insertMemory({
      confidence: 1.0,
      last_accessed: new Date().toISOString(),
      access_count: 0,
    });
    const score = importanceScore(loadMemory(id));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("zero access_count — floor is 0, score is purely confidence-decay based", () => {
    const id = insertMemory({
      confidence: 0.8,
      last_accessed: daysAgo(120), // exactly one half-life ago
      access_count: 0,
    });
    // decayed: 0.8 * 0.5^(120/120) = 0.8 * 0.5 = 0.4; floor: 0.1 * log2(1) = 0
    expect(importanceScore(loadMemory(id))).toBeCloseTo(0.4, 1);
  });
});
