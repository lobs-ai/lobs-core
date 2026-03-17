/**
 * task-dedup — 24-hour task deduplication utility.
 *
 * Before inserting a new task, callers should check for an existing task with
 * the same title AND agent AND model_tier that was created within the last 24 hours
 * AND is in an open (non-terminal) status.
 *
 * Criteria (ALL must match):
 *   - title  : exact string match (case-sensitive, trimmed by caller)
 *   - agent  : same agent type  (null treated as wildcard — matches any)
 *   - tier   : same model_tier  (null treated as wildcard — matches any)
 *   - status : one of DEDUP_STATUSES (not terminal)
 *   - created_at ≥ now − 24 h
 *
 * Returns the first matching task row or undefined.
 */

import { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { and, eq, gte, inArray, or, isNull } from "drizzle-orm";

/** Statuses that represent "open" / not yet resolved work. */
export const DEDUP_STATUSES = ["active", "proposed", "queued", "waiting_on", "in_progress", "blocked"] as const;

export interface DedupMatch {
  id: string;
  title: string;
  agent: string | null;
  modelTier: string | null;
  status: string;
  createdAt: string;
}

export interface DedupOptions {
  title: string;
  /** Agent type (e.g. "programmer"). Pass undefined/null to match any agent. */
  agent?: string | null;
  /** Model tier (e.g. "standard"). Pass undefined/null to match any tier. */
  modelTier?: string | null;
  /** Look-back window in hours (default: 24). */
  windowHours?: number;
}

/**
 * Check whether a duplicate task exists in the queue.
 *
 * @returns The matching task if a duplicate is found, otherwise `undefined`.
 */
export function findDuplicateTask(opts: DedupOptions): DedupMatch | undefined {
  const { title, agent, modelTier, windowHours = 24 } = opts;
  const db = getDb();

  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  // Build conditions
  const conditions = [
    eq(tasks.title, title),
    inArray(tasks.status, [...DEDUP_STATUSES]),
    gte(tasks.createdAt, since),
  ];

  // Agent match: if caller supplied an agent, require same agent OR null in DB.
  // If caller supplied no agent, skip the agent filter (matches any).
  if (agent) {
    conditions.push(
      or(eq(tasks.agent, agent), isNull(tasks.agent)) as ReturnType<typeof eq>
    );
  }

  // Model tier match: same logic — if caller specified a tier, require same tier OR null in DB.
  if (modelTier) {
    conditions.push(
      or(eq(tasks.modelTier, modelTier), isNull(tasks.modelTier)) as ReturnType<typeof eq>
    );
  }

  const row = db
    .select({
      id: tasks.id,
      title: tasks.title,
      agent: tasks.agent,
      modelTier: tasks.modelTier,
      status: tasks.status,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(and(...conditions))
    .limit(1)
    .get();

  return row as DedupMatch | undefined;
}
