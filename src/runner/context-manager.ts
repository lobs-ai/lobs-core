/**
 * Context window management — track token usage and compact history when needed.
 *
 * Strategy:
 * - Track cumulative input tokens across turns
 * - When approaching context limit (80%), start compaction
 * - Summarize old tool outputs first
 * - If still too large, compact older conversation turns
 *
 * Model context limits (tokens):
 * - claude-sonnet-4: 200K
 * - claude-opus-4: 200K
 * - claude-haiku-4.5: 200K
 * - qwen: 32K
 * - gpt-4o: 128K
 */

import type { LLMMessage } from "./providers.js";
import { getContextLimit as getContextLimitFromConfig } from "../config/models.js";

const CONTEXT_WARNING_THRESHOLD = 0.8; // 80%

/**
 * Get the context limit for a model (reads from config).
 */
export function getContextLimit(model: string): number {
  return getContextLimitFromConfig(model);
}

/**
 * Check if we're approaching the context limit.
 */
export function shouldCompact(
  cumulativeInputTokens: number,
  model: string
): boolean {
  const limit = getContextLimit(model);
  return cumulativeInputTokens > limit * CONTEXT_WARNING_THRESHOLD;
}

/**
 * Compact conversation history by summarizing old tool outputs.
 *
 * Strategy:
 * - Keep first user message (task prompt)
 * - Keep last N turns (preserve recent context)
 * - For older turns: truncate tool outputs but PRESERVE tool_use/tool_result pairing
 *
 * CRITICAL: Anthropic API requires every tool_use block to have a matching
 * tool_result block immediately after. We must never break this pairing.
 */
export function compactMessages(
  messages: LLMMessage[],
  keepRecentTurns: number = 5
): LLMMessage[] {
  if (messages.length === 0) return messages;

  const compacted: LLMMessage[] = [];

  // Always keep the first message (task prompt)
  compacted.push(messages[0]);

  // Calculate the boundary — keep last N turns
  const keepFromIndex = Math.max(1, messages.length - keepRecentTurns * 2);

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];

    // Keep recent messages as-is
    if (i >= keepFromIndex) {
      compacted.push(msg);
      continue;
    }

    // For older user messages with tool results, truncate output but keep structure
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const hasToolResults = msg.content.some(
        (block: Record<string, unknown>) => block.type === "tool_result"
      );

      if (hasToolResults) {
        // Truncate each tool_result's content but keep the tool_use_id pairing intact
        const compactedBlocks = msg.content.map((block: Record<string, unknown>) => {
          if (block.type === "tool_result") {
            const content = block.content;
            let summary: string;
            if (typeof content === "string") {
              summary = content.length > 200
                ? content.slice(0, 200) + "... [truncated]"
                : content;
            } else if (Array.isArray(content)) {
              summary = "[tool output truncated to save context]";
            } else {
              summary = "[tool output truncated]";
            }
            return {
              type: "tool_result" as const,
              tool_use_id: block.tool_use_id,
              content: summary,
              ...(block.is_error ? { is_error: true } : {}),
            };
          }
          return block;
        });

        compacted.push({
          role: "user",
          content: compactedBlocks,
        });
        continue;
      }
    }

    // For older assistant messages, truncate text but keep tool_use blocks intact
    if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        const compactedContent: Array<Record<string, unknown>> = [];

        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === "text") {
            const text = block.text as string;
            if (text.length > 500) {
              compactedContent.push({
                type: "text",
                text: text.slice(0, 500) + "... [truncated]",
              });
            } else {
              compactedContent.push(block);
            }
          } else {
            // Keep tool_use and other blocks exactly as-is (IDs must be preserved)
            compactedContent.push(block);
          }
        }

        compacted.push({
          role: "assistant",
          content: compactedContent,
        });
        continue;
      }
    }

    // Default: keep message as-is
    compacted.push(msg);
  }

  return compacted;
}

/**
 * Estimate token count for messages (rough heuristic: ~4 chars per token).
 */
export function estimateTokens(messages: LLMMessage[]): number {
  let total = 0;

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += msg.content.length / 4;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as unknown;
        if (typeof b === "string") {
          total += b.length / 4;
        } else if (typeof b === "object" && b !== null) {
          total += JSON.stringify(b).length / 4;
        }
      }
    }
  }

  return Math.ceil(total);
}
