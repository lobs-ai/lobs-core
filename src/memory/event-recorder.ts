/**
 * EventRecorder — write agent runtime events to the memory database.
 *
 * Responsible for:
 *  - Accepting structured event data from hooks
 *  - Classifying signal scores deterministically at ingestion time
 *  - Persisting events individually or in batches (transactions)
 *  - Providing lightweight query / stats helpers
 */

import { log } from "../util/logger.js";
import { getMemoryDb } from "./db.js";
import type {
  MemoryEvent,
  RecordEventParams,
  EventFilters,
  EventStats,
} from "./types.js";

// ── Signal classification ────────────────────────────────────────────────────

/**
 * Routine tools whose output is low-signal.
 * exec results are handled separately via command inspection.
 */
const ROUTINE_TOOLS = new Set(["ls"]);

/**
 * High-signal tools whose output indicates the agent sought external info.
 * File read/write/edit are mechanical (git is the record), not high-signal.
 */
const MEANINGFUL_TOOLS = new Set([
  "memory_search",
  "web_search",
  "web_fetch",
]);

/**
 * Simple patterns that indicate a navigation / listing exec command.
 * Checked against the first token / overall command string.
 */
const NAVIGATION_COMMAND_RE = /^\s*(ls|pwd|cd|echo)\b/;

/**
 * Classify a signal score for an event at ingestion time.
 *
 * Rules are applied in priority order and are deterministic — same input
 * always produces the same score.
 *
 * @param eventType - The event type being recorded.
 * @param metadata  - Optional structured metadata (tool name, command, etc.)
 * @returns A signal score in the range [0.0, 1.0].
 */
export function classifySignalScore(
  eventType: RecordEventParams["eventType"],
  metadata?: Record<string, unknown>,
): number {
  switch (eventType) {
    case "user_input":
      return 1.0;

    case "error":
      return 0.9;

    case "decision":
      return 0.9;

    case "observation":
      return 0.7;

    case "tool_result": {
      const toolName = typeof metadata?.tool === "string" ? metadata.tool : "";

      if (ROUTINE_TOOLS.has(toolName)) return 0.2;

      if (toolName === "exec") {
        const cmd = typeof metadata?.command === "string" ? metadata.command : "";
        if (NAVIGATION_COMMAND_RE.test(cmd)) return 0.2;
        return 0.3; // exec results are routine — git/logs are the record
      }

      // External info-seeking tools are genuinely high-signal
      if (MEANINGFUL_TOOLS.has(toolName)) return 0.7;

      // Code navigation tools (grep, read, etc.) are routine
      return 0.3;
    }

    case "action": {
      // Actions are things the agent DID (tool calls, file edits, commands).
      // Most are routine mechanical work — the code/git is the record, not memory.
      // Only elevate actions that indicate something non-obvious happened.
      const toolName = typeof metadata?.tool === "string" ? metadata.tool : "";
      const cmd = typeof metadata?.command === "string" ? metadata.command : "";

      // Navigation / listing commands are noise
      if (toolName === "exec" && NAVIGATION_COMMAND_RE.test(cmd)) return 0.2;

      // File mutations, builds, git ops, queries — routine work, git is the record
      if (toolName === "write" || toolName === "edit") return 0.3;
      if (toolName === "exec") return 0.3;

      return 0.2;
    }

    default:
      return 0.5;
  }
}

// ── Prepared statement cache ─────────────────────────────────────────────────

const INSERT_EVENT_SQL = `
  INSERT INTO events (
    timestamp, agent_id, agent_type, session_id,
    event_type, content, metadata, scope, project_id, signal_score
  ) VALUES (
    @timestamp, @agentId, @agentType, @sessionId,
    @eventType, @content, @metadata, @scope, @projectId, @signalScore
  )
`;

// ── EventRecorder class ──────────────────────────────────────────────────────

/**
 * Service class for persisting agent runtime events to the memory database.
 *
 * Instantiate once and share (or use the module-level singleton via
 * `getEventRecorder()`). All write methods silently swallow DB errors so
 * that a recording failure never crashes the agent.
 */
export class EventRecorder {
  /**
   * Record a single event. Signal score is classified automatically.
   * Errors are logged but never re-thrown.
   */
  recordEvent(params: RecordEventParams): void {
    try {
      const db = getMemoryDb();
      const stmt = db.prepare(INSERT_EVENT_SQL);

      const signalScore = classifySignalScore(params.eventType, params.metadata);
      const now = new Date().toISOString();

      stmt.run({
        timestamp: now,
        agentId: params.agentId,
        agentType: params.agentType,
        sessionId: params.sessionId ?? null,
        eventType: params.eventType,
        content: params.content,
        metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        scope: params.scope ?? "session",
        projectId: params.projectId ?? null,
        signalScore,
      });
    } catch (err) {
      log().error(`[event-recorder] Failed to record event: ${String(err)}`);
    }
  }

  /**
   * Record multiple events in a single transaction.
   * More efficient than calling recordEvent() in a loop for bulk ingestion.
   * Errors are logged but never re-thrown.
   */
  recordEvents(batch: RecordEventParams[]): void {
    if (batch.length === 0) return;
    try {
      const db = getMemoryDb();
      const stmt = db.prepare(INSERT_EVENT_SQL);
      const now = new Date().toISOString();

      const insertMany = db.transaction((events: RecordEventParams[]) => {
        for (const params of events) {
          const signalScore = classifySignalScore(params.eventType, params.metadata);
          stmt.run({
            timestamp: now,
            agentId: params.agentId,
            agentType: params.agentType,
            sessionId: params.sessionId ?? null,
            eventType: params.eventType,
            content: params.content,
            metadata: params.metadata ? JSON.stringify(params.metadata) : null,
            scope: params.scope ?? "session",
            projectId: params.projectId ?? null,
            signalScore,
          });
        }
      });

      insertMany(batch);
    } catch (err) {
      log().error(`[event-recorder] Failed to record batch of ${batch.length} events: ${String(err)}`);
    }
  }

  /**
   * Query stored events with optional filters.
   * Returns rows in descending timestamp order (newest first).
   */
  getEvents(filters: EventFilters = {}): MemoryEvent[] {
    try {
      const db = getMemoryDb();
      const conditions: string[] = [];
      const bindings: Record<string, unknown> = {};

      if (filters.agentId) {
        conditions.push("agent_id = @agentId");
        bindings.agentId = filters.agentId;
      }
      if (filters.agentType) {
        conditions.push("agent_type = @agentType");
        bindings.agentType = filters.agentType;
      }
      if (filters.sessionId) {
        conditions.push("session_id = @sessionId");
        bindings.sessionId = filters.sessionId;
      }
      if (filters.eventType) {
        conditions.push("event_type = @eventType");
        bindings.eventType = filters.eventType;
      }
      if (filters.projectId) {
        conditions.push("project_id = @projectId");
        bindings.projectId = filters.projectId;
      }
      if (filters.since) {
        conditions.push("timestamp >= @since");
        bindings.since = filters.since;
      }
      if (filters.until) {
        conditions.push("timestamp <= @until");
        bindings.until = filters.until;
      }
      if (filters.minSignalScore !== undefined) {
        conditions.push("signal_score >= @minSignalScore");
        bindings.minSignalScore = filters.minSignalScore;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = filters.limit ? `LIMIT ${filters.limit}` : "";
      const offset = filters.offset ? `OFFSET ${filters.offset}` : "";

      const sql = `SELECT * FROM events ${where} ORDER BY timestamp DESC ${limit} ${offset}`;
      return db.prepare(sql).all(bindings) as MemoryEvent[];
    } catch (err) {
      log().error(`[event-recorder] Failed to query events: ${String(err)}`);
      return [];
    }
  }

  /**
   * Return aggregate counts for stored events.
   */
  getStats(): EventStats {
    try {
      const db = getMemoryDb();

      const totalRow = db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number };
      const highSignalRow = db
        .prepare("SELECT COUNT(*) as count FROM events WHERE signal_score > 0.5")
        .get() as { count: number };
      const byTypeRows = db
        .prepare("SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type")
        .all() as Array<{ event_type: string; count: number }>;

      const byType: Record<string, number> = {};
      for (const row of byTypeRows) {
        byType[row.event_type] = row.count;
      }

      return {
        total: totalRow.count,
        byType,
        highSignal: highSignalRow.count,
      };
    } catch (err) {
      log().error(`[event-recorder] Failed to get stats: ${String(err)}`);
      return { total: 0, byType: {}, highSignal: 0 };
    }
  }
}

// ── Module-level singleton ───────────────────────────────────────────────────

let _recorder: EventRecorder | null = null;

/**
 * Return the shared EventRecorder singleton.
 * Created lazily on first access.
 */
export function getEventRecorder(): EventRecorder {
  if (!_recorder) {
    _recorder = new EventRecorder();
  }
  return _recorder;
}
