/**
 * Workspace context loader — reads the main agent workspace files.
 * Follows the same pattern as worker agents (~/.lobs/agents/{type}/).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = join(homedir(), ".lobs", "agents", "main");
const WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace");

// Core files loaded in order (from agent workspace)
const AGENT_FILES = [
  "SYSTEM_PROMPT.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "AGENTS.md",
  "MEMORY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
];

/** Load workspace files into a single context string */
export function loadWorkspaceContext(): string {
  const sections: string[] = [];

  for (const filename of AGENT_FILES) {
    // Try agent workspace first, then fall back to openclaw workspace
    let filepath = join(AGENT_DIR, filename);
    if (!existsSync(filepath)) {
      filepath = join(WORKSPACE_DIR, filename);
    }
    if (!existsSync(filepath)) continue;

    try {
      const content = readFileSync(filepath, "utf-8");
      sections.push(`## ${filename}\n${content}`);
    } catch (err) {
      console.warn(`[workspace] Failed to read ${filename}:`, err);
    }
  }

  // Also load today's memory file
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  const memoryPaths = [
    join(AGENT_DIR, "context", "memory", `${today}.md`),
    join(WORKSPACE_DIR, "memory", `${today}.md`),
  ];
  for (const mp of memoryPaths) {
    if (existsSync(mp)) {
      try {
        const content = readFileSync(mp, "utf-8");
        sections.push(`## Today's Memory (${today})\n${content}`);
      } catch {}
      break;
    }
  }

  return sections.join("\n\n");
}

/** Build the main agent system prompt from SYSTEM_PROMPT.md */
export function buildMainAgentPrompt(): string {
  const promptPath = join(AGENT_DIR, "SYSTEM_PROMPT.md");
  if (existsSync(promptPath)) {
    try {
      return readFileSync(promptPath, "utf-8");
    } catch {}
  }

  // Fallback if no SYSTEM_PROMPT.md exists
  return `You are Lobs, a personal AI assistant running on lobs-core.
You have access to tools for file operations, shell commands, web search, memory, and communication.
Be direct, concise, and helpful. Follow SOUL.md for personality.`;
}
