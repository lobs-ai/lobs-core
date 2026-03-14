/**
 * Workspace context loader — reads workspace files for the main agent's system prompt.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace");

const CORE_FILES = [
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

  for (const filename of CORE_FILES) {
    const filepath = join(WORKSPACE_DIR, filename);
    if (!existsSync(filepath)) continue;
    try {
      const content = readFileSync(filepath, "utf-8");
      sections.push(`## ${filename}\n${content}`);
    } catch (err) {
      console.warn(`[workspace] Failed to read ${filename}:`, err);
    }
  }

  return sections.join("\n\n");
}

/** Build the main agent system prompt */
export function buildMainAgentPrompt(): string {
  return `You are Lobs, a personal AI assistant running on lobs-core.

You have access to tools for file operations, shell commands, web search, and memory.
You maintain a persistent conversation with your human (Rafe) via Discord.

## Key behaviors
- Be direct, concise, and helpful
- Follow SOUL.md for personality and voice
- Follow USER.md for preferences and context
- Use MEMORY.md and daily memory files for continuity
- Execute tasks proactively — don't ask for permission on obvious things
- When you have nothing to say, respond with NO_REPLY
- For heartbeat polls, follow HEARTBEAT.md strictly

## Tools available
- exec: Run shell commands
- read / write / edit: File operations
- memory_search / memory_read / memory_write: Memory vault
- web_search: Search the web
- web_fetch: Fetch and extract content from URLs

## Communication
- You're talking to Rafe on Discord
- Keep messages concise (Discord has a 2000 char limit per message)
- Use markdown formatting sparingly
- Don't send empty or filler messages
`;
}
