/**
 * Memory tools — query structured memories and indexed docs for semantic recall.
 *
 * Three tools:
 * - memory_search: unified semantic search across structured memories and document chunks
 * - memory_read: read specific lines from a file (for diving deeper into search results)
 * - memory_write: write to daily or permanent memory files
 *
 * memory_search uses searchMemoriesFull() (FTS5 + vector), falling back to grep on error.
 * memory_write defaults to today's daily file (~/.lobs/agents/main/context/memory/YYYY-MM-DD.md).
 * Use permanent=true for lasting learnings/decisions (→ ~/lobs-shared-memory/learnings.md).
 */

import { readFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ToolDefinition } from "../types.js";
import { ensureTodaysMemoryFile } from "../../services/memory-condenser.js";
import { getMemoryDb } from "../../memory/db.js";
import { log } from "../../util/logger.js";
import { searchMemoriesFull, searchSessionTranscripts, type StructuredMemoryResult, type SessionSearchResult } from "../../memory/search.js";
import { invalidateKeyMemoriesCache } from "../../services/workspace-loader.js";

// ── lobs-memory document search ──────────────────────────────────────────────

const LOBS_MEMORY_URL = "http://localhost:7420/search";
const LOBS_MEMORY_TIMEOUT_MS = 3_000;

interface LobsMemoryResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
  citation: string;
}

interface LobsMemoryResponse {
  results: LobsMemoryResult[];
  query: string;
  timings?: { totalMs?: number };
}

async function queryLobsMemoryServer(
  query: string,
  maxResults: number,
  collections?: string[],
  conversationContext?: string,
): Promise<LobsMemoryResult[]> {
  try {
    const body: Record<string, unknown> = { query, maxResults };
    if (collections && collections.length > 0) body.collections = collections;
    if (conversationContext) body.conversationContext = conversationContext;

    const resp = await fetch(LOBS_MEMORY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LOBS_MEMORY_TIMEOUT_MS),
    });

    if (!resp.ok) return [];

    const data = (await resp.json()) as LobsMemoryResponse;
    return data.results ?? [];
  } catch {
    // Server down or timeout — silently skip
    return [];
  }
}

// ── memory_search ────────────────────────────────────────────────────────────

export const memorySearchToolDefinition: ToolDefinition = {
  name: "memory_search",
  description:
    "Semantically search memory, docs, ADRs, project files, and notes. " +
    "Returns relevant snippets with file paths and line numbers. " +
    "Use this to recall prior decisions, find documentation, or look up context about a topic. " +
    "Results include citations (path#line) for verification.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query — describe what you're looking for in natural language",
      },
      maxResults: {
        type: "number",
        description: "Maximum results to return (default 8, max 20)",
      },
      collections: {
        type: "array",
        items: { type: "string" },
        description:
          "Filter to specific collections (e.g. 'workspace', 'paw-hub', 'lobs-memory'). " +
          "Omit to search all collections.",
      },
      conversationContext: {
        type: "string",
        description:
          "Brief description of current conversation/task context to bias search relevance. " +
          "Helps the search engine understand what angle you're coming from.",
      },
    },
    required: ["query"],
  },
};

export async function memorySearchTool(
  params: Record<string, unknown>,
): Promise<string> {
  const query = params.query as string;
  if (!query || typeof query !== "string") {
    return "Error: query is required and must be a string";
  }

  const maxResults = Math.min(
    typeof params.maxResults === "number" ? params.maxResults : 8,
    20,
  );

  const collections = Array.isArray(params.collections)
    ? (params.collections as string[])
    : undefined;
  const conversationContext =
    typeof params.conversationContext === "string"
      ? params.conversationContext
      : undefined;

  const start = Date.now();

  try {
    // Fire structured-memory search, lobs-memory doc search, and session transcript search in parallel
    const [structuredResults, docResults, sessionResults] = await Promise.all([
      searchMemoriesFull(query, { maxResults, minConfidence: 0.3 }),
      queryLobsMemoryServer(query, maxResults, collections, conversationContext),
      searchSessionTranscripts(query, { maxResults }),
    ]);

    const timeMs = Date.now() - start;

    const hasStructured = structuredResults && structuredResults.length > 0;
    const hasDocs = docResults && docResults.length > 0;
    const hasSessions = sessionResults && sessionResults.length > 0;

    if (!hasStructured && !hasDocs && !hasSessions) {
      return `No results found for: "${query}"`;
    }

    // Build unified result list tagged by source for sorting
    type UnifiedResult =
      | { kind: "structured"; r: StructuredMemoryResult; score: number }
      | { kind: "doc"; r: LobsMemoryResult; score: number }
      | { kind: "session"; r: SessionSearchResult; score: number };

    const unified: UnifiedResult[] = [];

    for (const r of structuredResults ?? []) {
      unified.push({ kind: "structured", r, score: r.score });
    }
    for (const r of docResults ?? []) {
      unified.push({ kind: "doc", r, score: r.score });
    }
    for (const r of sessionResults ?? []) {
      unified.push({ kind: "session", r, score: r.score });
    }

    // Sort all results by score descending, cap at maxResults
    unified.sort((a, b) => b.score - a.score);
    const top = unified.slice(0, maxResults);

    const lines: string[] = [];
    const sources: string[] = [];
    if (hasStructured) sources.push("structured-db");
    if (hasDocs) sources.push("lobs-memory");
    if (hasSessions) sources.push("session-transcripts");
    const sourceTag = sources.join(" + ") || "none";
    lines.push(`Found ${top.length} results (${timeMs}ms, source: ${sourceTag}):`);
    lines.push("");

    for (let i = 0; i < top.length; i++) {
      const u = top[i];

      if (u.kind === "structured") {
        const r = u.r;
        const m = r.memory;

        if (m.source_path) {
          // Document chunk — use file-path style citation
          const shortPath = m.source_path.replace(/^\/Users\/lobs\//, "~/");
          const chunkSuffix = m.chunk_index != null ? `#chunk${m.chunk_index}` : "";
          lines.push(
            `[${i + 1}] ${shortPath}${chunkSuffix} (score: ${r.score.toFixed(2)}, type: document)`,
          );
        } else {
          // Episodic memory — use memory-db style citation
          lines.push(
            `[${i + 1}] memory-db:${m.id} (score: ${r.score.toFixed(2)}, type: ${m.memory_type}, confidence: ${m.confidence.toFixed(2)})`,
          );
        }

        lines.push(m.content.trim());
      } else if (u.kind === "doc") {
        // Document result from lobs-memory server
        const r = u.r;
        const shortPath = r.path.replace(/^\/Users\/lobs\//, "~/");
        const lineRef = `#${r.startLine}-${r.endLine}`;
        lines.push(
          `[${i + 1}] ${r.source}:${shortPath}${lineRef} (score: ${r.score.toFixed(2)})`,
        );
        lines.push(r.snippet.trim());
      } else {
        // Session transcript result
        const r = u.r;
        const date = r.timestamp ? r.timestamp.slice(0, 10) : "";
        lines.push(
          `[${i + 1}] session:${r.sessionId}/turn-${r.turn} (score: ${r.score.toFixed(2)}, agent: ${r.agentType}, ${date})`,
        );
        const snippet = r.content.length > 500 ? r.content.slice(0, 500) + "…" : r.content;
        lines.push(`**${r.role.charAt(0).toUpperCase() + r.role.slice(1)}:** ${snippet}`);
      }

      lines.push("");
    }

    return lines.join("\n");
  } catch (error) {
    // Fallback to grep when DB/search fails
    log().warn(`[memory_search] searchMemoriesFull failed, falling back to grep: ${String(error)}`);

    const start2 = Date.now();
    const grepResults = grepFallback(query, maxResults);
    const timeMs2 = Date.now() - start2;

    if (grepResults.length === 0) {
      return `No results found for: "${query}"`;
    }

    const lines: string[] = [];
    lines.push(`Found ${grepResults.length} results (${timeMs2}ms, source: grep):`);
    lines.push("");

    for (let i = 0; i < grepResults.length; i++) {
      const r = grepResults[i];
      const shortPath = r.path.replace(/^\/Users\/lobs\//, "~/");
      lines.push(`[${i + 1}] ${shortPath}#${r.startLine}-${r.endLine} (score: ${r.score.toFixed(2)})`);
      lines.push(r.snippet.trim());
      lines.push("");
    }

    return lines.join("\n");
  }
}

// ── Grep fallback ─────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? "";
const GREP_DIRS = [
  resolve(HOME, ".lobs/agents"),
  resolve(HOME, "lobs/lobs-shared-memory"),
  resolve(HOME, "lobs/lobs-core"),
  resolve(HOME, "paw/bot-shared"),
  resolve(HOME, "paw/paw-hub"),
  resolve(HOME, "paw/paw-designs"),
];

interface GrepResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

function grepFallback(query: string, maxResults: number): GrepResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const results: Array<GrepResult & { matchCount: number }> = [];

  for (const dir of GREP_DIRS) {
    walkDir(dir, (filePath) => {
      if (!filePath.endsWith(".md")) return;
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i += 8) {
          const chunk = lines.slice(i, i + 12).join("\n").toLowerCase();
          const matchCount = terms.filter((t) => chunk.includes(t)).length;
          if (matchCount >= Math.min(2, terms.length)) {
            results.push({
              path: filePath,
              startLine: i + 1,
              endLine: Math.min(i + 12, lines.length),
              score: matchCount / terms.length,
              snippet: lines.slice(i, i + 8).join("\n"),
              matchCount,
            });
          }
        }
      } catch {
        /* skip unreadable */
      }
    });
  }

  results.sort((a, b) => b.matchCount - a.matchCount);
  return results.slice(0, maxResults);
}

function walkDir(
  dir: string,
  callback: (path: string) => void,
  depth = 0,
): void {
  if (depth > 4) return;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (
        entry.startsWith(".") ||
        entry === "node_modules" ||
        entry === "dist" ||
        entry === "build"
      )
        continue;
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walkDir(full, callback, depth + 1);
        else if (stat.isFile()) callback(full);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
}

// ── memory_read ──────────────────────────────────────────────────────────────

export const memoryReadToolDefinition: ToolDefinition = {
  name: "memory_read",
  description:
    "Read specific lines from a file found via memory_search. " +
    "Use this to get more context around a search result snippet. " +
    "Provide the file path and optional line range.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (from memory_search results)",
      },
      from: {
        type: "number",
        description: "Start line (1-indexed, default 1)",
      },
      lines: {
        type: "number",
        description: "Number of lines to read (default 50, max 200)",
      },
    },
    required: ["path"],
  },
};

export async function memoryReadTool(
  params: Record<string, unknown>,
): Promise<string> {
  let filePath = params.path as string;
  if (!filePath || typeof filePath !== "string") {
    return "Error: path is required";
  }

  // Resolve ~ to home directory
  filePath = filePath.replace(/^~/, process.env.HOME ?? "");

  const from = Math.max(1, typeof params.from === "number" ? params.from : 1);
  const maxLines = Math.min(
    typeof params.lines === "number" ? params.lines : 50,
    200,
  );

  try {
    const content = readFileSync(filePath, "utf-8");
    const allLines = content.split("\n");
    const startIdx = from - 1;
    const endIdx = Math.min(startIdx + maxLines, allLines.length);
    const slice = allLines.slice(startIdx, endIdx);

    const header = `${filePath} (lines ${from}-${endIdx} of ${allLines.length})`;
    const numbered = slice.map((line, i) => `${from + i}: ${line}`).join("\n");

    return `${header}\n${numbered}`;
  } catch (error) {
    return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── memory_write ─────────────────────────────────────────────────────────────

const VALID_CATEGORIES = ["learning", "decision", "finding", "event", "note"] as const;
type MemoryCategory = (typeof VALID_CATEGORIES)[number];

/** Categories that can be written to permanent memory */
const PERMANENT_CATEGORIES: MemoryCategory[] = ["learning", "decision", "finding"];

/** Max content length for a single memory entry (characters). Entries beyond this are truncated. */
const MAX_MEMORY_CONTENT_LENGTH = 1000;

export const memoryWriteToolDefinition: ToolDefinition = {
  name: "memory_write",
  description:
    "Write to memory. By default writes to today's daily memory file. " +
    "Use permanent=true for lasting learnings/decisions that should persist forever. " +
    "Events and notes always go to the daily file.\n\n" +
    "IMPORTANT: Keep entries concise — 2-4 sentences max. Write the *what* and *why*, not implementation details. " +
    "Bad: listing every file, function name, threshold value, and checklist item. " +
    "Good: 'Built health monitoring with 4 probes, integrated into control loop. Design doc at X.' " +
    "If details matter, they belong in docs/code, not memory. Memory is for recall, not documentation. " +
    "Entries over 1000 characters are automatically truncated.",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "What to remember — keep concise (2-4 sentences, under 1000 chars). Focus on what happened and why, not implementation details.",
      },
      category: {
        type: "string",
        enum: ["learning", "decision", "finding", "event", "note"],
        description: "Category: learning, decision, finding, event, or note",
      },
      permanent: {
        type: "boolean",
        description:
          "Write to permanent memory instead of daily file (default: false). " +
          "Events/notes always go to daily.",
      },
      file: {
        type: "string",
        description: "Override: specific file to write to",
      },
    },
    required: ["content", "category"],
  },
};

export async function memoryWriteTool(
  params: Record<string, unknown>,
): Promise<string> {
  let content = params.content as string;
  const category = params.category as string;

  if (!content || typeof content !== "string") {
    return "Error: content is required and must be a string";
  }

  if (!category || !(VALID_CATEGORIES as readonly string[]).includes(category)) {
    return `Error: category must be one of: ${VALID_CATEGORIES.join(", ")}`;
  }

  // Truncate oversized entries
  let truncated = false;
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    content = content.slice(0, MAX_MEMORY_CONTENT_LENGTH).trimEnd() + "…";
    truncated = true;
  }

  const cat = category as MemoryCategory;
  const permanent = params.permanent === true;
  const homeDir = process.env.HOME ?? "";

  // Resolve target file
  let targetFile = params.file as string | undefined;
  let useDailyFormat: boolean;

  if (targetFile) {
    // Explicit file override — use permanent format
    targetFile = targetFile.replace(/^~/, homeDir);
    useDailyFormat = false;
  } else if (permanent && PERMANENT_CATEGORIES.includes(cat)) {
    // Permanent memory for learning/decision/finding
    targetFile = `${homeDir}/lobs-shared-memory/learnings.md`;
    useDailyFormat = false;
  } else {
    // Default: today's daily file (events/notes always land here)
    targetFile = ensureTodaysMemoryFile();
    useDailyFormat = true;
  }

  try {
    // Ensure directory exists
    mkdirSync(dirname(targetFile), { recursive: true });

    // Format the entry based on target
    let entry: string;
    if (useDailyFormat) {
      // Daily format: - **[HH:MM]** [category] — content
      const now = new Date();
      const timeStr = now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/New_York",
      });
      entry = `- **[${timeStr}]** [${cat}] — ${content}\n`;
    } else {
      // Permanent format: - **[YYYY-MM-DD] [category]** — content
      const dateStr = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      }); // en-CA gives YYYY-MM-DD
      entry = `- **[${dateStr}] [${cat}]** — ${content}\n`;
    }

    // Append to file
    appendFileSync(targetFile, entry, "utf-8");

    // Also write to structured memories table when permanent=true
    if (permanent && PERMANENT_CATEGORIES.includes(cat)) {
      try {
        const db = getMemoryDb();
        const now = new Date().toISOString();

        // Map category to memory_type
        const typeMap: Record<string, string> = {
          learning: "learning",
          decision: "decision",
          finding: "fact",
          note: "learning",
        };
        const memoryType = typeMap[cat] ?? "learning";

        // source_authority = 2: explicit agent statement
        db.prepare(
          `INSERT INTO memories (memory_type, content, confidence, scope, source_authority, derived_at, last_validated, status, access_count)
           VALUES (?, ?, 0.9, 'system', 2, ?, ?, 'active', 0)`,
        ).run(memoryType, content, now, now);

        // Fire-and-forget: generate and store embedding
        const lastRow = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
        const newMemoryId = lastRow.id;

        void (async () => {
          try {
            const resp = await fetch("http://localhost:1234/v1/embeddings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "text-embedding-qwen3-embedding-4b",
                input: content,
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (resp.ok) {
              const data = (await resp.json()) as {
                data?: Array<{ embedding?: number[] }>;
              };
              const raw = data.data?.[0]?.embedding;
              if (raw && Array.isArray(raw)) {
                const embedding = new Float32Array(raw);
                db.prepare(
                  "INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)",
                ).run(newMemoryId, Buffer.from(embedding.buffer));
              }
            }
          } catch {
            // Embedding is optional — memory is still saved
          }
        })();
      } catch (dbErr) {
        // Non-fatal — the flat file write already succeeded
        log().warn(`[memory_write] Failed to write structured memory: ${String(dbErr)}`);
      }

      // Bust the key-memories cache so the next system-prompt rebuild reflects
      // the newly written memory without waiting for the 5-minute TTL.
      invalidateKeyMemoriesCache();
    }

    const shortPath = targetFile.replace(homeDir, "~");
    const truncNote = truncated ? " (truncated — keep entries under 1000 chars)" : "";
    return `Wrote to memory: ${shortPath}${truncNote}\nEntry: ${entry.trim()}`;
  } catch (error) {
    return `Error writing to memory: ${error instanceof Error ? error.message : String(error)}`;
  }
}
