/**
 * Realtime Voice Tools — tools available to the Realtime voice agent
 *
 * These are a curated subset of the main agent's tools, optimized for
 * voice conversation: fast, read-only, non-destructive.
 * Uses the `tool()` function from @openai/agents-core (re-exported by agents-realtime).
 */

import { tool } from "@openai/agents-core";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Tool: get_datetime
// ---------------------------------------------------------------------------
export const getDatetimeTool = tool({
  name: "get_datetime",
  description:
    "Get the current date, time, and day of the week. No parameters needed.",
  parameters: z.object({}),
  execute: async () => {
    const now = new Date();
    return JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString("en-US", { timeZone: "America/New_York" }),
      day: now.toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        weekday: "long",
      }),
      date: now.toLocaleDateString("en-US", { timeZone: "America/New_York" }),
      time: now.toLocaleTimeString("en-US", { timeZone: "America/New_York" }),
    });
  },
});

// ---------------------------------------------------------------------------
// Tool: search_memory
// ---------------------------------------------------------------------------
export const searchMemoryTool = tool({
  name: "search_memory",
  description:
    "Search across indexed documents, notes, ADRs, and memory for relevant information. Returns matching snippets with file paths.",
  parameters: z.object({
    query: z.string().describe("Natural language search query"),
    max_results: z
      .number()
      .optional()
      .describe("Maximum results to return (default 5)"),
  }),
  execute: async (params) => {
    const memoryUrl =
      process.env.LOBS_MEMORY_URL ?? "http://localhost:7420";
    const maxResults = params.max_results ?? 5;

    try {
      const resp = await fetch(`${memoryUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: params.query, limit: maxResults }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!resp.ok) {
        return `Memory search failed: HTTP ${resp.status}`;
      }

      const data = (await resp.json()) as {
        results?: Array<{
          path?: string;
          content?: string;
          score?: number;
        }>;
      };
      const results = data.results ?? [];

      if (results.length === 0) {
        return "No results found.";
      }

      return results
        .map(
          (r: { path?: string; content?: string; score?: number }, i: number) =>
            `[${i + 1}] ${r.path ?? "unknown"} (score: ${(r.score ?? 0).toFixed(2)})\n${(r.content ?? "").slice(0, 500)}`,
        )
        .join("\n\n");
    } catch (err) {
      return `Memory search error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: web_search
// ---------------------------------------------------------------------------
export const webSearchTool = tool({
  name: "web_search",
  description:
    "Search the web for current information. Returns a summary of search results.",
  parameters: z.object({
    query: z.string().describe("Search query"),
  }),
  execute: async (params) => {
    const searxUrl = process.env.SEARXNG_URL ?? "http://localhost:8888";

    try {
      const url = new URL("/search", searxUrl);
      url.searchParams.set("q", params.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("engines", "google,duckduckgo");
      url.searchParams.set("categories", "general");

      const resp = await fetch(url.toString(), {
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        return `Web search failed: HTTP ${resp.status}`;
      }

      const data = (await resp.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
        }>;
      };
      const results = (data.results ?? []).slice(0, 5);

      if (results.length === 0) {
        return "No web results found.";
      }

      return results
        .map(
          (
            r: { title?: string; url?: string; content?: string },
            i: number,
          ) =>
            `[${i + 1}] ${r.title ?? "Untitled"}\n${r.url ?? ""}\n${(r.content ?? "").slice(0, 300)}`,
        )
        .join("\n\n");
    } catch (err) {
      return `Web search error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: read_file
// ---------------------------------------------------------------------------
export const readFileTool = tool({
  name: "read_file",
  description:
    "Read the contents of a file. For quick lookups only — keep it short.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative file path to read"),
    max_lines: z
      .number()
      .optional()
      .describe("Maximum lines to return (default 100)"),
  }),
  execute: async (params) => {
    try {
      const filePath = resolve(params.path);

      if (!existsSync(filePath)) {
        return `File not found: ${params.path}`;
      }

      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return `Path is a directory, not a file: ${params.path}`;
      }
      if (stat.size > 512 * 1024) {
        return `File too large (${(stat.size / 1024).toFixed(0)}KB). Use max_lines to read a portion.`;
      }

      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const maxLines = params.max_lines ?? 100;

      if (lines.length > maxLines) {
        return (
          lines.slice(0, maxLines).join("\n") +
          `\n\n--- Truncated at ${maxLines} lines (${lines.length} total) ---`
        );
      }

      return content;
    } catch (err) {
      return `Read error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: spawn_agent
// ---------------------------------------------------------------------------
export const spawnAgentTool = tool({
  name: "spawn_agent",
  description:
    "Delegate a task to a background subagent. Returns immediately with confirmation — the agent runs asynchronously. Use for heavy tasks like coding, research, or writing.",
  parameters: z.object({
    task: z
      .string()
      .describe("Detailed description of the task to perform"),
    agent_type: z
      .enum(["programmer", "researcher", "writer"])
      .describe("Type of agent to spawn"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the agent (optional)"),
  }),
  execute: async (params) => {
    // Fire-and-forget: post to the orchestrator endpoint
    // The agent runs asynchronously — we don't wait for it
    try {
      const orchUrl =
        process.env.LOBS_ORCHESTRATOR_URL ?? "http://localhost:7410";
      const body = {
        task: params.task,
        agentType: params.agent_type,
        cwd: params.cwd,
        source: "voice-realtime",
      };

      // Non-blocking: fire the request but don't await completion
      fetch(`${orchUrl}/api/agents/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      }).catch((err: unknown) => {
        console.error(
          "[voice:realtime] spawn_agent request failed:",
          err instanceof Error ? err.message : String(err),
        );
      });

      return `Agent spawned: ${params.agent_type} agent is now working on "${params.task.slice(0, 100)}". I'll let you know when it's done.`;
    } catch (err) {
      return `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ---------------------------------------------------------------------------
// All voice tools
// ---------------------------------------------------------------------------
export const realtimeVoiceTools = [
  getDatetimeTool,
  searchMemoryTool,
  webSearchTool,
  readFileTool,
  spawnAgentTool,
];
