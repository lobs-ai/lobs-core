/**
 * Agent loop — the core LLM ↔ tool execution cycle.
 *
 * Multi-provider: Anthropic (native), OpenAI, LM Studio, OpenRouter, any OpenAI-compatible.
 * Uses provider abstraction to normalize all responses to a common format.
 */

import type {
  AgentSpec,
  AgentResult,
  TokenUsage,
  ToolResult,
} from "./types.js";
import { MODEL_COSTS as COSTS } from "./types.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";
import { buildSystemPrompt, buildSmartSystemPrompt } from "./prompt-builder.js";
import { parseModelString, createClient, type LLMMessage, type LLMResponse } from "./providers.js";

export type { AgentSpec, AgentResult };

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_TOKENS = 16384;

/**
 * Run an agent to completion.
 *
 * The loop:
 * 1. Parse model string → resolve provider + credentials
 * 2. Build system prompt + task message
 * 3. Call LLM API
 * 4. If tool_use → execute tools → feed results back → goto 3
 * 5. If end_turn → extract output → return result
 */
export async function runAgent(spec: AgentSpec): Promise<AgentResult> {
  const startTime = Date.now();
  const maxTurns = spec.maxTurns ?? DEFAULT_MAX_TURNS;

  // Resolve provider from model string
  const providerConfig = parseModelString(spec.model);

  // Create LLM client
  let client;
  try {
    client = createClient(providerConfig);
  } catch (error) {
    return {
      succeeded: false,
      output: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      durationSeconds: 0,
      turns: 0,
      stopReason: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Build system prompt — use smart context engine if no explicit system prompt
  let systemPrompt: string;
  if (spec.systemPrompt) {
    systemPrompt = spec.systemPrompt;
  } else {
    try {
      // Try smart prompt with context engine (needs lobs-memory running)
      const smart = await buildSmartSystemPrompt(spec);
      systemPrompt = smart.systemPrompt;
    } catch {
      // Fall back to static prompt if context engine unavailable
      systemPrompt = buildSystemPrompt(spec);
    }
  }

  // Get tool definitions for the API
  const tools = getToolDefinitions(spec.tools);

  // Initialize message history
  const messages: LLMMessage[] = [
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

  // Timeout
  const timeoutMs = spec.timeout * 1000;

  try {
    while (turns < maxTurns) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        stopReason = "timeout";
        break;
      }

      turns++;

      // Call the LLM
      let response: LLMResponse;
      try {
        response = await client.createMessage({
          model: providerConfig.modelId,
          system: systemPrompt,
          messages,
          tools,
          maxTokens: DEFAULT_MAX_TOKENS,
        });
      } catch (error) {
        // Check if it's a timeout
        if (Date.now() - startTime > timeoutMs) {
          stopReason = "timeout";
          break;
        }
        throw error;
      }

      // Track usage
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.cacheReadTokens += response.usage.cacheReadTokens;
      usage.cacheWriteTokens += response.usage.cacheWriteTokens;

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
      messages.push({ role: "assistant", content: response.content as LLMMessage["content"] });

      // Extract any text output
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          lastTextOutput = block.text;
        }
      }

      // Check stop reason
      if (response.stopReason === "end_turn" || response.stopReason === "stop") {
        stopReason = "end_turn";
        break;
      }

      if (response.stopReason === "max_tokens") {
        stopReason = "max_turns";
        break;
      }

      // If we got tool_use, execute them
      if (response.stopReason === "tool_use") {
        const toolCalls = response.content.filter(
          (block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
            block.type === "tool_use"
        );

        if (toolCalls.length === 0) {
          stopReason = "end_turn";
          break;
        }

        // Execute tool calls
        const results: ToolResult[] = [];
        for (const call of toolCalls) {
          const result = await executeTool(
            call.name,
            call.input,
            call.id,
            spec.cwd,
          );
          results.push(result);
        }

        // Add tool results to history
        messages.push({
          role: "user",
          content: results as unknown as LLMMessage["content"],
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
  }
}

/**
 * Calculate cost based on model pricing.
 */
function calculateCost(model: string, usage: TokenUsage): number {
  const costEntry = Object.entries(COSTS).find(([key]) => model.includes(key));
  if (!costEntry) return 0;

  const [, rates] = costEntry;
  const cost =
    (usage.inputTokens * rates.input) / 1_000_000 +
    (usage.outputTokens * rates.output) / 1_000_000 +
    (usage.cacheReadTokens * rates.cacheRead) / 1_000_000 +
    (usage.cacheWriteTokens * rates.cacheWrite) / 1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000;
}
