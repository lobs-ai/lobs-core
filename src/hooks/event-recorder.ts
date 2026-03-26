/**
 * event-recorder hook — automatically capture agent runtime events to memory.db.
 *
 * Hooks into the runner lifecycle (before_agent_start, after_tool_call, on_error,
 * after_agent_end) and writes structured, human-readable events via EventRecorder.
 *
 * Intentionally low-overhead: all DB writes are fire-and-forget (errors are
 * swallowed inside EventRecorder so recording can never crash the agent).
 */

import type { LobsPluginApi } from "../types/lobs-plugin.js";
import { getHookRegistry, type HookEvent, type HookHandler } from "../runner/hooks.js";
import { getEventRecorder } from "../memory/event-recorder.js";
import type { RecordEventParams } from "../memory/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a stable agent_id from the hook event.
 * Uses "{agentType}-{taskId}" when a taskId is available, otherwise just agentType.
 */
function agentIdFrom(event: HookEvent): string {
  return event.taskId ? `${event.agentType}-${event.taskId}` : event.agentType;
}

/**
 * Truncate a string to a max length and append "…" if truncated.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/**
 * Produce a concise, human-readable summary for an after_tool_call event.
 *
 * Examples:
 *   exec "ls src/"        → "Listed directory (ls src/)"
 *   write "src/foo.ts"    → "Wrote file src/foo.ts"
 *   read "src/bar.ts"     → "Read file src/bar.ts"
 *   memory_search "hooks" → "Memory search: hooks"
 *   web_search "react"    → "Web search: react"
 */
function summariseToolCall(
  toolName: string,
  params: Record<string, unknown>,
  result: Record<string, unknown>,
  isError: boolean,
): string {
  if (isError) {
    const errContent = typeof result.content === "string" ? truncate(result.content, 120) : "unknown error";
    return `Tool error [${toolName}]: ${errContent}`;
  }

  const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

  switch (toolName) {
    case "exec": {
      const cmd = typeof params.command === "string" ? truncate(params.command, 80) : "";
      const lines = content.split("\n").length;
      return `Exec: ${cmd} (${lines} lines output)`;
    }
    case "ls": {
      const path = typeof params.path === "string" ? params.path : ".";
      const lines = content.split("\n").filter(Boolean).length;
      return `Listed directory ${path} (${lines} entries)`;
    }
    case "read": {
      const path = typeof params.path === "string" ? params.path : "unknown";
      const offset = typeof params.offset === "number" ? params.offset : 1;
      const limit = typeof params.limit === "number" ? params.limit : null;
      return limit
        ? `Read file ${path} (lines ${offset}–${offset + limit - 1})`
        : `Read file ${path}`;
    }
    case "write": {
      const path = typeof params.path === "string" ? params.path : "unknown";
      const lines = (typeof params.content === "string" ? params.content : "").split("\n").length;
      return `Wrote file ${path} (${lines} lines)`;
    }
    case "edit": {
      const path = typeof params.path === "string" ? params.path : "unknown";
      return `Edited file ${path}`;
    }
    case "grep": {
      const pattern = typeof params.pattern === "string" ? params.pattern : "";
      const matches = content.split("\n").filter(Boolean).length;
      return `Grep: ${truncate(pattern, 60)} (${matches} matches)`;
    }
    case "memory_search": {
      const query = typeof params.query === "string" ? truncate(params.query, 80) : "";
      return `Memory search: ${query}`;
    }
    case "web_search": {
      const query = typeof params.query === "string" ? truncate(params.query, 80) : "";
      return `Web search: ${query}`;
    }
    case "web_fetch": {
      const url = typeof params.url === "string" ? truncate(params.url, 80) : "";
      return `Fetched URL: ${url}`;
    }
    case "code_search": {
      const query = typeof params.query === "string" ? truncate(params.query, 80) : "";
      return `Code search: ${query}`;
    }
    case "memory_write": {
      const category = typeof params.category === "string" ? params.category : "";
      const contentStr = typeof params.content === "string" ? truncate(params.content, 60) : "";
      return `Wrote memory [${category}]: ${contentStr}`;
    }
    case "memory_read": {
      const path = typeof params.path === "string" ? params.path : "unknown";
      return `Read memory file ${path}`;
    }
    default: {
      const resultLen = content.length;
      return `Tool ${toolName} completed (${resultLen} chars output)`;
    }
  }
}

/**
 * Determine whether a tool call is better classified as an "action" (mutating)
 * or a "tool_result" (read / informational).
 *
 * Mutations: write, edit, exec (modifying commands), memory_write
 */
function toolEventType(
  toolName: string,
  params: Record<string, unknown>,
): RecordEventParams["eventType"] {
  if (toolName === "write" || toolName === "edit" || toolName === "memory_write") {
    return "action";
  }
  if (toolName === "exec") {
    const cmd = typeof params.command === "string" ? params.command : "";
    // Pure navigation/inspection commands → tool_result (read-like)
    if (/^\s*(ls|pwd|cat|echo|which|type|find|grep|wc|head|tail)\b/.test(cmd)) {
      return "tool_result";
    }
    // cd alone → action (navigation)
    if (/^\s*cd\b/.test(cmd)) {
      return "action";
    }
    // Everything else (git, npm, bun, make, etc.) → action
    return "action";
  }
  return "tool_result";
}

// ── Hook registration ────────────────────────────────────────────────────────

/**
 * Register runner hooks that automatically record agent events to memory.db.
 *
 * Must be called after initMemoryDb() has been invoked so the DB is ready.
 *
 * @param _api - LobsPluginApi (unused — we wire directly into HookRegistry)
 */
export function registerEventRecorderHook(_api: LobsPluginApi): void {
  const registry = getHookRegistry();
  const recorder = getEventRecorder();

  // ── before_agent_start ────────────────────────────────────────────────────
  const beforeAgentStart: HookHandler = async (event: HookEvent) => {
    try {
      const spec = event.data.spec as { task?: string; agent?: string; context?: { projectId?: string } } | undefined;
      const task = spec?.task ?? "";

      recorder.recordEvent({
        agentId: agentIdFrom(event),
        agentType: event.agentType,
        sessionId: event.taskId,
        eventType: "user_input",
        content: truncate(task, 500),
        metadata: {
          agent: event.agentType,
          taskId: event.taskId,
        },
        scope: event.taskId ? "session" : "agent",
        projectId: spec?.context?.projectId,
      });
    } catch {
      // never throw from a hook
    }
    return event;
  };
  // Low priority — record after other hooks have processed
  registry.register("before_agent_start", beforeAgentStart, -10);

  // ── after_tool_call ───────────────────────────────────────────────────────
  const afterToolCall: HookHandler = async (event: HookEvent) => {
    try {
      const toolName = typeof event.data.toolName === "string" ? event.data.toolName : "unknown";
      const rawResult = event.data.result as Record<string, unknown> | undefined;
      const isError = Boolean(event.data.isError);
      const params = (event.data.params ?? {}) as Record<string, unknown>;

      const result = rawResult ?? {};

      const eventType = toolEventType(toolName, params);
      const content = summariseToolCall(toolName, params, result, isError);

      // Build concise metadata — avoid dumping full outputs
      const resultContent = typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? "");
      const metadata: Record<string, unknown> = {
        tool: toolName,
        isError,
        outputLength: resultContent.length,
      };

      // Include command for exec, path for read/write/edit
      if (toolName === "exec" && typeof params.command === "string") {
        metadata.command = truncate(params.command, 200);
      } else if (["read", "write", "edit", "ls"].includes(toolName) && typeof params.path === "string") {
        metadata.path = params.path;
      } else if (["memory_search", "web_search", "code_search"].includes(toolName) && typeof params.query === "string") {
        metadata.query = truncate(params.query, 200);
      } else if (toolName === "web_fetch" && typeof params.url === "string") {
        metadata.url = truncate(params.url, 200);
      }

      recorder.recordEvent({
        agentId: agentIdFrom(event),
        agentType: event.agentType,
        sessionId: event.taskId,
        eventType,
        content,
        metadata,
        scope: event.taskId ? "session" : "agent",
      });
    } catch {
      // never throw from a hook
    }
    return event;
  };
  registry.register("after_tool_call", afterToolCall, -10);

  // ── on_error ──────────────────────────────────────────────────────────────
  const onError: HookHandler = async (event: HookEvent) => {
    try {
      const errorMsg = typeof event.data.error === "string" ? event.data.error : JSON.stringify(event.data.error);
      const turns = typeof event.data.turns === "number" ? event.data.turns : undefined;

      recorder.recordEvent({
        agentId: agentIdFrom(event),
        agentType: event.agentType,
        sessionId: event.taskId,
        eventType: "error",
        content: truncate(errorMsg, 500),
        metadata: {
          turns,
          durationSeconds: event.data.durationSeconds,
        },
        scope: event.taskId ? "session" : "agent",
      });
    } catch {
      // never throw from a hook
    }
    return event;
  };
  registry.register("on_error", onError, -10);

  // ── after_agent_end ───────────────────────────────────────────────────────
  const afterAgentEnd: HookHandler = async (event: HookEvent) => {
    try {
      const result = event.data.result as string | undefined;
      const turns = typeof event.data.turns === "number" ? event.data.turns : 0;
      const durationSeconds =
        typeof event.data.durationSeconds === "number" ? event.data.durationSeconds : undefined;
      const succeeded = !event.data.error;

      const summary = result
        ? truncate(result, 300)
        : succeeded
          ? `Agent completed after ${turns} turns`
          : `Agent failed after ${turns} turns`;

      recorder.recordEvent({
        agentId: agentIdFrom(event),
        agentType: event.agentType,
        sessionId: event.taskId,
        eventType: "observation",
        content: summary,
        metadata: {
          turns,
          durationSeconds,
          succeeded,
          stopReason: event.data.stopReason,
        },
        scope: event.taskId ? "session" : "agent",
      });
    } catch {
      // never throw from a hook
    }
    return event;
  };
  registry.register("after_agent_end", afterAgentEnd, -10);
}
