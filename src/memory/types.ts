/**
 * TypeScript types for the memory database schema.
 *
 * These mirror the SQLite tables in memory.db. They are plain interfaces —
 * no ORM dependency so they can be used anywhere without pulling in drizzle.
 */

// ── Table row types ──────────────────────────────────────────────────────────

export interface MemoryEvent {
  id: number;
  timestamp: string;
  agent_id: string;
  agent_type: string;
  session_id: string | null;
  event_type: "observation" | "action" | "decision" | "error" | "user_input" | "tool_result";
  content: string;
  metadata: string | null; // JSON string
  scope: "system" | "agent" | "session";
  project_id: string | null;
  signal_score: number;
  created_at: string;
}

export interface Memory {
  id: number;
  memory_type: string;
  title: string | null;
  content: string;
  confidence: number;
  scope: string;
  agent_type: string | null;
  project_id: string | null;
  source_authority: number;
  status: "active" | "superseded" | "expired" | "stale" | "archived" | "contested";
  superseded_by: number | null;
  derived_at: string;
  last_validated: string | null;
  expires_at: string | null;
  last_accessed: string | null;
  access_count: number;
  reflection_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryEmbedding {
  memory_id: number;
  embedding: Buffer; // BLOB
}

export interface Evidence {
  id: number;
  memory_id: number;
  event_id: number;
  relationship: string;
  strength: number;
  created_at: string;
}

export interface Conflict {
  id: number;
  memory_a: number;
  memory_b: number;
  description: string;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface ReflectionRun {
  id: string;
  trigger: string;
  started_at: string;
  completed_at: string | null;
  clusters_processed: number;
  memories_created: number;
  memories_reinforced: number;
  conflicts_detected: number;
  tokens_used: number;
  tier: string;
  status: "running" | "completed" | "failed";
}

export interface RetrievalLog {
  id: number;
  memory_id: number;
  query: string;
  agent_id: string | null;
  score: number | null;
  timestamp: string;
}

// ── Service input types ──────────────────────────────────────────────────────

/** Parameters for recording a single event. */
export interface RecordEventParams {
  agentId: string;
  agentType: string;
  sessionId?: string;
  eventType: "observation" | "action" | "decision" | "error" | "user_input" | "tool_result";
  content: string;
  metadata?: Record<string, unknown>;
  scope?: "system" | "agent" | "session";
  projectId?: string;
}

/** Filters for querying stored events. */
export interface EventFilters {
  agentId?: string;
  agentType?: string;
  sessionId?: string;
  eventType?: MemoryEvent["event_type"];
  projectId?: string;
  /** ISO timestamp lower bound (inclusive) */
  since?: string;
  /** ISO timestamp upper bound (inclusive) */
  until?: string;
  /** Minimum signal score */
  minSignalScore?: number;
  limit?: number;
  offset?: number;
}

/** Summary counts returned by getStats(). */
export interface EventStats {
  total: number;
  byType: Record<string, number>;
  highSignal: number; // signal_score > 0.5
}
