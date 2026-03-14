/**
 * Workspace context loader for ALL agent types.
 *
 * Each agent at ~/.lobs/agents/{type}/ gets:
 *   Always injected: AGENTS.md, SOUL.md (+ USER.md, MEMORY.md, TOOLS.md for main)
 *   On demand: everything else (HEARTBEAT.md, memory/*.md, PROJECT-*.md, etc.)
 *
 * Follows OpenClaw's pattern: small essential files always loaded,
 * everything else the agent reads when it needs it.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const AGENTS_BASE = join(HOME, ".lobs", "agents");
const WORKSPACE_DIR = join(HOME, ".openclaw", "workspace");

// ── Per-Agent Config ─────────────────────────────────────────────────────────

/**
 * Files always injected by agent type.
 * Main agent gets more because it's the chat interface with identity/memory.
 * Worker agents get their instructions + personality.
 */
const ALWAYS_LOADED: Record<string, string[]> = {
  main:       ["SOUL.md", "USER.md", "MEMORY.md", "TOOLS.md"],
  programmer: ["AGENTS.md", "SOUL.md"],
  writer:     ["AGENTS.md", "SOUL.md"],
  researcher: ["AGENTS.md", "SOUL.md"],
  reviewer:   ["AGENTS.md", "SOUL.md"],
  architect:  ["AGENTS.md", "SOUL.md"],
};

const DEFAULT_ALWAYS_LOADED = ["AGENTS.md", "SOUL.md"];

// ── File Reading ─────────────────────────────────────────────────────────────

/**
 * Get the base directory for an agent type.
 */
function agentDir(agentType: string): string {
  return join(AGENTS_BASE, agentType);
}

/**
 * Read a file from agent dir, optionally falling back to workspace dir.
 * Main agent falls back to OpenClaw workspace for compatibility.
 */
function readFile(agentType: string, filename: string): string | null {
  const dirs = [agentDir(agentType)];

  // Main agent also checks OpenClaw workspace (backwards compat)
  if (agentType === "main") {
    dirs.push(WORKSPACE_DIR);
  }

  for (const dir of dirs) {
    const fp = join(dir, filename);
    if (existsSync(fp)) {
      try {
        return readFileSync(fp, "utf-8");
      } catch {}
    }
  }
  return null;
}

// ── System Prompt ────────────────────────────────────────────────────────────

/**
 * Build a system prompt for any agent type.
 * Reads SYSTEM_PROMPT.md if it exists, otherwise returns a sensible default.
 */
export function buildSystemPrompt(agentType: string = "main"): string {
  const content = readFile(agentType, "SYSTEM_PROMPT.md");
  if (content) return content;

  if (agentType === "main") {
    return `You are Lobs, a personal AI assistant running on lobs-core.
Be direct, concise, and helpful.`;
  }

  return `You are a ${agentType} agent running on lobs-core.
Complete your assigned task thoroughly and correctly.`;
}

// Keep old name as alias for backwards compat
export const buildMainAgentPrompt = () => buildSystemPrompt("main");

// ── Workspace Context ────────────────────────────────────────────────────────

/**
 * Load workspace context for any agent type.
 *
 * Injects the essential files for that agent, plus tells it what other
 * files are available to read on demand.
 */
export function loadWorkspaceContext(agentType: string = "main"): string {
  const alwaysLoaded = ALWAYS_LOADED[agentType] ?? DEFAULT_ALWAYS_LOADED;
  const baseDir = agentDir(agentType);
  const sections: string[] = [];

  // Load essential files
  for (const filename of alwaysLoaded) {
    const content = readFile(agentType, filename);
    if (content) {
      sections.push(`## ${filename}\n${content}`);
    }
  }

  // Build list of on-demand files
  const available: string[] = [];

  // Check for common on-demand files in the agent dir
  const onDemandCandidates = ["HEARTBEAT.md", "IDENTITY.md", "TOOLS.md", "USER.md", "MEMORY.md"];
  for (const filename of onDemandCandidates) {
    // Skip if it's already in always-loaded
    if (alwaysLoaded.includes(filename)) continue;
    if (readFile(agentType, filename)) {
      available.push(filename);
    }
  }

  // List project files (deduplicated)
  const projectFiles = new Set<string>();
  const contextDir = join(baseDir, "context");
  const searchDirs = [contextDir];
  if (agentType === "main") searchDirs.push(WORKSPACE_DIR);

  for (const dir of searchDirs) {
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
    available.push(`${f} — project details`);
  }

  // Memory files (today + yesterday)
  const today = getDateString(0);
  if (findMemoryPath(agentType, today)) {
    available.push(`memory/${today}.md — today's memory`);
  }
  const yesterday = getDateString(-1);
  if (findMemoryPath(agentType, yesterday)) {
    available.push(`memory/${yesterday}.md — yesterday's memory`);
  }

  // History files for worker agents
  if (agentType !== "main") {
    const historyDir = join(baseDir, "history");
    if (existsSync(historyDir)) {
      try {
        const histFiles = readdirSync(historyDir).filter(f => f.endsWith(".md")).length;
        if (histFiles > 0) {
          available.push(`history/ — ${histFiles} past run summaries`);
        }
      } catch {}
    }
  }

  if (available.length > 0) {
    sections.push(
      `## Available Files (read on demand)\n` +
      `Located at \`~/.lobs/agents/${agentType}/\` (and \`context/\` subdirectory).\n` +
      `Use the \`read\` tool when you need them.\n` +
      available.map(a => `- ${a}`).join("\n")
    );
  }

  return sections.join("\n\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDateString(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function findMemoryPath(agentType: string, date: string): string | null {
  const paths = [
    join(agentDir(agentType), "context", "memory", `${date}.md`),
  ];
  if (agentType === "main") {
    paths.push(join(WORKSPACE_DIR, "memory", `${date}.md`));
  }
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}
