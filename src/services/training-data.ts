/**
 * Training Data Collection Service
 * 
 * Collects input/output pairs from LLM tasks for fine-tuning.
 * Every LLM call that goes through a sentinel task or brain dump
 * gets logged here with full context for later QLoRA training.
 * 
 * Export format: JSONL compatible with Unsloth/Axolotl.
 */

import { randomUUID } from "node:crypto";
import { eq, desc, and, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { trainingData } from "../db/schema.js";

export type TaskType = "braindump" | "calendar_check" | "daily_brief" | "system_state" | "categorization" | "summary";
export type ReviewStatus = "pending" | "approved" | "corrected" | "rejected";

export interface TrainingExample {
  id: string;
  taskType: TaskType;
  systemPrompt: string;
  userPrompt: string;
  context: Record<string, unknown>;  // assembled context that was included
  modelOutput: string;
  correctedOutput?: string;  // human correction if any
  reviewStatus: ReviewStatus;
  modelUsed: string;
  createdAt: string;
}

/**
 * Log a training example from an LLM call.
 */
export function logTrainingExample(opts: {
  taskType: TaskType;
  systemPrompt: string;
  userPrompt: string;
  context: Record<string, unknown>;
  modelOutput: string;
  modelUsed: string;
}): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.insert(trainingData).values({
    id,
    taskType: opts.taskType,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    context: JSON.stringify(opts.context),
    modelOutput: opts.modelOutput,
    correctedOutput: null,
    reviewStatus: "pending",
    modelUsed: opts.modelUsed,
    createdAt: now,
    updatedAt: now,
  }).run();

  return id;
}

/**
 * Mark an example as approved (output was good).
 */
export function approveExample(id: string): void {
  const db = getDb();
  db.update(trainingData)
    .set({ reviewStatus: "approved", updatedAt: new Date().toISOString() })
    .where(eq(trainingData.id, id))
    .run();
}

/**
 * Submit a corrected output for an example.
 */
export function correctExample(id: string, correctedOutput: string): void {
  const db = getDb();
  db.update(trainingData)
    .set({
      correctedOutput,
      reviewStatus: "corrected",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(trainingData.id, id))
    .run();
}

/**
 * Reject an example (not useful for training).
 */
export function rejectExample(id: string): void {
  const db = getDb();
  db.update(trainingData)
    .set({ reviewStatus: "rejected", updatedAt: new Date().toISOString() })
    .where(eq(trainingData.id, id))
    .run();
}

/**
 * Get examples for review.
 */
export function getPendingExamples(limit = 20): TrainingExample[] {
  const db = getDb();
  const rows = db.select().from(trainingData)
    .where(eq(trainingData.reviewStatus, "pending"))
    .orderBy(desc(trainingData.createdAt))
    .limit(limit)
    .all();

  return rows.map(rowToExample);
}

/**
 * Get all examples for a task type.
 */
export function getExamplesByType(taskType: TaskType, limit = 100): TrainingExample[] {
  const db = getDb();
  const rows = db.select().from(trainingData)
    .where(eq(trainingData.taskType, taskType))
    .orderBy(desc(trainingData.createdAt))
    .limit(limit)
    .all();

  return rows.map(rowToExample);
}

/**
 * Get training stats.
 */
export function getTrainingStats(): Record<string, { total: number; approved: number; corrected: number; pending: number; rejected: number }> {
  const db = getDb();
  const all = db.select().from(trainingData).all();

  const stats: Record<string, { total: number; approved: number; corrected: number; pending: number; rejected: number }> = {};

  for (const row of all) {
    const type = row.taskType as string;
    if (!stats[type]) stats[type] = { total: 0, approved: 0, corrected: 0, pending: 0, rejected: 0 };
    stats[type].total++;
    stats[type][row.reviewStatus as ReviewStatus]++;
  }

  return stats;
}

/**
 * Export approved/corrected examples as JSONL for Unsloth fine-tuning.
 * Format: ChatML conversation format.
 */
export function exportAsJsonl(taskType?: TaskType): string {
  const db = getDb();
  
  let query = db.select().from(trainingData)
    .where(inArray(trainingData.reviewStatus, ["approved", "corrected"]));

  const rows = taskType
    ? db.select().from(trainingData)
        .where(and(
          inArray(trainingData.reviewStatus, ["approved", "corrected"]),
          eq(trainingData.taskType, taskType),
        ))
        .all()
    : db.select().from(trainingData)
        .where(inArray(trainingData.reviewStatus, ["approved", "corrected"]))
        .all();

  const lines: string[] = [];

  for (const row of rows) {
    // Use corrected output if available, otherwise original
    const output = row.correctedOutput || row.modelOutput;
    
    const example = {
      conversations: [
        { role: "system", content: row.systemPrompt },
        { role: "user", content: row.userPrompt },
        { role: "assistant", content: output },
      ],
    };

    lines.push(JSON.stringify(example));
  }

  return lines.join("\n");
}

function rowToExample(row: any): TrainingExample {
  return {
    id: row.id,
    taskType: row.taskType as TaskType,
    systemPrompt: row.systemPrompt,
    userPrompt: row.userPrompt,
    context: typeof row.context === "string" ? JSON.parse(row.context) : row.context,
    modelOutput: row.modelOutput,
    correctedOutput: row.correctedOutput ?? undefined,
    reviewStatus: row.reviewStatus as ReviewStatus,
    modelUsed: row.modelUsed,
    createdAt: row.createdAt,
  };
}
