/**
 * Session transcript persistence — save conversation history to JSONL during agent runs.
 * Also generates a human-readable markdown transcript for memory indexing.
 *
 * Purpose:
 * - Resume interrupted runs (JSONL)
 * - Audit agent behavior (JSONL + Markdown)
 * - Memory indexing and search (Markdown)
 *
 * Formats:
 * - `~/.lobs/agents/{agentType}/sessions/{runId}.jsonl` — machine-readable, for resumption
 * - `~/.lobs/agents/{agentType}/sessions/{runId}.md` — human-readable, for memory indexing
 *
 * JSONL: each line is a JSON object representing a turn:
 * {
 *   "turn": 1,
 *   "timestamp": "2025-03-13T18:30:00.000Z",
 *   "messages": [...],
 *   "response": {...},
 *   "usage": {...},
 *   "toolCalls": [...]
 * }
 *
 * Final line is a summary entry with "type": "summary".
 */

import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LLMMessage, LLMResponse } from "./providers.js";
import type { TokenUsage } from "./types.js";

export interface TurnRecord {
  turn: number;
  timestamp: string;
  messages: LLMMessage[];
  response: LLMResponse;
  usage: TokenUsage;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
}

export interface SessionSummary {
  type: "summary";
  runId: string;
  agentType: string;
  taskId?: string;
  succeeded: boolean;
  totalTurns: number;
  totalUsage: TokenUsage;
  durationSeconds: number;
  stopReason: string;
  error?: string;
  timestamp: string;
}

export class SessionTranscript {
  private sessionPath: string;
  private markdownPath: string;
  private agentType: string;
  private runId: string;

  constructor(agentType: string, runId: string) {
    const homeDir = process.env.HOME ?? "";
    const sessionsDir = `${homeDir}/.lobs/agents/${agentType}/sessions`;
    mkdirSync(sessionsDir, { recursive: true });
    this.sessionPath = `${sessionsDir}/${runId}.jsonl`;
    this.markdownPath = `${sessionsDir}/${runId}.md`;
    this.agentType = agentType;
    this.runId = runId;
  }

  /**
   * Write a turn record to the session transcript.
   */
  writeTurn(record: TurnRecord): void {
    const line = JSON.stringify(record) + "\n";
    appendFileSync(this.sessionPath, line, "utf-8");
  }

  /**
   * Write the final summary entry and generate markdown transcript.
   */
  writeSummary(summary: SessionSummary): void {
    const line = JSON.stringify(summary) + "\n";
    appendFileSync(this.sessionPath, line, "utf-8");

    // Generate markdown transcript from the JSONL
    try {
      this.generateMarkdown(summary);
    } catch (err) {
      console.error(`[session-transcript] Failed to generate markdown for ${this.runId}:`, err);
    }
  }

  /**
   * Generate a human-readable markdown transcript from the JSONL file.
   * This is what gets indexed by lobs-memory for semantic search.
   */
  private generateMarkdown(summary: SessionSummary): void {
    const turns = SessionTranscript.load(this.agentType, this.runId);
    if (turns.length === 0) return;

    const md = convertToMarkdown(turns, summary);
    writeFileSync(this.markdownPath, md, "utf-8");
  }

  /**
   * Check if a session transcript exists.
   */
  static exists(agentType: string, runId: string): boolean {
    const homeDir = process.env.HOME ?? "";
    const sessionPath = `${homeDir}/.lobs/agents/${agentType}/sessions/${runId}.jsonl`;
    return existsSync(sessionPath);
  }

  /**
   * Load a session transcript for resuming.
   * Returns all turn records (excluding summary).
   */
  static load(agentType: string, runId: string): TurnRecord[] {
    const homeDir = process.env.HOME ?? "";
    const sessionPath = `${homeDir}/.lobs/agents/${agentType}/sessions/${runId}.jsonl`;

    if (!existsSync(sessionPath)) {
      return [];
    }

    const content = readFileSync(sessionPath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);

    const turns: TurnRecord[] = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.type !== "summary") {
          turns.push(record as TurnRecord);
        }
      } catch {
        // Skip invalid lines
      }
    }

    return turns;
  }

  /**
   * Load the conversation messages from the last turn of a session.
   * Returns the full message history + the assistant's final response,
   * ready to be used as `resumeMessages` in AgentSpec.
   *
   * Returns null if the session doesn't exist, has no turns, or is corrupt.
   */
  static loadResumableMessages(agentType: string, runId: string): LLMMessage[] | null {
    const homeDir = process.env.HOME ?? "";
    const sessionPath = `${homeDir}/.lobs/agents/${agentType}/sessions/${runId}.jsonl`;

    if (!existsSync(sessionPath)) return null;

    try {
      const content = readFileSync(sessionPath, "utf-8");
      const lines = content.trim().split("\n").filter((l) => l.length > 0);

      // Find the last non-summary turn (reading backwards for efficiency)
      let lastTurn: TurnRecord | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const record = JSON.parse(lines[i]);
          if (record.type === "summary") continue;
          if (record.turn && record.messages) {
            lastTurn = record as TurnRecord;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!lastTurn || !lastTurn.messages || lastTurn.messages.length === 0) {
        return null;
      }

      // Start with the messages that were sent TO the LLM on the last turn
      const messages: LLMMessage[] = [...lastTurn.messages];

      // Append the assistant's response from that turn
      if (lastTurn.response?.content) {
        messages.push({
          role: "assistant",
          content: lastTurn.response.content as LLMMessage["content"],
        });

        // If the last response was tool_use, we need to include the tool results
        // that would have been generated (they're in the NEXT turn's messages).
        // Since there IS no next turn (session was interrupted), we inject a
        // synthetic tool result telling the agent the tools were interrupted.
        if (lastTurn.response.stopReason === "tool_use") {
          const toolCalls = lastTurn.response.content.filter(
            (block: any) => block.type === "tool_use"
          );
          if (toolCalls.length > 0) {
            const syntheticResults: any[] = toolCalls.map((tc: any) => ({
              type: "tool_result",
              tool_use_id: tc.id,
              content: "[Session interrupted — tool execution was cut short by process restart. Re-run if needed.]",
              is_error: true,
            }));
            messages.push({
              role: "user",
              content: syntheticResults,
            });
          }
        }
      }

      return messages;
    } catch (err) {
      console.error(`[session-transcript] Failed to load resumable messages for ${runId}:`, err);
      return null;
    }
  }

  /**
   * Load the last summary from a JSONL transcript.
   * When a session is resumed, the file may contain multiple summaries —
   * we want the most recent one (last in file).
   */
  static loadSummary(agentType: string, runId: string): SessionSummary | null {
    const homeDir = process.env.HOME ?? "";
    const sessionPath = `${homeDir}/.lobs/agents/${agentType}/sessions/${runId}.jsonl`;

    if (!existsSync(sessionPath)) return null;

    const content = readFileSync(sessionPath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);

    // Read backwards to find the last summary
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const record = JSON.parse(lines[i]);
        if (record.type === "summary") return record as SessionSummary;
      } catch {
        // Skip
      }
    }
    return null;
  }
}

/**
 * Convert JSONL turn records + summary into a clean markdown transcript.
 * 
 * Design goals:
 * - Readable by humans and useful for semantic search
 * - Captures the task, key decisions, tool usage, and outcomes
 * - Omits raw tool I/O noise (file contents, large outputs) but keeps tool names + summaries
 * - Structured with clear turn boundaries
 */
export function convertToMarkdown(turns: TurnRecord[], summary: SessionSummary): string {
  const lines: string[] = [];
  const date = summary.timestamp ? new Date(summary.timestamp).toISOString().slice(0, 10) : "unknown";
  const status = summary.succeeded ? "✓ succeeded" : "✗ failed";
  const duration = summary.durationSeconds < 60
    ? `${Math.round(summary.durationSeconds)}s`
    : `${Math.round(summary.durationSeconds / 60)}m`;

  // Header
  lines.push(`# Session: ${summary.agentType} — ${date}`);
  lines.push("");
  lines.push(`- **Run ID:** ${summary.runId}`);
  if (summary.taskId) lines.push(`- **Task:** ${summary.taskId}`);
  lines.push(`- **Status:** ${status}`);
  lines.push(`- **Turns:** ${summary.totalTurns}`);
  lines.push(`- **Duration:** ${duration}`);
  lines.push(`- **Stop reason:** ${summary.stopReason}`);
  if (summary.error) lines.push(`- **Error:** ${summary.error}`);
  lines.push("");

  // Extract the initial task from turn 1
  if (turns.length > 0) {
    const firstTurn = turns[0];
    const taskText = extractUserText(firstTurn.messages);
    if (taskText) {
      lines.push("## Task");
      lines.push("");
      lines.push(taskText);
      lines.push("");
    }
  }

  // Conversation turns
  lines.push("## Conversation");
  lines.push("");

  for (const turn of turns) {
    lines.push(`### Turn ${turn.turn}`);
    lines.push("");

    // User message (only from this turn's new messages — skip the accumulated history)
    // In the JSONL format, messages contains the full history up to that point.
    // We only want the NEW user message for this turn, which is the task on turn 1
    // and tool results on subsequent turns.
    // For turn 1, we already showed the task above. For later turns, the "user" message
    // is tool results, which we show below as part of tool calls.

    // Assistant response
    const assistantText = extractAssistantText(turn.response);
    if (assistantText) {
      lines.push(`**Assistant:** ${assistantText}`);
      lines.push("");
    }

    // Tool calls
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      for (const tc of turn.toolCalls) {
        const toolSummary = summarizeToolCall(tc.name, tc.input);
        lines.push(`- 🔧 ${toolSummary}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Extract user text from messages array.
 */
function extractUserText(messages: LLMMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    return extractContentText(msg.content);
  }
  return "";
}

/**
 * Extract assistant text from LLM response.
 */
function extractAssistantText(response: LLMResponse): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text" && block.text?.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join("\n\n");
}

/**
 * Extract text from message content (string or content blocks array).
 */
function extractContentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && (block as any).text?.trim()) {
      parts.push((block as any).text.trim());
    }
    // Skip tool_result blocks — they're noise for the transcript
  }
  return parts.join("\n\n");
}

/**
 * Create a concise human-readable summary of a tool call.
 */
function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
    case "read":
      return `Read \`${input.path ?? "?"}\``;
    case "Write":
    case "write":
      return `Write \`${input.path ?? "?"}\``;
    case "Edit":
    case "edit":
      return `Edit \`${input.path ?? "?"}\``;
    case "exec":
      return `Exec: \`${truncate(String(input.command ?? ""), 120)}\``;
    case "Grep":
    case "grep":
      return `Grep \`${input.pattern ?? "?"}\`${input.path ? ` in ${input.path}` : ""}`;
    case "Glob":
    case "glob":
      return `Glob \`${input.pattern ?? "?"}\``;
    case "ls":
      return `ls \`${input.path ?? "."}\``;
    case "web_search":
      return `Search: "${truncate(String(input.query ?? ""), 100)}"`;
    case "web_fetch":
      return `Fetch: ${truncate(String(input.url ?? ""), 100)}`;
    case "memory_search":
      return `Memory search: "${truncate(String(input.query ?? ""), 100)}"`;
    case "memory_write":
      return `Memory write (${input.category ?? "?"}): ${truncate(String(input.content ?? ""), 100)}`;
    case "spawn_agent":
      return `Spawn ${input.agent_type ?? "?"}: ${truncate(String(input.task ?? ""), 120)}`;
    case "process":
      return `Process ${input.action ?? "?"}: ${truncate(String(input.command ?? input.sessionId ?? ""), 80)}`;
    case "imagine":
      return `Generate image: "${truncate(String(input.prompt ?? ""), 100)}"`;
    case "humanize":
      return `Humanize check${input.path ? `: ${input.path}` : ""}`;
    case "html_to_pdf":
      return `Generate PDF${input.filename ? `: ${input.filename}` : ""}`;
    default:
      // Generic fallback — show name + first meaningful param
      const firstKey = Object.keys(input).find(k => typeof input[k] === "string" && (input[k] as string).length > 0);
      if (firstKey) {
        return `${name}: ${truncate(String(input[firstKey]), 100)}`;
      }
      return name;
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}
