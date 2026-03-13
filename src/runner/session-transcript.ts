/**
 * Session transcript persistence — save conversation history to JSONL during agent runs.
 *
 * Purpose:
 * - Resume interrupted runs
 * - Audit agent behavior
 * - Debug issues
 *
 * Format: `~/.lobs/agents/{agentType}/sessions/{runId}.jsonl`
 *
 * Each line is a JSON object representing a turn:
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

import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
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

  constructor(agentType: string, runId: string) {
    const homeDir = process.env.HOME ?? "";
    const sessionsDir = `${homeDir}/.lobs/agents/${agentType}/sessions`;
    mkdirSync(sessionsDir, { recursive: true });
    this.sessionPath = `${sessionsDir}/${runId}.jsonl`;
  }

  /**
   * Write a turn record to the session transcript.
   */
  writeTurn(record: TurnRecord): void {
    const line = JSON.stringify(record) + "\n";
    appendFileSync(this.sessionPath, line, "utf-8");
  }

  /**
   * Write the final summary entry.
   */
  writeSummary(summary: SessionSummary): void {
    const line = JSON.stringify(summary) + "\n";
    appendFileSync(this.sessionPath, line, "utf-8");
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
}
