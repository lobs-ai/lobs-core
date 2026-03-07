/**
 * Learning Service — track task outcomes and inject learnings into agent prompts.
 *
 * Implements the agent learning system per the approved 560-line design document
 * (~/lobs-shared-memory/docs/agent-learning-system.md, agent-learning-implementation-plan.md).
 *
 * Key capabilities:
 *   1. Record task outcomes (success/failure) on every completion
 *   2. Accept human feedback via PATCH /api/tasks/{id}/feedback
 *   3. Extract rule-based lessons from feedback patterns
 *   4. Inject relevant learnings into agent prompts before dispatch
 *   5. Stats API: baseline vs current acceptance rate
 *
 * All ops synchronous (better-sqlite3 / drizzle).
 */

import { randomUUID } from "node:crypto";
import { eq, and, desc, gte } from "drizzle-orm";
import { getDb, getRawDb } from "../db/connection.js";
import { taskOutcomes, outcomeLearnings, learningPlans, learningLessons } from "../db/schema.js";
import { log } from "../util/logger.js";

// ─── Pattern Definitions ──────────────────────────────────────────────────────
// Rule-based patterns per the design doc (Section: Task 2.1 — initial patterns for programmer)

interface PatternDef {
  key: string;
  keywords: string[];
  lessonText: string;
  agentType: string;
  taskCategory?: string;
}

const PATTERNS: PatternDef[] = [
  {
    key: "require_tests",
    keywords: ["missing test", "no test", "unit test", "write test", "add test", "test coverage", "untested"],
    lessonText: "Write unit tests for all new functions. Tasks have been rejected for missing tests.",
    agentType: "programmer",
  },
  {
    key: "descriptive_names",
    keywords: ["variable name", "unclear name", "naming", "ambiguous", "readable", "rename", "confusing name"],
    lessonText: "Use descriptive variable and function names. Code with unclear names has been rejected.",
    agentType: "programmer",
  },
  {
    key: "error_handling",
    keywords: ["error handling", "exception", "try catch", "missing catch", "unhandled", "crash", "throw"],
    lessonText: "Add proper error handling with try/catch blocks. Missing error handling causes failures.",
    agentType: "programmer",
  },
  {
    key: "document_functions",
    keywords: ["docstring", "jsdoc", "comment", "documentation", "no doc", "undocumented", "describe the function"],
    lessonText: "Add JSDoc/docstring comments to functions. Undocumented code has been rejected.",
    agentType: "programmer",
  },
  {
    key: "security_review",
    keywords: ["security", "injection", "xss", "sql injection", "auth", "sanitize", "validate input", "vulnerability"],
    lessonText: "Review code for security issues: injection, auth, input validation. Security issues cause rejection.",
    agentType: "programmer",
  },
  {
    key: "commit_required",
    keywords: ["no commit", "missing commit", "forgot commit", "not committed", "uncommitted", "git commit"],
    lessonText: "Always commit changes with git add -A && git commit before finishing. Uncommitted work is lost.",
    agentType: "programmer",
  },
  {
    key: "smoke_test",
    keywords: ["syntax error", "parse error", "compile error", "smoke test", "broken", "does not run"],
    lessonText: "Run smoke tests after writing files (python3 -m py_compile or tsc --noEmit). Broken code is rejected.",
    agentType: "programmer",
  },
  // Patterns for other agent types
  {
    key: "cite_sources",
    keywords: ["citation", "source", "reference", "evidence", "uncited", "no source"],
    lessonText: "Cite sources and references in research output. Unsupported claims cause rejection.",
    agentType: "researcher",
  },
  {
    key: "clear_recommendation",
    keywords: ["recommendation", "conclusion", "unclear", "no decision", "wishy-washy", "vague"],
    lessonText: "End with a clear recommendation or decision. Vague conclusions are not actionable.",
    agentType: "researcher",
  },
  {
    key: "check_spec",
    keywords: ["spec", "requirement", "acceptance criteria", "missing requirement", "out of scope"],
    lessonText: "Re-read the full spec and acceptance criteria before starting. Missed requirements cause rejection.",
    agentType: "architect",
  },
];

// ─── Task Category Inference ──────────────────────────────────────────────────

/**
 * Infer task category from title and notes.
 * Categories: bug_fix / feature / refactor / test / docs / research / other
 */
export function inferTaskCategory(title: string, notes?: string): string {
  const text = `${title} ${notes ?? ""}`.toLowerCase();

  if (/\b(bug|fix|broken|crash|error|regression|defect|hotfix)\b/.test(text)) return "bug_fix";
  if (/\b(test|spec|coverage|unit test|integration test|e2e)\b/.test(text)) return "test";
  if (/\b(refactor|clean up|cleanup|simplify|reorganize|restructure|dedup)\b/.test(text)) return "refactor";
  if (/\b(doc|document|readme|runbook|guide|wiki|write up|write-up)\b/.test(text)) return "docs";
  if (/\b(research|investigate|analyze|explore|study|survey|audit)\b/.test(text)) return "research";
  if (/\b(feature|implement|add|build|create|new|integrate|ship)\b/.test(text)) return "feature";

  return "other";
}

// ─── Main Service ─────────────────────────────────────────────────────────────

export class LearningService {
  /**
   * Record a task outcome after completion (called by orchestrator on task close).
   */
  recordOutcome(params: {
    taskId: string;
    workerRunId?: string;
    agentType: string;
    success: boolean;
    taskCategory?: string;
    taskComplexity?: string;
    humanFeedback?: string;
    appliedLearnings?: string[];
  }): string {
    const db = getDb();

    // Check if outcome already exists for this task
    const existing = db.select({ id: taskOutcomes.id })
      .from(taskOutcomes)
      .where(eq(taskOutcomes.taskId, params.taskId))
      .all();

    if (existing.length > 0) {
      // Update existing outcome
      const now = new Date().toISOString();
      const id = existing[0].id;
      db.update(taskOutcomes).set({
        success: params.success,
        workerRunId: params.workerRunId ?? undefined,
        taskCategory: params.taskCategory ?? undefined,
        humanFeedback: params.humanFeedback ?? undefined,
        appliedLearnings: params.appliedLearnings ?? undefined,
        updatedAt: now,
      }).where(eq(taskOutcomes.id, id)).run();
      log().info(`[LEARNING] Updated outcome: ${params.agentType} task=${params.taskId.slice(0, 8)} success=${params.success}`);
      // Update confidence on existing learnings based on this outcome
      this._updateLearningConfidence(params.agentType, params.taskCategory ?? null, params.success);
      return id;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(taskOutcomes).values({
      id,
      taskId: params.taskId,
      workerRunId: params.workerRunId ?? null,
      agentType: params.agentType,
      success: params.success,
      taskCategory: params.taskCategory ?? null,
      taskComplexity: params.taskComplexity ?? null,
      humanFeedback: params.humanFeedback ?? null,
      appliedLearnings: params.appliedLearnings ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();

    // Update confidence on existing learnings based on this outcome
    this._updateLearningConfidence(params.agentType, params.taskCategory ?? null, params.success);

    log().info(`[LEARNING] Recorded outcome: ${params.agentType} task=${params.taskId.slice(0, 8)} success=${params.success}`);
    return id;
  }

  /**
   * Add or update human feedback on a task outcome.
   * Triggers pattern extraction automatically.
   */
  addHumanFeedback(params: {
    taskId: string;
    feedback: string;
    reviewState: "accepted" | "rejected" | "needs_revision";
    category?: string;
  }): { outcomeId: string; extracted: number } {
    const db = getDb();
    const now = new Date().toISOString();

    // Get the task to infer agent type
    const rawDb = getRawDb();
    const task = rawDb.prepare(
      `SELECT agent, title, notes FROM tasks WHERE id = ?`
    ).get(params.taskId) as { agent: string | null; title: string; notes: string | null } | undefined;

    const agentType = task?.agent ?? "programmer";
    const taskCategory = inferTaskCategory(task?.title ?? "", task?.notes ?? undefined);
    const success = params.reviewState === "accepted";

    // Upsert outcome
    const existing = db.select({ id: taskOutcomes.id })
      .from(taskOutcomes)
      .where(eq(taskOutcomes.taskId, params.taskId))
      .all();

    let outcomeId: string;
    if (existing.length > 0) {
      outcomeId = existing[0].id;
      db.update(taskOutcomes).set({
        humanFeedback: params.feedback,
        reviewState: params.reviewState,
        success,
        taskCategory,
        updatedAt: now,
      }).where(eq(taskOutcomes.id, outcomeId)).run();
    } else {
      outcomeId = randomUUID();
      db.insert(taskOutcomes).values({
        id: outcomeId,
        taskId: params.taskId,
        agentType,
        success,
        taskCategory,
        humanFeedback: params.feedback,
        reviewState: params.reviewState,
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    // Extract learnings from feedback
    const extracted = this._extractPatternsFromFeedback(outcomeId, agentType, params.feedback, taskCategory, success);
    log().info(`[LEARNING] Feedback recorded: task=${params.taskId.slice(0, 8)} state=${params.reviewState} extracted=${extracted}`);

    return { outcomeId, extracted };
  }

  /**
   * Extract a learning from a pattern of outcomes and store it.
   */
  extractLearning(params: {
    agentType: string;
    patternName: string;
    lessonText: string;
    taskCategory?: string;
    taskComplexity?: string;
    sourceOutcomeIds?: string[];
    confidence?: number;
  }): string {
    return this._upsertLearning({
      agentType: params.agentType,
      patternName: params.patternName,
      lessonText: params.lessonText,
      taskCategory: params.taskCategory,
      sourceOutcomeId: params.sourceOutcomeIds?.[0],
      confidence: params.confidence ?? 1.0,
      success: false, // Manually extracted — treat as failure-derived
    });
  }

  /**
   * Get relevant learnings to inject into an agent's prompt.
   * Returns formatted lesson strings (up to `limit`).
   */
  getRelevantLearnings(agentType: string, taskCategory?: string, limit = 3): string[] {
    const db = getDb();
    const rows = db.select().from(outcomeLearnings)
      .where(and(
        eq(outcomeLearnings.agentType, agentType),
        eq(outcomeLearnings.isActive, true),
      ))
      .orderBy(desc(outcomeLearnings.confidence), desc(outcomeLearnings.updatedAt))
      .limit(limit * 3)
      .all();

    // Prefer category-matching learnings, then general ones
    const categoryMatch = taskCategory
      ? rows.filter(r => r.taskCategory === taskCategory)
      : [];
    const general = rows.filter(r => !r.taskCategory);
    const merged = [...categoryMatch, ...general].slice(0, limit);

    return merged.map(r => `${r.lessonText}`);
  }

  /**
   * Build a learning injection block for an agent prompt.
   * Per design doc: prefix-style injection, IMPORTANT/REMINDER framing.
   */
  buildPromptInjection(agentType: string, taskCategory?: string): string {
    const learnings = this.getRelevantLearnings(agentType, taskCategory, 3);
    if (!learnings.length) return "";

    const lines = learnings.map(l => `REMINDER: ${l}`).join("\n\n");
    return `\n\n## Lessons from Past Tasks\n\n${lines}\n\n---`;
  }

  /**
   * Get learning system stats for an agent (for stats API).
   */
  getStats(agentType: string, lookbackDays = 30): {
    agentType: string;
    window: { start: string; end: string };
    outcomes: {
      total: number;
      withFeedback: number;
      accepted: number;
      rejected: number;
      acceptanceRate: number;
    };
    learnings: {
      total: number;
      active: number;
      avgConfidence: number;
      topPatterns: Array<{ patternName: string; confidence: number; successCount: number; failureCount: number }>;
    };
  } {
    const db = getDb();
    const windowStart = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date().toISOString();

    const allOutcomes = db.select().from(taskOutcomes)
      .where(and(
        eq(taskOutcomes.agentType, agentType),
        gte(taskOutcomes.createdAt, windowStart),
      ))
      .all();

    const withFeedback = allOutcomes.filter(o => o.humanFeedback);
    const accepted = withFeedback.filter(o => o.reviewState === "accepted").length;
    const rejected = withFeedback.filter(o => o.reviewState === "rejected").length;

    const allLearnings = db.select().from(outcomeLearnings)
      .where(eq(outcomeLearnings.agentType, agentType))
      .orderBy(desc(outcomeLearnings.confidence))
      .all();

    const activeLearnings = allLearnings.filter(l => l.isActive);
    const avgConfidence = activeLearnings.length
      ? activeLearnings.reduce((sum, l) => sum + (l.confidence ?? 0), 0) / activeLearnings.length
      : 0;

    return {
      agentType,
      window: { start: windowStart, end: windowEnd },
      outcomes: {
        total: allOutcomes.length,
        withFeedback: withFeedback.length,
        accepted,
        rejected,
        acceptanceRate: withFeedback.length > 0 ? accepted / withFeedback.length : 0,
      },
      learnings: {
        total: allLearnings.length,
        active: activeLearnings.length,
        avgConfidence: Math.round(avgConfidence * 100) / 100,
        topPatterns: activeLearnings.slice(0, 5).map(l => ({
          patternName: l.patternName,
          confidence: Math.round((l.confidence ?? 0) * 100) / 100,
          successCount: l.successCount ?? 0,
          failureCount: l.failureCount ?? 0,
        })),
      },
    };
  }

  /**
   * List all active learnings for an agent.
   */
  listLearnings(agentType?: string): typeof outcomeLearnings.$inferSelect[] {
    const db = getDb();
    if (agentType) {
      return db.select().from(outcomeLearnings)
        .where(eq(outcomeLearnings.agentType, agentType))
        .orderBy(desc(outcomeLearnings.confidence))
        .all();
    }
    return db.select().from(outcomeLearnings)
      .orderBy(desc(outcomeLearnings.confidence))
      .all();
  }

  /**
   * Deactivate a learning (soft delete).
   */
  deactivateLearning(id: string): void {
    const db = getDb();
    db.update(outcomeLearnings).set({
      isActive: false,
      updatedAt: new Date().toISOString(),
    }).where(eq(outcomeLearnings.id, id)).run();
    log().info(`[LEARNING] Deactivated learning: ${id}`);
  }

  /**
   * Run extraction pass over all outcomes with feedback that have not yet been processed.
   * Returns count of new/updated learnings.
   */
  runExtractionPass(): number {
    const db = getDb();
    // Get outcomes that have feedback but haven't triggered extraction recently
    const toProcess = db.select().from(taskOutcomes)
      .where(and(
        eq(taskOutcomes.learningDisabled, false),
      ))
      .all()
      .filter(o => o.humanFeedback && o.humanFeedback.length > 0);

    let total = 0;
    for (const outcome of toProcess) {
      total += this._extractPatternsFromFeedback(
        outcome.id,
        outcome.agentType,
        outcome.humanFeedback ?? "",
        outcome.taskCategory ?? undefined,
        outcome.success,
      );
    }
    if (total > 0) {
      log().info(`[LEARNING] Extraction pass: processed ${toProcess.length} outcomes, ${total} learnings updated`);
    }
    return total;
  }

  // ── Learning Plans (original functionality) ────────────────────────────────

  checkDuePlans(): { planId: string; topic: string; nextDay: number }[] {
    const db = getDb();
    const plans = db.select().from(learningPlans)
      .where(eq(learningPlans.status, "active"))
      .all();

    const due: { planId: string; topic: string; nextDay: number }[] = [];
    for (const plan of plans) {
      const nextDay = (plan.currentDay ?? 0) + 1;
      if (nextDay <= (plan.totalDays ?? 30)) {
        due.push({ planId: plan.id, topic: plan.topic ?? "", nextDay });
      }
    }
    return due;
  }

  createPlan(params: {
    topic: string;
    goal?: string;
    totalDays?: number;
    scheduleCron?: string;
    deliveryChannel?: string;
  }): string {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(learningPlans).values({
      id,
      topic: params.topic,
      goal: params.goal ?? "Get 1% better every day",
      totalDays: params.totalDays ?? 30,
      currentDay: 0,
      status: "active",
      scheduleCron: params.scheduleCron ?? "0 7 * * *",
      scheduleTz: "America/New_York",
      deliveryChannel: params.deliveryChannel ?? "discord",
      planOutline: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    log().info(`[LEARNING] Created plan "${params.topic}" (${params.totalDays ?? 30} days)`);
    return id;
  }

  recordLesson(planId: string, dayNumber: number, title: string, content: string): string {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(learningLessons).values({
      id,
      planId,
      dayNumber,
      title,
      content,
      summary: content.slice(0, 200),
      documentPath: null,
      createdAt: now,
    }).run();
    db.update(learningPlans).set({ currentDay: dayNumber, updatedAt: now })
      .where(eq(learningPlans.id, planId)).run();
    return id;
  }

  /**
   * Get recent outcomes summary for an agent.
   */
  getOutcomesSummary(agentType: string, limit = 20): { successRate: number; total: number; recent: typeof taskOutcomes.$inferSelect[] } {
    const db = getDb();
    const recent = db.select().from(taskOutcomes)
      .where(eq(taskOutcomes.agentType, agentType))
      .orderBy(desc(taskOutcomes.createdAt))
      .limit(limit)
      .all();
    const successes = recent.filter(r => r.success).length;
    return {
      successRate: recent.length ? successes / recent.length : 1.0,
      total: recent.length,
      recent,
    };
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Extract patterns from feedback text and create/update learnings.
   * Returns number of learnings created or updated.
   */
  private _extractPatternsFromFeedback(
    outcomeId: string,
    agentType: string,
    feedback: string,
    taskCategory?: string,
    success?: boolean,
  ): number {
    if (!feedback || feedback.trim().length < 10) return 0;

    const feedbackLower = feedback.toLowerCase();
    let count = 0;

    for (const pattern of PATTERNS) {
      if (pattern.agentType !== agentType) continue;
      if (pattern.taskCategory && pattern.taskCategory !== taskCategory) continue;

      const matched = pattern.keywords.some(kw => feedbackLower.includes(kw));
      if (!matched) continue;

      this._upsertLearning({
        agentType,
        patternName: pattern.key,
        lessonText: pattern.lessonText,
        taskCategory: pattern.taskCategory ?? taskCategory,
        sourceOutcomeId: outcomeId,
        confidence: 0.8,
        success: success ?? false,
      });
      count++;
    }

    return count;
  }

  /**
   * Create or update a learning by (agentType, patternName).
   * Returns the learning ID.
   */
  private _upsertLearning(params: {
    agentType: string;
    patternName: string;
    lessonText: string;
    taskCategory?: string;
    sourceOutcomeId?: string;
    confidence: number;
    success: boolean;
  }): string {
    const db = getDb();
    const now = new Date().toISOString();

    const existing = db.select().from(outcomeLearnings)
      .where(and(
        eq(outcomeLearnings.agentType, params.agentType),
        eq(outcomeLearnings.patternName, params.patternName),
      ))
      .all();

    if (existing.length > 0) {
      const l = existing[0];
      const successCount = (l.successCount ?? 0) + (params.success ? 1 : 0);
      const failureCount = (l.failureCount ?? 0) + (params.success ? 0 : 1);
      const total = successCount + failureCount;
      // Bayesian update: blend new evidence with prior confidence
      const newConfidence = total > 0
        ? (successCount / total) * 0.3 + (l.confidence ?? params.confidence) * 0.7
        : l.confidence ?? params.confidence;

      // Merge source outcome IDs
      let sourceIds: string[] = [];
      try {
        sourceIds = JSON.parse(l.sourceOutcomeIds as unknown as string ?? "[]") as string[];
      } catch {}
      if (params.sourceOutcomeId && !sourceIds.includes(params.sourceOutcomeId)) {
        sourceIds.push(params.sourceOutcomeId);
      }

      db.update(outcomeLearnings).set({
        successCount,
        failureCount,
        confidence: Math.max(0.1, Math.min(1.0, newConfidence)),
        sourceOutcomeIds: sourceIds,
        isActive: true, // Re-activate if it was deactivated
        updatedAt: now,
      }).where(eq(outcomeLearnings.id, l.id)).run();

      return l.id;
    }

    // Create new learning
    const id = randomUUID();
    db.insert(outcomeLearnings).values({
      id,
      agentType: params.agentType,
      patternName: params.patternName,
      lessonText: params.lessonText,
      taskCategory: params.taskCategory ?? null,
      confidence: params.confidence,
      sourceOutcomeIds: params.sourceOutcomeId ? [params.sourceOutcomeId] : null,
      isActive: true,
      successCount: params.success ? 1 : 0,
      failureCount: params.success ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    log().info(`[LEARNING] Created learning: ${params.patternName} for ${params.agentType}`);
    return id;
  }

  /**
   * Update confidence on existing learnings based on a new task outcome.
   * Called after every recordOutcome() to keep confidences fresh.
   */
  private _updateLearningConfidence(agentType: string, taskCategory: string | null, success: boolean): void {
    const db = getDb();
    const learnings = db.select().from(outcomeLearnings)
      .where(and(
        eq(outcomeLearnings.agentType, agentType),
        eq(outcomeLearnings.isActive, true),
      ))
      .all();

    for (const l of learnings) {
      if (taskCategory && l.taskCategory && l.taskCategory !== taskCategory) continue;
      const successCount = (l.successCount ?? 0) + (success ? 1 : 0);
      const failureCount = (l.failureCount ?? 0) + (success ? 0 : 1);
      const total = successCount + failureCount;
      const newConfidence = total > 0
        ? (successCount / total) * 0.7 + (l.confidence ?? 1.0) * 0.3
        : l.confidence ?? 1.0;
      db.update(outcomeLearnings).set({
        successCount,
        failureCount,
        confidence: Math.max(0.1, Math.min(1.0, newConfidence)),
        updatedAt: new Date().toISOString(),
      }).where(eq(outcomeLearnings.id, l.id)).run();
    }
  }
}
