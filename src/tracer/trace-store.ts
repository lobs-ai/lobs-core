/**
 * trace-store.ts — low-level read/write for agent execution traces.
 *
 * Schema (appended to the main SQLite DB via migrate.ts):
 *
 *   agent_traces   — one row per agent run (the root span)
 *   trace_spans    — one row per event within a run (tool calls, LLM turns, etc.)
 *
 * Trace format is OpenTelemetry-compatible so traces can be exported to any
 * OTLP-compatible backend (Jaeger, Tempo, Honeycomb, etc.).
 */

import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SpanKind = "agent" | "llm" | "tool" | "compaction" | "error";

export interface TraceSpan {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  startTimeMs: number;
  endTimeMs: number | null;
  durationMs: number | null;
  status: "ok" | "error" | "running";
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export interface SpanEvent {
  timeMs: number;
  name: string;
  attributes?: Record<string, unknown>;
}

export interface AgentTrace {
  traceId: string;
  runId: string;
  agentType: string;
  taskId: string | null;
  taskSummary: string | null;
  model: string | null;
  status: "running" | "completed" | "failed" | "timeout" | "interrupted";
  startTimeMs: number;
  endTimeMs: number | null;
  durationMs: number | null;
  totalTurns: number;
  totalToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  stopReason: string | null;
  errorMessage: string | null;
  spanCount: number;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export function createAgentTrace(
  db: Database.Database,
  params: {
    traceId: string;
    runId: string;
    agentType: string;
    taskId?: string | null;
    taskSummary?: string | null;
    model?: string | null;
  }
): void {
  db.prepare(`
    INSERT OR IGNORE INTO agent_traces (
      trace_id, run_id, agent_type, task_id, task_summary, model,
      status, start_time_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(
    params.traceId,
    params.runId,
    params.agentType,
    params.taskId ?? null,
    params.taskSummary ?? null,
    params.model ?? null,
    Date.now(),
  );
}

export function updateAgentTrace(
  db: Database.Database,
  traceId: string,
  update: Partial<{
    status: AgentTrace["status"];
    endTimeMs: number;
    durationMs: number;
    totalTurns: number;
    totalToolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    stopReason: string;
    errorMessage: string;
    spanCount: number;
  }>
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (update.status !== undefined) { sets.push("status = ?"); vals.push(update.status); }
  if (update.endTimeMs !== undefined) { sets.push("end_time_ms = ?"); vals.push(update.endTimeMs); }
  if (update.durationMs !== undefined) { sets.push("duration_ms = ?"); vals.push(update.durationMs); }
  if (update.totalTurns !== undefined) { sets.push("total_turns = ?"); vals.push(update.totalTurns); }
  if (update.totalToolCalls !== undefined) { sets.push("total_tool_calls = ?"); vals.push(update.totalToolCalls); }
  if (update.inputTokens !== undefined) { sets.push("input_tokens = ?"); vals.push(update.inputTokens); }
  if (update.outputTokens !== undefined) { sets.push("output_tokens = ?"); vals.push(update.outputTokens); }
  if (update.costUsd !== undefined) { sets.push("cost_usd = ?"); vals.push(update.costUsd); }
  if (update.stopReason !== undefined) { sets.push("stop_reason = ?"); vals.push(update.stopReason); }
  if (update.errorMessage !== undefined) { sets.push("error_message = ?"); vals.push(update.errorMessage); }
  if (update.spanCount !== undefined) { sets.push("span_count = ?"); vals.push(update.spanCount); }

  if (sets.length === 0) return;

  vals.push(traceId);
  db.prepare(`UPDATE agent_traces SET ${sets.join(", ")} WHERE trace_id = ?`).run(...vals);
}

export function insertSpan(
  db: Database.Database,
  span: Omit<TraceSpan, "events"> & { events?: SpanEvent[] }
): void {
  db.prepare(`
    INSERT OR IGNORE INTO trace_spans (
      span_id, trace_id, parent_span_id, name, kind,
      start_time_ms, end_time_ms, duration_ms, status,
      attributes_json, events_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    span.spanId,
    span.traceId,
    span.parentSpanId ?? null,
    span.name,
    span.kind,
    span.startTimeMs,
    span.endTimeMs ?? null,
    span.durationMs ?? null,
    span.status,
    JSON.stringify(span.attributes),
    JSON.stringify(span.events ?? []),
  );
}

export function updateSpan(
  db: Database.Database,
  spanId: string,
  update: {
    endTimeMs: number;
    durationMs: number;
    status: "ok" | "error";
    attributes?: Record<string, unknown>;
    events?: SpanEvent[];
  }
): void {
  db.prepare(
    `UPDATE trace_spans SET end_time_ms = ?, duration_ms = ?, status = ?, attributes_json = ?, events_json = ? WHERE span_id = ?`
  ).run(
    update.endTimeMs,
    update.durationMs,
    update.status,
    update.attributes ? JSON.stringify(update.attributes) : null,
    update.events ? JSON.stringify(update.events) : null,
    spanId,
  );
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export function listTraces(db: Database.Database, limit = 50, offset = 0): AgentTrace[] {
  const rows = db.prepare(
    `SELECT * FROM agent_traces ORDER BY start_time_ms DESC LIMIT ? OFFSET ?`
  ).all(limit, offset) as Record<string, unknown>[];
  return rows.map(rowToTrace);
}

export function getTrace(db: Database.Database, traceId: string): AgentTrace | null {
  const row = db.prepare(
    `SELECT * FROM agent_traces WHERE trace_id = ?`
  ).get(traceId) as Record<string, unknown> | null;
  return row ? rowToTrace(row) : null;
}

export function getTraceByRunId(db: Database.Database, runId: string): AgentTrace | null {
  const row = db.prepare(
    `SELECT * FROM agent_traces WHERE run_id = ? ORDER BY start_time_ms DESC LIMIT 1`
  ).get(runId) as Record<string, unknown> | null;
  return row ? rowToTrace(row) : null;
}

export function getSpansForTrace(db: Database.Database, traceId: string): TraceSpan[] {
  const rows = db.prepare(
    `SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY start_time_ms ASC`
  ).all(traceId) as Record<string, unknown>[];
  return rows.map(rowToSpan);
}

/**
 * Recover traces stuck in "running" from a previous process.
 * Counts actual spans to populate stats, marks status as "interrupted".
 * Also closes all running/stale spans for those traces.
 * Call once at startup before new traces begin.
 */
export function recoverStaleTraces(db: Database.Database): number {
  const staleRows = db.prepare(
    `SELECT trace_id, start_time_ms FROM agent_traces WHERE status = 'running'`
  ).all() as { trace_id: string; start_time_ms: number }[];

  if (staleRows.length === 0) return 0;

  const countSpans = db.prepare(
    `SELECT COUNT(*) as total,
            SUM(kind = 'llm') as llm_count,
            SUM(kind = 'tool') as tool_count,
            MAX(COALESCE(end_time_ms, start_time_ms)) as last_end
     FROM trace_spans WHERE trace_id = ?`
  );
  const updateTraceStmt = db.prepare(
    `UPDATE agent_traces
     SET status = 'interrupted',
         end_time_ms = ?,
         duration_ms = ?,
         total_turns = ?,
         total_tool_calls = ?,
         span_count = ?
     WHERE trace_id = ?`
  );
  // Close any running spans — set end_time = start_time (duration=0) so timeline still renders
  const closeRunningSpansStmt = db.prepare(
    `UPDATE trace_spans
     SET status = 'interrupted',
         end_time_ms = COALESCE(end_time_ms, start_time_ms),
         duration_ms = COALESCE(duration_ms, 0)
     WHERE trace_id = ? AND status = 'running'`
  );

  let recovered = 0;
  for (const row of staleRows) {
    // Close running spans first so last_end is accurate
    closeRunningSpansStmt.run(row.trace_id);

    const stats = countSpans.get(row.trace_id) as {
      total: number;
      llm_count: number;
      tool_count: number;
      last_end: number | null;
    } | null;
    const endMs = stats?.last_end ?? Date.now();
    const durationMs = endMs - row.start_time_ms;
    updateTraceStmt.run(
      endMs,
      durationMs,
      stats?.llm_count ?? 0,
      stats?.tool_count ?? 0,
      stats?.total ?? 0,
      row.trace_id,
    );
    recovered++;
  }

  return recovered;
}

export function countTraces(db: Database.Database): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM agent_traces`
  ).get() as { count: number } | null;
  return row?.count ?? 0;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToTrace(row: Record<string, unknown>): AgentTrace {
  return {
    traceId: String(row.trace_id),
    runId: String(row.run_id),
    agentType: String(row.agent_type),
    taskId: row.task_id ? String(row.task_id) : null,
    taskSummary: row.task_summary ? String(row.task_summary) : null,
    model: row.model ? String(row.model) : null,
    status: (row.status as AgentTrace["status"]) ?? "running",
    startTimeMs: Number(row.start_time_ms),
    endTimeMs: row.end_time_ms ? Number(row.end_time_ms) : null,
    durationMs: row.duration_ms ? Number(row.duration_ms) : null,
    totalTurns: Number(row.total_turns ?? 0),
    totalToolCalls: Number(row.total_tool_calls ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    costUsd: row.cost_usd ? Number(row.cost_usd) : null,
    stopReason: row.stop_reason ? String(row.stop_reason) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    spanCount: Number(row.span_count ?? 0),
  };
}

function rowToSpan(row: Record<string, unknown>): TraceSpan {
  let attributes: Record<string, unknown> = {};
  let events: SpanEvent[] = [];
  try { attributes = JSON.parse(String(row.attributes_json ?? "{}")); } catch { /* ignore */ }
  try { events = JSON.parse(String(row.events_json ?? "[]")); } catch { /* ignore */ }
  return {
    spanId: String(row.span_id),
    traceId: String(row.trace_id),
    parentSpanId: row.parent_span_id ? String(row.parent_span_id) : null,
    name: String(row.name),
    kind: (row.kind as SpanKind) ?? "agent",
    startTimeMs: Number(row.start_time_ms),
    endTimeMs: row.end_time_ms ? Number(row.end_time_ms) : null,
    durationMs: row.duration_ms ? Number(row.duration_ms) : null,
    status: (row.status as TraceSpan["status"]) ?? "running",
    attributes,
    events,
  };
}

// ── OTLP-compatible JSON export ───────────────────────────────────────────────

export function exportTraceAsOtlp(trace: AgentTrace, spans: TraceSpan[]): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "lobs-core" } },
            { key: "agent.type", value: { stringValue: trace.agentType } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "lobs-core/tracer", version: "0.1.0" },
            spans: spans.map((span) => ({
              traceId: trace.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId ?? undefined,
              name: span.name,
              kind: kindToOtlp(span.kind),
              startTimeUnixNano: String(span.startTimeMs * 1_000_000),
              endTimeUnixNano: span.endTimeMs ? String(span.endTimeMs * 1_000_000) : undefined,
              status: { code: span.status === "error" ? 2 : 1 },
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: valueToOtlp(value),
              })),
              events: span.events.map((evt) => ({
                name: evt.name,
                timeUnixNano: String(evt.timeMs * 1_000_000),
                attributes: Object.entries(evt.attributes ?? {}).map(([k, v]) => ({
                  key: k,
                  value: valueToOtlp(v),
                })),
              })),
            })),
          },
        ],
      },
    ],
  };
}

function kindToOtlp(kind: SpanKind): number {
  // OTLP SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER
  switch (kind) {
    case "agent": return 1;
    case "llm": return 3;   // client call
    case "tool": return 1;
    case "compaction": return 1;
    case "error": return 1;
    default: return 0;
  }
}

function valueToOtlp(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return { stringValue: JSON.stringify(value) };
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}
