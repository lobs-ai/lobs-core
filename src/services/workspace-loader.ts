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
import { isMemoryDbReady, getMemoryDb } from "../memory/db.js";

const HOME = homedir();

// ── Key Memory Injection ─────────────────────────────────────────────────────

const KEY_MEMORIES_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const KEY_MEMORIES_MAX_CHARS = 5000;
const KEY_MEMORIES_FETCH_LIMIT = 80; // fetch more than needed, trim to budget

interface KeyMemoriesCache {
  content: string;
  builtAt: number;
}

let _keyMemoriesCache: KeyMemoriesCache | null = null;

// TYPE_ORDER removed — preferences are forced to top via SQL CASE, no redundant weight needed.

/**
 * Load the top important memories from the DB for injection into the main
 * agent system prompt.
 *
 * Selection strategy (pure SQL, no LLM):
 *   1. All active preferences (always surfaced — these define Lobs' behaviour)
 *   2. High-confidence decisions and learnings
 *   3. Remaining active memories, ranked by: source_authority DESC,
 *      confidence DESC, access_count DESC, type weight DESC
 *
 * Results are cached for 5 minutes so repeated prompt rebuilds don't hammer
 * the DB on every message.
 *
 * @returns A "## Key Memories" markdown section, or "" if DB unavailable.
 */
function loadKeyMemories(): string {
  // Return cached result if fresh
  if (_keyMemoriesCache && Date.now() - _keyMemoriesCache.builtAt < KEY_MEMORIES_CACHE_TTL_MS) {
    return _keyMemoriesCache.content;
  }

  if (!isMemoryDbReady()) {
    return "";
  }

  try {
    const db = getMemoryDb();

    // Fetch candidates: active, non-document memories, ordered by importance signals.
    // We fetch more than we'll show so we can trim to the char budget gracefully.
    const rows = db.prepare(`
      SELECT memory_type, content, confidence, source_authority, access_count, last_accessed, created_at
      FROM memories
      WHERE status = 'active'
        AND memory_type != 'document'
      ORDER BY
        -- Preferences always bubble to the top
        CASE memory_type WHEN 'preference' THEN 1 ELSE 0 END DESC,
        -- Recency boost: fresh memories (last 24h) surface immediately
        CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END DESC,
        -- Then high source_authority (user-provided = authoritative)
        source_authority DESC,
        -- Then confidence
        confidence DESC,
        -- Then recency of access
        access_count DESC
      LIMIT ?
    `).all(KEY_MEMORIES_FETCH_LIMIT) as Array<{
      memory_type: string;
      content: string;
      confidence: number;
      source_authority: number;
      access_count: number;
      last_accessed: string | null;
      created_at: string | null;
    }>;

    if (rows.length === 0) {
      _keyMemoriesCache = { content: "", builtAt: Date.now() };
      return "";
    }

    // Format rows compactly: "[type] content"
    // Trim to char budget, keeping whole entries
    const lines: string[] = [];
    let totalChars = 0;
    for (const row of rows) {
      const line = `[${row.memory_type}] ${row.content.trim()}`;
      if (totalChars + line.length + 1 > KEY_MEMORIES_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length + 1;
    }

    if (lines.length === 0) {
      _keyMemoriesCache = { content: "", builtAt: Date.now() };
      return "";
    }

    const content = `## Key Memories\n${lines.join("\n")}`;
    _keyMemoriesCache = { content, builtAt: Date.now() };
    return content;
  } catch (err) {
    // Non-fatal — if DB is unavailable, skip injection
    console.warn(`[workspace-loader] Failed to load key memories: ${err}`);
    return "";
  }
}

/**
 * Invalidate the key memories cache (e.g. after memory_write calls).
 * Exported so tool handlers can bust the cache when new memories are saved.
 */
export function invalidateKeyMemoriesCache(): void {
  _keyMemoriesCache = null;
}

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
- when Rafe describes a problem, start investigating right away instead of asking broad diagnostic questions
- when the next useful step is obvious, take it instead of asking for permission
- stay focused on the main task
- if you notice a side issue, failure, or interesting detail, bring it up only if it matters to the current task; otherwise note it or save it for later
- if a tool fails during the main task, mention it briefly and keep going unless Rafe wants the tool failure debugged
- don't turn an internal tool failure into a new task or investigation unless it directly blocks the main goal

Rules:
- the tools in this session are real and available now
- don't say you can't see your tools
- if Rafe asks what tools you have, answer directly
- if something should be remembered, use write_note
- never claim a note was saved unless write_note succeeded
- don't ask Rafe to copy or save files for you unless that's the only option
- don't end with filler like "want me to do that?", "should I do that?", or "would you like me to do that?" unless you genuinely need a decision from Rafe
- when action is obvious, take it and say so briefly instead of asking
- only ask a question when a specific missing detail is actually blocking the next step

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

  // Inject top important memories for the main agent only.
  // Subagents get task-specific memory via context-engine.ts instead.
  if (agentType === "main") {
    const keyMemories = loadKeyMemories();
    if (keyMemories) {
      sections.push(keyMemories);
    }
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
