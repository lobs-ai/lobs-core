/**
 * Smarter context compaction for agent conversations.
 * 
 * Features:
 * - Proper context size calculation (handles tool_result content blocks)
 * - Uses a dedicated cheaper model for summarization (Haiku)
 * - Preserves important identifiers (file paths, IDs, URLs, variable names)
 * - Structured summary (decisions, open questions, current task state)
 * - Tracks compaction count for observability
 */

import { parseModelString, createClient } from "../runner/providers.js";
import { getModelForTier } from "../config/models.js";
import type { LLMMessage } from "../runner/providers.js";

export interface CompactionConfig {
  /** Char threshold to trigger auto-compaction (default 120000) */
  threshold: number;
  /** What percentage of old messages to summarize (default 0.6 = 60%) */
  summarizeRatio: number;
  /** Model to use for compaction summaries (cheaper than main model) */
  model: string;
  /** Max tokens for the summary output */
  maxSummaryTokens: number;
  /** Whether to preserve identifiers (IDs, paths, URLs) in summaries */
  preserveIdentifiers: boolean;
}

const DEFAULT_CONFIG: CompactionConfig = {
  threshold: 120_000,
  summarizeRatio: 0.6,
  model: getModelForTier("small"),
  maxSummaryTokens: 3000,
  preserveIdentifiers: true,
};

/**
 * Smarter compaction that:
 * 1. Calculates total context size properly (handling tool_result content blocks)
 * 2. Uses a dedicated cheaper model for summarization
 * 3. Preserves important identifiers (file paths, IDs, URLs, variable names)
 * 4. Keeps a structured summary (decisions, open questions, current task state)
 * 5. Tracks compaction count for observability
 */
export async function compactMessages(
  messages: LLMMessage[],
  config: Partial<CompactionConfig> = {},
): Promise<{ messages: LLMMessage[]; compacted: boolean; originalCount: number; newCount: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  const totalChars = calculateContextSize(messages);

  if (totalChars < cfg.threshold) {
    return { messages, compacted: false, originalCount: messages.length, newCount: messages.length };
  }

  console.log(`[compaction] Context at ${totalChars} chars (threshold: ${cfg.threshold}), compacting...`);

  const splitPoint = Math.floor(messages.length * cfg.summarizeRatio);
  const toSummarize = messages.slice(0, splitPoint);
  const toKeep = messages.slice(splitPoint);

  // Build summary input — include more detail than basic compaction
  const summaryText = toSummarize.map((m, i) => {
    const role = m.role.toUpperCase();
    let content = "";
    if (typeof m.content === "string") {
      content = m.content.substring(0, 400);
    } else if (Array.isArray(m.content)) {
      content = (m.content as Array<Record<string, unknown>>).map(block => {
        if (typeof block === "string") return (block as string).substring(0, 200);
        const b = block as Record<string, unknown>;
        if (b.type === "text") return String(b.text || "").substring(0, 200);
        if (b.type === "tool_use") return `[Tool: ${b.name}(${JSON.stringify(b.input).substring(0, 100)})]`;
        if (b.type === "tool_result") {
          const rc = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          return `[Result: ${String(rc).substring(0, 150)}]`;
        }
        return "[content block]";
      }).join(" ");
    } else {
      content = JSON.stringify(m.content).substring(0, 300);
    }
    return `[${i}] ${role}: ${content}`;
  }).join("\n");

  const systemPrompt = cfg.preserveIdentifiers
    ? `You are a conversation compactor. Summarize this conversation history into a structured summary.

RULES:
1. PRESERVE all identifiers exactly: file paths, URLs, git branches, issue numbers, variable names, channel IDs, user IDs, model names
2. PRESERVE all decisions made and their reasoning
3. PRESERVE all open questions and blockers
4. PRESERVE current task state (what was being worked on, what's done, what's next)
5. PRESERVE any constraints, requirements, or acceptance criteria mentioned
6. Use bullet points for clarity
7. Group by: Decisions, Current State, Open Questions, Key Identifiers

Output format:
## Decisions
- ...

## Current State
- What's being worked on: ...
- Completed: ...
- Next steps: ...

## Open Questions
- ...

## Key Identifiers
- Files: ...
- IDs: ...
- Other: ...`
    : `Summarize this conversation history concisely. Preserve: goals, decisions, constraints, key identifiers, and open questions. Output as bullet points.`;

  try {
    const modelConfig = parseModelString(cfg.model);
    const client = createClient(modelConfig);

    const response = await client.createMessage({
      model: modelConfig.modelId,
      system: systemPrompt,
      messages: [
        { role: "user", content: summaryText.substring(0, 80000) },
      ],
      tools: [],
      maxTokens: cfg.maxSummaryTokens,
    });

    const summary = (response.content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === "text")
      .map(b => b.text || "")
      .join("");

    const compactedMessages: LLMMessage[] = [
      {
        role: "user",
        content: `[Conversation compacted — ${splitPoint} messages summarized]\n\n${summary}`,
      },
      {
        role: "assistant",
        content: "Understood. I have the full context from the summary and will continue from where we left off.",
      },
      ...toKeep,
    ];

    const newSize = calculateContextSize(compactedMessages);
    console.log(`[compaction] Compacted ${splitPoint} messages into summary (${totalChars} → ${newSize} chars)`);

    return {
      messages: compactedMessages,
      compacted: true,
      originalCount: messages.length,
      newCount: compactedMessages.length,
    };
  } catch (err) {
    console.error("[compaction] Failed:", err);
    // Fallback: just keep recent messages
    return {
      messages: toKeep,
      compacted: true,
      originalCount: messages.length,
      newCount: toKeep.length,
    };
  }
}

/**
 * Prune old tool results in-memory before LLM calls.
 * Keeps recent tool outputs intact, truncates old ones.
 * Does NOT persist — only affects the current request's context.
 */
export function pruneToolResults(
  messages: LLMMessage[],
  keepRecentTurns: number = 8,
  maxOldToolOutputChars: number = 300,
): LLMMessage[] {
  // Count assistant turns from the end to find the cutoff
  let assistantCount = 0;
  let cutoffIndex = 0;
  
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantCount++;
      if (assistantCount >= keepRecentTurns) {
        // Set cutoff to the user message before this assistant (if exists)
        // This keeps the full turn (user + assistant) intact
        cutoffIndex = i > 0 && messages[i - 1].role === "user" ? i - 1 : i;
        break;
      }
    }
  }

  return messages.map((m, i) => {
    // Keep recent messages intact
    if (i >= cutoffIndex) return m;

    // For old messages, truncate large tool outputs
    if (typeof m.content === "string" && m.content.length > maxOldToolOutputChars * 3 && m.role === "user") {
      return {
        ...m,
        content: m.content.substring(0, maxOldToolOutputChars) + "\n\n[Earlier output truncated. Re-run the tool if needed.]",
      };
    }

    // Handle array content (tool_result blocks)
    if (Array.isArray(m.content) && m.role === "user") {
      return {
        ...m,
        content: m.content.map(block => {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > maxOldToolOutputChars * 3) {
            return {
              ...b,
              content: b.content.substring(0, maxOldToolOutputChars) + "\n[Truncated]",
            };
          }
          return block;
        }),
      };
    }

    return m;
  });
}

/**
 * Calculate total context size in characters.
 * Handles all content block types properly.
 */
export function calculateContextSize(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => {
    if (typeof m.content === "string") return sum + m.content.length;
    if (Array.isArray(m.content)) {
      return sum + (m.content as Array<Record<string, unknown>>).reduce((s: number, block: Record<string, unknown>) => {
        if (typeof block === "string") return s + (block as string).length;
        if (block.type === "text") return s + String(block.text || "").length;
        if (block.type === "tool_result") {
          return s + (typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length);
        }
        return s + JSON.stringify(block).length;
      }, 0);
    }
    return sum + JSON.stringify(m.content).length;
  }, 0);
}
