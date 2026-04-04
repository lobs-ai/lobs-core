/**
 * langfuse.ts — Lightweight fire-and-forget Langfuse trace emitter for lobs-core.
 *
 * Uses the Langfuse HTTP ingestion API directly (no npm SDK) to avoid adding
 * a new dependency. All network calls are async and never block the critical path.
 *
 * Configuration (read from env or ~/.lobs/.env):
 *   LANGFUSE_HOST        http://localhost:3000
 *   LANGFUSE_PUBLIC_KEY  pk-lf-...
 *   LANGFUSE_SECRET_KEY  sk-lf-...
 *
 * Design notes:
 * - Fire-and-forget: all trace() calls return immediately; network errors are
 *   logged as warnings but never throw.
 * - Singleton LangfuseClient is created once and reused.
 * - Cost estimation uses hardcoded model pricing (updated periodically).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { log } from "../util/logger.js";
import { getModelCost } from "../config/models.js";

// ---------------------------------------------------------------------------
// Model pricing (cost per 1M tokens in USD)
// Extend as new models are onboarded.
// ---------------------------------------------------------------------------
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic Claude
  "anthropic/claude-opus-4-6": { input: 15.0, output: 75.0 },
  "anthropic/claude-opus-4": { input: 15.0, output: 75.0 },
  "anthropic/claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "anthropic/claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "anthropic/claude-sonnet-3-7": { input: 3.0, output: 15.0 },
  "anthropic/claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "anthropic/claude-haiku-3-5": { input: 0.8, output: 4.0 },
  "anthropic/claude-haiku-3": { input: 0.25, output: 1.25 },
  // OpenAI
  "openai/gpt-4o": { input: 2.5, output: 10.0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai/o1": { input: 15.0, output: 60.0 },
  "openai/o3-mini": { input: 1.1, output: 4.4 },
  // Google
  "google/gemini-2.0-flash": { input: 0.075, output: 0.3 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10.0 },
  // Local models (no cost)
  "lmstudio/": { input: 0, output: 0 },
  "ollama/": { input: 0, output: 0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  if (!model || (!inputTokens && !outputTokens)) return 0;
  // Try centralized config first
  const configRates = getModelCost(model);
  if (configRates) {
    return (inputTokens * configRates.input + outputTokens * configRates.output) / 1_000_000;
  }
  // Exact match in local fallback table
  const pricing = MODEL_PRICING[model];
  if (pricing) {
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }
  // Prefix match (for local models and model variants)
  for (const [prefix, price] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(prefix)) {
      return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Env loading (reads ~/.lobs/.env once at module load)
// ---------------------------------------------------------------------------
let _envLoaded = false;
function loadEnvOnce(): void {
  if (_envLoaded) return;
  _envLoaded = true;
  const envPath = `${process.env.HOME}/.lobs/.env`;
  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      const val = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env may not exist; that's fine
  }
}

// ---------------------------------------------------------------------------
// Langfuse HTTP client
// ---------------------------------------------------------------------------
interface LangfuseEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

interface TraceOpts {
  traceId: string;
  name: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  startTime?: string;
  input?: unknown;
  output?: unknown;
}

interface GenerationOpts {
  traceId: string;
  name?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  startTime?: string;
  endTime?: string;
  output?: string;
  level?: "DEFAULT" | "ERROR";
  metadata?: Record<string, unknown>;
}

function makeBasicAuth(publicKey: string, secretKey: string): string {
  return Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
}

async function sendBatch(
  host: string,
  auth: string,
  events: LangfuseEvent[],
): Promise<void> {
  try {
    const resp = await fetch(`${host}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ batch: events }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log().warn(`[Langfuse] Ingestion HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    log().warn(`[Langfuse] Ingestion failed (fire-and-forget): ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit a worker-run trace to Langfuse (fire-and-forget).
 *
 * Cost is estimated from hardcoded model pricing if total_cost_usd is 0.
 * Never throws; network errors are logged as warnings.
 */
export function emitWorkerRunTrace(opts: {
  workerRunId: number | string;
  taskId?: string | null;
  taskTitle?: string;
  agentType?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  durationSeconds?: number;
  succeeded: boolean;
  summary?: string;
  modelTier?: string;
  promptVariant?: string;
  startedAt?: string;
  endedAt?: string;
}): void {
  // Fire-and-forget: intentionally not await-ed
  _emitWorkerRunTrace(opts).catch((e) => {
    log().warn(`[Langfuse] emitWorkerRunTrace error: ${e}`);
  });
}

async function _emitWorkerRunTrace(opts: {
  workerRunId: number | string;
  taskId?: string | null;
  taskTitle?: string;
  agentType?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  durationSeconds?: number;
  succeeded: boolean;
  summary?: string;
  modelTier?: string;
  promptVariant?: string;
  startedAt?: string;
  endedAt?: string;
}): Promise<void> {
  loadEnvOnce();
  const host = process.env.LANGFUSE_HOST ?? "http://localhost:3000";
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
  const secretKey = process.env.LANGFUSE_SECRET_KEY ?? "";
  if (!publicKey || !secretKey) {
    log().debug?.("[Langfuse] Credentials not set — skipping trace");
    return;
  }

  const auth = makeBasicAuth(publicKey, secretKey);
  const now = new Date().toISOString();

  const taskId = opts.taskId ?? `unknown-${opts.workerRunId}`;
  const taskTitle = opts.taskTitle ?? taskId;
  const agentType = opts.agentType ?? "unknown";
  const model = opts.model ?? "unknown";
  const inputTokens = opts.inputTokens ?? 0;
  const outputTokens = opts.outputTokens ?? 0;
  const durationSeconds = opts.durationSeconds ?? 0;

  // Use provided cost if non-zero, otherwise estimate from model pricing
  const estimatedCost = opts.totalCostUsd && opts.totalCostUsd > 0
    ? opts.totalCostUsd
    : estimateCost(model, inputTokens, outputTokens);

  const traceId = `paw-run-${opts.workerRunId}`;

  const events: LangfuseEvent[] = [
    {
      id: randomUUID(),
      type: "trace-create",
      timestamp: now,
      body: {
        id: traceId,
        name: taskTitle,
        userId: agentType,
        sessionId: taskId,
        metadata: {
          worker_run_id: opts.workerRunId,
          task_id: taskId,
          agent_type: agentType,
          model_tier: opts.modelTier,
          prompt_variant: opts.promptVariant,
          succeeded: opts.succeeded,
          duration_seconds: durationSeconds,
          cost_usd: estimatedCost,
        },
        tags: [agentType, "paw", opts.succeeded ? "succeeded" : "failed"],
        timestamp: opts.startedAt ?? now,
        input: { task_id: taskId, agent: agentType },
        output: { succeeded: opts.succeeded, summary: opts.summary ?? "" },
      },
    },
    {
      id: randomUUID(),
      type: "generation-create",
      timestamp: now,
      body: {
        traceId,
        name: "agent_run",
        model,
        usage: {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
          unit: "TOKENS",
          totalCost: estimatedCost,
        },
        metadata: {
          cost_usd: estimatedCost,
          duration_seconds: durationSeconds,
          prompt_variant: opts.promptVariant,
        },
        startTime: opts.startedAt ?? now,
        endTime: opts.endedAt ?? now,
        output: opts.summary ?? "",
        level: opts.succeeded ? "DEFAULT" : "ERROR",
      },
    },
  ];

  await sendBatch(host, auth, events);
  log().info(
    `[Langfuse] Emitted trace ${traceId} task=${taskTitle.slice(0, 60)} model=${model} ` +
    `tokens=${inputTokens}/${outputTokens} cost=$${estimatedCost.toFixed(4)} succeeded=${opts.succeeded}`,
  );
}
