/**
 * Workspace context loader — reads the main agent workspace files.
 * 
 * Always injected (core identity, ~3000 tokens):
 *   SOUL.md, USER.md, MEMORY.md, TOOLS.md
 * 
 * Read on demand by the agent (via read tool):
 *   HEARTBEAT.md, IDENTITY.md, memory/*.md, PROJECT-*.md
 * 
 * Follows OpenClaw's pattern: small essential files always loaded,
 * everything else the agent reads when it needs it.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const AGENT_DIR = join(HOME, ".lobs", "agents", "main");
const WORKSPACE_DIR = join(HOME, ".openclaw", "workspace");

// Files always injected into context (kept small)
const ALWAYS_LOADED = ["SOUL.md", "USER.md", "MEMORY.md", "TOOLS.md"];

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
 * Load workspace context — only essential files, always fresh.
 * 
 * The agent has access to read any file on demand. We only inject
 * what it needs every single turn: identity, personality, memory index, tools.
 */
export function loadWorkspaceContext(): string {
  const sections: string[] = [];

  for (const filename of ALWAYS_LOADED) {
    const content = readAgentFile(filename);
    if (content) {
      sections.push(`## ${filename}\n${content}`);
    }
  }

  // Tell the agent what other files are available to read
  const available: string[] = [];
  
  // Check for on-demand files
  if (readAgentFile("HEARTBEAT.md")) available.push("HEARTBEAT.md — heartbeat checklist (read during heartbeats)");
  if (readAgentFile("IDENTITY.md")) available.push("IDENTITY.md — extended identity info");
  
  // List project files (deduplicated)
  const projectFiles = new Set<string>();
  for (const dir of [join(AGENT_DIR, "context"), WORKSPACE_DIR]) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith("PROJECT-") && f.endsWith(".md")) {
          projectFiles.add(f);
        }
      }
    } catch {}
  }
  for (const f of projectFiles) {
    available.push(`${f} — read when that project comes up`);
  }

  // Today's memory
  const today = getDateString(0);
  const todayPath = findMemoryPath(today);
  if (todayPath) available.push(`memory/${today}.md — today's memory log (read for recent context)`);
  
  const yesterday = getDateString(-1);
  const yesterdayPath = findMemoryPath(yesterday);
  if (yesterdayPath) available.push(`memory/${yesterday}.md — yesterday's memory`);

  if (available.length > 0) {
    sections.push(`## Available Files (read on demand)\nThese files are at \`~/.lobs/agents/main/\` (or \`context/\` subdirectory). Use the \`read\` tool when you need them.\n${available.map(a => `- ${a}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

function getDateString(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function findMemoryPath(date: string): string | null {
  const paths = [
    join(AGENT_DIR, "context", "memory", `${date}.md`),
    join(WORKSPACE_DIR, "memory", `${date}.md`),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}
