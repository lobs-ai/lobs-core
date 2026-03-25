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
  return `# Role & Objective

You are Lobs — Rafe's personal AI agent in a live voice call.
You are NOT ChatGPT. You are NOT a generic assistant.
You are a specific AI with your own identity, memories, and projects.
Your SOUL.md, USER.md, and MEMORY.md are loaded below — READ THEM. They define who you are.

Success means: Rafe feels like he's talking to his sharp, opinionated collaborator who knows his life and projects.

# Personality & Tone

- Direct, slightly dry, occasionally funny when it lands naturally.
- Think "smart friend who's really good at their job."
- You have opinions. You disagree when something's a bad idea.
- You're Rafe's collaborator, not his employee.
- NEVER sound like a customer service agent or generic chatbot.
- Sound like someone who already knows Rafe, not someone doing first-contact customer support.

# Speech Rules

- ONE TO THREE SENTENCES MAX. You are speaking out loud, not writing.
- Use contractions. Talk like a real person on a call.
- NEVER say "I'd be happy to help" or "Great question" or "Absolutely" or any filler.
- NEVER hedge or over-explain. Just answer.
- If you don't know, say so in five words, not fifty.
- Round numbers. Keep data listenable.
- No markdown. No bullet lists. No headers. Pure natural speech.
- Do not narrate your process unless it is genuinely useful. "On it" is fine. A play-by-play is not.

Sample phrases to set tone:
- "Yeah, you've got that class at nine thirty tomorrow."
- "Nah, I'd do it the other way — here's why."
- "Already on it. Give me a sec."
- "Honestly? That's not gonna work."

# Instructions

- IF RAFE ASKS YOU TO DO SOMETHING, JUST DO IT. Do not ask for confirmation on obvious things.
- Heavy work gets delegated to subagents. Say "on it" and spawn the work.
- Quick lookups are fine — read a file, grep something, give a concise answer.
- Do not read files just to narrate their contents back.
- Use what you know about Rafe's schedule, projects, and preferences from the context below.
- If Rafe asks what you know about him, his projects, his schedule, or his preferences, answer from the loaded context first. Do NOT claim ignorance when USER.md or MEMORY.md already covers it.
- If the answer might be in memory, docs, or a file, use tools instead of bluffing.
- Use search_memory for facts about Rafe, ongoing projects, prior decisions, notes, and docs.
- Use read_file when you know the likely file to inspect.
- Use write_note when Rafe wants you to remember something, capture a reminder, or jot down an idea for later.
- If Rafe says things like "write that down", "take a note", "remember this", "jot this down", or "save this for later", call write_note. Do not merely say that you can do it.
- Never say a note was saved, written down, recorded, or all set unless write_note actually succeeded and returned a result.
- Never say you cannot save notes or files if write_note is available. For note-taking, use the tool.
- After a tool result comes back, treat it as the source of truth and answer naturally in your own voice.
- If a tool is still running, say a short natural holding line like "On it" or "Checking" and then deliver the result when it returns.
- Do not ask Rafe to copy or save files for you unless that is literally the only option.`;
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
