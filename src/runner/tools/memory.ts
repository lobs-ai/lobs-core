/**
 * Memory tools — query lobs-memory search server for semantic recall.
 *
 * Three tools:
 * - memory_search: semantic search across indexed docs (markdown, notes, ADRs, etc.)
 * - memory_read: read specific lines from a file (for diving deeper into search results)
 * - memory_write: write to daily or permanent memory files
 *
 * memory_search uses the bridge service (HTTP fallback to grep).
 * memory_write defaults to today's daily file (~/.lobs/agents/main/context/memory/YYYY-MM-DD.md).
 * Use permanent=true for lasting learnings/decisions (→ ~/lobs-shared-memory/learnings.md).
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDefinition } from "../types.js";
import { memorySearch } from "../../services/memory-client.js";
import { ensureTodaysMemoryFile } from "../../services/memory-condenser.js";

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

  const collections = Array.isArray(params.collections) && params.collections.length > 0
    ? params.collections as string[]
    : undefined;
  
  const context = typeof params.conversationContext === "string"
    ? params.conversationContext
    : undefined;

  try {
    const { results, source, timeMs } = await memorySearch(query, {
      maxResults,
      collections,
      conversationContext: context,
    });

    if (!results || results.length === 0) {
      return `No results found for: "${query}"`;
    }

    // Format results for the agent
    const lines: string[] = [];
    lines.push(`Found ${results.length} results (${timeMs}ms, source: ${source}):`);
    lines.push("");

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const shortPath = r.path.replace(/^\/Users\/lobs\//, "~/");
      lines.push(`[${i + 1}] ${shortPath}#${r.startLine}-${r.endLine} (score: ${r.score.toFixed(2)})`);
      lines.push(r.snippet.trim());
      lines.push("");
    }

    return lines.join("\n");
  } catch (error) {
    return `Memory search error: ${error instanceof Error ? error.message : String(error)}`;
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

export const memoryWriteToolDefinition: ToolDefinition = {
  name: "memory_write",
  description:
    "Write to memory. By default writes to today's daily memory file. " +
    "Use permanent=true for lasting learnings/decisions that should persist forever. " +
    "Events and notes always go to the daily file.",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "What to remember",
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
  const content = params.content as string;
  const category = params.category as string;

  if (!content || typeof content !== "string") {
    return "Error: content is required and must be a string";
  }

  if (!category || !(VALID_CATEGORIES as readonly string[]).includes(category)) {
    return `Error: category must be one of: ${VALID_CATEGORIES.join(", ")}`;
  }

  const cat = category as MemoryCategory;
  const permanent = params.permanent === true;
  const homeDir = process.env.HOME ?? "";

  // Resolve target file
  let targetFile = params.file as string | undefined;
  let useDailyFormat = true;

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

    const shortPath = targetFile.replace(homeDir, "~");
    return `Wrote to memory: ${shortPath}\nEntry: ${entry.trim()}`;
  } catch (error) {
    return `Error writing to memory: ${error instanceof Error ? error.message : String(error)}`;
  }
}
