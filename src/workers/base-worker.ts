/**
 * BaseWorker — abstract foundation for all local model workers.
 *
 * Each worker is a self-contained unit that:
 * 1. Runs on a schedule (cron) or responds to events
 * 2. Uses the local Qwen 3.5 9B model via LM Studio
 * 3. Logs results to the worker_logs DB table
 * 4. Surfaces alerts/artifacts through the result system
 *
 * Workers are designed for tasks where "good enough" intelligence is fine —
 * summarization, classification, monitoring, draft generation.
 * They run for free on local hardware.
 */

import { log } from "../util/logger.js";
import { getLocalConfig } from "../config/models.js";
import { isLocalModelAvailable } from "../runner/local-classifier.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface WorkerConfig {
  id: string;
  name: string;
  description: string;
  schedule?: string;          // Cron expression (for scheduled workers)
  enabled: boolean;
  model?: string;             // Override default local model
  maxTokens?: number;         // Per-call token limit
  timeoutMs?: number;         // Per-call timeout
  maxConcurrency?: number;    // Max simultaneous LLM calls (default 1)
}

export interface WorkerContext {
  /** Timestamp when this run started */
  startedAt: Date;
  /** The model to use for this run */
  model: string;
  /** Base URL of the local model API */
  baseUrl: string;
  /** Optional trigger event that caused this run */
  triggerEvent?: WorkerEvent;
}

export interface WorkerEvent {
  type: string;               // e.g. "task.created", "git.push", "inbox.new"
  payload: Record<string, unknown>;
  timestamp: Date;
}

export interface WorkerArtifact {
  type: "file" | "memory" | "db_record" | "draft" | "alert";
  path?: string;              // File path for file artifacts
  content: string;            // The actual content
  metadata?: Record<string, unknown>;
}

export interface WorkerAlert {
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  actionRequired: boolean;
}

export interface WorkerResult {
  success: boolean;
  artifacts: WorkerArtifact[];
  alerts: WorkerAlert[];
  tokensUsed: number;
  durationMs: number;
  error?: string;
  summary?: string;           // Brief human-readable summary of what happened
}

// ── Local Model Caller ───────────────────────────────────────────────────

const MAX_INPUT_CHARS = 16_000; // Workers can handle bigger prompts than classifier

export interface LocalCallOptions {
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  systemPrompt?: string;
}

/**
 * Call the local LM Studio model. This is the shared primitive all workers use.
 * Separate from local-classifier.ts so workers can use longer contexts and
 * system prompts.
 */
export async function callLocalModel(
  prompt: string,
  options?: LocalCallOptions,
): Promise<{ text: string; tokensUsed: number }> {
  const localCfg = getLocalConfig();
  // Strip lmstudio/ prefix — LM Studio API expects the bare model ID
  const rawModel = options?.model ?? localCfg.chatModel;
  const model = rawModel.replace(/^lmstudio\//, "");
  const baseUrl = options?.baseUrl ?? localCfg.baseUrl;
  const maxTokens = options?.maxTokens ?? 1024;
  const temperature = options?.temperature ?? 0.2;
  const timeoutMs = options?.timeoutMs ?? 30_000;

  const truncatedPrompt = prompt.length > MAX_INPUT_CHARS
    ? prompt.slice(0, MAX_INPUT_CHARS) + "\n... [truncated]"
    : prompt;

  const messages: Array<{ role: string; content: string }> = [];
  if (options?.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: truncatedPrompt });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LM Studio returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    };

    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    const tokensUsed = data.usage?.total_tokens ?? 0;

    return { text, tokensUsed };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Local model timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call local model and parse JSON response.
 * Strips markdown code fences and attempts JSON.parse.
 */
export async function callLocalModelJSON<T>(
  prompt: string,
  options?: LocalCallOptions,
): Promise<{ data: T; tokensUsed: number }> {
  const { text, tokensUsed } = await callLocalModel(prompt, options);

  // Strip markdown fences
  let cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();

  // Strip thinking tokens (e.g. <thinking>...</thinking>, <think>...</think>)
  cleaned = cleaned.replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>/gi, "").trim();

  // Try to extract the last complete JSON object or array from the text.
  // This handles models that prefix "Thinking Process: ..." or other preamble
  // where the JSON schema might appear inside the reasoning text.
  const data = extractLastJSON<T>(cleaned);
  if (data !== undefined) return { data, tokensUsed };

  // Fallback: try parsing the whole thing
  return { data: JSON.parse(cleaned) as T, tokensUsed };
}

/**
 * Extract the last valid top-level JSON object or array from a string.
 * Scans backwards to find the final `}` or `]`, then finds its matching
 * opener using bracket counting. This skips JSON fragments that appear
 * inside thinking/reasoning preamble.
 */
function extractLastJSON<T>(text: string): T | undefined {
  // Find the last } or ]
  for (let end = text.length - 1; end >= 0; end--) {
    const ch = text[end];
    if (ch !== "}" && ch !== "]") continue;

    const open = ch === "}" ? "{" : "[";
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = end; i >= 0; i--) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === "\\" && inString) { escape = true; continue; }
      if (c === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (c === ch) depth++;
      if (c === open) depth--;
      if (depth === 0) {
        const candidate = text.slice(i, end + 1);
        try {
          return JSON.parse(candidate) as T;
        } catch {
          break; // This bracket pair wasn't valid JSON, try earlier
        }
      }
    }
  }
  return undefined;
}

// ── Abstract Base ────────────────────────────────────────────────────────

export abstract class BaseWorker {
  abstract readonly config: WorkerConfig;

  /** Run the worker's main logic. Implemented by each worker. */
  abstract execute(ctx: WorkerContext): Promise<WorkerResult>;

  /** Optional: handle an event trigger */
  async onEvent(_event: WorkerEvent): Promise<WorkerResult | null> {
    return null;
  }

  /**
   * Run the worker with all the safety wrappers:
   * - Check model availability
   * - Measure duration
   * - Catch errors
   * - Return structured result
   */
  async run(triggerEvent?: WorkerEvent): Promise<WorkerResult> {
    const startedAt = new Date();
    const localCfg = getLocalConfig();

    // Pre-flight: is the local model available?
    const available = await isLocalModelAvailable();
    if (!available) {
      return {
        success: false,
        artifacts: [],
        alerts: [{
          severity: "warning",
          title: `${this.config.name}: Local model unavailable`,
          message: "LM Studio is not running or not responding. Worker skipped.",
          actionRequired: false,
        }],
        tokensUsed: 0,
        durationMs: 0,
        error: "Local model unavailable",
      };
    }

    const ctx: WorkerContext = {
      startedAt,
      model: this.config.model ?? localCfg.chatModel,
      baseUrl: localCfg.baseUrl,
      triggerEvent,
    };

    try {
      const result = triggerEvent
        ? (await this.onEvent(triggerEvent)) ?? await this.execute(ctx)
        : await this.execute(ctx);

      result.durationMs = Date.now() - startedAt.getTime();
      return result;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log().error(`[worker:${this.config.id}] Failed: ${errorMsg}`);

      return {
        success: false,
        artifacts: [],
        alerts: [{
          severity: "warning",
          title: `${this.config.name}: Execution failed`,
          message: errorMsg,
          actionRequired: false,
        }],
        tokensUsed: 0,
        durationMs: Date.now() - startedAt.getTime(),
        error: errorMsg,
      };
    }
  }
}
