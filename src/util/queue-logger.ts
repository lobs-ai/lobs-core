/**
 * Structured queue event logger.
 *
 * Emits discrete events for every significant queue operation — task dispatch,
 * block, retry, complete, fail, agent state change — as structured JSON to the
 * plugin logger AND to an in-memory ring buffer so the metrics API can surface
 * a recent-events feed without hitting the DB.
 */

import { log } from "./logger.js";

// ── Event types ───────────────────────────────────────────────────────────────

export type QueueEventType =
  // Task lifecycle
  | "task.dispatched"      // scanner sent a task to a workflow
  | "task.blocked"         // scanner skipped task — project lock / capacity
  | "task.retry"           // scanner dispatched a previously-blocked task for retry
  | "task.completed"       // worker recorded success
  | "task.failed"          // worker recorded failure
  | "task.escalated"       // task escalated to higher model tier
  // Agent state
  | "agent.busy"           // agent transitioned from idle → busy
  | "agent.idle"           // agent transitioned from busy → idle
  | "agent.stale_killed"   // stale worker force-terminated
  // Scanner scan cycle
  | "scanner.cycle"        // one full scan tick summary
  // Spawn
  | "spawn.queued"         // spawn request entered the pending queue
  | "spawn.started"        // gateway spawn call succeeded
  | "spawn.failed"         // gateway spawn call failed
  | "spawn.requeued";      // spawn deferred (capacity / project lock)

export interface QueueEvent {
  ts: string;               // ISO 8601
  type: QueueEventType;
  taskId?: string;          // short-form (first 8 chars)
  taskTitle?: string;       // truncated to 60 chars
  agentType?: string;
  projectId?: string;       // short-form (first 8 chars)
  modelTier?: string;
  reason?: string;          // why a task was blocked / failed / requeued
  meta?: Record<string, unknown>; // event-specific extras
}

// ── Ring buffer ───────────────────────────────────────────────────────────────

const RING_BUFFER_SIZE = 500;
const _ring: QueueEvent[] = [];

// ── Per-event-type counters (since process start) ────────────────────────────

const _counters: Record<string, number> = {};

// ── Core emit ────────────────────────────────────────────────────────────────

/**
 * Emit one structured queue event.
 * Writes to the plugin logger and the in-memory ring buffer.
 */
export function emitQueueEvent(event: QueueEvent): void {
  // Normalise IDs to short form
  if (event.taskId && event.taskId.length > 8)     event.taskId = event.taskId.slice(0, 8);
  if (event.projectId && event.projectId.length > 8) event.projectId = event.projectId.slice(0, 8);
  if (event.taskTitle && event.taskTitle.length > 60)
    event.taskTitle = event.taskTitle.slice(0, 60) + "…";

  // Ensure timestamp
  if (!event.ts) event.ts = new Date().toISOString();

  // Increment lifetime counter for this event type
  _counters[event.type] = (_counters[event.type] ?? 0) + 1;

  // Write to ring buffer
  _ring.push(event);
  if (_ring.length > RING_BUFFER_SIZE) _ring.shift();

  // Log with appropriate severity — always prefix [QUEUE] for grep-ability
  const line = JSON.stringify(event);
  switch (event.type) {
    case "task.failed":
    case "agent.stale_killed":
    case "spawn.failed":
      log().error(`[QUEUE] ${line}`);
      break;
    case "task.blocked":
    case "spawn.requeued":
      log().warn(`[QUEUE] ${line}`);
      break;
    default:
      log().info(`[QUEUE] ${line}`);
      break;
  }
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/** Return a snapshot of recent events, newest-first. */
export function getRecentQueueEvents(limit = 100): QueueEvent[] {
  const copy = [..._ring];
  copy.reverse();
  return limit > 0 ? copy.slice(0, limit) : copy;
}

/** Return a copy of all lifetime counters. */
export function getEventCounters(): Record<string, number> {
  return { ..._counters };
}

/** Return total events emitted since process start. */
export function getTotalEventCount(): number {
  return _ring.length + Math.max(0, Object.values(_counters).reduce((a, b) => a + b, 0) - _ring.length);
}

/** Clear the ring buffer (for testing). */
export function _clearRingBuffer(): void {
  _ring.length = 0;
}
