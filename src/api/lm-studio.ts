/**
 * LM Studio health-check API handler.
 *
 * Exposes the full LM Studio model diagnostic over HTTP so that paw-hub,
 * Nexus, and CI pipelines can call it without importing lobs-core TypeScript.
 *
 * Routes:
 *   GET  /api/lm-studio           — full diagnostic (models, mismatches, latency)
 *   GET  /api/lm-studio/models    — loaded models list only (lightweight)
 *   GET  /api/lm-studio/latency   — API round-trip latency probe only
 *
 * Designed to be called before spawn_agent when local models are involved.
 * Always responds 200 — use the `ok` field to determine health status.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  runLmStudioDiagnostic,
  fetchLoadedModels,
  type LmStudioDiagnosticReport,
} from "../diagnostics/lmstudio.js";
import { getModelConfig } from "../config/models.js";
import { json, error, parseQuery } from "./index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LmStudioHealthResponse {
  /** true if LM Studio is reachable and all configured local models are loaded */
  ok: boolean;
  /** HTTP status category for dashboards */
  status: "healthy" | "degraded" | "unreachable";
  reachable: boolean;
  loadedModels: string[];
  configuredLocalModels: { id: string; location: string }[];
  mismatches: {
    configId: string;
    location: string;
    suggestion?: string;
  }[];
  /** API round-trip latency in milliseconds (null if unreachable) */
  latencyMs: number | null;
  warnings: string[];
  checkedAt: string;
}

export interface LmStudioModelsResponse {
  ok: boolean;
  reachable: boolean;
  loadedModels: string[];
  latencyMs: number | null;
  checkedAt: string;
}

export interface LmStudioLatencyResponse {
  ok: boolean;
  reachable: boolean;
  latencyMs: number | null;
  baseUrl: string;
  checkedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Measure the round-trip latency to LM Studio /v1/models in milliseconds.
 * Returns null if the request fails or times out.
 */
async function measureLatency(baseUrl: string, timeoutMs: number): Promise<number | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    await res.json(); // read full body to capture actual round-trip
    return Math.round(performance.now() - start);
  } catch {
    return null;
  }
}

/**
 * Derive a status label from the diagnostic report.
 */
function deriveStatus(report: LmStudioDiagnosticReport): "healthy" | "degraded" | "unreachable" {
  if (!report.reachable) return "unreachable";
  if (!report.ok) return "degraded";
  return "healthy";
}

// ── Sub-handlers ──────────────────────────────────────────────────────────────

/**
 * GET /api/lm-studio
 *
 * Full diagnostic: reachability, loaded models, config mismatches, latency.
 * Query params:
 *   timeout  — per-request timeout in ms (default 4000, max 10000)
 *   baseUrl  — override LM Studio URL
 */
async function handleFullDiagnostic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = parseQuery(req.url ?? "");
  const cfg = getModelConfig();

  const rawTimeout = parseInt(query.timeout ?? "4000", 10);
  const timeoutMs = Math.min(isNaN(rawTimeout) ? 4000 : rawTimeout, 10_000);
  const baseUrl = query.baseUrl ?? cfg.local.baseUrl;

  // Run diagnostic and measure latency in parallel
  const [report, latencyMs] = await Promise.all([
    runLmStudioDiagnostic({ baseUrl, timeoutMs }),
    measureLatency(baseUrl, timeoutMs),
  ]);

  const response: LmStudioHealthResponse = {
    ok: report.ok,
    status: deriveStatus(report),
    reachable: report.reachable,
    loadedModels: report.loadedModels,
    configuredLocalModels: report.configuredLocalModels,
    mismatches: report.mismatches.map(m => ({
      configId: m.configId,
      location: m.location,
      ...(m.suggestion && { suggestion: m.suggestion }),
    })),
    latencyMs,
    warnings: report.warnings,
    checkedAt: report.checkedAt.toISOString(),
  };

  json(res, response);
}

/**
 * GET /api/lm-studio/models
 *
 * Lightweight: returns the loaded models list and latency only.
 * No config comparison — useful for polling and dashboards.
 */
async function handleModelsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = parseQuery(req.url ?? "");
  const cfg = getModelConfig();

  const rawTimeout = parseInt(query.timeout ?? "3000", 10);
  const timeoutMs = Math.min(isNaN(rawTimeout) ? 3000 : rawTimeout, 10_000);
  const baseUrl = query.baseUrl ?? cfg.local.baseUrl;

  const start = performance.now();
  const loaded = await fetchLoadedModels(baseUrl, timeoutMs);
  const latencyMs = loaded !== null ? Math.round(performance.now() - start) : null;

  const response: LmStudioModelsResponse = {
    ok: loaded !== null,
    reachable: loaded !== null,
    loadedModels: loaded?.map(m => m.id) ?? [],
    latencyMs,
    checkedAt: new Date().toISOString(),
  };

  json(res, response);
}

/**
 * GET /api/lm-studio/latency
 *
 * Minimal probe: just measures API round-trip latency.
 * Zero model comparison logic — fastest possible check.
 */
async function handleLatencyProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = parseQuery(req.url ?? "");
  const cfg = getModelConfig();

  const rawTimeout = parseInt(query.timeout ?? "2500", 10);
  const timeoutMs = Math.min(isNaN(rawTimeout) ? 2500 : rawTimeout, 10_000);
  const baseUrl = query.baseUrl ?? cfg.local.baseUrl;

  const latencyMs = await measureLatency(baseUrl, timeoutMs);

  const response: LmStudioLatencyResponse = {
    ok: latencyMs !== null,
    reachable: latencyMs !== null,
    latencyMs,
    baseUrl,
    checkedAt: new Date().toISOString(),
  };

  json(res, response);
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * Route handler for all /api/lm-studio/* requests.
 *
 * @param _req     Incoming HTTP request
 * @param res      Outgoing HTTP response
 * @param subPath  Path segments after "lm-studio" (e.g. ["models"] or [])
 */
export async function handleLmStudioRequest(
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string[],
): Promise<void> {
  if (req.method !== "GET") {
    error(res, "Method not allowed — use GET", 405);
    return;
  }

  const sub = subPath[0] ?? "";

  switch (sub) {
    case "":
    case "health":
      await handleFullDiagnostic(req, res);
      break;
    case "models":
      await handleModelsList(req, res);
      break;
    case "latency":
      await handleLatencyProbe(req, res);
      break;
    default:
      error(res, `Unknown lm-studio sub-resource: ${sub}`, 404);
  }
}
