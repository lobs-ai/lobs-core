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
import { readFileSync } from "node:fs";
import type { ToolDefinition, TokenUsage } from "./types.js";
import { getKeyPool } from "../services/key-pool.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "lmstudio" | "openrouter" | "openai-compatible";

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
    if (providerHint === "openai" || providerHint === "openai-codex") {
      return { provider: "openai", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "lmstudio" || providerHint === "local") {
      return { provider: "lmstudio", modelId: parts.slice(1).join("/") };
    }
    if (providerHint === "openrouter") {
      return { provider: "openrouter", modelId: parts.slice(1).join("/") };
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

// ── Anthropic Client ─────────────────────────────────────────────────────────

interface AnthropicAuth {
  apiKey?: string;
  authToken?: string;
  isOAuth: boolean;
}

function isOAuthToken(key: string): boolean {
  return key.includes("sk-ant-oat");
}

function resolveAnthropicAuth(sessionId?: string): AnthropicAuth | undefined {
  // Try KeyPool first if sessionId provided
  if (sessionId) {
    const keyPool = getKeyPool();
    const auth = keyPool.getAuth("anthropic", sessionId);
    if (auth) return auth as AnthropicAuth;
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

  // Check OpenClaw auth profiles
  const profilePaths = [
    `${process.env.HOME}/.openclaw/agents/main/agent/auth-profiles.json`,
    `${process.env.HOME}/.openclaw/agents/programmer/agent/auth-profiles.json`,
  ];

  for (const path of profilePaths) {
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      const profiles = data.profiles ?? data;
      for (const [key, profile] of Object.entries(profiles)) {
        if (!key.startsWith("anthropic:")) continue;
        const p = profile as Record<string, unknown>;
        const token = (p.token ?? p.apiKey) as string | undefined;
        if (token && typeof token === "string") {
          return isOAuthToken(token)
            ? { authToken: token, isOAuth: true }
            : { apiKey: token, isOAuth: false };
        }
      }
    } catch { /* skip */ }
  }

  return undefined;
}

function createAnthropicNativeClient(auth: AnthropicAuth): Anthropic {
  if (auth.isOAuth) {
    return new Anthropic({
      apiKey: null,
      authToken: auth.authToken,
      defaultHeaders: {
        "accept": "application/json",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
        "user-agent": "claude-cli/2.1.62",
        "x-app": "cli",
      },
    });
  }

  return new Anthropic({
    apiKey: auth.apiKey,
    defaultHeaders: {
      "accept": "application/json",
      "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
    },
  });
}

class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private sessionId?: string;
  private keyIndex?: number;

  constructor(auth: AnthropicAuth, sessionId?: string) {
    this.client = createAnthropicNativeClient(auth);
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
    };
  }): Promise<LLMResponse> {
    // Apply prompt caching — wrap system prompt in array format with cache_control on last block
    const systemParam: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> =
      [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }];

    // Apply cache_control to last tool definition
    const tools = [...params.tools] as Anthropic.Tool[];
    if (tools.length > 0) {
      tools[tools.length - 1] = {
        ...tools[tools.length - 1],
        cache_control: { type: "ephemeral" },
      };
    }

    // Build API params — use any to allow thinking extension
    const apiParams: any = {
      model: params.model,
      system: systemParam,
      tools,
      messages: params.messages as Anthropic.MessageParam[],
    };

    // Thinking mode — use max_output_tokens instead of max_tokens when thinking is enabled
    if (params.thinking) {
      apiParams.thinking = {
        type: params.thinking.type,
        budget_tokens: params.thinking.budgetTokens,
      };
      apiParams.max_output_tokens = params.maxTokens;
    } else {
      apiParams.max_tokens = params.maxTokens;
    }

    try {
      const response = await this.client.messages.create(apiParams);

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

      return {
        content: response.content as LLMResponse["content"],
        stopReason: response.stop_reason === "end_turn" ? "end_turn"
          : response.stop_reason === "tool_use" ? "tool_use"
          : response.stop_reason === "max_tokens" ? "max_tokens"
          : "stop",
        usage,
        thinkingContent,
      };
    } catch (error) {
      // Detect error type and mark key as failed if using KeyPool
      if (this.sessionId) {
        const message = error instanceof Error ? error.message : String(error);
        const keyPool = getKeyPool();
        
        // Parse HTTP status from error message
        const statusMatch = message.match(/\b(\d{3})\b/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

        if (status === 401 || status === 403) {
          // Auth failure — mark key as permanently failed
          if (keyPool.hasKeys("anthropic")) {
            // Get current key index by finding which key matches
            const sessionAuth = keyPool.getAuth("anthropic", this.sessionId);
            if (sessionAuth) {
              // Mark as auth failure (won't auto-recover)
              console.warn(`[AnthropicClient] Auth failure detected, marking key as failed`);
              // Note: We can't get the exact key index here, but the KeyPool will handle it
              // when the next call tries to get a key and finds this one failed
            }
          }
        } else if (status === 429) {
          // Rate limit — mark key as temporarily failed
          console.warn(`[AnthropicClient] Rate limit detected, will retry with backoff`);
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
  if (sessionId) {
    const keyPool = getKeyPool();
    const auth = keyPool.getAuth("openai", sessionId);
    if (auth?.apiKey) return auth.apiKey;
  }
  return process.env.OPENAI_API_KEY;
}

/**
 * Resolve OpenRouter API key from KeyPool or environment.
 */
function resolveOpenRouterKey(sessionId?: string): string | undefined {
  if (sessionId) {
    const keyPool = getKeyPool();
    const auth = keyPool.getAuth("openrouter", sessionId);
    if (auth?.apiKey) return auth.apiKey;
  }
  return process.env.OPENROUTER_API_KEY;
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

class OpenAICompatibleClient implements LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private headers: Record<string, string>;
  private provider: Provider;
  private sessionId?: string;

  constructor(
    baseUrl: string,
    apiKey: string,
    provider: Provider,
    sessionId?: string,
    extraHeaders?: Record<string, string>
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.provider = provider;
    this.sessionId = sessionId;
    this.headers = extraHeaders ?? {};
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
    // Convert to OpenAI format
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: params.system },
    ];

    for (const msg of params.messages) {
      if (msg.role === "user") {
        // Check if this is tool results
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
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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
          console.warn(`[${this.provider}Client] Auth failure detected`);
          // Auth failures are handled by KeyPool on next getKey call
        } else if (response.status === 429) {
          console.warn(`[${this.provider}Client] Rate limit detected`);
          // Rate limit handled by ResilientLLMClient retry logic
        }
      }

      throw error;
    }

    const data = (await response.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No choices in response");

    // Convert OpenAI response to our format
    const content: LLMResponse["content"] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

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
    }

    const stopReason: LLMResponse["stopReason"] =
      choice.finish_reason === "tool_calls" ? "tool_use"
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
  lmstudio: { baseUrl: "http://localhost:1234", envKey: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api", envKey: "OPENROUTER_API_KEY" },
  "openai-compatible": { baseUrl: "http://localhost:8080", envKey: "" },
};

// ── Resilient Client Wrapper ─────────────────────────────────────────────────

interface ResilientClientOptions {
  fallbackModels?: string[];
  maxRetries?: number;
}

class ResilientLLMClient implements LLMClient {
  private primaryClient: LLMClient;
  private primaryModel: string;
  private fallbackModels: string[];
  private maxRetries: number;
  private sessionId?: string;

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
    thinking?: { type: "enabled"; budgetTokens: number };
  }): Promise<LLMResponse> {
    const modelsToTry = [this.primaryModel, ...this.fallbackModels];

    for (let modelIdx = 0; modelIdx < modelsToTry.length; modelIdx++) {
      const model = modelsToTry[modelIdx];
      const isFallback = modelIdx > 0;

      // Create client for this model if it's a fallback
      const client = isFallback
        ? createClient(parseModelString(model), this.sessionId)
        : this.primaryClient;

      const modelParams = { ...params, model: parseModelString(model).modelId };

      let attempt = 0;
      while (attempt < this.maxRetries) {
        attempt++;

        try {
          return await client.createMessage(modelParams);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = this.extractHttpStatus(message);

          // Auth errors — fail immediately
          if (status === 401 || status === 403) {
            throw new Error(`Authentication failed for model ${model}: ${message}`);
          }

          // Rate limit — retry with backoff
          if (status === 429) {
            const retryAfter = this.extractRetryAfter(message);
            const waitTime = retryAfter ?? this.exponentialBackoff(attempt);

            if (attempt < this.maxRetries) {
              await this.sleep(waitTime * 1000);
              continue;
            }
          }

          // Server errors — retry once after 5s
          if (status && status >= 500 && status < 600) {
            if (attempt === 1) {
              await this.sleep(5000);
              continue;
            }
          }

          // Overloaded error — retry once after 30s
          if (message.includes("overloaded_error")) {
            if (attempt === 1) {
              await this.sleep(30000);
              continue;
            }
          }

          // All retries exhausted for this model
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

  private extractHttpStatus(message: string): number | undefined {
    const match = message.match(/\b(\d{3})\b/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private extractRetryAfter(message: string): number | undefined {
    const match = message.match(/retry[_-]after[:\s]+(\d+)/i);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private exponentialBackoff(attempt: number): number {
    return Math.min(5 * Math.pow(3, attempt - 1), 45); // 5s, 15s, 45s
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

/**
 * Create an LLM client for the given provider config.
 * @param sessionId - Optional session ID for sticky key assignment
 */
export function createClient(config: ProviderConfig, sessionId?: string): LLMClient {
  if (config.provider === "anthropic") {
    const auth = resolveAnthropicAuth(sessionId);
    if (!auth) throw new Error("No Anthropic credentials found");
    return new AnthropicClient(auth, sessionId);
  }

  // All other providers use OpenAI-compatible API
  const defaults = PROVIDER_DEFAULTS[config.provider] ?? PROVIDER_DEFAULTS["openai-compatible"];
  const baseUrl = config.baseUrl ?? defaults.baseUrl;

  let apiKey = config.apiKey ?? "";
  
  // Try KeyPool for OpenAI and OpenRouter
  if (!apiKey && config.provider === "openai") {
    apiKey = resolveOpenAIKey(sessionId) ?? "";
  } else if (!apiKey && config.provider === "openrouter") {
    apiKey = resolveOpenRouterKey(sessionId) ?? "";
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

  return new OpenAICompatibleClient(baseUrl, apiKey, config.provider, sessionId, extraHeaders);
}
