/**
 * Training Pipeline API — harvest, review, export training data for fine-tuning.
 *
 * GET  /api/training-pipeline                      → pipeline stats
 * POST /api/training-pipeline/harvest               → trigger harvest run
 * GET  /api/training-pipeline/samples               → list samples for review
 * POST /api/training-pipeline/samples/:id/approve   → approve sample
 * POST /api/training-pipeline/samples/:id/reject    → reject sample
 * POST /api/training-pipeline/samples/:id/correct   → correct sample
 * POST /api/training-pipeline/bulk-approve           → auto-approve above quality threshold
 * GET  /api/training-pipeline/export                 → JSONL export preview
 * GET  /api/training-pipeline/export/download        → download .jsonl file
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody, parseQuery } from "./index.js";
import {
  runHarvest,
  getHarvestStats,
  getSamplesForReview,
  reviewSample,
  bulkApprove,
  exportTrainingJSONL,
} from "../services/training-harvester.js";
import { log } from "../util/logger.js";

export async function handleTrainingPipelineRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  parts?: string[],
): Promise<void> {
  const allParts = parts ?? [];
  const method = req.method ?? "GET";
  const query = parseQuery(req.url ?? "");

  // POST /api/training-pipeline/harvest
  if (sub === "harvest" && method === "POST") {
    try {
      const results = await runHarvest();
      const total = results.reduce((sum, r) => sum + r.extracted, 0);
      return json(res, { ok: true, results, totalExtracted: total });
    } catch (err) {
      log().error(`[training-pipeline] Harvest error: ${err}`);
      return error(res, "Harvest failed", 500);
    }
  }

  // GET /api/training-pipeline/samples
  if (sub === "samples" && method === "GET") {
    try {
      const status = (query.status as string) ?? "pending";
      const taskType = query.taskType as string | undefined;
      const limit = parseInt(query.limit as string) || 20;
      const offset = parseInt(query.offset as string) || 0;

      const samples = getSamplesForReview({ status, taskType, limit, offset });
      const parsed = samples.map((s: any) => ({
        ...s,
        conversation: safeParseJson(s.conversation, []),
        quality_flags: safeParseJson(s.quality_flags, []),
        metadata: safeParseJson(s.metadata, {}),
        corrected_conversation: s.corrected_conversation ? safeParseJson(s.corrected_conversation, null) : null,
      }));

      return json(res, { samples: parsed, total: parsed.length });
    } catch (err) {
      log().error(`[training-pipeline] Samples error: ${err}`);
      return error(res, "Failed to get samples", 500);
    }
  }

  // POST /api/training-pipeline/samples/:id/approve|reject|correct
  // parts = ["training-pipeline", "samples", id, action]
  if (sub === "samples" && allParts.length >= 4 && method === "POST") {
    const sampleId = allParts[2];
    const action = allParts[3];

    if (!["approve", "reject", "correct"].includes(action)) {
      return error(res, "Invalid action. Must be: approve, reject, correct");
    }

    try {
      if (action === "correct") {
        const body = await parseBody(req) as { correctedConversation?: any[] };
        reviewSample(sampleId, "correct", body.correctedConversation);
      } else {
        reviewSample(sampleId, action as "approve" | "reject");
      }
      return json(res, { ok: true, id: sampleId, action });
    } catch (err) {
      log().error(`[training-pipeline] Review error: ${err}`);
      return error(res, "Review failed", 500);
    }
  }

  // POST /api/training-pipeline/bulk-approve
  if (sub === "bulk-approve" && method === "POST") {
    try {
      const body = await parseBody(req) as { minQuality?: number };
      const minQuality = body.minQuality ?? 0.6;
      const count = bulkApprove(minQuality);
      return json(res, { ok: true, approved: count, minQuality });
    } catch (err) {
      log().error(`[training-pipeline] Bulk approve error: ${err}`);
      return error(res, "Bulk approve failed", 500);
    }
  }

  // GET /api/training-pipeline/export/download
  if (sub === "export" && allParts[2] === "download" && method === "GET") {
    try {
      const taskType = query.taskType as string | undefined;
      const minQuality = parseFloat(query.minQuality as string) || 0.3;
      const jsonl = exportTrainingJSONL({ taskType, minQuality });
      const filename = `lobs-training-${taskType ?? "all"}-${new Date().toISOString().slice(0, 10)}.jsonl`;

      res.writeHead(200, {
        "Content-Type": "application/jsonl",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
      res.end(jsonl);
      return;
    } catch (err) {
      log().error(`[training-pipeline] Export download error: ${err}`);
      return error(res, "Export failed", 500);
    }
  }

  // GET /api/training-pipeline/export
  if (sub === "export" && method === "GET") {
    try {
      const taskType = query.taskType as string | undefined;
      const minQuality = parseFloat(query.minQuality as string) || 0.3;
      const jsonl = exportTrainingJSONL({ taskType, minQuality });
      const lineCount = jsonl.split("\n").filter(Boolean).length;

      return json(res, {
        format: "jsonl",
        lines: lineCount,
        preview: jsonl.split("\n").slice(0, 3).filter(Boolean),
        taskType: taskType ?? "all",
        minQuality,
      });
    } catch (err) {
      log().error(`[training-pipeline] Export error: ${err}`);
      return error(res, "Export failed", 500);
    }
  }

  // GET /api/training-pipeline → stats
  if (!sub && method === "GET") {
    try {
      const stats = getHarvestStats();
      return json(res, stats);
    } catch (err) {
      log().error(`[training-pipeline] Stats error: ${err}`);
      return error(res, "Failed to get stats", 500);
    }
  }

  return error(res, "Not found", 404);
}

function safeParseJson(val: string | null | undefined, fallback: any): any {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}
