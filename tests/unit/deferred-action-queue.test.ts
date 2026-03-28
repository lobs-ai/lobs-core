import { describe, it, expect } from "vitest";
import {
  DeferredActionQueue,
  isDuplicateAction,
  type DeferredAction,
} from "../../src/services/voice/deferred-action-queue.js";

describe("DeferredActionQueue", () => {
  function makeAction(overrides: Partial<DeferredAction> = {}): DeferredAction {
    return {
      description: "Refactor the auth module to use JWT tokens",
      actionType: "implement",
      priority: "medium",
      assignee: "lobs",
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it("starts empty", () => {
    const queue = new DeferredActionQueue();
    expect(queue.length).toBe(0);
    expect(queue.isEmpty).toBe(true);
    expect(queue.getMeetingId()).toBeNull();
  });

  it("can add and drain actions", () => {
    const queue = new DeferredActionQueue();
    const action1 = makeAction({ description: "Fix the login bug" });
    const action2 = makeAction({ description: "Write tests for voice module" });

    queue.add(action1);
    queue.add(action2);

    expect(queue.length).toBe(2);
    expect(queue.isEmpty).toBe(false);

    const drained = queue.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0].description).toBe("Fix the login bug");
    expect(drained[1].description).toBe("Write tests for voice module");

    // Queue should be empty after drain
    expect(queue.length).toBe(0);
    expect(queue.isEmpty).toBe(true);
  });

  it("peek returns items without removing them", () => {
    const queue = new DeferredActionQueue();
    queue.add(makeAction());

    const peeked = queue.peek();
    expect(peeked).toHaveLength(1);
    expect(queue.length).toBe(1); // Still there
  });

  it("drain returns empty array when queue is empty", () => {
    const queue = new DeferredActionQueue();
    const drained = queue.drain();
    expect(drained).toEqual([]);
  });

  it("tracks meeting ID", () => {
    const queue = new DeferredActionQueue();
    queue.setMeetingId("meeting-123");
    expect(queue.getMeetingId()).toBe("meeting-123");
  });

  it("drain can be called multiple times safely", () => {
    const queue = new DeferredActionQueue();
    queue.add(makeAction());

    const first = queue.drain();
    expect(first).toHaveLength(1);

    const second = queue.drain();
    expect(second).toHaveLength(0);
  });
});

describe("isDuplicateAction", () => {
  it("detects identical descriptions as duplicates", () => {
    const a = "Fix the drag-to-reorder bug in assessments";
    const b = "Fix the drag-to-reorder bug in assessments";
    expect(isDuplicateAction(a, b)).toBe(true);
  });

  it("detects similar descriptions as duplicates", () => {
    const a = "Fix the drag-to-reorder bug in assessments page";
    const b = "Fix drag to reorder bug in the assessments";
    expect(isDuplicateAction(a, b)).toBe(true);
  });

  it("does not flag different descriptions as duplicates", () => {
    const a = "Fix the drag-to-reorder bug in assessments";
    const b = "Implement voice transcription pipeline for meetings";
    expect(isDuplicateAction(a, b)).toBe(false);
  });

  it("handles empty strings gracefully", () => {
    expect(isDuplicateAction("", "something")).toBe(false);
    expect(isDuplicateAction("something", "")).toBe(false);
    expect(isDuplicateAction("", "")).toBe(false);
  });

  it("respects custom threshold", () => {
    const a = "Refactor auth module to use JWT";
    const b = "Refactor the authentication module with JWT tokens";
    // These share some words but not all
    expect(isDuplicateAction(a, b, 0.3)).toBe(true);
    expect(isDuplicateAction(a, b, 0.9)).toBe(false);
  });

  it("is case-insensitive", () => {
    const a = "Fix the LOGIN bug";
    const b = "fix the login bug";
    expect(isDuplicateAction(a, b)).toBe(true);
  });

  it("ignores punctuation", () => {
    const a = "Fix the login bug!";
    const b = "Fix the login bug";
    expect(isDuplicateAction(a, b)).toBe(true);
  });
});
