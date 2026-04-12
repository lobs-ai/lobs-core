/**
 * Smarter context compaction for agent conversations.
 *
 * Architecture (Claude Code-inspired):
 * 1. Microcompact  — runs every turn before the API call; clears old tool
 *    results entirely (replaces with stub), keeps N most recent intact.
 * 2. Full compact  — triggers at threshold; uses LLM to generate a structured
 *    9-section summary with an <analysis> scratchpad that gets stripped before
 *    the summary reaches context.
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

export interface CompactionResult {
  messages: LLMMessage[];
  compacted: boolean;
  originalCount: number;
  newCount: number;
}

const DEFAULT_CONFIG: CompactionConfig = {
  threshold: 120_000,
  summarizeRatio: 0.6,
  model: getModelForTier("small"),
  maxSummaryTokens: 16384,
  preserveIdentifiers: true,
};

// ---------------------------------------------------------------------------
// Full compaction — LLM-generated structured summary
// ---------------------------------------------------------------------------

const COMPACT_SYSTEM_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests. If your last task was concluded, then only list next steps if they are explicitly in line with the users request.
   If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`;

/**
 * Strip the <analysis> scratchpad and extract/reformat the <summary> block.
 */
export function formatCompactSummary(summary: string): string {
  let formatted = summary;
  // Strip analysis section (drafting scratchpad — not useful in context)
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, "");
  // Extract summary section content and reformat with a plain header
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    formatted = formatted.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${(summaryMatch[1] || "").trim()}`,
    );
  }
  formatted = formatted.replace(/\n\n+/g, "\n\n");
  return formatted.trim();
}

/**
 * Full LLM-based compaction. Triggers when context exceeds threshold.
 * Sends the full conversation to the summarizer (capped at 100K chars)
 * so the model can extract what matters rather than us pre-truncating.
 */
export async function compactMessages(
  messages: LLMMessage[],
  config: Partial<CompactionConfig> = {},
): Promise<CompactionResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const totalChars = calculateContextSize(messages);

  if (totalChars < cfg.threshold) {
    return { messages, compacted: false, originalCount: messages.length, newCount: messages.length };
  }

  console.log(`[compaction] Context at ${totalChars} chars (threshold: ${cfg.threshold}), compacting...`);

  const splitPoint = findSafeSplitPoint(messages, Math.floor(messages.length * cfg.summarizeRatio));
  const toSummarize = messages.slice(0, splitPoint);
  const toKeep = messages.slice(splitPoint);

  // Build the full conversation text for the summarizer.
  // Include more detail than before — the model handles extraction.
  const conversationText = toSummarize
    .map((m, i) => {
      const role = m.role.toUpperCase();
      const content =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as Array<Record<string, unknown>>)
                .map(block => {
                  if (typeof block === "string") return block;
                  const b = block as Record<string, unknown>;
                  if (b.type === "text") return String(b.text || "");
                  if (b.type === "tool_use") {
                    return `[Tool call: ${b.name}(${JSON.stringify(b.input).substring(0, 500)})]`;
                  }
                  if (b.type === "tool_result") {
                    const rc =
                      typeof b.content === "string" ? b.content : JSON.stringify(b.content);
                    // Keep more of tool results — they contain important findings
                    return `[Tool result: ${String(rc).substring(0, 2000)}]`;
                  }
                  return "[content block]";
                })
                .join("\n")
            : JSON.stringify(m.content).substring(0, 1000);
      return `[${i}] ${role}: ${content}`;
    })
    .join("\n\n");

  // Cap at 100K chars for the summarizer input
  const cappedInput =
    conversationText.length > 100_000
      ? conversationText.substring(0, 100_000) +
        "\n\n[...conversation truncated for summarization]"
      : conversationText;

  try {
    const modelConfig = parseModelString(cfg.model);
    const client = await createClient(modelConfig);

    const response = await client.createMessage({
      model: modelConfig.modelId,
      system: COMPACT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: cappedInput }],
      tools: [],
      maxTokens: cfg.maxSummaryTokens,
    });

    const rawSummary = (response.content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === "text")
      .map(b => b.text || "")
      .join("");

    const summary = formatCompactSummary(rawSummary);

    // Build the post-compact user message — matches Claude Code's format
    const summaryMessage = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${summary}

Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`;

    const compactedMessages: LLMMessage[] = [
      {
        role: "user",
        content: `[Conversation compacted — ${splitPoint} messages summarized]\n\n${summaryMessage}`,
      },
    ];

    // Only add ack if the next kept message isn't already assistant
    // (avoids consecutive assistant messages)
    if (toKeep.length === 0 || toKeep[0].role !== "assistant") {
      compactedMessages.push({
        role: "assistant",
        content: "Understood, I have the context from the summary. Continuing from where we left off.",
      });
    }

    compactedMessages.push(...toKeep);

    const newSize = calculateContextSize(compactedMessages);
    console.log(
      `[compaction] Compacted ${splitPoint} messages into summary (${totalChars} → ${newSize} chars, ${messages.length} → ${compactedMessages.length} messages)`,
    );

    return {
      messages: compactedMessages,
      compacted: true,
      originalCount: messages.length,
      newCount: compactedMessages.length,
    };
  } catch (err) {
    console.error("[compaction] LLM summary failed:", err);
    // Fallback: keep recent messages only
    return {
      messages: toKeep,
      compacted: true,
      originalCount: messages.length,
      newCount: toKeep.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Microcompact — clears old tool results before every API call
// ---------------------------------------------------------------------------

/**
 * Tool names whose results should be cleared when old enough.
 * These produce large outputs that are only relevant in the short term.
 */
const COMPACTABLE_TOOLS = new Set([
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "find_files",
  "code_search",
  // lowercase aliases
  "exec",
  "read",
  "grep",
  "glob",
]);

const CLEARED_MESSAGE = "[Old tool result content cleared]";

/**
 * Microcompact: clear old tool results before each API call.
 *
 * Key insight: if the model hasn't used a tool result in the last N turns,
 * it won't. Clearing it entirely is better than truncating — it removes the
 * token cost completely while keeping the structural turn intact.
 *
 * Keeps the N most recent compactable tool results intact.
 * Returns a new array — does NOT mutate the input.
 */
export function microcompact(
  messages: LLMMessage[],
  keepRecent: number = 8,
): LLMMessage[] {
  // Collect all compactable tool_use IDs in order (assistant messages)
  const compactableToolIds: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_use" && COMPACTABLE_TOOLS.has(String(block.name))) {
          compactableToolIds.push(String(block.id));
        }
      }
    }
  }

  // Keep the last N tool results; clear everything older
  const keepSet = new Set(compactableToolIds.slice(-keepRecent));
  const clearSet = new Set(compactableToolIds.filter(id => !keepSet.has(id)));

  if (clearSet.size === 0) return messages;

  let tokensSaved = 0;

  const result = messages.map(msg => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

    let touched = false;
    const newContent = (msg.content as Array<Record<string, unknown>>).map(block => {
      if (
        block.type === "tool_result" &&
        clearSet.has(String(block.tool_use_id)) &&
        block.content !== CLEARED_MESSAGE
      ) {
        const oldContent =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        tokensSaved += Math.ceil(oldContent.length / 4); // rough token estimate
        touched = true;
        return { ...block, content: CLEARED_MESSAGE };
      }
      return block;
    });

    if (!touched) return msg;
    return { ...msg, content: newContent };
  });

  if (tokensSaved > 0) {
    console.log(
      `[microcompact] Cleared ${clearSet.size} old tool results (~${tokensSaved} tokens saved)`,
    );
  }

  return result;
}

/**
 * Superseded Read Pruning — file-aware deduplication of read results.
 *
 * When the same file is read multiple times, all but the most recent read
 * are replaced with a stub. When a file is edited after a read, the pre-edit
 * read is also marked stale. This runs BEFORE microcompact so the recency
 * window operates on already-deduplicated content.
 *
 * Returns a new array — does NOT mutate the input.
 */

/** Returns true if `outer` read range fully covers `inner` read range. */
function rangeCovers(
  outer: { offset: number; limit: number; full: boolean },
  inner: { offset: number; limit: number; full: boolean },
): boolean {
  if (outer.full) return true;  // full read covers everything
  if (inner.full) return false; // a partial read can't cover a full read
  const outerEnd = outer.offset + outer.limit;
  const innerEnd = inner.offset + inner.limit;
  return outer.offset <= inner.offset && outerEnd >= innerEnd;
}

export function pruneSupersededReads(messages: LLMMessage[]): LLMMessage[] {
  // Step 1: Build a map of tool_use_id → { toolName, filePath, msgIndex, offset, limit, full }
  // by scanning assistant messages for Read/Edit tool_use blocks.
  // For Read tools, also capture offset/limit/full so we can do range-aware superseding.
  const toolUseMap = new Map<string, {
    toolName: string;
    filePath: string;
    msgIndex: number;
    offset: number;
    limit: number;
    full: boolean;
  }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_use") continue;
      const name = String(block.name || "");
      if (!["Read", "read", "Edit", "edit"].includes(name)) continue;

      const input = block.input as Record<string, unknown> | undefined;
      if (!input) continue;

      const filePath = String(input.file_path || input.path || "");
      if (!filePath) continue;

      const isRead = ["Read", "read"].includes(name);
      toolUseMap.set(String(block.id), {
        toolName: name,
        filePath,
        msgIndex: i,
        offset: isRead ? (typeof input.offset === "number" ? input.offset : 1) : 1,
        limit:  isRead ? (typeof input.limit  === "number" ? input.limit  : 500) : 500,
        full:   isRead ? (input.full === true) : false,
      });
    }
  }

  // Step 2: Build a map of filePath → list of file operations
  // by scanning user messages for tool_result blocks that match tracked tool_uses.
  type FileOperation = {
    toolUseId: string;
    toolName: string;
    msgIndex: number;       // assistant message index (tool_use)
    resultMsgIndex: number; // user message index (tool_result)
    offset: number;         // read start line (Read tools only)
    limit: number;          // max lines read (Read tools only)
    full: boolean;          // whether this was a full-file read
  };
  const fileOps = new Map<string, FileOperation[]>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      const toolUseId = String(block.tool_use_id || "");
      const info = toolUseMap.get(toolUseId);
      if (!info) continue;

      const ops = fileOps.get(info.filePath) || [];
      ops.push({
        toolUseId,
        toolName: info.toolName,
        msgIndex: info.msgIndex,
        resultMsgIndex: i,
        offset: info.offset,
        limit: info.limit,
        full: info.full,
      });
      fileOps.set(info.filePath, ops);
    }
  }

  // Step 3: For each file, determine which tool results to supersede.
  const toSupersede = new Map<string, string>(); // tool_use_id → reason message

  for (const [, ops] of fileOps) {
    if (ops.length <= 1) continue; // Only one operation — nothing to supersede

    // Sort chronologically by result message index
    ops.sort((a, b) => a.resultMsgIndex - b.resultMsgIndex);

    const reads = ops.filter(op => ["Read", "read"].includes(op.toolName));
    const edits = ops.filter(op => ["Edit", "edit"].includes(op.toolName));

    if (reads.length > 1) {
      // Multiple reads of same file — only supersede a read if a LATER read
      // fully covers its range. Non-overlapping partial reads are both kept.
      for (let i = 0; i < reads.length - 1; i++) {
        const earlier = reads[i];
        // Check whether any later read covers the earlier read's range
        const coveredByLater = reads
          .slice(i + 1)
          .some(later => rangeCovers(later, earlier));
        if (coveredByLater) {
          toSupersede.set(
            earlier.toolUseId,
            "[Superseded by a more recent read of this file — refer to the later result]",
          );
        }
      }
    }

    // If there are edits after a read, the pre-edit read content is stale
    if (edits.length > 0 && reads.length > 0) {
      const lastEdit = edits[edits.length - 1];
      for (const read of reads) {
        if (read.resultMsgIndex < lastEdit.resultMsgIndex && !toSupersede.has(read.toolUseId)) {
          toSupersede.set(
            read.toolUseId,
            "[File was edited after this read — content is outdated]",
          );
        }
      }
    }
  }

  if (toSupersede.size === 0) return messages;

  // Step 4: Replace superseded tool results with stubs.
  let tokensSaved = 0;
  const result = messages.map(msg => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

    let touched = false;
    const newContent = (msg.content as Array<Record<string, unknown>>).map(block => {
      if (block.type !== "tool_result") return block;
      const reason = toSupersede.get(String(block.tool_use_id));
      if (!reason) return block;

      // Don't supersede already-cleared results
      const existing = typeof block.content === "string" ? block.content : "";
      if (
        existing === CLEARED_MESSAGE ||
        existing.startsWith("[Superseded") ||
        existing.startsWith("[File was edited")
      ) {
        return block;
      }

      tokensSaved += Math.ceil(existing.length / 4);
      touched = true;
      return { ...block, content: reason };
    });

    if (!touched) return msg;
    return { ...msg, content: newContent };
  });

  if (tokensSaved > 0) {
    console.log(
      `[pruneSupersededReads] Replaced ${toSupersede.size} superseded read results (~${tokensSaved} tokens saved)`,
    );
  }

  return result;
}

/**
 * Prune old tool results before LLM calls.
 * First supersedes duplicate/stale file reads (file-aware), then clears
 * remaining old tool results by recency via microcompact.
 * Does NOT persist — only affects the current request's context.
 */
export function pruneToolResults(
  messages: LLMMessage[],
  keepRecentTurns: number = 8,
  _maxOldToolOutputChars: number = 300, // kept for signature compatibility
): LLMMessage[] {
  // First: supersede duplicate/stale reads (file-aware)
  const deduped = pruneSupersededReads(messages);
  // Then: clear remaining old tool results by recency
  return microcompact(deduped, keepRecentTurns);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a safe split point that doesn't orphan tool_result blocks.
 *
 * Claude's API requires every tool_result to have a matching tool_use in the
 * immediately preceding assistant message. If we split between an assistant
 * message with tool_use blocks and the following user message with tool_result
 * blocks, the kept portion starts with orphaned tool_results → 400 error.
 *
 * Strategy: walk backward from the target until the message at splitPoint is
 * NOT a user message containing tool_result blocks.
 */
export function findSafeSplitPoint(messages: LLMMessage[], targetSplit: number): number {
  let split = targetSplit;

  while (split > 0 && split < messages.length) {
    const msg = messages[split];

    if (msg.role === "user" && Array.isArray(msg.content)) {
      const hasToolResult = (msg.content as Array<Record<string, unknown>>).some(
        block => block.type === "tool_result",
      );
      if (hasToolResult) {
        split--;
        continue;
      }
    }

    break;
  }

  // Don't let split go below 2 (need at least something to summarize)
  return Math.max(split, 2);
}

/**
 * Calculate total context size in characters.
 * Handles all content block types properly.
 */
export function calculateContextSize(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => {
    if (typeof m.content === "string") return sum + m.content.length;
    if (Array.isArray(m.content)) {
      return (
        sum +
        (m.content as Array<Record<string, unknown>>).reduce(
          (s: number, block: Record<string, unknown>) => {
            if (typeof block === "string") return s + (block as string).length;
            if (block.type === "text") return s + String(block.text || "").length;
            if (block.type === "tool_result") {
              return (
                s +
                (typeof block.content === "string"
                  ? block.content.length
                  : JSON.stringify(block.content).length)
              );
            }
            return s + JSON.stringify(block).length;
          },
          0,
        )
      );
    }
    return sum + JSON.stringify(m.content).length;
  }, 0);
}
