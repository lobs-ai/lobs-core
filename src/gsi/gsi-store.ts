/**
 * GSI Office Hours — SQLite Persistence Layer
 *
 * Two tables:
 *   gsi_qa_log       — every question/answer event (analytics backbone)
 *   gsi_escalations  — pending TA escalations (survives restarts)
 *
 * Uses the shared getRawDb() connection — no separate DB file needed.
 * Call initGsiStore() once on startup (idempotent).
 */

import { getRawDb } from "../db/connection.js";
import { log } from "../util/logger.js";
import type { PendingEscalation } from "./gsi-agent.js";

// ── Schema Migrations ─────────────────────────────────────────────────────────

export function initGsiStore(): void {
  const db = getRawDb();

  // Q&A log — one row per /ask invocation
  db.exec(`
    CREATE TABLE IF NOT EXISTS gsi_qa_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id   TEXT    NOT NULL,
      guild_id    TEXT    NOT NULL,
      channel_id  TEXT    NOT NULL,
      user_id     TEXT    NOT NULL,
      question    TEXT    NOT NULL,
      answer      TEXT    NOT NULL DEFAULT '',
      confidence  REAL    NOT NULL DEFAULT 0,
      escalated   INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1
      answered_by TEXT    NOT NULL DEFAULT 'bot', -- 'bot' | 'ta:<userId>'
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS gsi_qa_log_course_idx   ON gsi_qa_log(course_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS gsi_qa_log_guild_idx    ON gsi_qa_log(guild_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS gsi_qa_log_created_idx  ON gsi_qa_log(created_at)`);

  // Persistent escalation store — replaces the in-memory Map so they survive restarts
  db.exec(`
    CREATE TABLE IF NOT EXISTS gsi_escalations (
      id            TEXT    PRIMARY KEY,  -- e.g. "ask-a3f"
      ta_user_id    TEXT    NOT NULL,
      channel_id    TEXT    NOT NULL,
      guild_id      TEXT    NOT NULL,
      question      TEXT    NOT NULL,
      asked_by      TEXT    NOT NULL,     -- Discord mention string
      course_name   TEXT    NOT NULL,
      draft_answer  TEXT    NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,     -- Unix ms timestamp
      resolved      INTEGER NOT NULL DEFAULT 0,  -- 0=pending, 1=resolved
      resolved_at   TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS gsi_esc_ta_idx       ON gsi_escalations(ta_user_id, resolved)`);
  db.exec(`CREATE INDEX IF NOT EXISTS gsi_esc_created_idx  ON gsi_escalations(created_at)`);

  log().info("[gsi-store] Tables ready");
}

// ── Q&A Log ───────────────────────────────────────────────────────────────────

export interface QaLogEntry {
  courseId: string;
  guildId: string;
  channelId: string;
  userId: string;
  question: string;
  answer: string;
  confidence: number;
  escalated: boolean;
  answeredBy?: string; // 'bot' or 'ta:<userId>'
}

export function logQaEvent(entry: QaLogEntry): void {
  try {
    const db = getRawDb();
    db.prepare(`
      INSERT INTO gsi_qa_log
        (course_id, guild_id, channel_id, user_id, question, answer, confidence, escalated, answered_by)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.courseId,
      entry.guildId,
      entry.channelId,
      entry.userId,
      entry.question,
      entry.answer,
      entry.confidence,
      entry.escalated ? 1 : 0,
      entry.answeredBy ?? "bot",
    );
  } catch (err) {
    // Non-fatal — don't break the answer pipeline if logging fails
    log().warn(`[gsi-store] Failed to log Q&A event: ${err}`);
  }
}

// ── Q&A Analytics ─────────────────────────────────────────────────────────────

export interface GsiCourseStats {
  courseId: string;
  totalQuestions: number;
  botAnswered: number;
  escalated: number;
  deflectionRate: number; // 0–1
  avgConfidence: number;
  last7Days: number;
  last30Days: number;
  topQuestions: Array<{ question: string; count: number }>;
}

export function getCourseStats(courseId: string): GsiCourseStats {
  const db = getRawDb();

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN escalated = 0 THEN 1 ELSE 0 END) as bot_answered,
      SUM(escalated) as escalated,
      AVG(confidence) as avg_confidence
    FROM gsi_qa_log
    WHERE course_id = ?
  `).get(courseId) as { total: number; bot_answered: number; escalated: number; avg_confidence: number } | null;

  const last7 = db.prepare(`
    SELECT COUNT(*) as cnt FROM gsi_qa_log
    WHERE course_id = ? AND created_at >= datetime('now', '-7 days')
  `).get(courseId) as { cnt: number } | null;

  const last30 = db.prepare(`
    SELECT COUNT(*) as cnt FROM gsi_qa_log
    WHERE course_id = ? AND created_at >= datetime('now', '-30 days')
  `).get(courseId) as { cnt: number } | null;

  // Top repeated questions (exact match — good enough for now)
  const topQs = db.prepare(`
    SELECT question, COUNT(*) as cnt FROM gsi_qa_log
    WHERE course_id = ?
    GROUP BY question
    ORDER BY cnt DESC
    LIMIT 5
  `).all(courseId) as Array<{ question: string; cnt: number }>;

  const total = totals?.total ?? 0;
  const botAnswered = totals?.bot_answered ?? 0;
  const escalated = totals?.escalated ?? 0;

  return {
    courseId,
    totalQuestions: total,
    botAnswered,
    escalated,
    deflectionRate: total > 0 ? botAnswered / total : 0,
    avgConfidence: totals?.avg_confidence ?? 0,
    last7Days: last7?.cnt ?? 0,
    last30Days: last30?.cnt ?? 0,
    topQuestions: topQs.map(r => ({ question: r.question, count: r.cnt })),
  };
}

export interface GsiAllCoursesStats {
  totalQuestions: number;
  botAnswered: number;
  escalated: number;
  deflectionRate: number;
  last7Days: number;
  byCourse: Array<{ courseId: string; total: number; escalated: number; deflection: number }>;
}

export function getAllCoursesStats(guildId: string): GsiAllCoursesStats {
  const db = getRawDb();

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN escalated = 0 THEN 1 ELSE 0 END) as bot_answered,
      SUM(escalated) as escalated
    FROM gsi_qa_log WHERE guild_id = ?
  `).get(guildId) as { total: number; bot_answered: number; escalated: number } | null;

  const last7 = db.prepare(`
    SELECT COUNT(*) as cnt FROM gsi_qa_log
    WHERE guild_id = ? AND created_at >= datetime('now', '-7 days')
  `).get(guildId) as { cnt: number } | null;

  const byCourse = db.prepare(`
    SELECT
      course_id,
      COUNT(*) as total,
      SUM(escalated) as escalated
    FROM gsi_qa_log WHERE guild_id = ?
    GROUP BY course_id
    ORDER BY total DESC
  `).all(guildId) as Array<{ course_id: string; total: number; escalated: number }>;

  const total = totals?.total ?? 0;
  const botAnswered = totals?.bot_answered ?? 0;

  return {
    totalQuestions: total,
    botAnswered,
    escalated: totals?.escalated ?? 0,
    deflectionRate: total > 0 ? botAnswered / total : 0,
    last7Days: last7?.cnt ?? 0,
    byCourse: byCourse.map(r => ({
      courseId: r.course_id,
      total: r.total,
      escalated: r.escalated,
      deflection: r.total > 0 ? (r.total - r.escalated) / r.total : 0,
    })),
  };
}

// ── Persistent Escalation Store ───────────────────────────────────────────────

/** TTL for escalations: 24 hours */
const ESCALATION_TTL_MS = 24 * 60 * 60 * 1000;

export function persistEscalation(escalation: PendingEscalation): void {
  try {
    const db = getRawDb();
    db.prepare(`
      INSERT OR REPLACE INTO gsi_escalations
        (id, ta_user_id, channel_id, guild_id, question, asked_by, course_name, draft_answer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      escalation.id,
      escalation.taUserId,
      escalation.channelId,
      escalation.guildId,
      escalation.question,
      escalation.askedBy,
      escalation.courseName,
      escalation.draftAnswer,
      escalation.createdAt,
    );
  } catch (err) {
    log().warn(`[gsi-store] Failed to persist escalation: ${err}`);
  }
}

export function resolvePersistedEscalationById(id: string): PendingEscalation | null {
  try {
    const db = getRawDb();
    const cutoff = Date.now() - ESCALATION_TTL_MS;
    const row = db.prepare(`
      SELECT * FROM gsi_escalations
      WHERE id = ? AND resolved = 0 AND created_at > ?
    `).get(id, cutoff) as RawEscalationRow | null;

    if (!row) return null;

    db.prepare(`UPDATE gsi_escalations SET resolved = 1, resolved_at = datetime('now') WHERE id = ?`).run(id);
    return rowToEscalation(row);
  } catch (err) {
    log().warn(`[gsi-store] resolveEscalationById error: ${err}`);
    return null;
  }
}

export function resolvePersistedEscalationForTA(taUserId: string): PendingEscalation | null {
  try {
    const db = getRawDb();
    const cutoff = Date.now() - ESCALATION_TTL_MS;
    const row = db.prepare(`
      SELECT * FROM gsi_escalations
      WHERE ta_user_id = ? AND resolved = 0 AND created_at > ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(taUserId, cutoff) as RawEscalationRow | null;

    if (!row) return null;

    db.prepare(`UPDATE gsi_escalations SET resolved = 1, resolved_at = datetime('now') WHERE id = ?`).run(row.id);
    return rowToEscalation(row);
  } catch (err) {
    log().warn(`[gsi-store] resolveEscalationForTA error: ${err}`);
    return null;
  }
}

export function getPersistentPendingTAIds(): Set<string> {
  try {
    const db = getRawDb();
    const cutoff = Date.now() - ESCALATION_TTL_MS;
    const rows = db.prepare(`
      SELECT DISTINCT ta_user_id FROM gsi_escalations
      WHERE resolved = 0 AND created_at > ?
    `).all(cutoff) as Array<{ ta_user_id: string }>;
    return new Set(rows.map(r => r.ta_user_id));
  } catch {
    return new Set();
  }
}

export function getPersistentPendingCount(): number {
  try {
    const db = getRawDb();
    const cutoff = Date.now() - ESCALATION_TTL_MS;
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM gsi_escalations WHERE resolved = 0 AND created_at > ?
    `).get(cutoff) as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

export function getPersistentPendingSummary(): Array<{ taUserId: string; count: number; oldest: number }> {
  try {
    const db = getRawDb();
    const cutoff = Date.now() - ESCALATION_TTL_MS;
    const rows = db.prepare(`
      SELECT ta_user_id, COUNT(*) as cnt, MIN(created_at) as oldest
      FROM gsi_escalations
      WHERE resolved = 0 AND created_at > ?
      GROUP BY ta_user_id
    `).all(cutoff) as Array<{ ta_user_id: string; cnt: number; oldest: number }>;
    return rows.map(r => ({ taUserId: r.ta_user_id, count: r.cnt, oldest: r.oldest }));
  } catch {
    return [];
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface RawEscalationRow {
  id: string;
  ta_user_id: string;
  channel_id: string;
  guild_id: string;
  question: string;
  asked_by: string;
  course_name: string;
  draft_answer: string;
  created_at: number;
}

function rowToEscalation(row: RawEscalationRow): PendingEscalation {
  return {
    id: row.id,
    taUserId: row.ta_user_id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    question: row.question,
    askedBy: row.asked_by,
    courseName: row.course_name,
    draftAnswer: row.draft_answer,
    createdAt: row.created_at,
  };
}
