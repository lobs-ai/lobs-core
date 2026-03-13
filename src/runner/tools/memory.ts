/**
 * Memory tools — query lobs-memory search server for semantic recall.
 *
 * Two tools:
 * - memory_search: semantic search across indexed docs (markdown, notes, ADRs, etc.)
 * - memory_read: read specific lines from a file (for diving deeper into search results)
 *
 * Both tools query http://localhost:7420 (lobs-memory server).
 */

import { readFileSync } from "node:fs";
import type { ToolDefinition } from "../types.js";

const MEMORY_SERVER = "http://localhost:7420";

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

  const body: Record<string, unknown> = {
    query,
    maxResults,
  };

  if (Array.isArray(params.collections) && params.collections.length > 0) {
    body.collections = params.collections;
  }
  if (typeof params.conversationContext === "string") {
    body.conversationContext = params.conversationContext;
  }

  try {
    const response = await fetch(`${MEMORY_SERVER}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return `Memory search failed (HTTP ${response.status}): ${await response.text().catch(() => "unknown error")}`;
    }

    const data = (await response.json()) as {
      results: Array<{
        path: string;
        startLine: number;
        endLine: number;
        score: number;
        snippet: string;
        source: string;
        citation: string;
      }>;
      query: string;
      expandedQueries?: string[];
      timings: { totalMs: number };
    };

    if (!data.results || data.results.length === 0) {
      return `No results found for: "${query}"`;
    }

    // Format results for the agent
    const lines: string[] = [];
    lines.push(`Found ${data.results.length} results (${data.timings.totalMs}ms):`);
    if (data.expandedQueries?.length) {
      lines.push(`Also searched: ${data.expandedQueries.join(", ")}`);
    }
    lines.push("");

    for (let i = 0; i < data.results.length; i++) {
      const r = data.results[i];
      const shortPath = r.path.replace(/^\/Users\/lobs\//, "~/");
      lines.push(`[${i + 1}] ${shortPath}#${r.startLine}-${r.endLine} (score: ${r.score.toFixed(2)})`);
      lines.push(r.snippet.trim());
      lines.push("");
    }

    return lines.join("\n");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return "Memory search timed out (15s). The memory server may be busy or down.";
    }
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
