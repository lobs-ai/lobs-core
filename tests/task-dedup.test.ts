/**
 * Tests for the 24-hour task deduplication utility.
 *
 * Expanded coverage — edge cases, all DEDUP_STATUSES, window boundaries, field wildcards.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db/connection.js";
import { tasks } from "../src/db/schema.js";
import { findDuplicateTask, DEDUP_STATUSES, type DedupMatch } from "../src/util/task-dedup.js";

// ─── Helper ──────────────────────────────────────────────────────────────────

function insertTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(tasks).values({
    id,
    title: "Test Task",
    status: "active",
    agent: "programmer",
    modelTier: "standard",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return id;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("findDuplicateTask", () => {
  beforeEach(() => {
    getDb().delete(tasks).run();
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  it("returns existing task when title + agent + tier match within 24h", () => {
    const id = insertTask({
      title: "Investigate lobs-memory config.json",
      agent: "programmer",
      modelTier: "standard",
    });
    const dup = findDuplicateTask({
      title: "Investigate lobs-memory config.json",
      agent: "programmer",
      modelTier: "standard",
    });
    expect(dup).toBeDefined();
    expect(dup!.id).toBe(id);
  });

  it("returns undefined when no matching task exists", () => {
    const dup = findDuplicateTask({
      title: "Brand new task nobody created",
      agent: "programmer",
      modelTier: "standard",
    });
    expect(dup).toBeUndefined();
  });

  it("returns a DedupMatch with all expected fields", () => {
    insertTask({ title: "Fields Task", agent: "reviewer", modelTier: "micro" });
    const dup = findDuplicateTask({ title: "Fields Task", agent: "reviewer", modelTier: "micro" });
    expect(dup).toBeDefined();
    expect(dup).toHaveProperty("id");
    expect(dup).toHaveProperty("title");
    expect(dup).toHaveProperty("agent");
    expect(dup).toHaveProperty("modelTier");
    expect(dup).toHaveProperty("status");
    expect(dup).toHaveProperty("createdAt");
  });

  // ── 24h window ──────────────────────────────────────────────────────────

  it("returns undefined for a task created more than 24h ago", () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertTask({ title: "Old Task", agent: "programmer", modelTier: "standard", createdAt: oldDate });
    const dup = findDuplicateTask({ title: "Old Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  it("returns match for task created exactly 1h ago (well within 24h window)", () => {
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const id = insertTask({
      title: "Recent Task",
      agent: "programmer",
      modelTier: "standard",
      createdAt: recentDate,
    });
    const dup = findDuplicateTask({ title: "Recent Task", agent: "programmer", modelTier: "standard" });
    expect(dup!.id).toBe(id);
  });

  it("returns match for task created 23h 59m ago (just inside window)", () => {
    const justInsideDate = new Date(Date.now() - (24 * 60 * 60 * 1000 - 60_000)).toISOString();
    const id = insertTask({
      title: "Near Boundary Task",
      agent: "programmer",
      modelTier: "standard",
      createdAt: justInsideDate,
    });
    const dup = findDuplicateTask({ title: "Near Boundary Task", agent: "programmer", modelTier: "standard" });
    expect(dup!.id).toBe(id);
  });

  it("returns undefined for task created 24h 1m ago (just outside window)", () => {
    const justOutsideDate = new Date(Date.now() - (24 * 60 * 60 * 1000 + 60_000)).toISOString();
    insertTask({ title: "Just Outside Task", agent: "programmer", modelTier: "standard", createdAt: justOutsideDate });
    const dup = findDuplicateTask({ title: "Just Outside Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  it("respects custom windowHours: 1h window does NOT find 2h-old task", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    insertTask({ title: "Windowed Task", agent: "programmer", modelTier: "standard", createdAt: twoHoursAgo });
    expect(
      findDuplicateTask({ title: "Windowed Task", agent: "programmer", modelTier: "standard", windowHours: 1 })
    ).toBeUndefined();
  });

  it("respects custom windowHours: 3h window DOES find 2h-old task", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    insertTask({ title: "Windowed Task 2", agent: "programmer", modelTier: "standard", createdAt: twoHoursAgo });
    expect(
      findDuplicateTask({ title: "Windowed Task 2", agent: "programmer", modelTier: "standard", windowHours: 3 })
    ).toBeDefined();
  });

  it("uses 24h window by default (no windowHours specified)", () => {
    const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    const id = insertTask({
      title: "Default Window Task",
      agent: "programmer",
      modelTier: "standard",
      createdAt: twentyHoursAgo,
    });
    const dup = findDuplicateTask({ title: "Default Window Task", agent: "programmer", modelTier: "standard" });
    expect(dup!.id).toBe(id);
  });

  // ── Status filtering ────────────────────────────────────────────────────

  it.each(DEDUP_STATUSES)("blocks duplicate for status '%s'", (status) => {
    insertTask({
      title: `Status Task ${status}`,
      agent: "programmer",
      modelTier: "standard",
      status,
    });
    const dup = findDuplicateTask({ title: `Status Task ${status}`, agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
  });

  it("returns undefined when existing task has status 'completed'", () => {
    insertTask({ title: "Done Task", agent: "programmer", modelTier: "standard", status: "completed" });
    expect(findDuplicateTask({ title: "Done Task", agent: "programmer", modelTier: "standard" })).toBeUndefined();
  });

  it("returns undefined when existing task has status 'failed'", () => {
    insertTask({ title: "Failed Task", agent: "programmer", modelTier: "standard", status: "failed" });
    expect(findDuplicateTask({ title: "Failed Task", agent: "programmer", modelTier: "standard" })).toBeUndefined();
  });

  it("returns undefined when existing task has status 'cancelled'", () => {
    insertTask({ title: "Cancelled Task", agent: "programmer", modelTier: "standard", status: "cancelled" });
    expect(findDuplicateTask({ title: "Cancelled Task", agent: "programmer", modelTier: "standard" })).toBeUndefined();
  });

  it("returns undefined for 'archived' status", () => {
    insertTask({ title: "Archived Task", agent: "programmer", modelTier: "standard", status: "archived" });
    expect(findDuplicateTask({ title: "Archived Task", agent: "programmer", modelTier: "standard" })).toBeUndefined();
  });

  it("DEDUP_STATUSES array contains at least 3 entries", () => {
    expect(DEDUP_STATUSES.length).toBeGreaterThanOrEqual(3);
  });

  it("DEDUP_STATUSES contains 'active'", () => {
    expect(DEDUP_STATUSES).toContain("active");
  });

  it("DEDUP_STATUSES contains 'queued'", () => {
    expect(DEDUP_STATUSES).toContain("queued");
  });

  it("DEDUP_STATUSES contains 'in_progress'", () => {
    expect(DEDUP_STATUSES).toContain("in_progress");
  });

  // ── Agent / tier matching ───────────────────────────────────────────────

  it("does NOT block when agent differs", () => {
    insertTask({ title: "Investigate X", agent: "researcher", modelTier: "standard" });
    const dup = findDuplicateTask({ title: "Investigate X", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  it("does NOT block when model_tier differs", () => {
    insertTask({ title: "Analyse Y", agent: "programmer", modelTier: "micro" });
    const dup = findDuplicateTask({ title: "Analyse Y", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  it("matches when DB row has null agent (wildcard match)", () => {
    insertTask({ title: "Null Agent Task", agent: undefined, modelTier: "standard" });
    const dup = findDuplicateTask({ title: "Null Agent Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
  });

  it("matches when DB row has null model_tier (wildcard match)", () => {
    insertTask({ title: "Null Tier Task", agent: "programmer", modelTier: undefined });
    const dup = findDuplicateTask({ title: "Null Tier Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
  });

  it("matches when DB row has null agent AND null tier (both wildcards)", () => {
    insertTask({ title: "Null Both Task", agent: undefined, modelTier: undefined });
    const dup = findDuplicateTask({ title: "Null Both Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
  });

  it("matches when caller passes no agent (no agent filter = any agent matches)", () => {
    insertTask({ title: "Any Agent Task", agent: "researcher", modelTier: "standard" });
    const dup = findDuplicateTask({ title: "Any Agent Task" });
    expect(dup).toBeDefined();
  });

  it("matches when caller passes no modelTier (no tier filter = any tier matches)", () => {
    insertTask({ title: "Any Tier Task", agent: "programmer", modelTier: "micro" });
    const dup = findDuplicateTask({ title: "Any Tier Task", agent: "programmer" });
    expect(dup).toBeDefined();
  });

  it("matches when caller passes neither agent nor tier", () => {
    insertTask({ title: "No Filter Task", agent: "researcher", modelTier: "micro" });
    const dup = findDuplicateTask({ title: "No Filter Task" });
    expect(dup).toBeDefined();
  });

  // ── Title exactness ─────────────────────────────────────────────────────

  it("is case-sensitive for title (lowercase does not match titlecase)", () => {
    insertTask({ title: "investigate lobs-memory config.json" });
    const dup = findDuplicateTask({ title: "Investigate lobs-memory config.json" });
    expect(dup).toBeUndefined();
  });

  it("does not match on partial title (subset of stored title)", () => {
    insertTask({ title: "Investigate lobs-memory config.json and related files" });
    const dup = findDuplicateTask({ title: "Investigate lobs-memory config.json" });
    expect(dup).toBeUndefined();
  });

  it("does not match on superset title (stored title is a substring of query)", () => {
    insertTask({ title: "Fix bug" });
    const dup = findDuplicateTask({ title: "Fix bug in the auth module" });
    expect(dup).toBeUndefined();
  });

  it("requires exact title including whitespace", () => {
    insertTask({ title: "Fix  bug" }); // double space
    const dup = findDuplicateTask({ title: "Fix bug" }); // single space
    expect(dup).toBeUndefined();
  });

  // ── Multiple tasks / ordering ───────────────────────────────────────────

  it("returns one result when multiple duplicates exist (defensive)", () => {
    insertTask({ title: "Multi Dup", agent: "programmer", modelTier: "standard" });
    insertTask({ title: "Multi Dup", agent: "programmer", modelTier: "standard" });
    const dup = findDuplicateTask({ title: "Multi Dup", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
    // Must be a single DedupMatch (not an array)
    expect(Array.isArray(dup)).toBe(false);
  });

  it("allows same title for different agent+tier combos (separate tasks)", () => {
    insertTask({ title: "Update README", agent: "writer", modelTier: "micro" });
    // Different agent + tier → no dup for programmer/standard
    const dup = findDuplicateTask({ title: "Update README", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  it("does not mix up two different task titles", () => {
    insertTask({ title: "Task Alpha", agent: "programmer", modelTier: "standard" });
    insertTask({ title: "Task Beta", agent: "programmer", modelTier: "standard" });
    const alpha = findDuplicateTask({ title: "Task Alpha", agent: "programmer", modelTier: "standard" });
    const beta = findDuplicateTask({ title: "Task Beta", agent: "programmer", modelTier: "standard" });
    expect(alpha!.title).toBe("Task Alpha");
    expect(beta!.title).toBe("Task Beta");
    expect(alpha!.id).not.toBe(beta!.id);
  });

  // ── Edge: empty DB ──────────────────────────────────────────────────────

  it("returns undefined when the tasks table is empty", () => {
    const dup = findDuplicateTask({ title: "Anything", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  // ── Returned fields are correct ─────────────────────────────────────────

  it("returned DedupMatch.title matches the stored title", () => {
    insertTask({ title: "Exact Title Check", agent: "programmer", modelTier: "standard" });
    const dup = findDuplicateTask({ title: "Exact Title Check", agent: "programmer", modelTier: "standard" });
    expect(dup!.title).toBe("Exact Title Check");
  });

  it("returned DedupMatch.agent matches the stored agent", () => {
    insertTask({ title: "Agent Check", agent: "reviewer", modelTier: "standard" });
    const dup = findDuplicateTask({ title: "Agent Check", agent: "reviewer", modelTier: "standard" });
    expect(dup!.agent).toBe("reviewer");
  });

  it("returned DedupMatch.status is one of DEDUP_STATUSES", () => {
    insertTask({ title: "Status Field Check", agent: "programmer", modelTier: "standard", status: "queued" });
    const dup = findDuplicateTask({ title: "Status Field Check", agent: "programmer", modelTier: "standard" });
    expect(DEDUP_STATUSES).toContain(dup!.status as typeof DEDUP_STATUSES[number]);
  });
});
