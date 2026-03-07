/**
 * Learning API — stats, learnings management, and extraction triggers.
 *
 * Routes:
 *   GET  /api/learning/stats?agent=programmer&lookback_days=30
 *   GET  /api/learning/learnings?agent=programmer&active=true
 *   POST /api/learning/extract      — trigger extraction pass over all feedback
 *   PATCH /api/learning/learnings/:id/deactivate — soft delete a learning
 *
 * Human feedback is submitted via PATCH /api/tasks/:id/feedback (see tasks.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { LearningService } from "../services/learning.js";
import { json, error, parseBody } from "./index.js";

const svc = new LearningService();

export async function handleLearningRequest(
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string | undefined,
  parts: string[],
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";

  // GET /api/learning/stats
  if (subPath === "stats" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const agentType = url.searchParams.get("agent") ?? "programmer";
    const lookbackDays = parseInt(url.searchParams.get("lookback_days") ?? "30", 10);

    const stats = svc.getStats(agentType, lookbackDays);
    return json(res, stats);
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

  return error(res, `Unknown learning resource: ${subPath}`, 404);
}
