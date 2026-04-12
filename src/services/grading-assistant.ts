/**
 * Grading Assistant — LLM-powered rubric grader
 *
 * Grades student submissions against a rubric, producing draft feedback
 * that Rafe (GSI) reviews before it goes anywhere.
 *
 * FERPA: submissionText is NEVER written to SQLite or disk. It lives in
 * memory only for the duration of the gradeSubmission() call.
 */

import { callApiModelJSON } from "../workers/base-worker.js";
import { log } from "../util/logger.js";
import {
  insertRubric,
  getRubricById,
  listRubricsByCourse,
  insertGradeResult,
  getGradeResultById,
  approveGradeResult,
  getStatsByCourse,
  type Rubric,
  type RubricCriterion,
  type GradeResult,
  type CriterionScore,
  type AssignmentStats,
} from "./grading-store.js";

// Re-export types so callers can import from here
export type { Rubric, RubricCriterion, GradeResult, CriterionScore, AssignmentStats };

// ── Rubric Management ─────────────────────────────────────────────────────────

export function createRubric(
  courseId: string,
  assignmentName: string,
  criteria: RubricCriterion[],
): Rubric {
  const totalPoints = criteria.reduce((sum, c) => sum + c.maxPoints, 0);
  const rubric: Rubric = {
    id: crypto.randomUUID(),
    courseId,
    assignmentName,
    totalPoints,
    criteria,
    createdAt: new Date().toISOString(),
  };
  insertRubric(rubric);
  log().info(`[grading] Created rubric ${rubric.id} for ${courseId}/${assignmentName} (${totalPoints} pts)`);
  return rubric;
}

export function getRubric(id: string): Rubric | null {
  return getRubricById(id);
}

export function listRubrics(courseId: string): Rubric[] {
  return listRubricsByCourse(courseId);
}

// ── Grading Engine ────────────────────────────────────────────────────────────

interface CriterionScoreRaw {
  score: unknown;
  feedback: unknown;
}

/**
 * Grade a student submission against a rubric.
 *
 * Grades each criterion independently for focused, accurate feedback.
 * FERPA: submissionText is in-memory only — never persisted.
 *
 * @returns A GradeResult with submissionText populated (in-memory only)
 */
export async function gradeSubmission(
  rubricId: string,
  submissionText: string,
): Promise<GradeResult> {
  const rubric = getRubricById(rubricId);
  if (!rubric) {
    throw new Error(`Rubric not found: ${rubricId}`);
  }

  log().info(`[grading] Grading submission against rubric ${rubricId} (${rubric.criteria.length} criteria)`);

  const criteriaScores: CriterionScore[] = [];

  // Grade each criterion independently for focused feedback
  for (const criterion of rubric.criteria) {
    const score = await gradeCriterion(criterion, submissionText, rubric.assignmentName);
    criteriaScores.push(score);
    log().debug?.(`[grading] ${criterion.name}: ${score.score}/${criterion.maxPoints}`);
  }

  const totalScore = criteriaScores.reduce((sum, s) => sum + s.score, 0);
  const totalPossible = rubric.totalPoints;

  const overallFeedback = await generateOverallFeedback(
    rubric,
    criteriaScores,
    submissionText,
    totalScore,
    totalPossible,
  );

  const result: GradeResult = {
    id: crypto.randomUUID(),
    rubricId,
    submissionText, // in-memory only — never stored
    criteriaScores,
    totalScore,
    totalPossible,
    overallFeedback,
    draftApproved: false,
    createdAt: new Date().toISOString(),
  };

  // Store everything EXCEPT submissionText (FERPA)
  const { submissionText: _excluded, ...storable } = result;
  insertGradeResult(storable);

  log().info(`[grading] Grade result ${result.id}: ${totalScore}/${totalPossible}`);
  return result;
}

/**
 * Grade a single rubric criterion using the LLM.
 * Returns a CriterionScore with integer score and 1-2 sentence feedback.
 */
async function gradeCriterion(
  criterion: RubricCriterion,
  submissionText: string,
  assignmentName: string,
): Promise<CriterionScore> {
  const prompt = `You are a fair and constructive teaching assistant grading a student submission.

Assignment: ${assignmentName}

CRITERION: ${criterion.name}
Maximum Points: ${criterion.maxPoints}
Full marks description: ${criterion.description}

STUDENT SUBMISSION:
---
${submissionText}
---

Grade this criterion ONLY. Do not consider other aspects of the submission.

Respond with ONLY a JSON object in this exact format:
{
  "score": <integer from 0 to ${criterion.maxPoints}>,
  "feedback": "<1-2 sentences of specific, constructive feedback explaining why this score was given>"
}

Rules:
- score MUST be an integer between 0 and ${criterion.maxPoints} inclusive
- feedback should cite specific evidence from the submission
- Be constructive: explain what was done well and what could be improved`;

  try {
    const { data } = await callApiModelJSON<CriterionScoreRaw>(prompt, { tier: "micro" });

    // Enforce integer score within range
    let score = Math.round(Number(data.score));
    if (isNaN(score)) score = 0;
    score = Math.max(0, Math.min(criterion.maxPoints, score));

    const feedback = typeof data.feedback === "string" && data.feedback.trim()
      ? data.feedback.trim()
      : "No specific feedback provided.";

    return {
      criterion: criterion.name,
      score,
      maxPoints: criterion.maxPoints,
      feedback,
    };
  } catch (err) {
    log().warn(`[grading] Error grading criterion "${criterion.name}": ${err}`);
    return {
      criterion: criterion.name,
      score: 0,
      maxPoints: criterion.maxPoints,
      feedback: "Grading error — please review manually.",
    };
  }
}

/**
 * Generate 2-3 sentence holistic summary feedback for the entire submission.
 */
async function generateOverallFeedback(
  rubric: Rubric,
  scores: CriterionScore[],
  submissionText: string,
  totalScore: number,
  totalPossible: number,
): Promise<string> {
  const percentage = Math.round((totalScore / totalPossible) * 100);
  const breakdownLines = scores
    .map(s => `- ${s.criterion}: ${s.score}/${s.maxPoints} — ${s.feedback}`)
    .join("\n");

  const prompt = `You are a teaching assistant writing holistic feedback for a student submission.

Assignment: ${rubric.assignmentName}
Total Score: ${totalScore}/${totalPossible} (${percentage}%)

Per-criterion breakdown:
${breakdownLines}

STUDENT SUBMISSION (for context):
---
${submissionText.slice(0, 2000)}${submissionText.length > 2000 ? "\n[...truncated...]" : ""}
---

Write 2-3 sentences of holistic overall feedback. Be encouraging but honest.
Highlight the strongest aspect and the most important area for improvement.
Do NOT repeat the per-criterion scores — give a high-level synthesis.
Respond with ONLY a JSON object: { "feedback": "<your 2-3 sentence summary>" }`;

  try {
    const { data } = await callApiModelJSON<{ feedback: unknown }>(prompt, { tier: "micro" });
    const text = typeof data.feedback === "string" ? data.feedback.trim() : "";
    return text || `Total score: ${totalScore}/${totalPossible} (${percentage}%).`;
  } catch (err) {
    log().warn(`[grading] Error generating overall feedback: ${err}`);
    return `Total score: ${totalScore}/${totalPossible} (${percentage}%). Please review the per-criterion feedback above.`;
  }
}

// ── Approval ──────────────────────────────────────────────────────────────────

/**
 * Mark a grade result as approved by Rafe.
 * Returns true if the result was found and updated.
 */
export function approveGrade(gradeId: string): boolean {
  const updated = approveGradeResult(gradeId);
  if (updated) {
    log().info(`[grading] Grade ${gradeId} approved`);
  }
  return updated;
}

/**
 * Retrieve a stored grade result (without submission text — never stored).
 */
export function getGradeResult(gradeId: string): Omit<GradeResult, "submissionText"> | null {
  return getGradeResultById(gradeId);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function getCourseGradingStats(courseId: string): AssignmentStats[] {
  return getStatsByCourse(courseId);
}
