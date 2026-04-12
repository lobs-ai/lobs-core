/**
 * Librarian tool — search the knowledge base and return synthesized answers.
 *
 * Does everything in-process (no nested agents, no recursion risk):
 * 1. Hits lobs-memory /search endpoint for vector search
 * 2. Reads key structured memory files directly
 * 3. Returns results with citations
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolDefinition } from "../types.js";
import { log } from "../../util/logger.js";

// ── Constants ────────────────────────────────────────────────────────────────

const MEMORY_URL = "http://localhost:7420";
const HOME = process.env.HOME ?? "/Users/lobs";
const KB_ROOT = resolve(HOME, "lobs-shared-memory");
const AGENT_CONTEXT = resolve(HOME, "lobs/agents/main/context");

// ── Tool Definition ──────────────────────────────────────────────────────────

export const librarianAskToolDefinition: ToolDefinition = {
  name: "librarian_ask",
  description:
    "Ask the Librarian a question about Rafe's knowledge base — projects, decisions, " +
    "preferences, documentation, or anything stored in memory. " +
    "Searches lobs-memory (vector store) + structured memory files. " +
    "Use this when you need to recall something rather than search for it manually.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The question to ask the Librarian. Be natural — describe what you're trying to find.",
      },
      scope: {
        type: "string",
        description:
          "Optional scope hint: 'preferences', 'decisions', 'projects', 'current', or omit for all.",
      },
      project: {
        type: "string",
        description:
          "Limit search to a specific project: 'lobs', 'paw', 'flock', or omit for all. " +
          "Known projects: lobs, paw, flock.",
      },
    },
    required: ["question"],
  },
};

export const librarianReindexToolDefinition: ToolDefinition = {
  name: "librarian_reindex_knowledge_base",
  description:
    "Trigger a re-index of the lobs-memory vector database to refresh knowledge base " +
    "contents from disk. Use when results are stale or new docs were added.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why re-indexing is needed. Brief description for logging.",
      },
    },
    required: [],
  },
};

// ── Memory File Readers ──────────────────────────────────────────────────────

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function extractKeyMemories(content: string, label: string, maxLines = 80): string[] {
  const lines = content.split("\n").filter((l) => l.trim());
  // Grab the top portion (intro + recent entries)
  const excerpt = lines.slice(0, maxLines).join("\n");
  return [`[${label}]\n${excerpt}`];
}

function readStructuredMemories(question: string, project?: string): string[] {
  const results: string[] = [];

  // Core identity files — always relevant
  const identityFiles: Array<[string, string]> = [
    [join(HOME, "lobs/agents/main/context/SOUL.md"), "SOUL.md"],
    [join(HOME, "lobs/agents/main/context/USER.md"), "USER.md"],
    [join(HOME, "lobs-shared-memory/learnings.md"), "learnings.md"],
  ];

  // Project-specific files
  if (!project || project === "lobs") {
    identityFiles.push(
      [join(HOME, "lobs/agents/main/context/PROJECT-lobs.md"), "PROJECT-lobs.md"],
      [join(HOME, "lobs-shared-memory/adrs"), "lobs ADRs"],
    );
  }
  if (!project || project === "paw") {
    identityFiles.push(
      [join(HOME, "lobs/agents/main/context/PROJECT-paw.md"), "PROJECT-paw.md"],
      [join(HOME, "paw/bot-shared/adrs"), "paw ADRs"],
      [join(HOME, "paw/bot-shared/ideas"), "paw ideas"],
    );
  }
  if (!project || project === "flock") {
    identityFiles.push(
      [join(HOME, "lobs/agents/main/context/PROJECT-flock.md"), "PROJECT-flock.md"],
    );
  }

  // If question is very specific, try targeted files
  const q = question.toLowerCase();
  for (const [path, label] of identityFiles) {
    const content = readIfExists(path);
    if (!content) continue;

    // For directories, search within
    if (!path.endsWith(".md")) {
      const entries = readdirSync(path).filter((f: string) => f.endsWith(".md")).slice(0, 5);
      for (const entry of entries) {
        const entryPath = join(path, entry);
        const entryContent = readIfExists(entryPath);
        if (entryContent) {
          results.push(`[${label}/${entry}]\n${entryContent.slice(0, 3000)}`);
        }
      }
    } else {
      results.push(`[${label}]\n${content.slice(0, 4000)}`);
    }
  }

  return results;
}

// ── Project → Collection Mapping ─────────────────────────────────────────────

const PROJECT_COLLECTIONS: Record<string, string[]> = {
  lobs: [
    "lobs-core", "lobs-core-memory", "lobs-nexus", "lobs-sentinel", "lobs-voice",
    "lobslab-infra", "agent-memory", "agent-context", "knowledge",
  ],
  paw: [
    "paw-hub", "paw-portal", "paw-plugin", "paw-designs", "paw-docs", "paw-proposals",
    "bot-shared", "trident", "version-claw", "ship-api", "ship-services",
    "lobs-sail", "lobs-sets-sail", "service-sdk", "service-sdk-python",
  ],
  flock: ["knowledge"], // flock docs live in shared knowledge for now
};

// Collections to always exclude from search (noisy, low signal)
const EXCLUDED_COLLECTIONS = ["sessions"];

// ── HTTP Helpers ─────────────────────────────────────────────────────────────

interface MemorySearchResult {
  query: string;
  results: Array<{ snippet: string; score: number; source?: string; path?: string; citation?: string }>;
  total: number;
}

async function searchMemory(question: string, project?: string, limit = 8): Promise<MemorySearchResult> {
  // Build the proper lobs-memory request format
  const body: Record<string, unknown> = {
    query: question,
    maxResults: limit,
  };

  // Map project to collection filter, always excluding sessions
  if (project && PROJECT_COLLECTIONS[project]) {
    body.collections = PROJECT_COLLECTIONS[project];
  }
  // If no project specified, search everything except sessions
  // lobs-memory doesn't have an "exclude" filter, so we don't filter —
  // we'll filter sessions out of the results instead

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(`${MEMORY_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { query: question, results: [], total: 0 };
    }

    const data = await res.json() as {
      results?: Array<{ text?: string; snippet?: string; score: number; source?: string; path?: string; citation?: string }>;
      items?: Array<{ text?: string; snippet?: string; score: number; source?: string; path?: string; citation?: string }>;
      total?: number;
      count?: number;
    };

    // Filter out excluded collections (sessions etc.)
    const raw = (data.results ?? data.items ?? []).filter(
      (r) => !EXCLUDED_COLLECTIONS.some((ex) => r.source?.includes(ex)),
    );
    const items = raw.slice(0, limit);
    const total = data.total ?? data.count ?? items.length;

    return {
      query: question,
      results: items.map((r) => ({
        snippet: typeof (r.text ?? r.snippet) === "string" ? (r.text ?? r.snippet ?? "") : JSON.stringify(r.text ?? r.snippet),
        score: r.score ?? 0,
        source: r.source ?? undefined,
      })),
      total,
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      log().warn(`[librarian] Memory search timed out for: "${question}"`);
    } else {
      log().warn(`[librarian] Memory search failed: ${err}`);
    }
    return { query: question, results: [], total: 0 };
  }
}

// ── Formatter ────────────────────────────────────────────────────────────────

function formatResults(
  memResults: MemorySearchResult,
  fileResults: string[],
  question: string,
): string {
  const parts: string[] = [];

  // Header
  parts.push(`## Librarian: "${question}"\n`);

  // Memory results
  if (memResults.results.length > 0) {
    parts.push("### From knowledge base:\n");
    for (const r of memResults.results) {
      const source = r.source ? ` _(source: ${r.source})_` : "";
      const score = r.score > 0 ? ` [${(r.score * 100).toFixed(0)}%]` : "";
      const text = r.snippet.slice(0, 600);
      parts.push(`- ${text}${score}${source}`);
    }
  } else {
    parts.push("### From knowledge base:\n_No results found._\n");
  }

  // Structured memory files
  if (fileResults.length > 0) {
    parts.push("### From structured files:\n");
    for (const f of fileResults) {
      const firstLine = f.split("\n")[0].replace(/^\[|\]$/g, "");
      const excerpt = f.split("\n").slice(1).join("\n").trim().slice(0, 400);
      parts.push(`**${firstLine}:** ${excerpt}...`);
    }
  }

  // Footer
  if (memResults.total > memResults.results.length) {
    parts.push(`\n_(+${memResults.total - memResults.results.length} more results in knowledge base)_\n`);
  }
  if (memResults.results.length === 0 && fileResults.length === 0) {
    parts.push("\n_I couldn't find anything relevant in the knowledge base._\n");
  }

  return parts.join("\n");
}

// ── Re-index Tool ────────────────────────────────────────────────────────────

export async function reindexKnowledgeBaseTool(
  params: Record<string, unknown>,
  _cwd: string,
): Promise<string> {
  const reason = (params.reason as string) ?? "no reason provided";
  log().info(`[librarian-reindex] Triggered — reason: ${reason}`);

  let statusBefore = "";
  try {
    const res = await fetch(`${MEMORY_URL}/status`);
    if (res.ok) {
      const data = await res.json() as { index?: { documents?: number; chunks?: number } };
      statusBefore = `${data.index?.documents ?? "?"} docs / ${data.index?.chunks ?? "?"} chunks`;
    }
  } catch { /* ignore */ }
  log().info(`[librarian-reindex] Status before: ${statusBefore}`);

  let triggerResult: { ok: boolean; message?: string; error?: string };
  try {
    const res = await fetch(`${MEMORY_URL}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggeredBy: "librarian", reason }),
    });
    triggerResult = await res.json() as { ok: boolean; message?: string; error?: string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log().error(`[librarian-reindex] HTTP error: ${msg}`);
    return `Failed to reach lobs-memory at ${MEMORY_URL}: ${msg}`;
  }

  if (!triggerResult.ok) {
    log().error(`[librarian-reindex] Re-index failed: ${triggerResult.error}`);
    return `Re-index failed: ${triggerResult.error ?? "unknown error"}`;
  }

  const msg = triggerResult.message ?? "Re-indexing started in background.";
  log().info(`[librarian-reindex] Triggered: ${msg}`);

  // Poll until stable
  const pollStart = Date.now();
  let stable = 0;
  while (Date.now() - pollStart < 60_000) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch(`${MEMORY_URL}/status`);
      const data = await res.json() as { indexer?: { isIndexing?: boolean }; index?: { documents?: number; chunks?: number; collections?: string[] } };
      if (data.indexer?.isIndexing) { stable = 0; continue; }
      stable++;
      if (stable >= 2) {
        const docs = data.index?.documents ?? "?";
        const chunks = data.index?.chunks ?? "?";
        const cols = (data.index?.collections ?? []).join(", ");
        log().info(`[librarian-reindex] Done: ${docs} docs / ${chunks} chunks`);
        return `Re-index complete. Now: ${docs} docs / ${chunks} chunks. Collections: ${cols}.`;
      }
    } catch { /* keep polling */ }
  }

  return `${msg} (polling timed out after 60s — check lobs-memory status manually)`;
}

// ── Main Librarian Ask Tool ─────────────────────────────────────────────────

export async function librarianAskTool(
  params: Record<string, unknown>,
  _cwd: string,
): Promise<string> {
  const question = (params.question as string | undefined) ?? "";
  if (!question) return "Error: question is required";

  const project = params.project as string | undefined;
  const scope = params.scope as string | undefined;

  log().info(`[librarian] question="${question}" project=${project ?? "all"}`);

  // Run memory search + file reads in parallel
  const [memResults, fileResults] = await Promise.all([
    searchMemory(question, project),
    readStructuredMemories(question, project),
  ]);

  const output = formatResults(memResults, fileResults, question);

  log().info(
    `[librarian] Done: ${memResults.total} hits, ${fileResults.length} file sources`,
  );

  return output;
}
