/**
 * Memory tools — query lobs-memory search server for semantic recall.
 *
 * Three tools:
 * - memory_search: semantic search across indexed docs (markdown, notes, ADRs, etc.)
 * - memory_read: read specific lines from a file (for diving deeper into search results)
 * - memory_write: write learnings/decisions back to memory during agent runs
 *
 * memory_search uses the bridge service (HTTP fallback to grep).
 * memory_write appends to ~/lobs-shared-memory/learnings.md or a specified file.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDefinition } from "../types.js";
import { memorySearch } from "../../services/memory-search.js";

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
    const { results, source, timeMs } = await memorySearch(
      query,
      maxResults,
      collections,
      context,
    );

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

export const memoryWriteToolDefinition: ToolDefinition = {
  name: "memory_write",
  description:
    "Write a learning, decision, or important finding to persistent memory. " +
    "Use when you discover something that should be remembered for future runs. " +
    "Appends to ~/lobs-shared-memory/learnings.md (or a specified file) with timestamp.",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "What to remember — the learning, decision, or finding",
      },
      category: {
        type: "string",
        enum: ["learning", "decision", "finding"],
        description: "Category of memory entry",
      },
      file: {
        type: "string",
        description: "Optional: specific file to append to (default: learnings.md in ~/lobs-shared-memory)",
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

  if (!category || !["learning", "decision", "finding"].includes(category)) {
    return "Error: category must be one of: learning, decision, finding";
  }

  // Resolve target file
  const homeDir = process.env.HOME ?? "";
  let targetFile = params.file as string | undefined;

  if (!targetFile) {
    targetFile = `${homeDir}/lobs-shared-memory/learnings.md`;
  } else {
    // Resolve ~ in custom path
    targetFile = targetFile.replace(/^~/, homeDir);
  }

  try {
    // Ensure directory exists
    mkdirSync(dirname(targetFile), { recursive: true });

    // Format the entry
    const timestamp = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const entry = `- **[${timestamp}] [${category}]** — ${content}\n`;

    // Append to file
    appendFileSync(targetFile, entry, "utf-8");

    return `Wrote to memory: ${targetFile}\nEntry: ${entry.trim()}`;
  } catch (error) {
    return `Error writing to memory: ${error instanceof Error ? error.message : String(error)}`;
  }
}
