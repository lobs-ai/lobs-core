/**
 * Tests for src/util/task-context.ts
 *
 * buildTaskContext(opts?) — generates a markdown context block from DB state.
 * - Returns empty string when no tasks exist.
 * - Shows active tasks with correct workState icons.
 * - Shows recently completed tasks.
 * - Respects the `limit` option.
 * - Includes preamble header/footer strings.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db/connection.js";
import { tasks } from "../src/db/schema.js";
import { buildTaskContext } from "../src/util/task-context.js";

// ─── Helper ──────────────────────────────────────────────────────────────────

function insertTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(tasks).values({
    id,
    title: "Untitled Task",
    status: "active",
    agent: "programmer",
    workState: "not_started",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return id;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildTaskContext", () => {
  beforeEach(() => {
    getDb().delete(tasks).run();
  });

  // ── Empty DB ────────────────────────────────────────────────────────────

  it("returns empty string when DB has no tasks", () => {
    expect(buildTaskContext()).toBe("");
  });

  it("returns empty string when only tasks with non-active/non-completed status exist", () => {
    insertTask({ status: "cancelled" });
    insertTask({ status: "failed" });
    insertTask({ status: "archived" });
    expect(buildTaskContext()).toBe("");
  });

  // ── Active tasks section ────────────────────────────────────────────────

  it("includes '## Currently Active Tasks' header when active tasks exist", () => {
    insertTask({ title: "Debug loop detector", status: "active", workState: "not_started" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("## Currently Active Tasks");
  });

  it("renders 'not_started' workState as '⏳ queued'", () => {
    insertTask({ title: "Queue Me", status: "active", workState: "not_started", agent: "programmer" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("⏳ queued");
    expect(ctx).toContain("Queue Me");
  });

  it("renders 'in_progress' workState as '🔄 in progress'", () => {
    insertTask({ title: "Active Work", status: "active", workState: "in_progress", agent: "programmer" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("🔄 in progress");
    expect(ctx).toContain("Active Work");
  });

  it("renders unknown workState with '📋' prefix", () => {
    insertTask({ title: "Custom State", status: "active", workState: "review", agent: "programmer" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("📋 review");
    expect(ctx).toContain("Custom State");
  });

  it("includes agent name in active task line", () => {
    insertTask({ title: "My Task", status: "active", workState: "not_started", agent: "researcher" });
    expect(buildTaskContext()).toContain("(researcher)");
  });

  it("lists multiple active tasks", () => {
    insertTask({ title: "Task Alpha", status: "active", workState: "not_started", agent: "programmer" });
    insertTask({ title: "Task Beta", status: "active", workState: "in_progress", agent: "reviewer" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("Task Alpha");
    expect(ctx).toContain("Task Beta");
    expect(ctx).toContain("(programmer)");
    expect(ctx).toContain("(reviewer)");
  });

  // ── Completed tasks section ─────────────────────────────────────────────

  it("includes '## Recently Completed Tasks' header when completed tasks exist", () => {
    insertTask({ title: "Done Work", status: "completed", agent: "programmer" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("## Recently Completed Tasks");
  });

  it("renders completed tasks with ✅ prefix", () => {
    insertTask({ title: "Finished Feature", status: "completed", agent: "programmer" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("✅");
    expect(ctx).toContain("Finished Feature");
  });

  it("includes agent name in completed task line", () => {
    insertTask({ title: "Done", status: "completed", agent: "writer" });
    expect(buildTaskContext()).toContain("(writer)");
  });

  it("does not include cancelled/failed tasks in completed section", () => {
    insertTask({ title: "Cancelled Task", status: "cancelled" });
    insertTask({ title: "Failed Task", status: "failed" });
    const ctx = buildTaskContext();
    expect(ctx).not.toContain("Cancelled Task");
    expect(ctx).not.toContain("Failed Task");
  });

  // ── Limit option ────────────────────────────────────────────────────────

  it("respects limit option: shows only N completed tasks", () => {
    for (let i = 0; i < 10; i++) {
      insertTask({ title: `Completed Task ${i}`, status: "completed", agent: "programmer" });
    }
    const ctx = buildTaskContext({ limit: 3 });
    // Count occurrences of '✅' — should be exactly 3
    const matches = ctx.match(/✅/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("uses 20 as default limit for completed tasks", () => {
    for (let i = 0; i < 25; i++) {
      insertTask({ title: `Done ${i}`, status: "completed", agent: "programmer" });
    }
    const ctx = buildTaskContext(); // no limit → default 20
    const matches = ctx.match(/✅/g) ?? [];
    expect(matches.length).toBe(20);
  });

  it("shows all completed tasks when count is under limit", () => {
    insertTask({ title: "Only Done", status: "completed", agent: "programmer" });
    const ctx = buildTaskContext({ limit: 10 });
    const matches = ctx.match(/✅/g) ?? [];
    expect(matches.length).toBe(1);
  });

  // ── Preamble / structure ────────────────────────────────────────────────

  it("includes anti-duplication preamble when context is non-empty", () => {
    insertTask({ title: "Some Task", status: "active", workState: "not_started" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("Do NOT duplicate any of this work");
  });

  it("includes '### Context: Current & Recent Work' heading", () => {
    insertTask({ title: "Some Task", status: "active", workState: "not_started" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("### Context: Current & Recent Work");
  });

  it("wraps output in --- dividers", () => {
    insertTask({ title: "Any Task", status: "active", workState: "not_started" });
    const ctx = buildTaskContext();
    expect(ctx).toMatch(/^[\r\n]+---/); // starts with newlines + ---
    expect(ctx).toMatch(/---[\r\n]+$/); // ends with --- + newlines
  });

  it("starts with newlines (so it appends nicely to a prompt)", () => {
    insertTask({ title: "Prompt Task", status: "active", workState: "not_started" });
    const ctx = buildTaskContext();
    expect(ctx.startsWith("\n")).toBe(true);
  });

  // ── Both sections present ───────────────────────────────────────────────

  it("shows both sections when active and completed tasks exist", () => {
    insertTask({ title: "Running Now", status: "active", workState: "in_progress" });
    insertTask({ title: "Already Done", status: "completed" });
    const ctx = buildTaskContext();
    expect(ctx).toContain("## Currently Active Tasks");
    expect(ctx).toContain("## Recently Completed Tasks");
    expect(ctx).toContain("Running Now");
    expect(ctx).toContain("Already Done");
  });

  // ── Return type ─────────────────────────────────────────────────────────

  it("always returns a string", () => {
    expect(typeof buildTaskContext()).toBe("string");
  });

  it("returns a string with content when tasks exist", () => {
    insertTask({ title: "Has Content", status: "active", workState: "not_started" });
    const ctx = buildTaskContext();
    expect(ctx.length).toBeGreaterThan(0);
  });

  it("returns empty string (not null/undefined) when no tasks", () => {
    const ctx = buildTaskContext({});
    expect(ctx).toBe("");
  });

  // ── opts fields not crash ────────────────────────────────────────────────

  it("accepts projectId opt without crashing", () => {
    insertTask({ title: "Proj Task", status: "active", workState: "not_started" });
    expect(() => buildTaskContext({ projectId: "proj-paw" })).not.toThrow();
  });

  it("accepts agentType opt without crashing", () => {
    insertTask({ title: "Agent Task", status: "active", workState: "not_started" });
    expect(() => buildTaskContext({ agentType: "programmer" })).not.toThrow();
  });

  it("accepts limit: 0 without crashing (returns empty completed section)", () => {
    insertTask({ title: "No Limit", status: "completed" });
    expect(() => buildTaskContext({ limit: 0 })).not.toThrow();
  });

  it("calling with empty opts {} still works", () => {
    insertTask({ title: "Empty opts task", status: "active", workState: "not_started" });
    expect(() => buildTaskContext({})).not.toThrow();
  });

  it("calling with no args still works", () => {
    insertTask({ title: "No args task", status: "active", workState: "not_started" });
    expect(() => buildTaskContext()).not.toThrow();
  });
});
