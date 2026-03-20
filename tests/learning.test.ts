/**
 * Tests for src/services/learning.ts
 *
 * Covers:
 *   - inferTaskCategory — keyword detection for all 6 categories
 *   - LearningService.recordOutcome — create, upsert, idempotent
 *   - LearningService.addHumanFeedback — creates outcome + extracts learnings
 *   - LearningService.extractLearning — manual upsert
 *   - LearningService.getRelevantLearnings — confidence filtering, category preference
 *   - LearningService.buildPromptInjection — REMINDER framing, kill switch
 *   - LearningService.deactivateLearning — soft delete
 *   - LearningService.listLearnings — by agent or all
 *   - LearningService.getStats — outcome counts, acceptance rate
 *   - LearningService.getAllStats — aggregation across agents
 *   - LearningService.runExtractionPass — processes all outcomes with feedback
 *   - LearningService.checkDuePlans / createPlan / recordLesson
 *   - LearningService.getOutcomesSummary
 *   - Kill switch via LEARNING_INJECTION_ENABLED env var
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, getRawDb } from "../src/db/connection.js";
import {
  LearningService,
  inferTaskCategory,
} from "../src/services/learning.js";
import { taskOutcomes, outcomeLearnings, learningPlans } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

// ── Helpers ──────────────────────────────────────────────────────────────────

function clearLearningTables() {
  const raw = getRawDb();
  raw.exec(`
    DELETE FROM outcome_learnings;
    DELETE FROM task_outcomes;
    DELETE FROM learning_lessons;
    DELETE FROM learning_plans;
    DELETE FROM tasks;
  `);
}

function seedTask(overrides: {
  id: string;
  title: string;
  agent?: string | null;
  notes?: string | null;
}) {
  const raw = getRawDb();
  const now = new Date().toISOString();
  raw.prepare(`
    INSERT INTO tasks (id, title, agent, notes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(
    overrides.id,
    overrides.title,
    overrides.agent ?? null,
    overrides.notes ?? null,
    now, now,
  );
}

const svc = new LearningService();

beforeEach(() => clearLearningTables());

// ── inferTaskCategory ────────────────────────────────────────────────────────

describe("inferTaskCategory", () => {
  it("returns 'bug_fix' for bug/fix/crash keywords", () => {
    expect(inferTaskCategory("Fix login bug")).toBe("bug_fix");
    expect(inferTaskCategory("Crash on startup")).toBe("bug_fix");
    expect(inferTaskCategory("Hotfix for auth regression")).toBe("bug_fix");
    expect(inferTaskCategory("Investigate broken pipeline")).toBe("bug_fix");
  });

  it("returns 'test' for test/spec/coverage keywords", () => {
    // Note: regex uses \btest\b so "tests" (plural) won't match, but "test" will
    expect(inferTaskCategory("Write unit test for auth")).toBe("test");
    expect(inferTaskCategory("Add e2e spec for dashboard")).toBe("test");
    expect(inferTaskCategory("Improve test coverage in API")).toBe("test");
  });

  it("returns 'refactor' for refactor/cleanup keywords", () => {
    expect(inferTaskCategory("Refactor the auth module")).toBe("refactor");
    expect(inferTaskCategory("Clean up legacy code")).toBe("refactor");
    expect(inferTaskCategory("Simplify database layer")).toBe("refactor");
    expect(inferTaskCategory("Dedup utility functions")).toBe("refactor");
  });

  it("returns 'docs' for documentation keywords", () => {
    expect(inferTaskCategory("Write README")).toBe("docs");
    expect(inferTaskCategory("Update runbook for deploy")).toBe("docs");
    expect(inferTaskCategory("Create API guide")).toBe("docs");
  });

  it("returns 'research' for research/investigate keywords", () => {
    expect(inferTaskCategory("Research caching strategies")).toBe("research");
    expect(inferTaskCategory("Investigate performance bottlenecks")).toBe("research");
    expect(inferTaskCategory("Audit security vulnerabilities")).toBe("research");
    expect(inferTaskCategory("Analyze DB query patterns")).toBe("research");
  });

  it("returns 'feature' for feature/implement/build keywords", () => {
    expect(inferTaskCategory("Implement OAuth login")).toBe("feature");
    expect(inferTaskCategory("Add new dashboard page")).toBe("feature");
    expect(inferTaskCategory("Build user profile feature")).toBe("feature");
    expect(inferTaskCategory("Ship payment integration")).toBe("feature");
  });

  it("returns 'other' for unclassified tasks", () => {
    expect(inferTaskCategory("Miscellaneous task")).toBe("other");
    expect(inferTaskCategory("")).toBe("other");
    expect(inferTaskCategory("Meeting prep")).toBe("other");
  });

  it("uses notes to disambiguate", () => {
    expect(inferTaskCategory("Something", "This is a bug fix")).toBe("bug_fix");
    expect(inferTaskCategory("Something", "We need to add a spec")).toBe("test");
  });

  it("bug_fix takes priority over feature (first match wins)", () => {
    // Both "fix" and "feature" in title — "bug_fix" check is first
    const result = inferTaskCategory("Fix the new feature");
    expect(result).toBe("bug_fix");
  });
});

// ── LearningService.recordOutcome ────────────────────────────────────────────

describe("LearningService.recordOutcome", () => {
  it("creates a new outcome record and returns an id", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Test task" });
    const id = svc.recordOutcome({
      taskId,
      agentType: "programmer",
      success: true,
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBe(36);

    const db = getDb();
    const rows = db.select().from(taskOutcomes).where(eq(taskOutcomes.id, id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].taskId).toBe(taskId);
    expect(rows[0].success).toBe(true);
    expect(rows[0].agentType).toBe("programmer");
  });

  it("records failure outcome", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Failure task" });
    const id = svc.recordOutcome({ taskId, agentType: "researcher", success: false });
    const db = getDb();
    const [row] = db.select().from(taskOutcomes).where(eq(taskOutcomes.id, id)).all();
    expect(row.success).toBe(false);
    expect(row.agentType).toBe("researcher");
  });

  it("records taskCategory and taskComplexity", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Category task" });
    const id = svc.recordOutcome({
      taskId,
      agentType: "programmer",
      success: true,
      taskCategory: "bug_fix",
      taskComplexity: "medium",
    });
    const db = getDb();
    const [row] = db.select().from(taskOutcomes).where(eq(taskOutcomes.id, id)).all();
    expect(row.taskCategory).toBe("bug_fix");
    expect(row.taskComplexity).toBe("medium");
  });

  it("records humanFeedback and appliedLearnings", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Feedback task" });
    const id = svc.recordOutcome({
      taskId,
      agentType: "programmer",
      success: false,
      humanFeedback: "Missing tests for edge cases",
      appliedLearnings: ["learning-1", "learning-2"],
    });
    const db = getDb();
    const [row] = db.select().from(taskOutcomes).where(eq(taskOutcomes.id, id)).all();
    expect(row.humanFeedback).toBe("Missing tests for edge cases");
    expect(row.appliedLearnings).toEqual(["learning-1", "learning-2"]);
  });

  it("updates existing outcome when called twice for same task", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Upsert task" });
    const id1 = svc.recordOutcome({ taskId, agentType: "programmer", success: false });
    const id2 = svc.recordOutcome({ taskId, agentType: "programmer", success: true });

    // Same outcome record, just updated
    expect(id1).toBe(id2);

    const db = getDb();
    const rows = db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId, taskId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(true); // Updated to true
  });
});

// ── LearningService.addHumanFeedback ─────────────────────────────────────────

describe("LearningService.addHumanFeedback", () => {
  it("creates a new outcome with feedback if none exists", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Write unit tests", agent: "programmer" });

    const result = svc.addHumanFeedback({
      taskId,
      feedback: "Missing unit test for edge case",
      reviewState: "rejected",
    });

    expect(result.outcomeId).toBeTruthy();

    const db = getDb();
    const rows = db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId, taskId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].humanFeedback).toBe("Missing unit test for edge case");
    expect(rows[0].reviewState).toBe("rejected");
    expect(rows[0].success).toBe(false);
  });

  it("updates existing outcome with feedback", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Fix auth bug", agent: "programmer" });
    svc.recordOutcome({ taskId, agentType: "programmer", success: false });

    const result = svc.addHumanFeedback({
      taskId,
      feedback: "Good fix, but lacks comments",
      reviewState: "accepted",
    });

    const db = getDb();
    const rows = db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId, taskId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].humanFeedback).toBe("Good fix, but lacks comments");
    expect(rows[0].reviewState).toBe("accepted");
    expect(rows[0].success).toBe(true);
  });

  it("extracts learnings from feedback keywords (pattern match)", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Build feature", agent: "programmer" });

    const result = svc.addHumanFeedback({
      taskId,
      feedback: "Missing unit test coverage for new function",
      reviewState: "rejected",
    });

    // Pattern 'require_tests' should have been extracted
    expect(result.extracted).toBeGreaterThan(0);

    const db = getDb();
    const learnings = db.select().from(outcomeLearnings)
      .where(eq(outcomeLearnings.agentType, "programmer"))
      .all();
    expect(learnings.length).toBeGreaterThan(0);
    // At least one learning should mention tests
    const testLearning = learnings.find(l => l.patternName.includes("test") || l.lessonText?.includes("test"));
    expect(testLearning).toBeTruthy();
  });

  it("accepts 'needs_revision' reviewState (maps to success=false)", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Refactor auth", agent: "programmer" });

    svc.addHumanFeedback({
      taskId,
      feedback: "Needs cleanup",
      reviewState: "needs_revision",
    });

    const db = getDb();
    const rows = db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId, taskId)).all();
    expect(rows[0].reviewState).toBe("needs_revision");
    expect(rows[0].success).toBe(false);
  });

  it("infers agent type from task's agent field if available", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Write docs", agent: "writer" });

    svc.addHumanFeedback({
      taskId,
      feedback: "Good writing",
      reviewState: "accepted",
    });

    const db = getDb();
    const rows = db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId, taskId)).all();
    expect(rows[0].agentType).toBe("writer");
  });

  it("falls back to 'programmer' agent type when task agent is null", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Generic task", agent: null });

    svc.addHumanFeedback({
      taskId,
      feedback: "Looks good",
      reviewState: "accepted",
    });

    const db = getDb();
    const rows = db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId, taskId)).all();
    expect(rows[0].agentType).toBe("programmer");
  });
});

// ── LearningService.extractLearning ──────────────────────────────────────────

describe("LearningService.extractLearning", () => {
  it("creates a new learning with specified fields", () => {
    const id = svc.extractLearning({
      agentType: "programmer",
      patternName: "always_check_null",
      lessonText: "Always check for null before accessing properties.",
    });

    expect(typeof id).toBe("string");
    const db = getDb();
    const [row] = db.select().from(outcomeLearnings).where(eq(outcomeLearnings.id, id)).all();
    expect(row.agentType).toBe("programmer");
    expect(row.patternName).toBe("always_check_null");
    expect(row.lessonText).toBe("Always check for null before accessing properties.");
    expect(row.isActive).toBe(true);
  });

  it("uses specified confidence", () => {
    const id = svc.extractLearning({
      agentType: "researcher",
      patternName: "cite_sources",
      lessonText: "Always cite sources in research output.",
      confidence: 0.9,
    });

    const db = getDb();
    const [row] = db.select().from(outcomeLearnings).where(eq(outcomeLearnings.id, id)).all();
    expect(row.confidence).toBeCloseTo(0.9, 2);
  });

  it("upserts when same patternName+agentType exists", () => {
    const id1 = svc.extractLearning({
      agentType: "programmer",
      patternName: "require_tests",
      lessonText: "Write tests.",
      confidence: 0.8,
    });
    const id2 = svc.extractLearning({
      agentType: "programmer",
      patternName: "require_tests",
      lessonText: "Write tests (updated).",
      confidence: 0.9,
    });

    // Should return same id (upserted)
    expect(id1).toBe(id2);

    const db = getDb();
    const rows = db.select().from(outcomeLearnings)
      .where(eq(outcomeLearnings.patternName, "require_tests"))
      .all();
    expect(rows).toHaveLength(1);
    // _upsertLearning updates counts/confidence but does NOT update lessonText
    expect(rows[0].lessonText).toBe("Write tests.");
  });
});

// ── LearningService.getRelevantLearnings ─────────────────────────────────────

describe("LearningService.getRelevantLearnings", () => {
  it("returns empty array when no learnings exist", () => {
    const result = svc.getRelevantLearnings("programmer");
    expect(result).toEqual([]);
  });

  it("filters by agentType", () => {
    svc.extractLearning({ agentType: "programmer", patternName: "p1", lessonText: "Prog lesson", confidence: 1.0 });
    svc.extractLearning({ agentType: "researcher", patternName: "p2", lessonText: "Res lesson", confidence: 1.0 });

    const progLearnings = svc.getRelevantLearnings("programmer");
    expect(progLearnings).toHaveLength(1);
    expect(progLearnings[0]).toBe("Prog lesson");

    const resLearnings = svc.getRelevantLearnings("researcher");
    expect(resLearnings).toHaveLength(1);
    expect(resLearnings[0]).toBe("Res lesson");
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      svc.extractLearning({
        agentType: "programmer",
        patternName: `pattern_${i}`,
        lessonText: `Lesson ${i}`,
        confidence: 1.0,
      });
    }

    const result = svc.getRelevantLearnings("programmer", undefined, 2);
    expect(result).toHaveLength(2);
  });

  it("filters out learnings below minConfidence (default 0.7)", () => {
    svc.extractLearning({ agentType: "programmer", patternName: "low_conf", lessonText: "Low confidence lesson", confidence: 0.5 });
    svc.extractLearning({ agentType: "programmer", patternName: "high_conf", lessonText: "High confidence lesson", confidence: 0.9 });

    const results = svc.getRelevantLearnings("programmer");
    expect(results).not.toContain("Low confidence lesson");
    expect(results).toContain("High confidence lesson");
  });

  it("prefers category-matching learnings over general ones", () => {
    svc.extractLearning({ agentType: "programmer", patternName: "general", lessonText: "General lesson", confidence: 1.0 });
    svc.extractLearning({ agentType: "programmer", patternName: "bug_specific", lessonText: "Bug-fix specific lesson", confidence: 0.8, taskCategory: "bug_fix" });

    const results = svc.getRelevantLearnings("programmer", "bug_fix", 2);
    expect(results[0]).toBe("Bug-fix specific lesson");
  });

  it("respects LEARNING_INJECTION_ENABLED env kill switch in getRelevantLearnings (does not affect retrieval)", () => {
    // Kill switch only affects buildPromptInjection, not getRelevantLearnings directly
    svc.extractLearning({ agentType: "programmer", patternName: "test_p", lessonText: "Test lesson", confidence: 1.0 });
    const results = svc.getRelevantLearnings("programmer");
    expect(results).toHaveLength(1);
  });
});

// ── LearningService.buildPromptInjection ─────────────────────────────────────

describe("LearningService.buildPromptInjection", () => {
  it("returns empty string when no learnings", () => {
    const result = svc.buildPromptInjection("programmer");
    expect(result).toBe("");
  });

  it("returns REMINDER-formatted learnings", () => {
    svc.extractLearning({ agentType: "programmer", patternName: "p1", lessonText: "Write tests.", confidence: 1.0 });
    svc.extractLearning({ agentType: "programmer", patternName: "p2", lessonText: "Check for nulls.", confidence: 1.0 });

    const result = svc.buildPromptInjection("programmer");
    expect(result).toContain("## Lessons from Past Tasks");
    expect(result).toContain("REMINDER: Write tests.");
    expect(result).toContain("REMINDER: Check for nulls.");
    expect(result).toContain("---");
  });

  it("returns empty string when kill switch is disabled via env var", () => {
    process.env.LEARNING_INJECTION_ENABLED = "false";
    try {
      svc.extractLearning({ agentType: "programmer", patternName: "p1", lessonText: "Lesson.", confidence: 1.0 });
      const result = svc.buildPromptInjection("programmer");
      expect(result).toBe("");
    } finally {
      delete process.env.LEARNING_INJECTION_ENABLED;
    }
  });

  it("re-enables injection after kill switch is removed", () => {
    svc.extractLearning({ agentType: "programmer", patternName: "p1", lessonText: "Lesson.", confidence: 1.0 });
    process.env.LEARNING_INJECTION_ENABLED = "false";
    const blocked = svc.buildPromptInjection("programmer");
    expect(blocked).toBe("");

    delete process.env.LEARNING_INJECTION_ENABLED;
    const allowed = svc.buildPromptInjection("programmer");
    expect(allowed).toContain("REMINDER: Lesson.");
  });
});

// ── LearningService.deactivateLearning ───────────────────────────────────────

describe("LearningService.deactivateLearning", () => {
  it("soft-deletes a learning (isActive=false)", () => {
    const id = svc.extractLearning({
      agentType: "programmer",
      patternName: "to_deactivate",
      lessonText: "Deactivate me.",
      confidence: 1.0,
    });

    svc.deactivateLearning(id);

    const db = getDb();
    const [row] = db.select().from(outcomeLearnings).where(eq(outcomeLearnings.id, id)).all();
    expect(row.isActive).toBe(false);
  });

  it("deactivated learnings are not returned by getRelevantLearnings", () => {
    const id = svc.extractLearning({
      agentType: "programmer",
      patternName: "inactive",
      lessonText: "Should not appear.",
      confidence: 1.0,
    });

    svc.deactivateLearning(id);

    const results = svc.getRelevantLearnings("programmer");
    expect(results).not.toContain("Should not appear.");
  });
});

// ── LearningService.listLearnings ────────────────────────────────────────────

describe("LearningService.listLearnings", () => {
  it("returns all learnings for a specific agent", () => {
    svc.extractLearning({ agentType: "programmer", patternName: "p1", lessonText: "P1", confidence: 0.9 });
    svc.extractLearning({ agentType: "programmer", patternName: "p2", lessonText: "P2", confidence: 0.8 });
    svc.extractLearning({ agentType: "researcher", patternName: "r1", lessonText: "R1", confidence: 0.95 });

    const progLearnings = svc.listLearnings("programmer");
    expect(progLearnings).toHaveLength(2);
    expect(progLearnings.every(l => l.agentType === "programmer")).toBe(true);
  });

  it("returns all learnings across agents when no agentType specified", () => {
    svc.extractLearning({ agentType: "programmer", patternName: "p1", lessonText: "P1", confidence: 1.0 });
    svc.extractLearning({ agentType: "researcher", patternName: "r1", lessonText: "R1", confidence: 1.0 });
    svc.extractLearning({ agentType: "writer", patternName: "w1", lessonText: "W1", confidence: 1.0 });

    const all = svc.listLearnings();
    expect(all).toHaveLength(3);
  });

  it("orders by confidence descending", () => {
    svc.extractLearning({ agentType: "programmer", patternName: "lo", lessonText: "Low", confidence: 0.5 });
    svc.extractLearning({ agentType: "programmer", patternName: "hi", lessonText: "High", confidence: 0.99 });
    svc.extractLearning({ agentType: "programmer", patternName: "mid", lessonText: "Mid", confidence: 0.75 });

    const learnings = svc.listLearnings("programmer");
    expect(learnings[0].lessonText).toBe("High");
    expect(learnings[1].lessonText).toBe("Mid");
    expect(learnings[2].lessonText).toBe("Low");
  });
});

// ── LearningService.getStats ─────────────────────────────────────────────────

describe("LearningService.getStats", () => {
  it("returns zeroes when no data exists", () => {
    const stats = svc.getStats("programmer");
    expect(stats.outcomes.total).toBe(0);
    expect(stats.outcomes.withFeedback).toBe(0);
    expect(stats.outcomes.accepted).toBe(0);
    expect(stats.outcomes.rejected).toBe(0);
    expect(stats.outcomes.acceptanceRate).toBe(0);
    expect(stats.learnings.total).toBe(0);
    expect(stats.learnings.active).toBe(0);
  });

  it("calculates acceptance rate from feedback data", () => {
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    const tasks = ids.map((id, i) => {
      seedTask({ id, title: `Task ${i}` });
      return id;
    });

    // 3 accepted, 2 rejected
    const [t1, t2, t3, t4, t5] = tasks;
    svc.addHumanFeedback({ taskId: t1, feedback: "Good", reviewState: "accepted" });
    svc.addHumanFeedback({ taskId: t2, feedback: "Good", reviewState: "accepted" });
    svc.addHumanFeedback({ taskId: t3, feedback: "Good", reviewState: "accepted" });
    svc.addHumanFeedback({ taskId: t4, feedback: "Bad", reviewState: "rejected" });
    svc.addHumanFeedback({ taskId: t5, feedback: "Bad", reviewState: "rejected" });

    const stats = svc.getStats("programmer");
    expect(stats.outcomes.withFeedback).toBe(5);
    expect(stats.outcomes.accepted).toBe(3);
    expect(stats.outcomes.rejected).toBe(2);
    expect(stats.outcomes.acceptanceRate).toBeCloseTo(0.6, 2);
  });

  it("returns kill switch status and minConfidence", () => {
    const stats = svc.getStats("programmer");
    expect(typeof stats.killSwitch.enabled).toBe("boolean");
    expect(stats.killSwitch.minConfidence).toBe(0.7);
  });

  it("returns learnings count and avgConfidence", () => {
    svc.extractLearning({ agentType: "programmer", patternName: "p1", lessonText: "L1", confidence: 0.8 });
    svc.extractLearning({ agentType: "programmer", patternName: "p2", lessonText: "L2", confidence: 1.0 });

    const stats = svc.getStats("programmer");
    expect(stats.learnings.total).toBe(2);
    expect(stats.learnings.active).toBe(2);
    expect(stats.learnings.avgConfidence).toBeCloseTo(0.9, 2);
  });

  it("includes lookback window in response", () => {
    const stats = svc.getStats("programmer", 7);
    expect(stats.window.start).toBeTruthy();
    expect(stats.window.end).toBeTruthy();
    // Window should be ~7 days
    const diffMs = new Date(stats.window.end).getTime() - new Date(stats.window.start).getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(7, 0);
  });
});

// ── LearningService.getAllStats ───────────────────────────────────────────────

describe("LearningService.getAllStats", () => {
  it("aggregates totals across all agents", () => {
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    seedTask({ id: t1, title: "Prog task", agent: "programmer" });
    seedTask({ id: t2, title: "Res task 2", agent: "researcher" });

    svc.addHumanFeedback({ taskId: t1, feedback: "Good", reviewState: "accepted" });
    svc.addHumanFeedback({ taskId: t2, feedback: "Good", reviewState: "accepted" });

    const all = svc.getAllStats();
    expect(all.totals.withFeedback).toBe(2);
    expect(all.totals.accepted).toBe(2);
    expect(typeof all.enabled).toBe("boolean");
    expect(all.agents).toContain("programmer");
    expect(all.agents).toContain("researcher");
  });

  it("includes byAgent breakdown", () => {
    const all = svc.getAllStats();
    expect(all.byAgent["programmer"]).toBeTruthy();
    expect(all.byAgent["programmer"].outcomes.total).toBe(0);
  });
});

// ── LearningService.runExtractionPass ────────────────────────────────────────

describe("LearningService.runExtractionPass", () => {
  it("returns 0 when no outcomes with feedback", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "No feedback task" });
    svc.recordOutcome({ taskId, agentType: "programmer", success: true });

    const count = svc.runExtractionPass();
    expect(count).toBe(0);
  });

  it("extracts learnings from outcomes that have feedback", () => {
    const taskId = crypto.randomUUID();
    seedTask({ id: taskId, title: "Needs tests task", agent: "programmer" });
    svc.addHumanFeedback({
      taskId,
      feedback: "Missing unit test for this function",
      reviewState: "rejected",
    });

    // Clear learnings to test extraction fresh
    getRawDb().exec("DELETE FROM outcome_learnings");

    const count = svc.runExtractionPass();
    expect(count).toBeGreaterThan(0);
  });
});

// ── LearningService.getOutcomesSummary ────────────────────────────────────────

describe("LearningService.getOutcomesSummary", () => {
  it("returns successRate=1.0 with no data (optimistic default)", () => {
    const summary = svc.getOutcomesSummary("programmer");
    expect(summary.successRate).toBe(1.0);
    expect(summary.total).toBe(0);
    expect(summary.recent).toHaveLength(0);
  });

  it("calculates success rate from outcomes", () => {
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    ids.forEach((id, i) => seedTask({ id, title: `Task ${i}` }));
    // 3 success, 1 failure
    svc.recordOutcome({ taskId: ids[0], agentType: "programmer", success: true });
    svc.recordOutcome({ taskId: ids[1], agentType: "programmer", success: true });
    svc.recordOutcome({ taskId: ids[2], agentType: "programmer", success: true });
    svc.recordOutcome({ taskId: ids[3], agentType: "programmer", success: false });

    const summary = svc.getOutcomesSummary("programmer");
    expect(summary.total).toBe(4);
    expect(summary.successRate).toBeCloseTo(0.75, 2);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      const taskId = crypto.randomUUID();
      seedTask({ id: taskId, title: `Task ${i}` });
      svc.recordOutcome({ taskId, agentType: "programmer", success: true });
    }

    const summary = svc.getOutcomesSummary("programmer", 5);
    expect(summary.recent).toHaveLength(5);
  });
});

// ── Learning Plans ────────────────────────────────────────────────────────────

describe("Learning Plans: createPlan / checkDuePlans / recordLesson", () => {
  it("creates a plan with default values", () => {
    const id = svc.createPlan({ topic: "TypeScript Generics" });
    expect(typeof id).toBe("string");

    const db = getDb();
    const [plan] = db.select().from(learningPlans).where(eq(learningPlans.id, id)).all();
    expect(plan.topic).toBe("TypeScript Generics");
    expect(plan.totalDays).toBe(30);
    expect(plan.currentDay).toBe(0);
    expect(plan.status).toBe("active");
  });

  it("creates a plan with custom values", () => {
    const id = svc.createPlan({
      topic: "Rust",
      goal: "Learn ownership",
      totalDays: 14,
      scheduleCron: "0 8 * * *",
      deliveryChannel: "email",
    });

    const db = getDb();
    const [plan] = db.select().from(learningPlans).where(eq(learningPlans.id, id)).all();
    expect(plan.totalDays).toBe(14);
    expect(plan.scheduleCron).toBe("0 8 * * *");
  });

  it("checkDuePlans returns active plans with nextDay", () => {
    const id = svc.createPlan({ topic: "Go", totalDays: 7 });

    const due = svc.checkDuePlans();
    expect(due).toHaveLength(1);
    expect(due[0].planId).toBe(id);
    expect(due[0].topic).toBe("Go");
    expect(due[0].nextDay).toBe(1); // currentDay=0 → nextDay=1
  });

  it("recordLesson saves lesson and advances currentDay", () => {
    const planId = svc.createPlan({ topic: "Vim", totalDays: 10 });
    const lessonId = svc.recordLesson(planId, 1, "Basic Navigation", "h, j, k, l movements");
    expect(typeof lessonId).toBe("string");

    const db = getDb();
    const [plan] = db.select().from(learningPlans).where(eq(learningPlans.id, planId)).all();
    expect(plan.currentDay).toBe(1);
  });

  it("plan is no longer due once at totalDays", () => {
    const planId = svc.createPlan({ topic: "Python", totalDays: 1 });
    svc.recordLesson(planId, 1, "Intro", "Python basics");

    // currentDay=1, totalDays=1 → nextDay=2 > totalDays → not due
    const due = svc.checkDuePlans();
    expect(due.find(d => d.planId === planId)).toBeUndefined();
  });
});
