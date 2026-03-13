/**
 * Agent loop — the core LLM ↔ tool execution cycle.
 *
 * This is our own agent runner. No OpenClaw dependency.
 * Uses the Anthropic SDK directly, executes tools in-process.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import type {
  AgentSpec,
  AgentResult,
  TokenUsage,
  ToolResult,
  MODEL_COSTS,
} from "./types.js";
import { MODEL_COSTS as COSTS } from "./types.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";
import { buildSystemPrompt } from "./prompt-builder.js";

// Re-export for convenience
export type { AgentSpec, AgentResult };

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_TOKENS = 16384;

interface AnthropicAuth {
  apiKey?: string;
  authToken?: string;
  isOAuth: boolean;
}

/** Check if a key is an OAuth token (vs standard API key) */
function isOAuthToken(key: string): boolean {
  return key.includes("sk-ant-oat");
}

/**
 * Resolve Anthropic credentials from available sources:
 * 1. ANTHROPIC_API_KEY env var (standard API key)
 * 2. ANTHROPIC_AUTH_TOKEN env var (OAuth token)
 * 3. OpenClaw auth profiles (OAuth tokens stored as "token" field)
 */
function resolveAnthropicAuth(): AnthropicAuth | undefined {
  // Check env first
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
    `${process.env.HOME}/.openclaw/agents/reviewer/agent/auth-profiles.json`,
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
    } catch {
      // Skip unreadable files
    }
  }

  return undefined;
}

/**
 * Create an Anthropic client configured for the given auth method.
 * OAuth tokens require special headers (beta flags, user-agent, Claude Code identity).
 */
function createAnthropicClient(auth: AnthropicAuth): Anthropic {
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

/**
 * Run an agent to completion.
 *
 * The loop:
 * 1. Build system prompt + task message
 * 2. Call Anthropic API
 * 3. If tool_use → execute tools → feed results back → goto 2
 * 4. If end_turn → extract output → return result
 */
export async function runAgent(spec: AgentSpec): Promise<AgentResult> {
  const startTime = Date.now();
  const maxTurns = spec.maxTurns ?? DEFAULT_MAX_TURNS;

  // Initialize Anthropic client
  const auth = resolveAnthropicAuth();
  if (!auth) {
    return {
      succeeded: false,
      output: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      durationSeconds: 0,
      turns: 0,
      stopReason: "error",
      error: "No Anthropic credentials found. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or configure OpenClaw auth profiles.",
    };
  }
  const client = createAnthropicClient(auth);

  // Build system prompt
  const systemPrompt = spec.systemPrompt ?? buildSystemPrompt(spec);

  // Get tool definitions for the API
  const tools = getToolDefinitions(spec.tools);

  // Initialize message history
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: spec.task },
  ];

  // Token tracking
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  let turns = 0;
  let lastTextOutput = "";
  let stopReason: AgentResult["stopReason"] = "end_turn";

  // Timeout controller
  const timeoutMs = spec.timeout * 1000;
  const abortController = new AbortController();
  const timeoutTimer = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    while (turns < maxTurns) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        stopReason = "timeout";
        break;
      }

      turns++;

      // Call the API
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: spec.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system: systemPrompt,
          tools: tools as Anthropic.Tool[],
          messages,
        });
      } catch (error) {
        if (abortController.signal.aborted) {
          stopReason = "timeout";
          break;
        }
        throw error;
      }

      // Track usage
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      if ("cache_read_input_tokens" in response.usage) {
        usage.cacheReadTokens += (response.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0;
      }
      if ("cache_creation_input_tokens" in response.usage) {
        usage.cacheWriteTokens += (response.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0;
      }

      // Progress callback
      if (spec.onProgress) {
        for (const block of response.content) {
          if (block.type === "text") {
            spec.onProgress({ turn: turns, type: "text", text: block.text, usage });
          } else if (block.type === "tool_use") {
            spec.onProgress({ turn: turns, type: "tool_call", toolName: block.name, usage });
          }
        }
      }

      // Add assistant response to history
      messages.push({ role: "assistant", content: response.content });

      // Extract any text output
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          lastTextOutput = block.text;
        }
      }

      // Check stop reason
      if (response.stop_reason === "end_turn") {
        stopReason = "end_turn";
        break;
      }

      // If we got tool_use, execute them
      if (response.stop_reason === "tool_use") {
        const toolCalls = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
        );

        if (toolCalls.length === 0) {
          stopReason = "end_turn";
          break;
        }

        // Execute tool calls (sequentially for now — can parallelize later)
        const results: ToolResult[] = [];
        for (const call of toolCalls) {
          const result = await executeTool(
            call.name,
            call.input as Record<string, unknown>,
            call.id,
            spec.cwd,
          );
          results.push(result);
        }

        // Add tool results to history
        messages.push({
          role: "user",
          content: results as Anthropic.ToolResultBlockParam[],
        });

        continue;
      }

      // Unknown stop reason — end the loop
      break;
    }

    if (turns >= maxTurns) {
      stopReason = "max_turns";
    }

    const durationSeconds = (Date.now() - startTime) / 1000;
    const costUsd = calculateCost(spec.model, usage);

    return {
      succeeded: stopReason === "end_turn",
      output: lastTextOutput,
      usage,
      costUsd,
      durationSeconds,
      turns,
      stopReason,
    };
  } catch (error) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    const costUsd = calculateCost(spec.model, usage);
    const message = error instanceof Error ? error.message : String(error);

    return {
      succeeded: false,
      output: lastTextOutput,
      usage,
      costUsd,
      durationSeconds,
      turns,
      stopReason: "error",
      error: message,
    };
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/**
 * Calculate cost based on model pricing.
 */
function calculateCost(model: string, usage: TokenUsage): number {
  // Find matching cost entry (partial match)
  const costEntry = Object.entries(COSTS).find(([key]) => model.includes(key));
  if (!costEntry) return 0;

  const [, rates] = costEntry;
  const cost =
    (usage.inputTokens * rates.input) / 1_000_000 +
    (usage.outputTokens * rates.output) / 1_000_000 +
    (usage.cacheReadTokens * rates.cacheRead) / 1_000_000 +
    (usage.cacheWriteTokens * rates.cacheWrite) / 1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal places
}
