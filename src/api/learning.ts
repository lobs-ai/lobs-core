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

const svc = new LearningService();

export async function handleLearningRequest(
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string | undefined,
  parts: string[],
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";

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
