/**
 * Grading Assistant — SQLite Persistence Layer
 *
 * Two tables:
 *   rubrics        — assignment rubrics (criteria + point values)
 *   grade_results  — grading results WITHOUT submission text (FERPA)
 *
 * Uses the shared getRawDb() connection — no separate DB file needed.
 * Call initGradingStore() once on startup (idempotent).
 *
 * FERPA note: submission text is NEVER written to disk. Only rubricId,
 * criteriaScores, totalScore, totalPossible, overallFeedback, and metadata
 * are persisted. The submission text lives in memory only during grading.
 */

import { getRawDb } from "../db/connection.js";
import { log } from "../util/logger.js";

// ── Schema ────────────────────────────────────────────────────────────────────

export function initGradingStore(): void {
  const db = getRawDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS rubrics (
      id               TEXT PRIMARY KEY,
      course_id        TEXT NOT NULL,
      assignment_name  TEXT NOT NULL,
      total_points     INTEGER NOT NULL,
      criteria_json    TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS rubrics_course_idx ON rubrics(course_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS grade_results (
      id                  TEXT PRIMARY KEY,
      rubric_id           TEXT NOT NULL,
      criteria_scores_json TEXT NOT NULL,
      total_score         INTEGER NOT NULL,
      total_possible      INTEGER NOT NULL,
      overall_feedback    TEXT NOT NULL,
      draft_approved      INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS grade_results_rubric_idx ON grade_results(rubric_id)`);

  log().info("[grading-store] Tables ready");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RubricCriterion {
  name: string;
  maxPoints: number;
  description: string;
}

export interface Rubric {
  id: string;
  courseId: string;
  assignmentName: string;
  totalPoints: number;
  criteria: RubricCriterion[];
  createdAt: string;
}

export interface CriterionScore {
  criterion: string;
  score: number;
  maxPoints: number;
  feedback: string;
}

export interface GradeResult {
  id: string;
  rubricId: string;
  /** In-memory only during grading — never stored */
  submissionText: string;
  criteriaScores: CriterionScore[];
  totalScore: number;
  totalPossible: number;
  overallFeedback: string;
  draftApproved: boolean;
  createdAt: string;
}

// ── Raw DB row types ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawRow = Record<string, any>;

// ── Rubric CRUD ───────────────────────────────────────────────────────────────

export function insertRubric(rubric: Rubric): void {
  try {
    const db = getRawDb();
    db.prepare(`
      INSERT INTO rubrics (id, course_id, assignment_name, total_points, criteria_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      rubric.id,
      rubric.courseId,
      rubric.assignmentName,
      rubric.totalPoints,
      JSON.stringify(rubric.criteria),
      rubric.createdAt,
    );
  } catch (err) {
    log().warn(`[grading-store] Failed to insert rubric: ${err}`);
    throw err;
  }
}

export function getRubricById(id: string): Rubric | null {
  try {
    const db = getRawDb();
    const row = db.prepare(`SELECT * FROM rubrics WHERE id = ?`).get(id) as RawRow | null;
    return row ? rowToRubric(row) : null;
  } catch (err) {
    log().warn(`[grading-store] getRubricById error: ${err}`);
    return null;
  }
}

export function listRubricsByCourse(courseId: string): Rubric[] {
  try {
    const db = getRawDb();
    const rows = db.prepare(`SELECT * FROM rubrics WHERE course_id = ? ORDER BY created_at DESC`).all(courseId) as RawRow[];
    return rows.map(rowToRubric);
  } catch (err) {
    log().warn(`[grading-store] listRubricsByCourse error: ${err}`);
    return [];
  }
}

// ── Grade Result CRUD ─────────────────────────────────────────────────────────

/** Persist a grade result. submissionText is intentionally excluded. */
export function insertGradeResult(result: Omit<GradeResult, 'submissionText'>): void {
  try {
    const db = getRawDb();
    db.prepare(`
      INSERT INTO grade_results
        (id, rubric_id, criteria_scores_json, total_score, total_possible, overall_feedback, draft_approved, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id,
      result.rubricId,
      JSON.stringify(result.criteriaScores),
      result.totalScore,
      result.totalPossible,
      result.overallFeedback,
      result.draftApproved ? 1 : 0,
      result.createdAt,
    );
  } catch (err) {
    log().warn(`[grading-store] Failed to insert grade result: ${err}`);
    throw err;
  }
}

export function getGradeResultById(id: string): Omit<GradeResult, 'submissionText'> | null {
  try {
    const db = getRawDb();
    const row = db.prepare(`SELECT * FROM grade_results WHERE id = ?`).get(id) as RawRow | null;
    return row ? rowToGradeResult(row) : null;
  } catch (err) {
    log().warn(`[grading-store] getGradeResultById error: ${err}`);
    return null;
  }
}

export function approveGradeResult(id: string): boolean {
  try {
    const db = getRawDb();
    const info = db.prepare(`UPDATE grade_results SET draft_approved = 1 WHERE id = ?`).run(id);
    return info.changes > 0;
  } catch (err) {
    log().warn(`[grading-store] approveGradeResult error: ${err}`);
    return false;
  }
}

// ── Stats Queries ─────────────────────────────────────────────────────────────

export interface AssignmentStats {
  rubricId: string;
  assignmentName: string;
  count: number;
  minScore: number;
  maxScore: number;
  avgScore: number;
  totalPossible: number;
  approvalRate: number;
}

export function getStatsByCourse(courseId: string): AssignmentStats[] {
  try {
    const db = getRawDb();
    const rows = db.prepare(`
      SELECT
        r.id              AS rubric_id,
        r.assignment_name,
        r.total_points,
        COUNT(g.id)       AS cnt,
        MIN(g.total_score)  AS min_score,
        MAX(g.total_score)  AS max_score,
        AVG(g.total_score)  AS avg_score,
        SUM(g.draft_approved) AS approved_count
      FROM rubrics r
      LEFT JOIN grade_results g ON g.rubric_id = r.id
      WHERE r.course_id = ?
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `).all(courseId) as RawRow[];

    return rows.map(r => ({
      rubricId: r.rubric_id as string,
      assignmentName: r.assignment_name as string,
      count: (r.cnt as number) ?? 0,
      minScore: (r.min_score as number) ?? 0,
      maxScore: (r.max_score as number) ?? 0,
      avgScore: Math.round(((r.avg_score as number) ?? 0) * 10) / 10,
      totalPossible: r.total_points as number,
      approvalRate: (r.cnt as number) > 0
        ? Math.round(((r.approved_count as number) / (r.cnt as number)) * 100) / 100
        : 0,
    }));
  } catch (err) {
    log().warn(`[grading-store] getStatsByCourse error: ${err}`);
    return [];
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function rowToRubric(row: RawRow): Rubric {
  return {
    id: row.id as string,
    courseId: row.course_id as string,
    assignmentName: row.assignment_name as string,
    totalPoints: row.total_points as number,
    criteria: JSON.parse(row.criteria_json as string) as RubricCriterion[],
    createdAt: row.created_at as string,
  };
}

function rowToGradeResult(row: RawRow): Omit<GradeResult, 'submissionText'> {
  return {
    id: row.id as string,
    rubricId: row.rubric_id as string,
    criteriaScores: JSON.parse(row.criteria_scores_json as string) as CriterionScore[],
    totalScore: row.total_score as number,
    totalPossible: row.total_possible as number,
    overallFeedback: row.overall_feedback as string,
    draftApproved: (row.draft_approved as number) === 1,
    createdAt: row.created_at as string,
  };
}
