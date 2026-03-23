/**
 * Tests for src/util/queue-logger.ts
 *
 * Covers:
 * - emitQueueEvent writes to ring buffer
 * - ID truncation to 8 chars
 * - Title truncation to 60 chars
 * - Per-event-type counters increment
 * - getRecentQueueEvents returns newest-first, respects limit
 * - getEventCounters returns live totals
 * - Ring buffer never exceeds RING_BUFFER_SIZE
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  emitQueueEvent,
  getRecentQueueEvents,
  getEventCounters,
  _clearRingBuffer,
  type QueueEvent,
} from "../src/util/queue-logger.js";
import { setLogger } from "../src/util/logger.js";

// Silence log output during tests
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("queue-logger", () => {
  beforeEach(() => {
    setLogger(noopLogger as any);
    _clearRingBuffer();
  });

  it("emits an event into the ring buffer", () => {
    emitQueueEvent({ ts: "2026-01-01T00:00:00.000Z", type: "task.dispatched", taskId: "abc12345", agentType: "programmer" });
    const events = getRecentQueueEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task.dispatched");
  });

  it("truncates taskId to 8 characters", () => {
    emitQueueEvent({ ts: new Date().toISOString(), type: "task.dispatched", taskId: "1234567890abcdef" });
    const events = getRecentQueueEvents(1);
    expect(events[0].taskId).toBe("12345678");
  });

  it("truncates projectId to 8 characters", () => {
    emitQueueEvent({ ts: new Date().toISOString(), type: "task.blocked", projectId: "proj-abc-xyz-long" });
    const events = getRecentQueueEvents(1);
    expect(events[0].projectId).toBe("proj-abc");
  });

  it("truncates taskTitle longer than 60 chars and appends ellipsis", () => {
    const longTitle = "A".repeat(80);
    emitQueueEvent({ ts: new Date().toISOString(), type: "task.dispatched", taskTitle: longTitle });
    const events = getRecentQueueEvents(1);
    expect(events[0].taskTitle!.length).toBe(61); // 60 + "…"
    expect(events[0].taskTitle!.endsWith("…")).toBe(true);
  });

  it("does not truncate short IDs or titles", () => {
    emitQueueEvent({ ts: new Date().toISOString(), type: "task.completed", taskId: "short", taskTitle: "A short title" });
    const events = getRecentQueueEvents(1);
    expect(events[0].taskId).toBe("short");
    expect(events[0].taskTitle).toBe("A short title");
  });

  it("returns events newest-first", () => {
    emitQueueEvent({ ts: "2026-01-01T00:00:01.000Z", type: "task.dispatched", agentType: "programmer" });
    emitQueueEvent({ ts: "2026-01-01T00:00:02.000Z", type: "task.completed", agentType: "programmer" });
    emitQueueEvent({ ts: "2026-01-01T00:00:03.000Z", type: "agent.idle", agentType: "programmer" });
    const events = getRecentQueueEvents(10);
    expect(events[0].type).toBe("agent.idle");
    expect(events[1].type).toBe("task.completed");
    expect(events[2].type).toBe("task.dispatched");
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      emitQueueEvent({ ts: new Date().toISOString(), type: "scanner.cycle" });
    }
    expect(getRecentQueueEvents(3)).toHaveLength(3);
  });

  it("increments event counters per type", () => {
    const before = getEventCounters()["task.dispatched"] ?? 0;
    emitQueueEvent({ ts: new Date().toISOString(), type: "task.dispatched" });
    emitQueueEvent({ ts: new Date().toISOString(), type: "task.dispatched" });
    emitQueueEvent({ ts: new Date().toISOString(), type: "task.failed" });
    const counters = getEventCounters();
    expect(counters["task.dispatched"]).toBe(before + 2);
    expect(counters["task.failed"]).toBeGreaterThanOrEqual(1);
  });

  it("auto-inserts ts if missing", () => {
    const event: QueueEvent = { ts: "", type: "agent.busy", agentType: "reviewer" };
    emitQueueEvent(event);
    const events = getRecentQueueEvents(1);
    expect(events[0].ts).toBeTruthy();
    expect(events[0].ts).not.toBe("");
  });

  it("ring buffer evicts oldest events when full", () => {
    // Fill beyond the 500-item limit
    for (let i = 0; i < 510; i++) {
      emitQueueEvent({ ts: new Date().toISOString(), type: "scanner.cycle", meta: { i } });
    }
    const events = getRecentQueueEvents(0); // 0 = all
    // Should be at most 500 (RING_BUFFER_SIZE)
    expect(events.length).toBeLessThanOrEqual(500);
  });

  it("spawn.failed uses error severity path (does not throw)", () => {
    expect(() => {
      emitQueueEvent({ ts: new Date().toISOString(), type: "spawn.failed", reason: "connection refused" });
    }).not.toThrow();
  });

  it("task.blocked uses warn severity path (does not throw)", () => {
    expect(() => {
      emitQueueEvent({ ts: new Date().toISOString(), type: "task.blocked", reason: "project_locked" });
    }).not.toThrow();
  });
});
