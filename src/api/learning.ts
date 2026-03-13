/**
 * Learning API — stats, learnings management, extraction triggers, kill switch.
 *
 * Routes:
 *   GET  /api/learning/stats?agent=programmer&lookback_days=30
 *        — agent=all returns aggregated cross-agent stats
 *   GET  /api/learning/learnings?agent=programmer&active=true
 *   POST /api/learning/extract      — trigger extraction pass over all feedback
 *   PATCH /api/learning/learnings/:id/deactivate — soft delete a learning
 *   GET  /api/learning/kill-switch  — get kill switch status
 *   POST /api/learning/kill-switch  — toggle kill switch { enabled: boolean }
 *
 * Human feedback is submitted via PATCH /api/tasks/:id/feedback (see tasks.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { LearningService } from "../services/learning.js";
import { json, error, parseBody } from "./index.js";
import { getRawDb } from "../db/connection.js";
import { log } from "../util/logger.js";
import { randomUUID } from "node:crypto";

const svc = new LearningService();

export async function handleLearningRequest(
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string | undefined,
  parts: string[],
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";

  // ── Micro-learning Topics ──────────────────────────────────────────────

  // GET /api/learning/topics — list all topics
  if (subPath === "topics" && method === "GET") {
    const rawDb = getRawDb();
    const topics = rawDb.prepare(`SELECT * FROM learning_topics WHERE active = 1 ORDER BY created_at DESC`).all();
    return json(res, { topics });
  }

  // POST /api/learning/topics — create a new topic
  if (subPath === "topics" && method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.name) return error(res, "name is required", 400);
    
    const rawDb = getRawDb();
    const id = randomUUID().replace(/-/g, "");
    const now = new Date().toISOString();
    
    rawDb.prepare(
      `INSERT INTO learning_topics (id, name, description, active, created_at, updated_at) 
       VALUES (?, ?, ?, 1, ?, ?)`
    ).run(id, body.name, body.description ?? null, now, now);
    
    return json(res, { id, name: body.name, description: body.description }, 201);
  }

  // ── Micro-learning Cards ───────────────────────────────────────────────

  // GET /api/learning/cards/due — list cards due for review
  if (parts[1] === "cards" && parts[2] === "due" && method === "GET") {
    const rawDb = getRawDb();
    const now = new Date().toISOString();
    const cards = rawDb.prepare(
      `SELECT c.*, t.name as topic_name 
       FROM learning_cards c
       JOIN learning_topics t ON c.topic_id = t.id
       WHERE c.next_review_at IS NULL OR c.next_review_at <= ?
       ORDER BY c.next_review_at ASC
       LIMIT 20`
    ).all(now);
    return json(res, { cards });
  }

  // POST /api/learning/cards — create a new card
  if (subPath === "cards" && method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.topic_id || !body.question || !body.answer) {
      return error(res, "topic_id, question, and answer are required", 400);
    }
    
    const rawDb = getRawDb();
    const id = randomUUID().replace(/-/g, "");
    const now = new Date().toISOString();
    
    rawDb.prepare(
      `INSERT INTO learning_cards (id, topic_id, question, answer, explanation, difficulty, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      body.topic_id,
      body.question,
      body.answer,
      body.explanation ?? null,
      body.difficulty ?? "medium",
      now,
      now
    );
    
    // Update card count on topic
    rawDb.prepare(
      `UPDATE learning_topics SET card_count = (SELECT COUNT(*) FROM learning_cards WHERE topic_id = ?) WHERE id = ?`
    ).run(body.topic_id, body.topic_id);
    
    return json(res, { id, topic_id: body.topic_id, question: body.question }, 201);
  }

  // POST /api/learning/cards/:id/review — record a review
  if (parts[1] === "cards" && parts[3] === "review" && method === "POST") {
    const cardId = parts[2];
    if (!cardId) return error(res, "card id required", 400);
    
    const body = await parseBody(req) as Record<string, unknown>;
    const grade = typeof body.grade === "number" ? body.grade : 3; // 0-5 scale, default medium
    
    const rawDb = getRawDb();
    const card = rawDb.prepare(`SELECT * FROM learning_cards WHERE id = ?`).get(cardId) as any;
    if (!card) return error(res, "Card not found", 404);
    
    // Simple SM-2 algorithm
    let interval = card.interval ?? 1;
    let easeFactor = card.ease_factor ?? 2.5;
    let repetitions = card.repetitions ?? 0;
    
    if (grade >= 3) {
      // Correct answer
      if (repetitions === 0) {
        interval = 1;
      } else if (repetitions === 1) {
        interval = 6;
      } else {
        interval = Math.round(interval * easeFactor);
      }
      repetitions += 1;
    } else {
      // Incorrect answer - reset
      repetitions = 0;
      interval = 1;
    }
    
    // Update ease factor
    easeFactor = Math.max(1.3, easeFactor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)));
    
    const nextReview = new Date();
    nextReview.setDate(nextReview.getDate() + interval);
    const now = new Date().toISOString();
    
    rawDb.prepare(
      `UPDATE learning_cards 
       SET interval = ?, ease_factor = ?, repetitions = ?, 
           next_review_at = ?, last_reviewed_at = ?, last_grade = ?, updated_at = ?
       WHERE id = ?`
    ).run(interval, easeFactor, repetitions, nextReview.toISOString(), now, grade, now, cardId);
    
    return json(res, { id: cardId, next_review_at: nextReview.toISOString(), interval });
  }

  // ── Learning System Stats & Management ─────────────────────────────────

  // GET /api/learning/stats?agent=programmer&lookback_days=30
  // GET /api/learning/stats?agent=all — aggregated cross-agent stats
  if (subPath === "stats" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const agentType = url.searchParams.get("agent") ?? "programmer";
    const lookbackDays = parseInt(url.searchParams.get("lookback_days") ?? "30", 10);

    if (agentType === "all") {
      return json(res, svc.getAllStats(lookbackDays));
    }
    return json(res, svc.getStats(agentType, lookbackDays));
  }

  // GET /api/learning/learnings
  if (subPath === "learnings" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const agentType = url.searchParams.get("agent") ?? undefined;
    const activeOnly = url.searchParams.get("active") !== "false";

    let learnings = svc.listLearnings(agentType);
    if (activeOnly) {
      learnings = learnings.filter(l => l.isActive);
    }
    return json(res, learnings);
  }

  // PATCH /api/learning/learnings/:id/deactivate
  if (parts[1] === "learnings" && parts[3] === "deactivate" && method === "PATCH") {
    const id = parts[2];
    if (!id) return error(res, "Missing learning id", 400);
    svc.deactivateLearning(id);
    return json(res, { ok: true });
  }

  // POST /api/learning/extract
  if (subPath === "extract" && method === "POST") {
    const count = svc.runExtractionPass();
    return json(res, { ok: true, extracted: count });
  }

  // GET /api/learning/outcomes?agent=programmer&limit=20
  if (subPath === "outcomes" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const agentType = url.searchParams.get("agent") ?? "programmer";
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const summary = svc.getOutcomesSummary(agentType, limit);
    return json(res, summary);
  }

  // GET /api/learning/kill-switch — current kill switch state
  if (subPath === "kill-switch" && method === "GET") {
    const rawDb = getRawDb();
    const enabledRow = rawDb.prepare(
      `SELECT value FROM orchestrator_settings WHERE key = 'LEARNING_INJECTION_ENABLED' LIMIT 1`
    ).get() as { value: string } | undefined;
    const confRow = rawDb.prepare(
      `SELECT value FROM orchestrator_settings WHERE key = 'LEARNING_MIN_CONFIDENCE' LIMIT 1`
    ).get() as { value: string } | undefined;

    const envOverride = process.env.LEARNING_INJECTION_ENABLED;
    return json(res, {
      enabled: enabledRow ? (enabledRow.value.toLowerCase() !== "false" && enabledRow.value !== "0") : true,
      dbValue: enabledRow?.value ?? "true",
      envOverride: envOverride ?? null,
      minConfidence: confRow ? parseFloat(confRow.value) : 0.7,
    });
  }

  // POST /api/learning/kill-switch — toggle kill switch
  // Body: { enabled: boolean } or { minConfidence: number }
  if (subPath === "kill-switch" && method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    const rawDb = getRawDb();
    const now = new Date().toISOString();

    if (body.enabled !== undefined) {
      const value = body.enabled ? "true" : "false";
      rawDb.prepare(
        `INSERT OR REPLACE INTO orchestrator_settings (key, value, updated_at) VALUES ('LEARNING_INJECTION_ENABLED', ?, ?)`
      ).run(value, now);
      log().info(`[LEARNING] Kill switch updated: LEARNING_INJECTION_ENABLED=${value}`);
    }

    if (body.minConfidence !== undefined) {
      const value = String(body.minConfidence);
      rawDb.prepare(
        `INSERT OR REPLACE INTO orchestrator_settings (key, value, updated_at) VALUES ('LEARNING_MIN_CONFIDENCE', ?, ?)`
      ).run(value, now);
      log().info(`[LEARNING] Confidence threshold updated: LEARNING_MIN_CONFIDENCE=${value}`);
    }

    return json(res, { ok: true });
  }

  return error(res, `Unknown learning resource: ${subPath}`, 404);
}
