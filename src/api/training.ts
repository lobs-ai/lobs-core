/**
 * Training Data API — review, correct, and export training examples.
 * 
 * GET  /api/training                    → stats overview
 * GET  /api/training/pending             → pending examples for review
 * GET  /api/training/examples?type=X     → examples by task type
 * GET  /api/training/export?type=X       → JSONL export for fine-tuning
 * POST /api/training/:id/approve         → approve example
 * POST /api/training/:id/correct         → submit correction
 * POST /api/training/:id/reject          → reject example
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody, parseQuery } from "./index.js";
import {
  getTrainingStats,
  getPendingExamples,
  getExamplesByType,
  exportAsJsonl,
  approveExample,
  correctExample,
  rejectExample,
  type TaskType,
} from "../services/training-data.js";

export async function handleTrainingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  sub?: string,
): Promise<void> {
  // POST /api/training/:id/approve
  if (id && sub === "approve" && req.method === "POST") {
    approveExample(id);
    return json(res, { ok: true });
  }

  // POST /api/training/:id/correct
  if (id && sub === "correct" && req.method === "POST") {
    const body = await parseBody(req) as { corrected_output?: string };
    if (!body.corrected_output?.trim()) return error(res, "corrected_output is required");
    correctExample(id, body.corrected_output);
    return json(res, { ok: true });
  }

  // POST /api/training/:id/reject
  if (id && sub === "reject" && req.method === "POST") {
    rejectExample(id);
    return json(res, { ok: true });
  }

  // GET /api/training/pending
  if (id === "pending" && req.method === "GET") {
    const examples = getPendingExamples();
    return json(res, { examples });
  }

  // GET /api/training/examples?type=braindump
  if (id === "examples" && req.method === "GET") {
    const query = parseQuery(req.url ?? "");
    const type = query.type as TaskType | undefined;
    if (!type) return error(res, "type query parameter required");
    const examples = getExamplesByType(type);
    return json(res, { examples });
  }

  // GET /api/training/export?type=braindump (optional type filter)
  if (id === "export" && req.method === "GET") {
    const query = parseQuery(req.url ?? "");
    const type = query.type as TaskType | undefined;
    const jsonl = exportAsJsonl(type);
    res.writeHead(200, {
      "Content-Type": "application/jsonl",
      "Content-Disposition": `attachment; filename="training-data${type ? `-${type}` : ""}.jsonl"`,
    });
    res.end(jsonl);
    return;
  }

  // GET /api/training → stats
  if (!id && req.method === "GET") {
    const stats = getTrainingStats();
    return json(res, { stats });
  }

  return error(res, "Not found", 404);
}
