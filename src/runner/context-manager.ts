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
import { compactSession, formatCompactedSession } from "./context-engine.js";

const CONTEXT_WARNING_THRESHOLD = 0.8; // 80%

/**
 * Get the context limit for a model (reads from config).
 */
export function getContextLimit(model: string): number {
  return getContextLimitFromConfig(model);
}

/**
 * Check if we're approaching the context limit.
 * Uses current message array size (not cumulative tokens) to avoid
 * triggering compaction every turn after the first compaction.
 */
export function shouldCompact(
  messages: LLMMessage[],
  model: string
): boolean {
  const limit = getContextLimit(model);
  const currentTokens = estimateTokens(messages);
  return currentTokens > limit * CONTEXT_WARNING_THRESHOLD;
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
  if (messages.length <= 2) return messages;

  const compacted: LLMMessage[] = [];

  // Always keep the first message (task prompt)
  compacted.push(messages[0]);

  // Calculate the boundary — keep last N turns
  let keepFromIndex = Math.max(1, messages.length - keepRecentTurns * 2);

  // Adjust keepFromIndex to avoid orphaning tool_result blocks from their tool_use parents.
  // If the boundary lands on a user message with tool_result blocks, the matching assistant
  // message (with tool_use blocks) would be compacted away, breaking the Anthropic API pairing
  // requirement. Move the boundary back until we land on a safe split point.
  while (keepFromIndex > 1) {
    const msg = messages[keepFromIndex];
    if (
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      msg.content.some((block: any) => block.type === "tool_result")
    ) {
      keepFromIndex--;
    } else {
      break;
    }
  }

  const olderMessages = messages.slice(1, keepFromIndex);

  const summaryCandidates = olderMessages
    .map((msg) => ({
      role: msg.role,
      content: stringifyMessageContent(msg.content),
    }))
    .filter((msg) => msg.content.length > 0);

  if (summaryCandidates.length > 0) {
    const summary = formatCompactedSession(compactSession(summaryCandidates));
    const workingState = buildWorkingStateSummary(olderMessages);
    if (summary.trim().length > 0) {
      compacted.push({
        role: "assistant",
        content:
          "[Earlier session summary]\n" +
          "Use this as already-established context. Continue from it instead of redoing the same investigation.\n\n" +
          workingState +
          "\n\n" +
          summary,
      });
    }
  }

  for (let i = keepFromIndex; i < messages.length; i++) {
    const msg = messages[i];
    const preserveFull = i >= messages.length - 4;
    compacted.push(compactRecentMessage(msg, preserveFull));
  }

  return compacted;
}

function buildWorkingStateSummary(messages: LLMMessage[]): string {
  const files = new Set<string>();
  const decisions: string[] = [];
  const completed: string[] = [];
  const openQuestions: string[] = [];
  const nextSteps: string[] = [];
  let objective = "";

  for (const message of messages) {
    const text = stringifyMessageContent(message.content);
    if (!text) continue;

    if (!objective && message.role === "user") {
      objective = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
    }

    for (const match of text.matchAll(/(?:^|[\s(["'`])((?:\/|\.\/|\.\.\/)[^\s)"'`:,;]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)/g)) {
      const file = match[1]?.trim();
      if (file) files.add(file);
    }

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (/^(done|implemented|fixed|updated|created|added|changed)\b/i.test(trimmed) || /\b(done|fixed|implemented|updated)\b/i.test(trimmed)) {
        pushUnique(completed, trimmed);
      }
      if (/\b(decided|using|use |plan is|approach|strategy)\b/i.test(trimmed)) {
        pushUnique(decisions, trimmed);
      }
      if (/\b(todo|remaining|still need|next|follow up|need to)\b/i.test(trimmed)) {
        pushUnique(nextSteps, trimmed);
      }
      if (/\b(issue|problem|question|unclear|blocked|failing|error)\b/i.test(trimmed)) {
        pushUnique(openQuestions, trimmed);
      }
    }
  }

  const lines = ["WORKING STATE:"];
  lines.push(`OBJECTIVE: ${objective || "Continue the active task without redoing prior work."}`);
  if (completed.length > 0) {
    lines.push("COMPLETED:");
    for (const item of completed.slice(0, 4)) lines.push(`- ${item}`);
  }
  if (decisions.length > 0) {
    lines.push("DECISIONS:");
    for (const item of decisions.slice(0, 4)) lines.push(`- ${item}`);
  }
  if (files.size > 0) {
    lines.push(`FILES: ${Array.from(files).slice(0, 8).join(", ")}`);
  }
  if (openQuestions.length > 0) {
    lines.push("OPEN ISSUES:");
    for (const item of openQuestions.slice(0, 4)) lines.push(`- ${item}`);
  }
  if (nextSteps.length > 0) {
    lines.push("NEXT STEPS:");
    for (const item of nextSteps.slice(0, 4)) lines.push(`- ${item}`);
  }

  return lines.join("\n");
}

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}

function compactRecentMessage(msg: LLMMessage, preserveFull: boolean = false): LLMMessage {
  if (msg.role === "user" && Array.isArray(msg.content)) {
    return {
      role: "user",
      content: msg.content.map((block: Record<string, unknown>) => {
        if (block.type !== "tool_result") return block;

        if (preserveFull) return block;

        const content = block.content;
        let summary: string;
        if (typeof content === "string") {
          summary = content.length > 6000
            ? content.slice(0, 6000) + "... [truncated]"
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
      }),
    };
  }

  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    return {
      role: "assistant",
      content: msg.content.map((block: Record<string, unknown>) => {
        if (block.type !== "text" || typeof block.text !== "string") return block;
        if (preserveFull) return block;
        return block.text.length > 6000
          ? { type: "text", text: block.text.slice(0, 6000) + "... [truncated]" }
          : block;
      }),
    };
  }

  return msg;
}

function stringifyMessageContent(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block: Record<string, unknown>) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "tool_use") {
        const toolName = typeof block.name === "string" ? block.name : "tool";
        const input = JSON.stringify(block.input ?? {}).slice(0, 200);
        return `[tool ${toolName} input=${input}]`;
      }
      if (block.type === "tool_result") {
        const raw = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "").slice(0, 300);
        return `[tool result ${raw}]`;
      }
      return JSON.stringify(block).slice(0, 200);
    })
    .join("\n");
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
