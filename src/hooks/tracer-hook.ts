/**
 * tracer-hook.ts — agent execution tracer via the hook system.
 *
 * Attaches to the lobs-core hook registry and records every agent lifecycle
 * event (LLM turns, tool calls, errors, completions) as OpenTelemetry-
 * compatible spans in the local SQLite DB.
 *
 * Zero-overhead design: all writes are fire-and-forget. A tracer error never
 * propagates to the agent loop.
 */

import { getHookRegistry, type HookEvent } from "../runner/hooks.js";
import { getRawDb } from "../db/connection.js";
import {
  createAgentTrace,
  updateAgentTrace,
  insertSpan,
  updateSpan,
  newSpanId,
  newTraceId,
  recoverStaleTraces,
} from "../tracer/trace-store.js";
import type Database from "better-sqlite3";

// ── In-memory bookkeeping ─────────────────────────────────────────────────────

interface ActiveTrace {
  traceId: string;
  rootSpanId: string;
  turnSpanId: string | null;
  startTimeMs: number;
  /** map from toolUseId → spanId */
  toolSpans: Map<string, string>;
  /** map from spanId → startTimeMs for duration calculation */
  spanStartTimes: Map<string, number>;
  turns: number;
  toolCalls: number;
  model: string | null;
}

// Keyed by runId (derived from taskId or agentType+timestamp)
const activeTraces = new Map<string, ActiveTrace>();

function getOrCreateTrace(db: Database.Database, event: HookEvent): ActiveTrace {
  const runKey = event.taskId ?? `${event.agentType}__${event.timestamp.getTime()}`;
  if (activeTraces.has(runKey)) return activeTraces.get(runKey)!;

  const traceId = newTraceId();
  const rootSpanId = newSpanId();
  const now = event.timestamp.getTime();

  createAgentTrace(db, {
    traceId,
    runId: runKey,
    agentType: event.agentType,
    taskId: event.taskId ?? null,
    model: (event.data as Record<string, unknown>)?.model as string | null ?? null,
  });

  insertSpan(db, {
    spanId: rootSpanId,
    traceId,
    parentSpanId: null,
    name: `agent:${event.agentType}`,
    kind: "agent",
    startTimeMs: now,
    endTimeMs: null,
    durationMs: null,
    status: "running",
    attributes: {
      "agent.type": event.agentType,
      "task.id": event.taskId ?? "",
    },
    events: [{ timeMs: now, name: "agent_start" }],
  });

  const trace: ActiveTrace = {
    traceId,
    rootSpanId,
    turnSpanId: null,
    startTimeMs: now,
    toolSpans: new Map(),
    spanStartTimes: new Map([[rootSpanId, now]]),
    turns: 0,
    toolCalls: 0,
    model: null,
  };
  activeTraces.set(runKey, trace);
  return trace;
}

// ── Hook handlers ─────────────────────────────────────────────────────────────

export function registerTracerHook(): void {
  const hookRegistry = getHookRegistry();
  const db: Database.Database = getRawDb();

  // Heal any traces left in "running" status from a previous process restart
  try {
    const recovered = recoverStaleTraces(db);
    if (recovered > 0) {
      console.log(`[tracer-hook] Recovered ${recovered} stale trace(s) from previous session`);
    }
  } catch (err) {
    console.warn("[tracer-hook] recoverStaleTraces error:", err);
  }

  // ── before_agent_start ────────────────────────────────────────────────────
  hookRegistry.register("before_agent_start", async (event: HookEvent) => {
    try {
      getOrCreateTrace(db, event);
    } catch (err) {
      console.warn("[tracer-hook] before_agent_start error:", err);
    }
    return event;
  });

  // ── before_llm_call ───────────────────────────────────────────────────────
  hookRegistry.register("before_llm_call", async (event: HookEvent) => {
    try {
      const runKey = event.taskId ?? `${event.agentType}__${event.timestamp.getTime()}`;
      const trace = getOrCreateTrace(db, event);
      const data = event.data as Record<string, unknown>;

      if (data.model && typeof data.model === "string") {
        trace.model = data.model;
      }

      trace.turns++;
      const spanId = newSpanId();
      trace.turnSpanId = spanId;
      const now = event.timestamp.getTime();
      trace.spanStartTimes.set(spanId, now);

      insertSpan(db, {
        spanId,
        traceId: trace.traceId,
        parentSpanId: trace.rootSpanId,
        name: `llm:turn_${trace.turns}`,
        kind: "llm",
        startTimeMs: now,
        endTimeMs: null,
        durationMs: null,
        status: "running",
        attributes: {
          "llm.turn": trace.turns,
          "llm.model": data.model ?? "",
          "llm.message_count": data.messageCount ?? 0,
        },
        events: [],
      });

      // Update the runKey on the map (taskId might be set now)
      activeTraces.set(runKey, trace);
    } catch (err) {
      console.warn("[tracer-hook] before_llm_call error:", err);
    }
    return event;
  });

  // ── after_llm_call ────────────────────────────────────────────────────────
  hookRegistry.register("after_llm_call", async (event: HookEvent) => {
    try {
      const runKey = event.taskId ?? `${event.agentType}__${event.timestamp.getTime()}`;
      const trace = activeTraces.get(runKey);
      if (!trace?.turnSpanId) return event;

      const data = event.data as Record<string, unknown>;
      const usage = data.usage as Record<string, number> | undefined;
      const now = event.timestamp.getTime();
      const startMs = trace.spanStartTimes.get(trace.turnSpanId) ?? now;

      updateSpan(db, trace.turnSpanId, {
        endTimeMs: now,
        durationMs: Math.max(0, now - startMs),
        status: "ok",
        attributes: {
          "llm.stop_reason": data.stopReason ?? "",
          "llm.input_tokens": usage?.inputTokens ?? 0,
          "llm.output_tokens": usage?.outputTokens ?? 0,
          "llm.cache_read_tokens": usage?.cacheReadTokens ?? 0,
          "llm.thinking_tokens": usage?.thinkingTokens ?? 0,
        },
        events: [],
      });

      trace.spanStartTimes.delete(trace.turnSpanId);
      trace.turnSpanId = null;
    } catch (err) {
      console.warn("[tracer-hook] after_llm_call error:", err);
    }
    return event;
  });

  // ── before_tool_call ──────────────────────────────────────────────────────
  hookRegistry.register("before_tool_call", async (event: HookEvent) => {
    try {
      const runKey = event.taskId ?? `${event.agentType}__${event.timestamp.getTime()}`;
      const trace = getOrCreateTrace(db, event);
      const data = event.data as Record<string, unknown>;
      const toolUseId = String(data.toolUseId ?? newSpanId());
      const toolName = String(data.toolName ?? "unknown");

      trace.toolCalls++;
      const spanId = newSpanId();
      const now = event.timestamp.getTime();
      trace.toolSpans.set(toolUseId, spanId);
      trace.spanStartTimes.set(spanId, now);

      // Truncate large params for storage
      const params = data.params as Record<string, unknown> | undefined;
      const paramsSummary = params ? truncateParams(params) : {};

      insertSpan(db, {
        spanId,
        traceId: trace.traceId,
        parentSpanId: trace.turnSpanId ?? trace.rootSpanId,
        name: `tool:${toolName}`,
        kind: "tool",
        startTimeMs: now,
        endTimeMs: null,
        durationMs: null,
        status: "running",
        attributes: {
          "tool.name": toolName,
          "tool.use_id": toolUseId,
          "tool.params": paramsSummary,
        },
        events: [],
      });

      activeTraces.set(runKey, trace);
    } catch (err) {
      console.warn("[tracer-hook] before_tool_call error:", err);
    }
    return event;
  });

  // ── after_tool_call ───────────────────────────────────────────────────────
  hookRegistry.register("after_tool_call", async (event: HookEvent) => {
    try {
      const runKey = event.taskId ?? `${event.agentType}__${event.timestamp.getTime()}`;
      const trace = activeTraces.get(runKey);
      if (!trace) return event;

      const data = event.data as Record<string, unknown>;
      const toolUseId = String(data.toolUseId ?? "");
      const spanId = trace.toolSpans.get(toolUseId);
      if (!spanId) return event;

      const isError = Boolean(data.isError);
      const result = data.result as Record<string, unknown> | undefined;
      const resultContent = result?.content as string | undefined;
      const now = event.timestamp.getTime();
      const startMs = trace.spanStartTimes.get(spanId) ?? now;

      updateSpan(db, spanId, {
        endTimeMs: now,
        durationMs: Math.max(0, now - startMs),
        status: isError ? "error" : "ok",
        attributes: {
          "tool.name": String(data.toolName ?? ""),
          "tool.is_error": isError,
          "tool.result_preview": resultContent ? resultContent.slice(0, 300) : "",
          "tool.result_length": resultContent?.length ?? 0,
        },
        events: [],
      });

      trace.spanStartTimes.delete(spanId);
      trace.toolSpans.delete(toolUseId);
    } catch (err) {
      console.warn("[tracer-hook] after_tool_call error:", err);
    }
    return event;
  });

  // ── after_agent_end ───────────────────────────────────────────────────────
  hookRegistry.register("after_agent_end", async (event: HookEvent) => {
    try {
      const runKey = event.taskId ?? `${event.agentType}__${event.timestamp.getTime()}`;
      const trace = activeTraces.get(runKey);
      if (!trace) return event;

      const data = event.data as Record<string, unknown>;
      const usage = data.usage as Record<string, number> | undefined;
      const now = event.timestamp.getTime();

      const stopReason = String(data.stopReason ?? "");
      const status: "completed" | "failed" | "timeout" =
        stopReason === "timeout" ? "timeout"
        : stopReason === "error" ? "failed"
        : "completed";

      updateAgentTrace(db, trace.traceId, {
        status,
        endTimeMs: now,
        durationMs: Math.max(0, now - trace.startTimeMs),
        totalTurns: trace.turns,
        totalToolCalls: trace.toolCalls,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        stopReason,
        spanCount: trace.turns + trace.toolCalls + 1, // +1 for root span
      });

      // Close root span
      const rootStartMs = trace.spanStartTimes.get(trace.rootSpanId) ?? trace.startTimeMs;
      updateSpan(db, trace.rootSpanId, {
        endTimeMs: now,
        durationMs: Math.max(0, now - rootStartMs),
        status: status === "completed" ? "ok" : "error",
        attributes: {
          "agent.type": event.agentType,
          "agent.turns": trace.turns,
          "agent.tool_calls": trace.toolCalls,
          "agent.stop_reason": stopReason,
          "agent.input_tokens": usage?.inputTokens ?? 0,
          "agent.output_tokens": usage?.outputTokens ?? 0,
        },
        events: [{ timeMs: now, name: "agent_end", attributes: { stopReason } }],
      });

      activeTraces.delete(runKey);
    } catch (err) {
      console.warn("[tracer-hook] after_agent_end error:", err);
    }
    return event;
  });

  // ── on_error ──────────────────────────────────────────────────────────────
  hookRegistry.register("on_error", async (event: HookEvent) => {
    try {
      const runKey = event.taskId ?? `${event.agentType}__${event.timestamp.getTime()}`;
      const trace = activeTraces.get(runKey);
      if (!trace) return event;

      const data = event.data as Record<string, unknown>;
      const errMsg = String(data.error ?? data.message ?? "unknown error");
      const now = event.timestamp.getTime();

      const errSpanId = newSpanId();
      insertSpan(db, {
        spanId: errSpanId,
        traceId: trace.traceId,
        parentSpanId: trace.turnSpanId ?? trace.rootSpanId,
        name: "error",
        kind: "error",
        startTimeMs: now,
        endTimeMs: now,
        durationMs: 0,
        status: "error",
        attributes: {
          "error.message": errMsg,
          "error.type": String(data.errorType ?? "unknown"),
        },
        events: [],
      });

      updateAgentTrace(db, trace.traceId, {
        errorMessage: errMsg.slice(0, 500),
      });
    } catch (err) {
      console.warn("[tracer-hook] on_error error:", err);
    }
    return event;
  });

  console.log("[tracer-hook] registered");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v.length > 400) {
      out[k] = v.slice(0, 400) + "…";
    } else if (Array.isArray(v)) {
      out[k] = `[array:${v.length}]`;
    } else if (v && typeof v === "object") {
      out[k] = `[object]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
