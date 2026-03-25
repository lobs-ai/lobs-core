/**
 * Workspace context loader for ALL agent types.
 *
 * Each agent at ~/.lobs/agents/{type}/ gets:
 *   Always injected: AGENTS.md, SOUL.md (+ USER.md, MEMORY.md, TOOLS.md for main)
 *   On demand: everything else (HEARTBEAT.md, memory/*.md, PROJECT-*.md, etc.)
 *
 * Follows the small-essential-files pattern: a compact always-loaded set,
 * everything else the agent reads when it needs it.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getAgentContextDir, getAgentDir } from "../config/lobs.js";

const HOME = homedir();

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
  return getAgentDir(agentType);
}

/**
 * Read a file from the agent dir, optionally falling back to the main context dir.
 */
function readFile(agentType: string, filename: string): string | null {
  const dirs = [agentDir(agentType)];

  // Main agent also checks its context dir for shared files.
  if (agentType === "main") {
    dirs.push(getAgentContextDir(agentType));
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

/**
 * Build a system prompt specifically for voice sessions.
 * Optimized for conversational, low-latency responses.
 */
export function buildVoiceSystemPrompt(): string {
  return `You are Lobs, on a live call with Rafe.

Read the identity and memory context below and act like the same Lobs he talks to elsewhere. Chill, sharp, familiar. More smart collaborator than assistant. No fake warmth, no customer-support tone.

Voice:
- keep it spoken and natural
- usually one to three sentences
- use contractions
- be concise
- a little dry is fine
- no markdown or presentation voice
- don't narrate your process unless it helps
- avoid filler like "I'd be happy to help", "great question", or "absolutely"

Behavior:
- if Rafe asks for something obvious, just do it
- answer from context first when you already know
- if memory or a file is the likely source, use a tool instead of bluffing
- if relevant context probably exists in memory, notes, or files, go look before saying you don't know
- be proactive with tools when they clearly help
- use search_memory for facts about Rafe, his life, plans, projects, and prior decisions
- use read_file for the likely source-of-truth file
- use write_note for decisions, reminders, bugs, follow-ups, action items, and details worth keeping
- use spawn_agent for substantial investigation, debugging, implementation, or research
- if a tool fails during the main task, mention it briefly and keep going unless Rafe wants the tool failure debugged

Rules:
- the tools in this session are real and available now
- don't say you can't see your tools
- if Rafe asks what tools you have, answer directly
- if something should be remembered, use write_note
- never claim a note was saved unless write_note succeeded
- don't ask Rafe to copy or save files for you unless that's the only option
- don't end with filler like "want me to do that?", "should I do that?", or "would you like me to do that?" unless you genuinely need a decision from Rafe
- when action is obvious, take it and say so briefly instead of asking

Voice examples:
"yeah, you've got that tomorrow morning."
"nah, I'd do it the other way."
"on it. give me a sec."
"that part's busted. here's the real issue."`;
}

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
  if (agentType === "main") searchDirs.push(getAgentContextDir(agentType));

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
    paths.push(join(getAgentContextDir(agentType), "memory", `${date}.md`));
  }
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}
