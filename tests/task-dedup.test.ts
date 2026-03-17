/**
 * Tests for the 24-hour task deduplication utility.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db/connection.js";
import { tasks } from "../src/db/schema.js";
import { findDuplicateTask, DEDUP_STATUSES } from "../src/util/task-dedup.js";

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

describe("findDuplicateTask", () => {
  beforeEach(() => {
    // Clean slate
    const db = getDb();
    db.delete(tasks).run();
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  it("returns existing task when title + agent + tier match within 24h", () => {
    const id = insertTask({ title: "Investigate lobs-memory config.json", agent: "programmer", modelTier: "standard" });
    const dup = findDuplicateTask({ title: "Investigate lobs-memory config.json", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
    expect(dup!.id).toBe(id);
  });

  it("returns undefined when no matching task exists", () => {
    const dup = findDuplicateTask({ title: "Brand new task nobody created", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  // ── 24h window ──────────────────────────────────────────────────────────

  it("returns undefined for a task created more than 24h ago", () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    insertTask({ title: "Old Task", agent: "programmer", modelTier: "standard", createdAt: oldDate });
    const dup = findDuplicateTask({ title: "Old Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  it("returns match for task created exactly 1h ago", () => {
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const id = insertTask({ title: "Recent Task", agent: "programmer", modelTier: "standard", createdAt: recentDate });
    const dup = findDuplicateTask({ title: "Recent Task", agent: "programmer", modelTier: "standard" });
    expect(dup!.id).toBe(id);
  });

  it("respects custom windowHours", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    insertTask({ title: "Windowed Task", agent: "programmer", modelTier: "standard", createdAt: twoHoursAgo });
    // 1h window → should NOT find the 2h-old task
    expect(findDuplicateTask({ title: "Windowed Task", agent: "programmer", modelTier: "standard", windowHours: 1 })).toBeUndefined();
    // 3h window → should find it
    expect(findDuplicateTask({ title: "Windowed Task", agent: "programmer", modelTier: "standard", windowHours: 3 })).toBeDefined();
  });

  // ── Status filtering ────────────────────────────────────────────────────

  it.each(DEDUP_STATUSES)("blocks duplicate for status '%s'", (status) => {
    insertTask({ title: `Status Task ${status}`, agent: "programmer", modelTier: "standard", status });
    const dup = findDuplicateTask({ title: `Status Task ${status}`, agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
  });

  it("returns undefined when existing task has a terminal status", () => {
    insertTask({ title: "Done Task", agent: "programmer", modelTier: "standard", status: "completed" });
    const dup = findDuplicateTask({ title: "Done Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  it("returns undefined for archived tasks", () => {
    insertTask({ title: "Archived Task", agent: "programmer", modelTier: "standard", status: "archived" });
    const dup = findDuplicateTask({ title: "Archived Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  // ── Agent / tier matching ───────────────────────────────────────────────

  it("does NOT block when agent differs (different agent types = different tasks)", () => {
    insertTask({ title: "Investigate X", agent: "researcher", modelTier: "standard" });
    // Caller is spawning a programmer — different agent → no dup
    const dup = findDuplicateTask({ title: "Investigate X", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  it("does NOT block when model_tier differs", () => {
    insertTask({ title: "Analyse Y", agent: "programmer", modelTier: "micro" });
    const dup = findDuplicateTask({ title: "Analyse Y", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });

  it("matches when DB row has null agent (null = wildcard match)", () => {
    insertTask({ title: "Null Agent Task", agent: undefined, modelTier: "standard" });
    // Caller is spawning a programmer — DB has null agent → wildcard dup detected
    const dup = findDuplicateTask({ title: "Null Agent Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
  });

  it("matches when DB row has null model_tier (null = wildcard match)", () => {
    insertTask({ title: "Null Tier Task", agent: "programmer", modelTier: undefined });
    const dup = findDuplicateTask({ title: "Null Tier Task", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
  });

  it("matches when caller passes no agent (no agent filter = any agent matches)", () => {
    insertTask({ title: "Any Agent Task", agent: "researcher", modelTier: "standard" });
    // Caller doesn't specify agent → no agent filter → matches any
    const dup = findDuplicateTask({ title: "Any Agent Task" });
    expect(dup).toBeDefined();
  });

  // ── Title exactness ─────────────────────────────────────────────────────

  it("is case-sensitive for title", () => {
    insertTask({ title: "investigate lobs-memory config.json" });
    const dup = findDuplicateTask({ title: "Investigate lobs-memory config.json" });
    expect(dup).toBeUndefined();
  });

  it("does not match on partial title", () => {
    insertTask({ title: "Investigate lobs-memory config.json and related files" });
    const dup = findDuplicateTask({ title: "Investigate lobs-memory config.json" });
    expect(dup).toBeUndefined();
  });

  // ── Multiple tasks ──────────────────────────────────────────────────────

  it("returns the first match when multiple duplicates exist (shouldn't happen but handled)", () => {
    insertTask({ title: "Multi Dup", agent: "programmer", modelTier: "standard" });
    insertTask({ title: "Multi Dup", agent: "programmer", modelTier: "standard" });
    const dup = findDuplicateTask({ title: "Multi Dup", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeDefined();
  });

  it("allows same title for different projects if agent/tier differ", () => {
    insertTask({ title: "Update README", agent: "writer", modelTier: "micro" });
    // Different agent + tier → no dup
    const dup = findDuplicateTask({ title: "Update README", agent: "programmer", modelTier: "standard" });
    expect(dup).toBeUndefined();
  });
});
