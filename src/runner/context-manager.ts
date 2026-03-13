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
 * - Summarize tool outputs in older turns
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

    // For older messages, compact tool results
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const hasToolResults = msg.content.some(
        (block: Record<string, unknown>) => block.type === "tool_result"
      );

      if (hasToolResults) {
        // Summarize tool results
        const toolCount = msg.content.filter(
          (block: Record<string, unknown>) => block.type === "tool_result"
        ).length;

        compacted.push({
          role: "user",
          content: `[${toolCount} tool outputs summarized to save context]`,
        });
        continue;
      }
    }

    // For assistant messages, keep as-is (or truncate text if needed)
    if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(
          (block: Record<string, unknown>) => block.type === "text"
        );
        const toolUseBlocks = msg.content.filter(
          (block: Record<string, unknown>) => block.type === "tool_use"
        );

        // Keep tool use blocks, truncate text
        const compactedContent: Array<Record<string, unknown>> = [];

        for (const block of textBlocks) {
          const text = (block as { text: string }).text;
          if (text.length > 500) {
            compactedContent.push({
              type: "text",
              text: text.slice(0, 500) + "... [truncated]",
            });
          } else {
            compactedContent.push(block);
          }
        }

        compactedContent.push(...toolUseBlocks);

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
