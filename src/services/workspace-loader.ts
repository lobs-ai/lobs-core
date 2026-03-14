/**
 * Workspace context loader — reads the main agent workspace files.
 * 
 * Loads files from ~/.lobs/agents/main/ with fallback to ~/.openclaw/workspace/.
 * Context is structured and concise — no dumping entire files verbatim.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const AGENT_DIR = join(HOME, ".lobs", "agents", "main");
const WORKSPACE_DIR = join(HOME, ".openclaw", "workspace");

/**
 * Read a file from agent dir, falling back to workspace dir.
 */
function readAgentFile(filename: string): string | null {
  for (const dir of [AGENT_DIR, WORKSPACE_DIR]) {
    const fp = join(dir, filename);
    if (existsSync(fp)) {
      try {
        return readFileSync(fp, "utf-8");
      } catch {}
    }
  }
  return null;
}

/**
 * Build the main agent system prompt from SYSTEM_PROMPT.md
 */
export function buildMainAgentPrompt(): string {
  const content = readAgentFile("SYSTEM_PROMPT.md");
  if (content) return content;

  return `You are Lobs, a personal AI assistant running on lobs-core.
Be direct, concise, and helpful.`;
}

/**
 * Load workspace context — structured, concise, no bloat.
 * 
 * Priority order:
 * 1. SOUL.md — personality (always loaded, core identity)
 * 2. USER.md — about the human (always loaded)
 * 3. MEMORY.md — lean index (always loaded)
 * 4. TOOLS.md — tool notes and integrations (always loaded)
 * 5. HEARTBEAT.md — only loaded if this is a heartbeat
 * 6. Today's memory — recent context
 * 7. Yesterday's memory — continuity
 */
export function loadWorkspaceContext(isHeartbeat: boolean = false): string {
  const sections: string[] = [];

  // Core identity files — always loaded
  const coreFiles = ["SOUL.md", "USER.md", "MEMORY.md", "TOOLS.md"];
  if (isHeartbeat) coreFiles.push("HEARTBEAT.md");

  for (const filename of coreFiles) {
    const content = readAgentFile(filename);
    if (content) {
      sections.push(`## ${filename}\n${content}`);
    }
  }

  // Today's memory file
  const today = getDateString(0);
  const yesterday = getDateString(-1);

  for (const [label, date] of [["Today", today], ["Yesterday", yesterday]] as const) {
    const content = findMemoryFile(date);
    if (content) {
      // Truncate to last 4000 chars if huge
      const trimmed = content.length > 4000
        ? `...(earlier entries truncated)\n\n${content.slice(-4000)}`
        : content;
      sections.push(`## ${label}'s Memory (${date})\n${trimmed}`);
    }
  }

  return sections.join("\n\n");
}

/**
 * Get date string in YYYY-MM-DD format, offset by days from today.
 */
function getDateString(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Find and read a memory file for a given date.
 */
function findMemoryFile(date: string): string | null {
  const paths = [
    join(AGENT_DIR, "context", "memory", `${date}.md`),
    join(WORKSPACE_DIR, "memory", `${date}.md`),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {}
    }
  }
  return null;
}

/**
 * List available project context files.
 */
export function listProjectFiles(): string[] {
  const files: string[] = [];
  for (const dir of [join(AGENT_DIR, "context"), WORKSPACE_DIR]) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith("PROJECT-") && f.endsWith(".md")) {
          files.push(f);
        }
      }
    } catch {}
  }
  return [...new Set(files)];
}
