/**
 * Learning Service — track task outcomes and inject learnings into agent prompts.
 * Port of lobs-server/app/services/learning_service.py (outcome tracking parts)
 * and learning_service.py (scheduled lesson delivery).
 * All ops synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import { eq, and, desc, gte, lte } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { taskOutcomes, outcomeLearnings, learningPlans, learningLessons } from "../db/schema.js";
import { log } from "../util/logger.js";

export class LearningService {
  /**
   * Record a task outcome after completion.
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
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(outcomeLearnings).values({
      id,
      agentType: params.agentType,
      patternName: params.patternName,
      lessonText: params.lessonText,
      taskCategory: params.taskCategory ?? null,
      taskComplexity: params.taskComplexity ?? null,
      confidence: params.confidence ?? 1.0,
      sourceOutcomeIds: params.sourceOutcomeIds ?? null,
      isActive: true,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    }).run();
    log().info(`[LEARNING] Extracted learning: ${params.patternName} for ${params.agentType}`);
    return id;
  }

  /**
   * Get relevant learnings to inject into an agent's prompt.
   */
  getRelevantLearnings(agentType: string, taskCategory?: string, limit = 5): string[] {
    const db = getDb();
    const rows = db.select().from(outcomeLearnings)
      .where(and(
        eq(outcomeLearnings.agentType, agentType),
        eq(outcomeLearnings.isActive, true),
      ))
      .orderBy(desc(outcomeLearnings.confidence), desc(outcomeLearnings.updatedAt))
      .limit(limit * 2)
      .all();

    // Prefer category-matching learnings
    const categoryMatch = rows.filter(r => r.taskCategory === taskCategory);
    const general = rows.filter(r => !r.taskCategory);
    const merged = [...categoryMatch, ...general].slice(0, limit);

    return merged.map(r => `[${r.patternName}] ${r.lessonText} (confidence: ${(r.confidence ?? 1).toFixed(2)})`);
  }

  /**
   * Build a learning injection block for an agent prompt.
   */
  buildPromptInjection(agentType: string, taskCategory?: string): string {
    const learnings = this.getRelevantLearnings(agentType, taskCategory);
    if (!learnings.length) return "";
    return `\n\n## Learned Patterns\n${learnings.map(l => `- ${l}`).join("\n")}\n`;
  }

  /**
   * Check for active learning plans that are due today.
   */
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

  /**
   * Create a new learning plan.
   */
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

  /**
   * Record a completed lesson for a plan.
   */
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
    // Advance plan day
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
      const newConfidence = total > 0 ? (successCount / total) * 0.7 + (l.confidence ?? 1.0) * 0.3 : l.confidence ?? 1.0;
      db.update(outcomeLearnings).set({
        successCount,
        failureCount,
        confidence: Math.max(0.1, Math.min(1.0, newConfidence)),
        updatedAt: new Date().toISOString(),
      }).where(eq(outcomeLearnings.id, l.id)).run();
    }
  }
}
