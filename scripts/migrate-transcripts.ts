#!/usr/bin/env npx tsx
/**
 * One-time migration: convert existing JSONL session transcripts to markdown.
 * 
 * Usage: npx tsx scripts/migrate-transcripts.ts [--dry-run]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Import the converter from session-transcript
// We inline a simplified version here to avoid build dependency issues
interface TurnRecord {
  turn: number;
  timestamp: string;
  messages: any[];
  response: any;
  usage: any;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
}

interface SessionSummary {
  type: "summary";
  runId: string;
  agentType: string;
  taskId?: string;
  succeeded: boolean;
  totalTurns: number;
  totalUsage: any;
  durationSeconds: number;
  stopReason: string;
  error?: string;
  timestamp: string;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read": case "read": return `Read \`${input.path ?? "?"}\``;
    case "Write": case "write": return `Write \`${input.path ?? "?"}\``;
    case "Edit": case "edit": return `Edit \`${input.path ?? "?"}\``;
    case "exec": return `Exec: \`${truncate(String(input.command ?? ""), 120)}\``;
    case "Grep": case "grep": return `Grep \`${input.pattern ?? "?"}\`${input.path ? ` in ${input.path}` : ""}`;
    case "Glob": case "glob": return `Glob \`${input.pattern ?? "?"}\``;
    case "ls": return `ls \`${input.path ?? "."}\``;
    case "web_search": return `Search: "${truncate(String(input.query ?? ""), 100)}"`;
    case "web_fetch": return `Fetch: ${truncate(String(input.url ?? ""), 100)}`;
    case "memory_search": return `Memory search: "${truncate(String(input.query ?? ""), 100)}"`;
    case "memory_write": return `Memory write (${input.category ?? "?"}): ${truncate(String(input.content ?? ""), 100)}`;
    case "spawn_agent": return `Spawn ${input.agent_type ?? "?"}: ${truncate(String(input.task ?? ""), 120)}`;
    case "process": return `Process ${input.action ?? "?"}: ${truncate(String(input.command ?? input.sessionId ?? ""), 80)}`;
    default:
      const firstKey = Object.keys(input).find(k => typeof input[k] === "string" && (input[k] as string).length > 0);
      if (firstKey) return `${name}: ${truncate(String(input[firstKey]), 100)}`;
      return name;
  }
}

function extractAssistantText(response: any): string {
  if (!response?.content) return "";
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text" && block.text?.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join("\n\n");
}

function extractUserText(messages: any[]): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b: any) => b.type === "text" && b.text?.trim())
        .map((b: any) => b.text.trim())
        .join("\n\n");
    }
  }
  return "";
}

function convertJsonlToMarkdown(jsonlContent: string, agentType: string, filename: string): string | null {
  const lines = jsonlContent.trim().split("\n").filter(l => l.length > 0);
  
  const turns: TurnRecord[] = [];
  let summary: SessionSummary | null = null;

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.type === "summary") {
        summary = record;
      } else if (record.turn !== undefined) {
        turns.push(record);
      }
    } catch {
      continue;
    }
  }

  if (turns.length === 0) return null;

  // If no summary, synthesize one from what we have
  if (!summary) {
    const lastTurn = turns[turns.length - 1];
    summary = {
      type: "summary",
      runId: filename.replace(".jsonl", ""),
      agentType,
      succeeded: true,
      totalTurns: turns.length,
      totalUsage: lastTurn.usage ?? {},
      durationSeconds: 0,
      stopReason: "unknown",
      timestamp: lastTurn.timestamp ?? new Date().toISOString(),
    };
  }

  const md: string[] = [];
  const date = summary.timestamp ? new Date(summary.timestamp).toISOString().slice(0, 10) : "unknown";
  const status = summary.succeeded ? "✓ succeeded" : "✗ failed";
  const duration = summary.durationSeconds < 60
    ? `${Math.round(summary.durationSeconds)}s`
    : `${Math.round(summary.durationSeconds / 60)}m`;

  md.push(`# Session: ${summary.agentType} — ${date}`);
  md.push("");
  md.push(`- **Run ID:** ${summary.runId}`);
  if (summary.taskId) md.push(`- **Task:** ${summary.taskId}`);
  md.push(`- **Status:** ${status}`);
  md.push(`- **Turns:** ${summary.totalTurns}`);
  md.push(`- **Duration:** ${duration}`);
  md.push(`- **Stop reason:** ${summary.stopReason}`);
  if (summary.error) md.push(`- **Error:** ${summary.error}`);
  md.push("");

  // Task
  if (turns.length > 0) {
    const taskText = extractUserText(turns[0].messages);
    if (taskText) {
      md.push("## Task");
      md.push("");
      md.push(taskText);
      md.push("");
    }
  }

  // Conversation
  md.push("## Conversation");
  md.push("");

  for (const turn of turns) {
    md.push(`### Turn ${turn.turn}`);
    md.push("");

    const assistantText = extractAssistantText(turn.response);
    if (assistantText) {
      md.push(`**Assistant:** ${assistantText}`);
      md.push("");
    }

    if (turn.toolCalls && turn.toolCalls.length > 0) {
      for (const tc of turn.toolCalls) {
        const toolSummary = summarizeToolCall(tc.name, tc.input);
        md.push(`- 🔧 ${toolSummary}`);
      }
      md.push("");
    }
  }

  return md.join("\n");
}

// --- Main ---

const dryRun = process.argv.includes("--dry-run");
const homeDir = process.env.HOME ?? "";
const agentsDir = join(homeDir, ".lobs/agents");

if (!existsSync(agentsDir)) {
  console.log("No agents directory found. Nothing to migrate.");
  process.exit(0);
}

const agents = readdirSync(agentsDir);
let converted = 0;
let skipped = 0;
let errors = 0;

for (const agent of agents) {
  const sessionsDir = join(agentsDir, agent, "sessions");
  if (!existsSync(sessionsDir)) continue;

  const files = readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
  
  for (const file of files) {
    const jsonlPath = join(sessionsDir, file);
    const mdPath = join(sessionsDir, file.replace(".jsonl", ".md"));

    // Skip if markdown already exists
    if (existsSync(mdPath)) {
      skipped++;
      continue;
    }

    try {
      const content = readFileSync(jsonlPath, "utf-8");
      const markdown = convertJsonlToMarkdown(content, agent, file);
      
      if (!markdown) {
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`[dry-run] Would create: ${mdPath} (${markdown.length} chars)`);
      } else {
        writeFileSync(mdPath, markdown, "utf-8");
        console.log(`Created: ${mdPath.replace(homeDir, "~")}`);
      }
      converted++;
    } catch (err) {
      console.error(`Error converting ${jsonlPath}:`, err);
      errors++;
    }
  }
}

console.log(`\nMigration complete: ${converted} converted, ${skipped} skipped, ${errors} errors`);
