/**
 * Realtime Voice Tools — tools available to the Realtime voice agent
 *
 * These are a curated subset of the main agent's tools, optimized for
 * voice conversation: fast, read-only, non-destructive.
 * Uses the Realtime SDK's `tool()` helper so the definitions match the
 * documented RealtimeAgent function-tool path.
 */

import type { RunContext } from "@openai/agents-core";
import { backgroundResult, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { getDb } from "../../db/connection.js";
import { getBotId } from "../../config/identity.js";
import { inboxItems } from "../../db/schema.js";
import { executeSpawnAgent } from "../../runner/tools/agent-control.js";
import type { DeferredActionQueue } from "./deferred-action-queue.js";

export interface RealtimeVoiceToolContext {
  enqueueBackgroundToolResult?: (job: {
    toolName: string;
    task: Promise<string>;
    startedAt: number;
  }) => void;
  channelId?: string;
  cwd?: string;
  /** Queue for deferred actions during live meetings */
  deferredActionQueue?: DeferredActionQueue;
}

export function queueBackgroundVoiceTool(
  toolName: string,
  acknowledgement: string,
  runContext: RunContext<RealtimeVoiceToolContext> | undefined,
  task: Promise<string>,
): Promise<string | ReturnType<typeof backgroundResult<string>>> {
  const enqueue = runContext?.context.enqueueBackgroundToolResult;
  if (!enqueue) return task;

  enqueue({
    toolName,
    task,
    startedAt: Date.now(),
  });
  return Promise.resolve(backgroundResult(acknowledgement));
}

// ---------------------------------------------------------------------------
// Tool: get_datetime
// ---------------------------------------------------------------------------
export const getDatetimeTool = tool<z.ZodObject<{}>, RealtimeVoiceToolContext>({
  name: "get_datetime",
  description:
    "Get the current date, time, and day of the week. Use this for time-sensitive questions instead of guessing.",
  parameters: z.object({}),
  execute: async (_params, runContext) => {
    return queueBackgroundVoiceTool(
      "get_datetime",
      "Checking the time now.",
      runContext,
      Promise.resolve().then(() => {
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
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// Tool: search_memory
// ---------------------------------------------------------------------------
export const searchMemoryTool = tool({
  name: "search_memory",
  description:
    "Search across memory, notes, docs, and indexed files. Use this for questions about Rafe, his life, his schedule, his projects, preferences, prior decisions, and internal docs before saying you do not know.",
  parameters: z.object({
    query: z.string().describe("Natural language search query"),
    max_results: z
      .number()
      .optional()
      .describe("Maximum results to return (default 5)"),
  }),
  execute: async (params, runContext?: RunContext<RealtimeVoiceToolContext>) => {
    const memoryUrl =
      process.env.LOBS_MEMORY_URL ?? "http://localhost:7420";
    const maxResults = params.max_results ?? 5;

    return queueBackgroundVoiceTool(
      "search_memory",
      `Checking memory for ${JSON.stringify(params.query)}.`,
      runContext,
      (async () => {
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
      })(),
    );
  },
});

// ---------------------------------------------------------------------------
// Tool: web_search
// ---------------------------------------------------------------------------
export const webSearchTool = tool({
  name: "web_search",
  description:
    "Search the web for current external information. Use this only for current events or outside facts that would not be in memory or local files.",
  parameters: z.object({
    query: z.string().describe("Search query"),
  }),
  execute: async (params, runContext?: RunContext<RealtimeVoiceToolContext>) => {
    const searxUrl = process.env.SEARXNG_URL ?? "http://localhost:8888";

    return queueBackgroundVoiceTool(
      "web_search",
      `Searching the web for ${JSON.stringify(params.query)}.`,
      runContext,
      (async () => {
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
      })(),
    );
  },
});

// ---------------------------------------------------------------------------
// Tool: read_file
// ---------------------------------------------------------------------------
export const readFileTool = tool({
  name: "read_file",
  description:
    "Read the contents of a specific file when you know or strongly suspect the relevant path. Use this for direct inspection of local docs, notes, or config files.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative file path to read"),
    max_lines: z
      .number()
      .optional()
      .describe("Maximum lines to return (default 100)"),
  }),
  execute: async (params, runContext?: RunContext<RealtimeVoiceToolContext>) => {
    return queueBackgroundVoiceTool(
      "read_file",
      `Reading ${JSON.stringify(params.path)}.`,
      runContext,
      (async () => {
        try {
          const normalizedPath = params.path.startsWith("~/")
            ? resolve(homedir(), params.path.slice(2))
            : params.path === "~"
              ? homedir()
              : params.path;
          const filePath = resolve(normalizedPath);

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
      })(),
    );
  },
});

// ---------------------------------------------------------------------------
// Tool: spawn_agent
// ---------------------------------------------------------------------------
export const spawnAgentTool = tool({
  name: "spawn_agent",
  description:
    "Delegate a substantial task to a background subagent. Use this for coding, deeper research, or writing work that would take longer than a quick voice answer.",
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
  execute: async (params, runContext?: RunContext<RealtimeVoiceToolContext>) => {
    return queueBackgroundVoiceTool(
      "spawn_agent",
      `Starting a ${params.agent_type} subagent now.`,
      runContext,
      (async () => {
        try {
          const channelId = runContext?.context.channelId;
          const cwd = params.cwd ?? runContext?.context.cwd;
          return await executeSpawnAgent(
            {
              agent_type: params.agent_type,
              task: params.task,
              cwd,
              model_tier: "small",
            },
            cwd,
            channelId,
          );
        } catch {
          return "Background delegation unavailable right now.";
        }
      })(),
    );
  },
});

// ---------------------------------------------------------------------------
// Tool: write_note
// ---------------------------------------------------------------------------
export const writeNoteTool = tool({
  name: "write_note",
  description:
    "Save a short note, reminder, idea, or follow-up item for later processing. Use this when Rafe asks you to remember something from the conversation or jot down a note.",
  parameters: z.object({
    title: z
      .string()
      .describe("A short title for the note"),
    content: z
      .string()
      .describe("The actual note content to save"),
  }),
  execute: async (params, runContext?: RunContext<RealtimeVoiceToolContext>) => {
    return queueBackgroundVoiceTool(
      "write_note",
      "Writing that down.",
      runContext,
      Promise.resolve().then(() => {
        const db = getDb();
        const id = randomUUID();
        db.insert(inboxItems).values({
          id,
          title: params.title,
          content: params.content,
          type: "voice_note",
          requiresAction: false,
          actionStatus: "pending",
          sourceAgent: "voice-realtime",
        }).run();

        return `Saved note: ${params.title}`;
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// Tool: defer_action
// ---------------------------------------------------------------------------
export const deferActionTool = tool({
  name: "defer_action",
  description:
    "Queue an action item for after the meeting. Use this for tasks, investigations, follow-ups, or ideas that emerged from discussion but do NOT need immediate execution. Don't announce every deferral — just quietly log it unless someone explicitly asked you to write something down.",
  parameters: z.object({
    description: z
      .string()
      .describe("Clear, actionable description of what needs to be done"),
    action_type: z
      .enum([
        "investigate",
        "implement",
        "write_doc",
        "review_pr",
        "research",
        "fix_bug",
        "other",
      ])
      .describe("Category of the action"),
    priority: z
      .enum(["high", "medium", "low"])
      .describe("Urgency — high for blockers/bugs, medium for features, low for nice-to-haves"),
    assignee: z
      .string()
      .optional()
      .describe(
        "Who should do this — lowercase first name. Default: lobs. Only assign to a person if it explicitly requires human action.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "Brief context from the discussion that prompted this action",
      ),
  }),
  execute: async (params, runContext?: RunContext<RealtimeVoiceToolContext>) => {
    const queue = runContext?.context.deferredActionQueue;
    if (queue) {
      queue.add({
        description: params.description,
        actionType: params.action_type,
        priority: params.priority,
        assignee: params.assignee ?? getBotId(),
        context: params.context,
        timestamp: Date.now(),
      });
      return `Noted for after the meeting: ${params.description}`;
    }
    // Fallback: no queue available — save as inbox note instead
    const db = getDb();
    const id = randomUUID();
    db.insert(inboxItems)
      .values({
        id,
        title: `Deferred: ${params.description.slice(0, 80)}`,
        content: `Action type: ${params.action_type}\nPriority: ${params.priority}\nAssignee: ${params.assignee ?? getBotId()}\n${params.context ? `Context: ${params.context}` : ""}\n\n${params.description}`,
        type: "voice_note",
        requiresAction: true,
        actionStatus: "pending",
        sourceAgent: "voice-realtime",
      })
      .run();
    return `Saved as inbox item: ${params.description}`;
  },
});

// ---------------------------------------------------------------------------
// All voice tools
// ---------------------------------------------------------------------------
export const realtimeVoiceTools = [
  searchMemoryTool,
  readFileTool,
  writeNoteTool,
  spawnAgentTool,
  deferActionTool,
];
