/**
 * Multi-provider LLM client — routes to Anthropic (native) or OpenAI-compatible APIs.
 *
 * Supports:
 * - Anthropic (native API, OAuth + API key)
 * - OpenAI (openai-compatible)
 * - LM Studio (openai-compatible, local)
 * - OpenRouter (openai-compatible)
 * - Any OpenAI-compatible endpoint
 *
 * Model string format: "provider/model-id" or just "model-id" (defaults to anthropic)
 * Examples:
 *   "anthropic/claude-sonnet-4-20250514"
 *   "openai/gpt-4o"
 *   "lmstudio/qwen3.5-9b"
 *   "openrouter/anthropic/claude-sonnet-4"
 *   "claude-sonnet-4-20250514"  (auto-detected as anthropic)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ToolDefinition, TokenUsage } from "./types.js";
import type { TaskCategory } from "../services/model-router.js";
import { getKeyPool } from "../services/key-pool.js";
import { getCodexAuth } from "../services/codex-auth.js";
import { randomUUID } from "node:crypto";
import {
  fromClaudeCodeToolName,
  toClaudeCodeToolName,
} from "../claude-runtime/tool-contracts.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "openai-codex" | "lmstudio" | "openrouter" | "openai-compatible" | "opencode-zen" | "opencode-go" | "z-ai" | "minimax" | "kimi";

export interface ProviderConfig {
  provider: Provider;
  modelId: string;       // The model ID to send to the API
  baseUrl?: string;      // Override base URL
  apiKey?: string;       // Override API key
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

export interface LLMResponse {
  content: Array<{
    type: "text";
    text: string;
  } | {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop";
  usage: TokenUsage;
  thinkingContent?: string;
}

export interface LLMClient {
  createMessage(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    thinking?: {
      type: "enabled";
      budgetTokens: number;
    } | {
      type: "adaptive";
    };
  }): Promise<LLMResponse>;
}

// ── Provider Resolution ──────────────────────────────────────────────────────

/**
 * Parse a model string into provider + model ID.
 * "anthropic/claude-sonnet-4" → { provider: "anthropic", modelId: "claude-sonnet-4" }
 * "lmstudio/qwen3.5-9b" → { provider: "lmstudio", modelId: "qwen3.5-9b" }
 * "claude-sonnet-4" → { provider: "anthropic", modelId: "claude-sonnet-4" }
 */
export function parseModelString(model: string): ProviderConfig {
  const parts = model.split("/");

  if (parts.length >= 2) {
    const providerHint = parts[0].toLowerCase();

    if (providerHint === "anthropic") {
      return { provider: "anthropic", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "openai") {
      return { provider: "openai", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "openai-codex") {
      return { provider: "openai-codex", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "lmstudio" || providerHint === "local") {
      return { provider: "lmstudio", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "openrouter") {
      return { provider: "openrouter", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "opencode-zen") {
      return { provider: "opencode-zen", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "opencode-go") {
      return { provider: "opencode-go", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "z-ai") {
      return { provider: "z-ai", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "minimax") {
      return { provider: "minimax", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "kimi") {
      return { provider: "kimi", modelId: parts.slice(1).join("/") };
    }
    // Unknown provider prefix — treat as openai-compatible
    return { provider: "openai-compatible", modelId: model, baseUrl: undefined };
  }

  // No provider prefix — auto-detect from model name
  if (model.startsWith("claude-") || model.startsWith("claude_")) {
    return { provider: "anthropic", modelId: model };
  }
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) {
    return { provider: "openai", modelId: model };
  }
  if (model.startsWith("qwen") || model.startsWith("llama") || model.startsWith("mistral") || model.startsWith("phi")) {
    return { provider: "lmstudio", modelId: model };
  }

  // Default to anthropic
  return { provider: "anthropic", modelId: model };
}

// ── Claude Code Tool Name Mapping ────────────────────────────────────────────
// OAuth/setup-token requests must use Claude Code's canonical tool names.
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md

const claudeCodeVersion = "2.1.75";

/** Map a tool name to Claude Code canonical casing (case-insensitive match). */
const toClaudeCodeName = (name: string): string => {
  const lower = name.toLowerCase();
  const mapped = toClaudeCodeToolName(lower);
  return mapped === lower ? name : mapped;
};

/** Map a Claude Code tool name back to the original tool name from definitions. */
const fromClaudeCodeName = (name: string, tools?: ToolDefinition[]): string => {
  if (tools && tools.length > 0) {
    const lowerName = name.toLowerCase();
    const matched = tools.find((t) => t.name.toLowerCase() === lowerName);
    if (matched) return matched.name;
  }
  return fromClaudeCodeToolName(name);
};

/**
 * Check if a model supports adaptive thinking (Opus 4.6 and Sonnet 4.6).
 * These models have interleaved thinking built-in — the beta header is redundant.
 */
function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

// ── Anthropic Client ─────────────────────────────────────────────────────────

interface AnthropicAuth {
  apiKey?: string;
  authToken?: string;
  isOAuth: boolean;
  keyIndex?: number;
  keyLabel?: string;
}

const ANTHROPIC_5XX_FAILOVER_THRESHOLD = 2;
const ANTHROPIC_GLOBAL_5XX_QUARANTINE_THRESHOLD = 3;
const ANTHROPIC_GLOBAL_5XX_QUARANTINE_MS = 10 * 60 * 1000;
const ANTHROPIC_STREAM_FIRST_EVENT_TIMEOUT_MS = 15 * 1000; // 15s to get first stream event (connection/key issue)
const ANTHROPIC_STREAM_INACTIVITY_TIMEOUT_MS = 90 * 1000;  // 90s mid-stream silence before treating as dead
const ANTHROPIC_FIRST_EVENT_TIMEOUT_COOLDOWN_MS = 15 * 1000; // 15s cooldown for first-event timeouts (likely transient)
const ANTHROPIC_TIMEOUT_COOLDOWN_MS = 30 * 1000; // 30s cooldown for mid-stream timeouts
const anthropicServerErrorsBySession = new Map<string, { keyIndex: number; count: number }>();
const anthropicServerErrorsByKey = new Map<number, number>();
const RATE_LIMIT_COOLDOWN_FLOOR_MS = 15 * 60 * 1000;
const MAX_INLINE_RATE_LIMIT_WAIT_SECONDS = 15;
const RATE_LIMIT_ROTATION_RETRY_DELAY_MS = 1_000;

const DEFAULT_KEYPOOL_SESSION_ID = "__default__";

function isOAuthToken(key: string): boolean {
  return key.includes("sk-ant-oat");
}

type AnthropicMessageStream = {
  finalMessage(): Promise<any>;
  abort(): void;
  on(event: "connect" | "streamEvent", listener: (...args: any[]) => void): unknown;
};

export async function awaitAnthropicFinalMessageWithInactivityTimeout(
  stream: AnthropicMessageStream,
  sessionId?: string,
  firstEventTimeoutOrInactivityMs = ANTHROPIC_STREAM_FIRST_EVENT_TIMEOUT_MS,
  inactivityTimeoutMs?: number,
): Promise<any> {
  const firstEventTimeoutMs =
    inactivityTimeoutMs === undefined
      ? ANTHROPIC_STREAM_FIRST_EVENT_TIMEOUT_MS
      : firstEventTimeoutOrInactivityMs;
  const effectiveInactivityTimeoutMs =
    inactivityTimeoutMs ?? firstEventTimeoutOrInactivityMs;

  let timeout: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let lastActivityAt = Date.now();
  let gotFirstEvent = false;

  const touch = () => {
    lastActivityAt = Date.now();
    gotFirstEvent = true;
  };

  stream.on("connect", touch);
  stream.on("streamEvent", touch);

  const timeoutError = (elapsedMs: number, source: "timeout" | "watchdog", isFirstEvent: boolean) => {
    const tag = isFirstEvent ? "anthropic_stream_first_event_timeout" : "anthropic_stream_timeout";
    return new Error(
      `${tag}${source === "watchdog" ? " (watchdog)" : ""} after ${Math.round(elapsedMs / 1000)}s ` +
      `session=${sessionId?.slice(0, 40) ?? "none"}`,
    );
  };

  return await Promise.race([
    stream.finalMessage(),
    new Promise<never>((_, reject) => {
      const checkForTimeout = (source: "timeout" | "watchdog") => {
        const idleMs = Date.now() - lastActivityAt;
        const effectiveTimeout = gotFirstEvent ? effectiveInactivityTimeoutMs : firstEventTimeoutMs;
        if (idleMs < effectiveTimeout) return;
        stream.abort();
        reject(timeoutError(idleMs, source, !gotFirstEvent));
      };

      // Primary: setTimeout that re-arms with the appropriate timeout.
      // Starts with firstEventTimeoutMs, switches to inactivityTimeoutMs once streaming.
      const armTimeout = () => {
        if (timeout) clearTimeout(timeout);
        const effectiveTimeout = gotFirstEvent ? effectiveInactivityTimeoutMs : firstEventTimeoutMs;
        timeout = setTimeout(() => {
          checkForTimeout("timeout");
          armTimeout();
        }, effectiveTimeout);
      };

      armTimeout();

      // Backup: setInterval watchdog in case timers drift while the stream is stalled.
      watchdog = setInterval(() => {
        checkForTimeout("watchdog");
      }, 10_000);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (watchdog) clearInterval(watchdog);
  });
}

function getHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }

  const message = error instanceof Error ? error.message : String(error);

  // Anthropic overloaded_error doesn't include a numeric status in the message,
  // but it corresponds to HTTP 529
  if (message.includes("overloaded_error")) return 529;

  const match = message.match(/\b(\d{3})\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

function getRetryAfterSeconds(error: unknown): number | undefined {
  if (error && typeof error === "object" && "headers" in error) {
    const headers = (error as { headers?: unknown }).headers;
    if (headers && typeof headers === "object" && "get" in headers && typeof (headers as Headers).get === "function") {
      const retryAfter = (headers as Headers).get("retry-after");
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!Number.isNaN(parsed)) return parsed;
      }
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/retry[_-]after[:\s]+(\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}

function getRateLimitCooldownMs(error: unknown): number {
  const retryAfterSeconds = getRetryAfterSeconds(error);
  const retryAfterMs = retryAfterSeconds ? retryAfterSeconds * 1000 : 0;
  return Math.max(retryAfterMs, RATE_LIMIT_COOLDOWN_FLOOR_MS);
}

function annotateRetryAfter(error: unknown, retryAfterSeconds?: number): Error {
  const base =
    error instanceof Error
      ? error
      : new Error(String(error));

  if (retryAfterSeconds !== undefined && !base.message.includes("retry_after=")) {
    base.message = `${base.message} retry_after=${retryAfterSeconds}`;
  }

  return base;
}

type RateLimitErrorMeta = {
  provider: "anthropic" | "openai" | "openrouter";
  sessionId?: string;
  keyIndex?: number;
  keyLabel?: string;
  cooldownMs?: number;
};

function annotateRateLimitMeta(error: unknown, meta: RateLimitErrorMeta): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  Object.assign(base, { __lobsRateLimitMeta: meta });
  return base;
}

function getRateLimitMeta(error: unknown): RateLimitErrorMeta | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { __lobsRateLimitMeta?: RateLimitErrorMeta }).__lobsRateLimitMeta;
}

function isTimeoutLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
    const message = error.message.toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("aborterror") ||
      message.includes("anthropic_stream_timeout")
    );
  }

  const message = String(error).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborterror") ||
    message.includes("anthropic_stream_timeout")
  );
}

export function shouldRetryProviderError(error: unknown): boolean | undefined {
  if (isTimeoutLikeError(error)) return true;

  if (error && typeof error === "object" && "headers" in error) {
    const headers = (error as { headers?: unknown }).headers;
    if (headers && typeof headers === "object" && "get" in headers && typeof (headers as Headers).get === "function") {
      const shouldRetry = (headers as Headers).get("x-should-retry");
      if (shouldRetry === "true") return true;
      if (shouldRetry === "false") return false;
    }
  }

  return undefined;
}

function resolveAnthropicAuth(sessionId?: string): AnthropicAuth | undefined {
  // Try KeyPool first, even for callers without a session-scoped ID.
  const keyPool = getKeyPool();
  const auth = keyPool.getAuth("anthropic", sessionId ?? DEFAULT_KEYPOOL_SESSION_ID);
  if (auth) {
    return {
      ...auth,
      keyLabel: auth.label,
    } as AnthropicAuth;
  }

  // If a pool is configured but no healthy key is available, do not fall back to
  // single-key env vars. That would silently reuse a key the pool just marked bad.
  if (keyPool.hasKeys("anthropic")) {
    return undefined;
  }

  // Fallback to single-key environment variables
  if (process.env.ANTHROPIC_API_KEY) {
    const key = process.env.ANTHROPIC_API_KEY;
    return isOAuthToken(key)
      ? { authToken: key, isOAuth: true }
      : { apiKey: key, isOAuth: false };
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return { authToken: process.env.ANTHROPIC_AUTH_TOKEN, isOAuth: true };
  }

  return undefined;
}

function createAnthropicNativeClient(auth: AnthropicAuth, modelId: string): Anthropic {
  // Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
  // The beta header is deprecated/redundant on these models, so skip it.
  const needsInterleavedBeta = !supportsAdaptiveThinking(modelId);

  const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
  if (needsInterleavedBeta) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }

  if (auth.isOAuth) {
    return new Anthropic({
      apiKey: null,
      authToken: auth.authToken,
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        "accept": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
        "user-agent": `claude-cli/${claudeCodeVersion}`,
        "x-app": "cli",
      },
    });
  }

  return new Anthropic({
    apiKey: auth.apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      "accept": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": betaFeatures.join(","),
    },
  });
}

class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private sessionId?: string;
  private keyIndex?: number;
  private keyLabel?: string;
  private isOAuth: boolean;

  constructor(auth: AnthropicAuth, modelId: string, sessionId?: string) {
    this.client = createAnthropicNativeClient(auth, modelId);
    this.sessionId = sessionId;
    this.keyIndex = auth.keyIndex;
    this.keyLabel = auth.keyLabel;
    this.isOAuth = auth.isOAuth;
  }

  async createMessage(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    thinking?: {
      type: "enabled";
      budgetTokens: number;
    } | {
      type: "adaptive";
    };
  }): Promise<LLMResponse> {
    console.log(
      `[AnthropicClient] request session=${this.sessionId?.slice(0, 40) ?? "none"} ` +
      `key=${this.keyLabel ?? `key-${this.keyIndex ?? "env"}`} model=${params.model} ` +
      `oauth=${this.isOAuth} stream=true`,
    );

    // Build system prompt blocks — OAuth requires Claude Code preamble
    const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];
    if (this.isOAuth) {
      systemBlocks.push({
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: "ephemeral" },
      });
    }
    systemBlocks.push({
      type: "text",
      text: params.system,
      cache_control: { type: "ephemeral" },
    });

    // Convert tools — OAuth requires Claude Code canonical tool names
    const tools: Anthropic.Tool[] = params.tools.map((t) => ({
      name: this.isOAuth ? toClaudeCodeName(t.name) : t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        properties: (t.input_schema as any).properties || {},
        required: (t.input_schema as any).required || [],
      },
    }));
    if (tools.length > 0) {
      tools[tools.length - 1] = {
        ...tools[tools.length - 1],
        cache_control: { type: "ephemeral" },
      };
    }

    // Convert messages — map tool_use names for OAuth
    let messages = params.messages as Anthropic.MessageParam[];
    if (this.isOAuth) {
      messages = (params.messages as any[]).map((msg: any) => {
        if (!Array.isArray(msg.content)) return msg;
        return {
          ...msg,
          content: msg.content.map((block: any) => {
            if (block.type === "tool_use") {
              return { ...block, name: toClaudeCodeName(block.name) };
            }
            return block;
          }),
        };
      });
    }

    // Build API params
    const apiParams: any = {
      model: params.model,
      system: systemBlocks,
      tools,
      messages,
      stream: true,
    };

    // Thinking mode
    if (params.thinking) {
      if (params.thinking.type === "adaptive") {
        apiParams.thinking = { type: "adaptive" };
      } else {
        apiParams.thinking = {
          type: params.thinking.type,
          budget_tokens: params.thinking.budgetTokens,
        };
      }
    }
    apiParams.max_tokens = params.maxTokens;

    // Track this request as in-flight so the pool can deprioritize this key
    // for new sessions if it appears stuck.
    if (this.keyIndex !== undefined) {
      getKeyPool().trackRequestStart("anthropic", this.keyIndex);
    }

    try {
      // Use streaming — matches Claude Code's calling convention
      const stream = this.client.messages.stream(apiParams);
      const response = await awaitAnthropicFinalMessageWithInactivityTimeout(stream, this.sessionId);

      const usage: TokenUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: (response.usage as any).cache_read_input_tokens ?? 0,
        cacheWriteTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
        thinkingTokens: (response.usage as any).thinking_tokens,
      };

      // Extract thinking content if present
      let thinkingContent: string | undefined;
      const thinkingBlocks = (response.content as any[]).filter(
        (block: any) => block.type === "thinking"
      );
      if (thinkingBlocks.length > 0) {
        thinkingContent = thinkingBlocks
          .map((block: any) => block.thinking as string)
          .join("\n\n");
      }

      if (this.keyIndex !== undefined) {
        getKeyPool().trackRequestEnd("anthropic", this.keyIndex, true);
      }
      if (this.sessionId && this.keyIndex !== undefined) {
        anthropicServerErrorsBySession.delete(this.sessionId);
        anthropicServerErrorsByKey.delete(this.keyIndex);
        getKeyPool().markHealthy("anthropic", this.keyIndex);
      }

      // Map tool names back from Claude Code names to original names
      const content = (response.content as any[]).map((block: any) => {
        if (block.type === "tool_use" && this.isOAuth) {
          return { ...block, name: fromClaudeCodeName(block.name, params.tools) };
        }
        return block;
      }) as LLMResponse["content"];

      return {
        content,
        stopReason: response.stop_reason === "end_turn" ? "end_turn"
          : response.stop_reason === "tool_use" ? "tool_use"
          : response.stop_reason === "max_tokens" ? "max_tokens"
          : "stop",
        usage,
        thinkingContent,
      };
    } catch (error) {
      // Track end of in-flight request (failure)
      if (this.keyIndex !== undefined) {
        getKeyPool().trackRequestEnd("anthropic", this.keyIndex, false);
      }

      // Detect error type and mark key as failed if using KeyPool
      if (this.sessionId) {
        const message = error instanceof Error ? error.message : String(error);
        const keyPool = getKeyPool();
        const status = getHttpStatus(error);

        if (isTimeoutLikeError(error) && this.keyIndex !== undefined) {
          // First-event timeout = stream never started. Likely transient — use short cooldown
          // so the key recovers quickly. Mid-stream timeout = stream died — slightly longer cooldown.
          const isFirstEventTimeout = message.includes("first_event_timeout");
          const cooldownMs = isFirstEventTimeout
            ? ANTHROPIC_FIRST_EVENT_TIMEOUT_COOLDOWN_MS
            : ANTHROPIC_TIMEOUT_COOLDOWN_MS;
          keyPool.markFailed(
            "anthropic",
            this.keyIndex,
            message,
            "unknown",
            cooldownMs,
          );
          const rotated = keyPool.rotateSession(
            "anthropic",
            this.sessionId,
            `timeout:${this.keyLabel ?? `key-${this.keyIndex}`}`,
          );
          console.warn(
            `[AnthropicClient] ${isFirstEventTimeout ? "First-event timeout" : "Stream timeout"} on ` +
            `key=${this.keyLabel ?? `key-${this.keyIndex ?? "unknown"}`} ` +
            `rotated=${rotated} session=${this.sessionId.slice(0, 40)} ` +
            `cooldown_ms=${cooldownMs}`,
          );
        } else if (status === 401 || status === 403) {
          if (this.keyIndex !== undefined) {
            keyPool.markFailed("anthropic", this.keyIndex, message, "auth");
          } else {
            keyPool.markSessionFailed("anthropic", this.sessionId, message, "auth");
          }
          const rotated = keyPool.rotateSession(
            "anthropic",
            this.sessionId,
            `auth:${this.keyLabel ?? `key-${this.keyIndex ?? "unknown"}`}`,
          );
          console.warn(
            `[AnthropicClient] Auth failure detected on key=${this.keyLabel ?? `key-${this.keyIndex ?? "unknown"}`} ` +
            `rotated=${rotated}`,
          );
        } else if (status === 429) {
          const cooldownMs = getRateLimitCooldownMs(error);
          console.warn(
            `[AnthropicClient] Rate limit detected on key=${this.keyLabel ?? `key-${this.keyIndex ?? "unknown"}`} ` +
            `cooldown_ms=${cooldownMs} waiting_for_retries=true`,
          );
          throw annotateRateLimitMeta(error, {
            provider: "anthropic",
            sessionId: this.sessionId,
            keyIndex: this.keyIndex,
            keyLabel: this.keyLabel,
            cooldownMs,
          });
        } else if (status === 529 || message.includes("overloaded_error")) {
          // Overloaded errors are capacity-related — rotate key immediately so
          // retries hit a different key that may have available capacity
          const cooldownMs = 30_000;
          if (this.keyIndex !== undefined) {
            keyPool.markFailed("anthropic", this.keyIndex, message, "rate_limit", cooldownMs);
          } else {
            keyPool.markSessionFailed("anthropic", this.sessionId, message, "rate_limit", cooldownMs);
          }
          const rotated = keyPool.rotateSession("anthropic", this.sessionId, `overloaded:${this.keyLabel ?? `key-${this.keyIndex}`}`);
          console.warn(
            `[AnthropicClient] Overloaded on key=${this.keyLabel ?? `key-${this.keyIndex ?? "unknown"}`} ` +
            `rotated=${rotated} session=${this.sessionId.slice(0, 40)}`,
          );
        } else if (status && status >= 500 && status < 600 && this.keyIndex !== undefined) {
          const prev = anthropicServerErrorsBySession.get(this.sessionId);
          const count = prev && prev.keyIndex === this.keyIndex ? prev.count + 1 : 1;
          anthropicServerErrorsBySession.set(this.sessionId, { keyIndex: this.keyIndex, count });
          const globalCount = (anthropicServerErrorsByKey.get(this.keyIndex) ?? 0) + 1;
          anthropicServerErrorsByKey.set(this.keyIndex, globalCount);
          console.warn(
            `[AnthropicClient] Server error ${status} on key=${this.keyLabel ?? `key-${this.keyIndex}`} ` +
            `session=${this.sessionId.slice(0, 40)} consecutive=${count} global=${globalCount}`,
          );
          if (globalCount >= ANTHROPIC_GLOBAL_5XX_QUARANTINE_THRESHOLD) {
            keyPool.markFailed(
              "anthropic",
              this.keyIndex,
              message,
              "unknown",
              ANTHROPIC_GLOBAL_5XX_QUARANTINE_MS,
            );
            anthropicServerErrorsByKey.delete(this.keyIndex);
            console.warn(
              `[AnthropicClient] Quarantined key=${this.keyLabel ?? `key-${this.keyIndex}`} ` +
              `after repeated cross-session server errors cooldown_ms=${ANTHROPIC_GLOBAL_5XX_QUARANTINE_MS}`,
            );
          }
          if (count >= ANTHROPIC_5XX_FAILOVER_THRESHOLD) {
            keyPool.rotateSession(
              "anthropic",
              this.sessionId,
              `repeated_server_errors:${this.keyLabel ?? `key-${this.keyIndex}`}`,
            );
            anthropicServerErrorsBySession.delete(this.sessionId);
            console.warn(
              `[AnthropicClient] Repeated server errors on ${this.keyLabel ?? `key-${this.keyIndex}`}, rotating key`,
            );
          }
        } else {
          // Log any unhandled error statuses so we don't have silent failures
          console.warn(
            `[AnthropicClient] Unhandled error status=${status ?? "none"} on key=${this.keyLabel ?? `key-${this.keyIndex ?? "unknown"}`} ` +
            `session=${this.sessionId.slice(0, 40)} message=${message.slice(0, 200)}`,
          );
        }
      }

      // Re-throw error to let ResilientLLMClient handle retries
      throw error;
    }
  }
}

/**
 * Resolve OpenAI API key from KeyPool or environment.
 */
function resolveOpenAIKey(sessionId?: string): string | undefined {
  const keyPool = getKeyPool();
  const auth = keyPool.getAuth("openai", sessionId ?? DEFAULT_KEYPOOL_SESSION_ID);
  if (auth?.apiKey) return auth.apiKey;
  return process.env.OPENAI_API_KEY;
}

function resolveOpenAIAuth(sessionId?: string): { apiKey: string; keyIndex?: number; keyLabel?: string } | undefined {
  const keyPool = getKeyPool();
  const auth = keyPool.getAuth("openai", sessionId ?? DEFAULT_KEYPOOL_SESSION_ID);
  if (auth?.apiKey) return { apiKey: auth.apiKey, keyIndex: auth.keyIndex, keyLabel: auth.label };
  if (process.env.OPENAI_API_KEY) return { apiKey: process.env.OPENAI_API_KEY };
  return undefined;
}

/**
 * Resolve OpenRouter API key from KeyPool or environment.
 */
function resolveOpenRouterKey(sessionId?: string): string | undefined {
  const keyPool = getKeyPool();
  const auth = keyPool.getAuth("openrouter", sessionId ?? DEFAULT_KEYPOOL_SESSION_ID);
  if (auth?.apiKey) return auth.apiKey;
  return process.env.OPENROUTER_API_KEY;
}

function resolveOpenRouterAuth(sessionId?: string): { apiKey: string; keyIndex?: number; keyLabel?: string } | undefined {
  const keyPool = getKeyPool();
  const auth = keyPool.getAuth("openrouter", sessionId ?? DEFAULT_KEYPOOL_SESSION_ID);
  if (auth?.apiKey) return { apiKey: auth.apiKey, keyIndex: auth.keyIndex, keyLabel: auth.label };
  if (process.env.OPENROUTER_API_KEY) return { apiKey: process.env.OPENROUTER_API_KEY };
  return undefined;
}

// ── OpenCode Go Client (Anthropic Messages API) ──────────────────────────────

/**
 * OpenCodeGoClient — routes opencode-go through the Anthropic messages API.
 * OpenCode Go speaks native Anthropic format and supports prompt caching
 * (cache_control ephemeral, cache_read_input_tokens, cache_creation_input_tokens).
 * No OAuth, no key rotation, no Claude Code name mapping needed.
 */
class OpenCodeGoClient implements LLMClient {
  private client: Anthropic;
  private modelId: string;
  private sessionId?: string;

  constructor(client: Anthropic, modelId: string, sessionId?: string) {
    this.client = client;
    this.modelId = modelId;
    this.sessionId = sessionId;
  }

  async createMessage(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    thinking?: {
      type: "enabled";
      budgetTokens: number;
    } | {
      type: "adaptive";
    };
  }): Promise<LLMResponse> {
    console.log(
      `[OpenCodeGoClient] request session=${this.sessionId?.slice(0, 40) ?? "none"} model=${params.model} stream=true`,
    );

    // Build system blocks with cache control
    const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];
    systemBlocks.push({
      type: "text",
      text: params.system,
      cache_control: { type: "ephemeral" },
    });

    // Convert tools and cache the last one
    const tools: Anthropic.Tool[] = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        properties: (t.input_schema as any).properties || {},
        required: (t.input_schema as any).required || [],
      },
    }));
    if (tools.length > 0) {
      tools[tools.length - 1] = {
        ...tools[tools.length - 1],
        cache_control: { type: "ephemeral" },
      };
    }

    // Build API params
    const apiParams: any = {
      model: params.model,
      system: systemBlocks,
      tools,
      messages: params.messages,
      stream: true,
      max_tokens: params.maxTokens,
    };

    // Thinking mode
    if (params.thinking) {
      if (params.thinking.type === "adaptive") {
        apiParams.thinking = { type: "adaptive" };
      } else {
        apiParams.thinking = {
          type: params.thinking.type,
          budget_tokens: params.thinking.budgetTokens,
        };
      }
    }

    const stream = this.client.messages.stream(apiParams);
    const response = await awaitAnthropicFinalMessageWithInactivityTimeout(stream, this.sessionId);

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: (response.usage as any).cache_read_input_tokens ?? 0,
      cacheWriteTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
      thinkingTokens: (response.usage as any).thinking_tokens,
    };

    console.log(
      `[OpenCodeGoClient] usage: in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadTokens} cacheWrite=${usage.cacheWriteTokens}`,
    );

    // Extract thinking content if present
    let thinkingContent: string | undefined;
    const thinkingBlocks = (response.content as any[]).filter(
      (block: any) => block.type === "thinking"
    );
    if (thinkingBlocks.length > 0) {
      thinkingContent = thinkingBlocks
        .map((block: any) => block.thinking as string)
        .join("\n\n");
    }

    const content = response.content as LLMResponse["content"];

    return {
      content,
      stopReason: response.stop_reason === "end_turn" ? "end_turn"
        : response.stop_reason === "tool_use" ? "tool_use"
        : response.stop_reason === "max_tokens" ? "max_tokens"
        : "stop",
      usage,
      thinkingContent,
    };
  }
}

// ── OpenAI-Compatible Client ─────────────────────────────────────────────────

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChoice {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "tool_calls" | "length";
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface ParsedToolCallFromText {
  name: string;
  input: Record<string, unknown>;
}

function stripCodeFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function tryParseToolCallPayload(payload: unknown): ParsedToolCallFromText[] | null {
  const normalizeOne = (entry: any): ParsedToolCallFromText | null => {
    if (!entry || typeof entry !== "object") return null;
    const name = typeof entry.tool === "string" ? entry.tool
      : typeof entry.name === "string" ? entry.name
      : typeof entry.tool_name === "string" ? entry.tool_name
      : typeof entry.function?.name === "string" ? entry.function.name
      : null;
    const input = entry.input && typeof entry.input === "object" ? entry.input
      : entry.arguments && typeof entry.arguments === "object" ? entry.arguments
      : entry.function?.arguments && typeof entry.function.arguments === "object" ? entry.function.arguments
      : {};
    if (!name) return null;
    return { name, input: input as Record<string, unknown> };
  };

  if (Array.isArray(payload)) {
    const calls = payload.map(normalizeOne).filter(Boolean) as ParsedToolCallFromText[];
    return calls.length > 0 ? calls : null;
  }

  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.tool_calls)) return tryParseToolCallPayload(obj.tool_calls);
    if (Array.isArray(obj.calls)) return tryParseToolCallPayload(obj.calls);
    const single = normalizeOne(obj);
    return single ? [single] : null;
  }

  return null;
}

function extractToolCallsFromText(content: string, allowedTools: ToolDefinition[]): {
  toolCalls: ParsedToolCallFromText[];
  remainingText: string;
} {
  const candidates: Array<{ raw: string; parsed: unknown }> = [];
  const trimmed = content.trim();
  if (!trimmed) return { toolCalls: [], remainingText: "" };

  const fencedMatches = [...content.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    try {
      candidates.push({ raw: match[0], parsed: JSON.parse(stripCodeFence(match[0])) });
    } catch { /* ignore */ }
  }

  try {
    candidates.push({ raw: trimmed, parsed: JSON.parse(stripCodeFence(trimmed)) });
  } catch { /* ignore */ }

  const firstJsonMatch = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (firstJsonMatch) {
    try {
      candidates.push({ raw: firstJsonMatch[0], parsed: JSON.parse(firstJsonMatch[0]) });
    } catch { /* ignore */ }
  }

  const allowed = new Set(allowedTools.map((t) => t.name));
  for (const candidate of candidates) {
    const parsed = tryParseToolCallPayload(candidate.parsed);
    if (!parsed?.length) continue;
    if (!parsed.every((call) => allowed.has(call.name))) continue;
    const remainingText = content.replace(candidate.raw, "").trim();
    return { toolCalls: parsed, remainingText };
  }

  return { toolCalls: [], remainingText: content };
}

function buildOpenAIToolFallbackInstruction(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "";
  const toolList = tools
    .map((tool) => `- ${tool.name}: ${tool.description.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return [
    "Tool usage is enabled.",
    "If the model/API supports native tool calling, use it.",
    "If native tool calling is unavailable, respond with ONLY valid JSON in one of these forms:",
    '{"tool":"tool_name","input":{"arg":"value"}}',
    '{"tool_calls":[{"tool":"tool_name","input":{"arg":"value"}}]}',
    "Do not wrap the JSON in prose. Do not describe the tool call. Emit the JSON directly.",
    `Allowed tools and descriptions:\n${toolList}`,
  ].join("\n");
}

function providerHasNativeToolCalling(provider: Provider): boolean {
  return provider === "anthropic" || provider === "openai" || provider === "openai-codex" || provider === "openrouter" || provider === "lmstudio";
}

class OpenAICompatibleClient implements LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private headers: Record<string, string>;
  private provider: Provider;
  private sessionId?: string;
  private keyIndex?: number;
  private keyLabel?: string;

  constructor(
    baseUrl: string,
    apiKey: string,
    provider: Provider,
    sessionId?: string,
    extraHeaders?: Record<string, string>,
    keyIndex?: number,
    keyLabel?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.provider = provider;
    this.sessionId = sessionId;
    this.headers = extraHeaders ?? {};
    this.keyIndex = keyIndex;
    this.keyLabel = keyLabel;
  }

  async createMessage(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    thinking?: {
      type: "enabled";
      budgetTokens: number;
    };
  }): Promise<LLMResponse> {
    const effectiveSystem = params.tools.length > 0 && !providerHasNativeToolCalling(this.provider)
      ? `${params.system}\n\n${buildOpenAIToolFallbackInstruction(params.tools)}`
      : params.system;

    // Convert to OpenAI format
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: effectiveSystem },
    ];

    for (const msg of params.messages) {
      if (msg.role === "user") {
        // Check if this is an array content (tool results, images, etc.)
        if (Array.isArray(msg.content)) {
          const toolResults = msg.content.filter(
            (c: Record<string, unknown>) => c.type === "tool_result"
          );
          if (toolResults.length > 0) {
            for (const tr of toolResults) {
              messages.push({
                role: "tool",
                tool_call_id: (tr as Record<string, unknown>).tool_use_id,
                content: typeof (tr as Record<string, unknown>).content === "string"
                  ? (tr as Record<string, unknown>).content
                  : JSON.stringify((tr as Record<string, unknown>).content),
              });
            }
            continue;
          }

          // Convert Anthropic-style content blocks to OpenAI multimodal format
          // Handles image blocks and text blocks
          const hasImages = msg.content.some((c: Record<string, unknown>) => c.type === "image");
          if (hasImages) {
            const openaiParts: Array<Record<string, unknown>> = [];
            for (const block of msg.content) {
              const b = block as Record<string, unknown>;
              if (b.type === "text") {
                openaiParts.push({ type: "text", text: b.text });
              } else if (b.type === "image") {
                const source = b.source as Record<string, unknown>;
                if (source?.type === "base64") {
                  openaiParts.push({
                    type: "image_url",
                    image_url: {
                      url: `data:${source.media_type};base64,${source.data}`,
                    },
                  });
                }
              }
            }
            messages.push({ role: "user", content: openaiParts });
            continue;
          }
        }
        messages.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        // Convert Anthropic-style assistant content to OpenAI format
        if (Array.isArray(msg.content)) {
          let textContent = "";
          const toolCalls: OpenAIToolCall[] = [];

          for (const block of msg.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text") {
              textContent += (b.text as string) ?? "";
            } else if (b.type === "tool_use") {
              toolCalls.push({
                id: b.id as string,
                type: "function",
                function: {
                  name: b.name as string,
                  arguments: JSON.stringify(b.input),
                },
              });
            }
          }

          const assistantMsg: Record<string, unknown> = {
            role: "assistant",
            content: textContent || null,
          };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
          }
          messages.push(assistantMsg);
        } else {
          messages.push({ role: "assistant", content: msg.content });
        }
      }
    }

    // Convert tools to OpenAI format
    const tools = params.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      max_tokens: params.maxTokens,
    };

    if (tools.length > 0) {
      body.tools = tools;
    }

    let response: Response;
    try {
      const endpoint = this.provider === "openai-codex"
        ? `${this.baseUrl}/codex/responses`
        : `${this.baseUrl}/v1/chat/completions`;
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000), // 10 minutes — agent tool loops can be long
      });
    } catch (error) {
      // Network error — re-throw as-is
      throw error;
    }

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`${response.status} ${text.slice(0, 200)}`);

      // Mark key as failed if using KeyPool
      if (this.sessionId && (this.provider === "openai" || this.provider === "openrouter")) {
        const keyPool = getKeyPool();
        const providerKey = this.provider as "openai" | "openrouter";

        if (response.status === 401 || response.status === 403) {
          if (this.keyIndex !== undefined) {
            keyPool.markFailed(providerKey, this.keyIndex, error.message, "auth");
          } else {
            keyPool.markSessionFailed(providerKey, this.sessionId, error.message, "auth");
          }
          const rotated = keyPool.rotateSession(
            providerKey,
            this.sessionId,
            `auth:${this.keyLabel ?? `key-${this.keyIndex ?? "unknown"}`}`,
          );
          console.warn(
            `[${this.provider}Client] Auth failure detected on key=${this.keyLabel ?? `key-${this.keyIndex ?? "unknown"}`} ` +
            `rotated=${rotated}`,
          );
        } else if (response.status === 429) {
          const cooldownMs = getRateLimitCooldownMs(error);
          console.warn(
            `[${this.provider}Client] Rate limit detected on key=${this.keyLabel ?? `key-${this.keyIndex ?? "unknown"}`} ` +
            `cooldown_ms=${cooldownMs} waiting_for_retries=true`,
          );
          throw annotateRateLimitMeta(error, {
            provider: providerKey,
            sessionId: this.sessionId,
            keyIndex: this.keyIndex,
            keyLabel: this.keyLabel,
            cooldownMs,
          });
        }
      }

      throw error;
    }

    const data = (await response.json()) as OpenAIResponse;
    if (this.sessionId && this.keyIndex !== undefined && (this.provider === "openai" || this.provider === "openrouter")) {
      getKeyPool().markHealthy(this.provider as "openai" | "openrouter", this.keyIndex);
    }
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No choices in response");

    // Convert OpenAI response to our format
    const content: LLMResponse["content"] = [];

    let parsedFromText: ParsedToolCallFromText[] = [];
    let remainingText = choice.message.content ?? "";

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch { /* empty */ }

        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    } else if (choice.message.content && params.tools.length > 0) {
      const extracted = extractToolCallsFromText(choice.message.content, params.tools);
      parsedFromText = extracted.toolCalls;
      remainingText = extracted.remainingText;
      for (const tc of parsedFromText) {
        content.push({
          type: "tool_use",
          id: `toolu_${randomUUID().replace(/-/g, "")}`,
          name: tc.name,
          input: tc.input,
        });
      }
    }

    if (remainingText && remainingText.trim()) {
      content.unshift({ type: "text", text: remainingText });
    }

    const stopReason: LLMResponse["stopReason"] =
      choice.finish_reason === "tool_calls" || parsedFromText.length > 0 ? "tool_use"
      : choice.finish_reason === "length" ? "max_tokens"
      : "end_turn";

    return {
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

// ── Client Factory ───────────────────────────────────────────────────────────

/** Default base URLs per provider */
const PROVIDER_DEFAULTS: Record<Provider, { baseUrl: string; envKey: string }> = {
  anthropic: { baseUrl: "https://api.anthropic.com", envKey: "ANTHROPIC_API_KEY" },
  openai: { baseUrl: "https://api.openai.com", envKey: "OPENAI_API_KEY" },
  "openai-codex": { baseUrl: "https://chatgpt.com/backend-api/codex", envKey: "OPENAI_CODEX_TOKEN" },
  lmstudio: { baseUrl: "http://localhost:1234", envKey: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api", envKey: "OPENROUTER_API_KEY" },
  "openai-compatible": { baseUrl: "http://localhost:8080", envKey: "" },
  "opencode-zen": { baseUrl: "https://opencode.ai/zen", envKey: "OPENCODE_API_KEY" },
  "opencode-go": { baseUrl: "https://opencode.ai/zen/go", envKey: "OPENCODE_API_KEY" },
  "z-ai": { baseUrl: "https://open.z.ai/api/paas/v4", envKey: "ZAI_API_KEY" },
  minimax: { baseUrl: "https://api.minimax.chat/v1", envKey: "MINIMAX_API_KEY" },
  kimi: { baseUrl: "https://api.moonshot.cn/v1", envKey: "KIMI_API_KEY" },
};

// ── Resilient Client Wrapper ─────────────────────────────────────────────────

interface ResilientClientOptions {
  fallbackModels?: string[];
  maxRetries?: number;
  taskCategory?: TaskCategory;
  sensitiveData?: boolean;
}

class ResilientLLMClient implements LLMClient {
  private primaryClient: LLMClient;
  private primaryModel: string;
  private fallbackModels: string[];
  private maxRetries: number;
  private sessionId?: string;
  private primaryClientUsed = false;
  private allKeysWaitStart?: number;

  constructor(
    primaryClient: LLMClient,
    primaryModel: string,
    options?: ResilientClientOptions & { sessionId?: string }
  ) {
    this.primaryClient = primaryClient;
    this.primaryModel = primaryModel;
    this.fallbackModels = options?.fallbackModels ?? [];
    this.maxRetries = options?.maxRetries ?? 3;
    this.sessionId = options?.sessionId;
  }

  async createMessage(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    thinking?: { type: "enabled"; budgetTokens: number } | { type: "adaptive" };
  }): Promise<LLMResponse> {
    const modelsToTry = [this.primaryModel, ...this.fallbackModels];

    for (let modelIdx = 0; modelIdx < modelsToTry.length; modelIdx++) {
      const model = modelsToTry[modelIdx];
      const isFallback = modelIdx > 0;

      const modelParams = { ...params, model: parseModelString(model).modelId };

      let attempt = 0;
      while (attempt < this.maxRetries) {
        attempt++;

        try {
          // Use the pre-built primaryClient only for the very first attempt of
          // the very first createMessage() call. After that, always create a
          // fresh client so we pick up key rotations from the pool.
          const useOriginalPrimary = attempt === 1 && !isFallback && !this.primaryClientUsed;
          const client = useOriginalPrimary
            ? this.primaryClient
            : createClient(parseModelString(model), this.sessionId);
          if (useOriginalPrimary) this.primaryClientUsed = true;

          return await client.createMessage(modelParams);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = getHttpStatus(error);
          const shouldRetry = shouldRetryProviderError(error);

          if (isTimeoutLikeError(error)) {
            if (attempt < this.maxRetries && shouldRetry !== false) {
              // First-event timeouts already rotated the key — retry immediately (1s)
              // since we're hitting a different key now. Mid-stream timeouts use normal backoff.
              const isFirstEvent = message.includes("first_event_timeout");
              const waitTime = isFirstEvent ? 1000 : this.exponentialBackoff(attempt) * 1000;
              console.warn(
                `[ResilientLLMClient] ${isFirstEvent ? "First-event" : "Stream"} timeout for model ${model}, ` +
                `retrying in ${(waitTime / 1000).toFixed(1)}s ` +
                `(attempt ${attempt}/${this.maxRetries}) session=${this.sessionId?.slice(0, 40) ?? "none"}`,
              );
              await this.sleep(waitTime);
              continue;
            }
          }

          // Auth errors — retry to allow key rotation
          if (status === 401 || status === 403) {
            if (attempt < this.maxRetries) {
              continue;
            }
            throw new Error(`Authentication failed for model ${model}: ${message}`);
          }

          // Rate limit — retry with backoff
          if (status === 429) {
            const retryAfter = getRetryAfterSeconds(error);
            const annotatedError = annotateRetryAfter(error, retryAfter);
            const shouldQuarantineImmediately =
              retryAfter !== undefined && retryAfter > MAX_INLINE_RATE_LIMIT_WAIT_SECONDS;

            if (attempt < this.maxRetries && shouldRetry !== false && !shouldQuarantineImmediately) {
              console.warn(
                `[ResilientLLMClient] Rate limit for model ${model}, retrying with backoff before quarantining key ` +
                `(attempt ${attempt}/${this.maxRetries}) session=${this.sessionId?.slice(0, 40) ?? "none"} ` +
                `retry_after=${retryAfter ?? "unknown"}`,
              );
              const waitTimeSeconds = retryAfter !== undefined
                ? Math.max(1, retryAfter)
                : this.exponentialBackoff(attempt);
              await this.sleep(waitTimeSeconds * 1000);
              continue;
            }

            const rateLimitMeta = getRateLimitMeta(error);
            if (rateLimitMeta?.sessionId && rateLimitMeta.keyIndex !== undefined) {
              const keyPool = getKeyPool();
              keyPool.markFailed(
                rateLimitMeta.provider,
                rateLimitMeta.keyIndex,
                annotatedError.message,
                "rate_limit",
                rateLimitMeta.cooldownMs,
              );
              const rotated = keyPool.rotateSession(
                rateLimitMeta.provider,
                rateLimitMeta.sessionId,
                `rate_limit:${rateLimitMeta.cooldownMs ?? "unknown"}`,
              );
              console.warn(
                `[ResilientLLMClient] Quarantined ${rateLimitMeta.provider}/${rateLimitMeta.keyLabel ?? `key-${rateLimitMeta.keyIndex}`} ` +
                `after ${attempt} rate-limit attempts rotated=${rotated}`,
              );

              if (attempt < this.maxRetries && shouldRetry !== false) {
                console.warn(
                  `[ResilientLLMClient] Retrying ${model} with a rotated key after quarantine ` +
                  `(attempt ${attempt}/${this.maxRetries}) session=${this.sessionId?.slice(0, 40) ?? "none"} ` +
                  `retry_after=${retryAfter ?? "unknown"}`,
                );
                await this.sleep(RATE_LIMIT_ROTATION_RETRY_DELAY_MS);
                continue;
              }
            }

            throw annotatedError;
          }

          // Server errors — retry with exponential backoff + jitter
          if (status && status >= 500 && status < 600) {
            if (attempt < this.maxRetries && shouldRetry !== false) {
              const waitTime = this.exponentialBackoff(attempt) * 1000;
              console.warn(`[ResilientLLMClient] Server error ${status}, retrying in ${(waitTime / 1000).toFixed(1)}s (attempt ${attempt}/${this.maxRetries})`);
              await this.sleep(waitTime);
              continue;
            }
          }

          // Overloaded error — the inner AnthropicClient already rotated the key,
          // so retry quickly with a new client (which will pick up the rotated key)
          if (status === 529 || message.includes("overloaded_error")) {
            if (attempt < this.maxRetries) {
              const waitTime = (2 + Math.random() * 3) * 1000; // 2-5s, just enough to not hammer
              console.warn(
                `[ResilientLLMClient] API overloaded, retrying with rotated key in ${(waitTime / 1000).toFixed(1)}s ` +
                `(attempt ${attempt}/${this.maxRetries}) session=${this.sessionId?.slice(0, 40) ?? "none"}`,
              );
              await this.sleep(waitTime);
              continue;
            }
          }

          // All keys unavailable — wait for recovery then retry with fresh client.
          // Key cooldowns can be 1–15+ minutes, so we need a longer retry window here
          // than for normal errors. We use dedicated retry logic with 30s intervals,
          // up to 20 minutes total, to outlast even escalated cooldowns.
          if (message.includes("all_anthropic_keys_unavailable") || message.includes("all_openai_keys_unavailable") || message.includes("all_openrouter_keys_unavailable")) {
            const ALL_KEYS_RETRY_INTERVAL_MS = 30_000;  // Check every 30s
            const ALL_KEYS_MAX_WAIT_MS = 20 * 60 * 1000; // Give up after 20 minutes
            const allKeysStartTime = this.allKeysWaitStart ?? Date.now();
            this.allKeysWaitStart = allKeysStartTime;
            const elapsed = Date.now() - allKeysStartTime;

            if (elapsed < ALL_KEYS_MAX_WAIT_MS) {
              console.warn(
                `[ResilientLLMClient] All keys unavailable for ${model}, waiting 30s for recovery ` +
                `(elapsed ${(elapsed / 1000).toFixed(0)}s / max ${ALL_KEYS_MAX_WAIT_MS / 1000}s) ` +
                `session=${this.sessionId?.slice(0, 40) ?? "none"}`,
              );
              await this.sleep(ALL_KEYS_RETRY_INTERVAL_MS);
              // Don't increment attempt counter — this is a wait-for-recovery loop
              attempt--;
              continue;
            }
            // Exhausted wait time — clean up and fall through to error
            this.allKeysWaitStart = undefined;
          }

          // All retries exhausted for this model — log and decide
          console.warn(
            `[ResilientLLMClient] Unhandled error for model ${model} status=${status ?? "none"} ` +
            `attempt=${attempt}/${this.maxRetries} modelIdx=${modelIdx}/${modelsToTry.length} ` +
            `session=${this.sessionId?.slice(0, 40) ?? "none"} error=${message.slice(0, 200)}`,
          );
          if (isFallback || modelIdx === modelsToTry.length - 1) {
            // Last model — propagate error
            throw error;
          }

          // Try next fallback model
          break;
        }
      }
    }

    throw new Error("All models and retries exhausted");
  }
  private exponentialBackoff(attempt: number): number {
    const base = Math.min(5 * Math.pow(3, attempt - 1), 45); // 5s, 15s, 45s
    // Add ±30% jitter to prevent thundering herd
    const jitter = base * (0.7 + Math.random() * 0.6);
    return jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a resilient LLM client with retry and fallback support.
 * @param sessionId - Optional session ID for sticky key assignment
 */
export function createResilientClient(
  model: string,
  options?: ResilientClientOptions & { sessionId?: string }
): LLMClient {
  const config = parseModelString(model);
  const sessionId = options?.sessionId;
  const primaryClient = createClient(config, sessionId);
  return new ResilientLLMClient(primaryClient, model, { ...options, sessionId });
}

// ── OpenAICodexClient ──────────────────────────────────────────────────────────

/**
 * LLM client for the OpenAI Codex endpoint using the Responses API.
 * The Codex endpoint at chatgpt.com/backend-api/codex/responses uses the
 * Responses API format, which is fundamentally different from Chat Completions.
 */
class OpenAICodexClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly sessionId?: string;
  private readonly headers: Record<string, string>;

  constructor(
    baseUrl: string,
    apiKey: string,
    sessionId?: string,
    extraHeaders?: Record<string, string>,
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.sessionId = sessionId;
    this.headers = extraHeaders ?? {};
  }

  async createMessage(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    thinking?: { type: "enabled"; budgetTokens: number } | { type: "adaptive" };
  }): Promise<LLMResponse> {
    const input = this.convertMessagesToInput(params.messages);
    const tools = params.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      strict: false,
    }));

    const requestBody: Record<string, unknown> = {
      model: params.model,
      store: false,
      stream: true,
      instructions: params.system,
      input,
      text: { verbosity: "medium" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
      ...(this.sessionId ? { prompt_cache_key: this.sessionId } : {}),
    };

    if (tools.length > 0) {
      requestBody.tools = tools;
    }

    const response = await fetch(this.resolveEndpoint(), {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(600_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${text.slice(0, 200)}`.trim());
    }

    const sseText = await response.text();
    const finalResponse = this.extractFinalResponseFromSSE(sseText);
    return this.convertResponse(finalResponse);
  }

  private convertMessagesToInput(messages: LLMMessage[]): unknown[] {
    const input: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          input.push({
            role: "user",
            content: [{ type: "input_text", text: msg.content }],
          });
        } else if (Array.isArray(msg.content)) {
          const content: Array<Record<string, unknown>> = [];
          for (const block of msg.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "tool_result") {
              input.push({
                type: "function_call_output",
                call_id: b.tool_use_id,
                output:
                  typeof b.content === "string"
                    ? b.content
                    : JSON.stringify(b.content),
              });
            } else if (b.type === "text") {
              content.push({
                type: "input_text",
                text: b.text,
              });
            } else if (b.type === "image" && typeof b.data === "string" && typeof b.mediaType === "string") {
              content.push({
                type: "input_image",
                detail: "auto",
                image_url: `data:${b.mediaType};base64,${b.data}`,
              });
            }
          }
          if (content.length > 0) {
            input.push({ role: "user", content });
          }
        }
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: msg.content, annotations: [] }],
            status: "completed",
          });
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && b.text) {
              input.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: b.text, annotations: [] }],
                status: "completed",
              });
            } else if (b.type === "tool_use") {
              input.push({
                type: "function_call",
                call_id: b.id,
                id: String(b.id).startsWith("fc_") ? b.id : `fc_${String(b.id)}`,
                name: b.name,
                arguments: JSON.stringify(b.input),
              });
            }
          }
        }
      }
    }

    return input;
  }

  private convertResponse(response: {
    output?: Array<{
      type: string;
      role?: string;
      content?: Array<{ type: string; text?: string }>;
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
    status?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  }): LLMResponse {
    const content: LLMResponse["content"] = [];

    for (const item of response.output ?? []) {
      if (item.type === "message") {
        for (const block of item.content ?? []) {
          if (block.type === "output_text" && block.text) {
            content.push({ type: "text", text: block.text });
          }
        }
      } else if (item.type === "function_call") {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(item.arguments ?? "{}") as Record<string, unknown>;
        } catch {
          // keep empty object
        }
        content.push({
          type: "tool_use",
          id: item.call_id ?? item.id ?? "",
          name: item.name ?? "",
          input,
        });
      }
    }

    // Determine stop reason
    const stopReason: LLMResponse["stopReason"] = content.some(
      (c) => c.type === "tool_use",
    )
      ? "tool_use"
      : response.status === "incomplete"
        ? "max_tokens"
        : "end_turn";

    return {
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      stopReason,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }

  private resolveEndpoint(): string {
    const normalized = this.baseUrl.replace(/\/+$/, "");
    if (normalized.endsWith("/codex/responses")) return normalized;
    if (normalized.endsWith("/codex")) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
  }

  private buildHeaders(): Record<string, string> {
    const accountId = this.headers["ChatGPT-Account-Id"] ?? this.headers["chatgpt-account-id"];
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      accept: "text/event-stream",
      "content-type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      originator: "pi",
      "User-Agent": `lobs-core (${process.platform} ${process.arch})`,
      ...this.headers,
    };
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
      delete headers["ChatGPT-Account-Id"];
    }
    if (this.sessionId) {
      headers["session_id"] = this.sessionId;
    }
    return headers;
  }

  private extractFinalResponseFromSSE(sseText: string): {
    output?: Array<{
      type: string;
      role?: string;
      content?: Array<{ type: string; text?: string }>;
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
    status?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  } {
    let finalResponse: Record<string, unknown> | null = null;
    let responseError: string | null = null;

    for (const chunk of sseText.split("\n\n")) {
      const dataLines = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) continue;

      const data = dataLines.join("\n").trim();
      if (!data || data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const type = parsed.type;
        if (type === "error") {
          responseError = String(parsed.message ?? parsed.code ?? "Codex error");
        } else if (
          type === "response.completed" ||
          type === "response.done" ||
          type === "response.incomplete"
        ) {
          finalResponse = parsed.response as Record<string, unknown>;
        } else if (type === "response.failed") {
          const response = parsed.response as Record<string, unknown> | undefined;
          const errorObj = response?.error as Record<string, unknown> | undefined;
          responseError = String(errorObj?.message ?? "Codex response failed");
        }
      } catch {
        // Ignore malformed SSE fragments.
      }
    }

    if (!finalResponse) {
      throw new Error(responseError ?? "Codex response stream ended without a final response");
    }

    return finalResponse as {
      output?: Array<{
        type: string;
        role?: string;
        content?: Array<{ type: string; text?: string }>;
        id?: string;
        call_id?: string;
        name?: string;
        arguments?: string;
      }>;
      status?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  }
}

/**
 * Create an LLM client for the given provider config.
 * @param sessionId - Optional session ID for sticky key assignment
 */
export function createClient(config: ProviderConfig, sessionId?: string): LLMClient {
  if (config.provider === "anthropic") {
    const keyPool = getKeyPool();
    const auth = resolveAnthropicAuth(sessionId);
    if (!auth) {
      if (keyPool.hasKeys("anthropic")) {
        const summary = keyPool.getPoolHealthSummary("anthropic");
        throw new Error(
          `all_anthropic_keys_unavailable: configured=${summary.total} healthy=${summary.healthy} ` +
          `auth_failed=${summary.authFailed} rate_limited=${summary.rateLimited} provider_failed=${summary.providerFailed}`,
        );
      }
      throw new Error("No Anthropic credentials found");
    }
    return new AnthropicClient(auth, config.modelId, sessionId);
  }

  // openai-codex: Bearer token (OAuth) through chatgpt.com
  if (config.provider === "openai-codex") {
    const defaults = PROVIDER_DEFAULTS["openai-codex"];
    const baseUrl = config.baseUrl ?? defaults.baseUrl;

    // Priority: explicit config override > OAuth credentials > key pool > env var
    let apiKey = config.apiKey ?? "";

    // Try OAuth credentials (sync cached token — refreshed async on last getAccessToken() call)
    if (!apiKey) {
      const codexAuth = getCodexAuth();
      const cached = codexAuth.getCachedAccessToken();
      if (cached) {
        apiKey = cached;
      }
    }

    // Try key pool
    if (!apiKey) {
      const keyPool = getKeyPool();
      if (keyPool.hasKeys("openai-codex")) {
        const auth = keyPool.getAuth("openai-codex", sessionId ?? DEFAULT_KEYPOOL_SESSION_ID);
        if (auth?.apiKey) {
          apiKey = auth.apiKey;
        }
      }
    }

    // Fall back to env var
    if (!apiKey && defaults.envKey) {
      apiKey = process.env[defaults.envKey] ?? "";
    }

    if (!apiKey) {
      throw new Error(
        "No OpenAI Codex token found. Run `lobs codex-auth login` for OAuth, " +
        "add to ~/.lobs/config/secrets/keys.json, or set OPENAI_CODEX_TOKEN env var.",
      );
    }

    const extraHeaders: Record<string, string> = {};
    // Prefer accountId from OAuth credentials, fall back to env var
    const codexAuth = getCodexAuth();
    const oauthAccountId = codexAuth.credentials?.accountId;
    const accountId = oauthAccountId ?? process.env.OPENAI_CODEX_ACCOUNT_ID;
    if (accountId) {
      extraHeaders["ChatGPT-Account-Id"] = accountId;
    }

    return new OpenAICodexClient(baseUrl, apiKey, sessionId, extraHeaders);
  }

  // opencode-go: Uses Anthropic messages API format (supports prompt caching)
  if (config.provider === "opencode-go") {
    const defaults = PROVIDER_DEFAULTS["opencode-go"];
    const baseUrl = config.baseUrl ?? defaults.baseUrl;
    const apiKey = config.apiKey ?? (defaults.envKey ? process.env[defaults.envKey] ?? "" : "");

    if (!apiKey) {
      throw new Error("No OpenCode API key found. Set OPENCODE_API_KEY environment variable.");
    }

    // Create Anthropic SDK client pointed at OpenCode Go endpoint
    const anthropicClient = new Anthropic({
      apiKey,
      baseURL: baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        "accept": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });

    return new OpenCodeGoClient(anthropicClient, config.modelId, sessionId);
  }

  // All other providers use OpenAI-compatible API
  const defaults = PROVIDER_DEFAULTS[config.provider] ?? PROVIDER_DEFAULTS["openai-compatible"];
  const baseUrl = config.baseUrl ?? defaults.baseUrl;

  let apiKey = config.apiKey ?? "";
  let keyIndex: number | undefined;
  let keyLabel: string | undefined;
  
  // Try KeyPool for any provider (generic — works for all providers in keys.json)
  if (!apiKey && sessionId) {
    const pool = getKeyPool();
    const selection = pool.getKeySelection(config.provider, sessionId);
    if (selection) {
      apiKey = selection.key;
      keyIndex = selection.keyIndex;
      keyLabel = selection.label;
    }
  }

  // Fallback to environment variables
  if (!apiKey && defaults.envKey) {
    apiKey = process.env[defaults.envKey] ?? "";
  }

  // LM Studio doesn't need an API key
  if (config.provider === "lmstudio") {
    apiKey = apiKey || "lm-studio";
  }

  const extraHeaders: Record<string, string> = {};
  if (config.provider === "openrouter") {
    extraHeaders["HTTP-Referer"] = "https://lobs.ai";
    extraHeaders["X-Title"] = "Lobs Agent Runner";
  }

  return new OpenAICompatibleClient(baseUrl, apiKey, config.provider, sessionId, extraHeaders, keyIndex, keyLabel);
}
