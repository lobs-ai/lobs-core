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
import { createHash, randomBytes } from "node:crypto";
import { SessionTranscript, type TurnRecord } from "./session-transcript.js";
import { shouldCompact, compactMessages } from "./context-manager.js";

export type { AgentSpec, AgentResult };

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_TOKENS = 16384;

/** Track recent tool calls for loop detection */
interface ToolCallRecord {
  name: string;
  argsHash: string;
}

/**
 * Hash tool arguments for comparison.
 * Normalizes JSON to detect functionally identical calls.
 */
function hashToolArgs(args: Record<string, unknown>): string {
  const normalized = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Check for consecutive tool call loops.
 * Returns the repeat count of the most recent pattern.
 */
function detectToolLoop(recentCalls: ToolCallRecord[]): number {
  if (recentCalls.length < 3) return 0;

  const latest = recentCalls[recentCalls.length - 1];
  let consecutiveCount = 0;

  // Count how many times the latest call appears consecutively from the end
  for (let i = recentCalls.length - 1; i >= 0; i--) {
    const call = recentCalls[i];
    if (call.name === latest.name && call.argsHash === latest.argsHash) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  return consecutiveCount;
}

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

  // Generate or use existing run ID for session persistence
  const runId = spec.context?.taskId ?? randomBytes(8).toString("hex");
  const transcript = new SessionTranscript(spec.agent, runId);

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
  let thinkingContent = "";

  // Tool loop detection — track last 10 tool calls
  const recentCalls: ToolCallRecord[] = [];
  const MAX_RECENT_CALLS = 10;

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

      // Check if we need to compact context
      if (shouldCompact(usage.inputTokens, spec.model)) {
        const beforeCount = messages.length;
        messages.splice(0, messages.length, ...compactMessages(messages));
        const afterCount = messages.length;

        if (beforeCount !== afterCount) {
          console.log(
            `[Context compaction] Reduced messages from ${beforeCount} to ${afterCount} (${usage.inputTokens.toLocaleString()} input tokens)`
          );
        }
      }

      // Call the LLM
      let response: LLMResponse;
      try {
        response = await client.createMessage({
          model: providerConfig.modelId,
          system: systemPrompt,
          messages,
          tools,
          maxTokens: DEFAULT_MAX_TOKENS,
          thinking: spec.thinking,
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
      if (response.usage.thinkingTokens) {
        usage.thinkingTokens = (usage.thinkingTokens ?? 0) + response.usage.thinkingTokens;
      }

      // Capture thinking content
      if (response.thinkingContent) {
        thinkingContent += (thinkingContent ? "\n\n" : "") + response.thinkingContent;
      }

      // Extract tool calls from response for transcript
      const toolCalls = response.content
        .filter((block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => block.type === "tool_use")
        .map((block) => ({ name: block.name, input: block.input }));

      // Write turn to transcript
      transcript.writeTurn({
        turn: turns,
        timestamp: new Date().toISOString(),
        messages: [...messages], // Snapshot current messages
        response,
        usage,
        toolCalls,
      });

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

        // Execute tool calls in parallel
        const results = await Promise.all(
          toolCalls.map((call) =>
            executeTool(call.name, call.input, call.id, spec.cwd)
          )
        );

        // Track tool calls for loop detection
        for (const call of toolCalls) {
          const callRecord: ToolCallRecord = {
            name: call.name,
            argsHash: hashToolArgs(call.input),
          };
          recentCalls.push(callRecord);
          if (recentCalls.length > MAX_RECENT_CALLS) {
            recentCalls.shift();
          }
        }

        // Check for tool loops
        const loopCount = detectToolLoop(recentCalls);

        if (loopCount >= 5) {
          // Force-stop at 5 repeats
          stopReason = "error";
          const errorMsg = `Tool loop detected: ${recentCalls[recentCalls.length - 1].name} repeated ${loopCount} times with identical arguments. Breaking loop.`;
          
          return {
            succeeded: false,
            output: lastTextOutput,
            usage,
            costUsd: calculateCost(spec.model, usage),
            durationSeconds: (Date.now() - startTime) / 1000,
            turns,
            stopReason,
            error: errorMsg,
            thinkingContent: thinkingContent || undefined,
          };
        }

        if (loopCount === 3) {
          // Inject warning at 3 repeats
          const warningMsg = `WARNING: You appear to be repeating the same action (${recentCalls[recentCalls.length - 1].name}). This approach isn't working. Try a different strategy or tool.`;
          
          messages.push({
            role: "user",
            content: [{ type: "text", text: warningMsg }],
          });

          // Progress callback for the warning
          if (spec.onProgress) {
            spec.onProgress({ 
              turn: turns, 
              type: "error", 
              text: warningMsg,
              usage 
            });
          }

          continue;
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

    // Write final summary
    transcript.writeSummary({
      type: "summary",
      runId,
      agentType: spec.agent,
      taskId: spec.context?.taskId,
      succeeded: stopReason === "end_turn",
      totalTurns: turns,
      totalUsage: usage,
      durationSeconds,
      stopReason,
      timestamp: new Date().toISOString(),
    });

    return {
      succeeded: stopReason === "end_turn",
      output: lastTextOutput,
      usage,
      costUsd,
      durationSeconds,
      turns,
      stopReason,
      thinkingContent: thinkingContent || undefined,
    };
  } catch (error) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    const costUsd = calculateCost(spec.model, usage);
    const message = error instanceof Error ? error.message : String(error);

    // Write error summary
    transcript.writeSummary({
      type: "summary",
      runId,
      agentType: spec.agent,
      taskId: spec.context?.taskId,
      succeeded: false,
      totalTurns: turns,
      totalUsage: usage,
      durationSeconds,
      stopReason: "error",
      error: message,
      timestamp: new Date().toISOString(),
    });

    return {
      succeeded: false,
      output: lastTextOutput,
      usage,
      costUsd,
      durationSeconds,
      turns,
      stopReason: "error",
      error: message,
      thinkingContent: thinkingContent || undefined,
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
