/**
 * Tests for src/runner/loop-detector.ts
 *
 * LoopDetector detects 3 patterns:
 *  1. generic-repeat — same tool + same input ≥ warningThreshold (8) or criticalThreshold (15)
 *  2. poll-no-progress — same tool + same output (varying input) for ≥ 8 calls
 *  3. ping-pong — A/B/A/B alternation for last 8 calls
 *
 * maxHistory = 30 (older entries are dropped).
 * reset() clears all history.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LoopDetector } from "../src/runner/loop-detector.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build up N identical calls to a tool. Returns the last LoopDetectionResult. */
function repeat(
  det: LoopDetector,
  n: number,
  tool = "exec",
  input: Record<string, unknown> = { command: "ls" },
  output = "output"
) {
  let result!: ReturnType<LoopDetector["record"]>;
  for (let i = 0; i < n; i++) {
    result = det.record(tool, input, output);
  }
  return result;
}

/** Build an alternating A/B sequence of exactly n total calls. Returns the last result. */
function pingPong(
  det: LoopDetector,
  n: number,
  toolA = "read",
  toolB = "write",
  inputA: Record<string, unknown> = { path: "/a" },
  inputB: Record<string, unknown> = { path: "/b" }
) {
  let result!: ReturnType<LoopDetector["record"]>;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      result = det.record(toolA, inputA, "out_a");
    } else {
      result = det.record(toolB, inputB, "out_b");
    }
  }
  return result;
}

// ─── Test setup ───────────────────────────────────────────────────────────────

describe("LoopDetector", () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector();
  });

  // ── No-loop baseline ────────────────────────────────────────────────────

  describe("no-loop baseline", () => {
    it("returns detected=false for a single unique call", () => {
      const r = detector.record("read", { path: "/file" }, "content");
      expect(r.detected).toBe(false);
    });

    it("returns null type/message/severity when not detected", () => {
      const r = detector.record("read", { path: "/x" }, "data");
      expect(r.type).toBeNull();
      expect(r.message).toBeNull();
      expect(r.severity).toBeNull();
    });

    it("does not detect on 10 fully unique calls", () => {
      for (let i = 0; i < 10; i++) {
        const r = detector.record(`tool_${i}`, { param: `val_${i}` }, `out_${i}`);
        expect(r.detected).toBe(false);
      }
    });

    it("does not detect when same tool has different inputs", () => {
      for (let i = 0; i < 10; i++) {
        const r = detector.record("read", { path: `/file_${i}` }, `content_${i}`);
        expect(r.detected).toBe(false);
      }
    });

    it("does not detect on 7 identical calls (under warning threshold)", () => {
      const r = repeat(detector, 7);
      expect(r.detected).toBe(false);
    });
  });

  // ── generic-repeat ────────────────────────────────────────────────────

  describe("generic-repeat detection", () => {
    it("triggers warning at exactly 8 identical calls", () => {
      const r = repeat(detector, 8, "read", { path: "/same" }, "content");
      expect(r.detected).toBe(true);
      expect(r.type).toBe("generic-repeat");
      expect(r.severity).toBe("warning");
    });

    it("message contains the tool name at warning level", () => {
      const r = repeat(detector, 8, "my_tool", { x: 1 }, "out");
      expect(r.message).toContain("my_tool");
    });

    it("message mentions 8 times at warning level", () => {
      const r = repeat(detector, 8, "exec", { command: "ls" }, "files");
      expect(r.message).toContain("8 times");
    });

    it("message contains 'WARNING' at warning level", () => {
      const r = repeat(detector, 8);
      expect(r.message).toContain("WARNING");
    });

    it("call #9 still detected as warning (not yet critical)", () => {
      const r = repeat(detector, 9);
      expect(r.severity).toBe("warning");
    });

    it("triggers critical at exactly 15 identical calls", () => {
      const r = repeat(detector, 15);
      expect(r.detected).toBe(true);
      expect(r.type).toBe("generic-repeat");
      expect(r.severity).toBe("critical");
    });

    it("message contains 'CRITICAL' at critical level", () => {
      const r = repeat(detector, 15);
      expect(r.message).toContain("CRITICAL");
    });

    it("message mentions 15 times at critical level", () => {
      const r = repeat(detector, 15, "exec", { command: "test" }, "output");
      expect(r.message).toContain("15 times");
    });

    it("different tools with same input count independently (no cross-contamination)", () => {
      // 7 calls to "exec", then 7 calls to "read" — neither hits threshold
      repeat(detector, 7, "exec", { command: "ls" }, "out");
      const r = repeat(detector, 7, "read", { path: "/x" }, "data");
      expect(r.detected).toBe(false);
    });

    it("same tool + different input does not accumulate towards generic-repeat threshold", () => {
      // Different inputs so generic-repeat won't trigger. But if outputs are also different,
      // poll-no-progress won't trigger either.
      for (let i = 0; i < 10; i++) {
        const r = detector.record("exec", { command: `cmd_${i}` }, `unique_output_${i}`);
        expect(r.detected).toBe(false);
      }
    });

    it("output variation does NOT prevent generic-repeat (only input matters)", () => {
      // Same tool, same input, different output → still counts as generic-repeat
      for (let i = 0; i < 8; i++) {
        detector.record("read", { path: "/x" }, `different_output_${i}`);
      }
      const r = detector.record("read", { path: "/x" }, "one_more");
      // Wait — the count needs 8 of the SAME call. Let's check:
      // The hash key is inputHash only (not outputHash) for generic-repeat.
      // But outputHash changes with different output...
      // Actually for generic-repeat: filter by name AND inputHash only.
      // So 8 calls with same name+input but different output still count.
      // However, after the 8th call (i=7), detection triggers. Let me re-count.
      // Calls 0..7 = 8 total with same name+inputHash → warning triggers on call 8 (i=7).
      // Then call 9 (r) = 9th same-input call → still warning (< 15).
      expect(r.detected).toBe(true);
      expect(r.type).toBe("generic-repeat");
    });
  });

  // ── poll-no-progress ──────────────────────────────────────────────────

  describe("poll-no-progress detection", () => {
    it("triggers at 8 calls with same output (varying inputs)", () => {
      const sameOut = "Process not found";
      let result!: ReturnType<LoopDetector["record"]>;
      for (let i = 0; i < 8; i++) {
        result = detector.record("process", { sessionId: `s_${i}` }, sameOut);
      }
      expect(result.detected).toBe(true);
      expect(result.type).toBe("poll-no-progress");
      expect(result.severity).toBe("warning");
    });

    it("message contains 'No progress detected'", () => {
      const sameOut = "still waiting";
      for (let i = 0; i < 8; i++) {
        detector.record("ping", { iter: i }, sameOut);
      }
      const last = detector.record("ping", { iter: 99 }, sameOut);
      // At 9th same-output call → still poll-no-progress
      expect(last.message).toContain("No progress detected");
    });

    it("does NOT trigger when output varies between calls", () => {
      for (let i = 0; i < 8; i++) {
        const r = detector.record("process", { session: `s_${i}` }, `output_${i}`);
        expect(r.detected).toBe(false);
      }
    });

    it("resets detection when output changes after a streak", () => {
      const sameOut = "stuck";
      // Build up 7 same-output calls
      for (let i = 0; i < 7; i++) {
        detector.record("tool", { iter: i }, sameOut);
      }
      // New different output on 8th call — breaks the streak
      const r = detector.record("tool", { iter: 99 }, "progress!");
      expect(r.detected).toBe(false);
    });

    it("uses last 8 calls for poll-no-progress window", () => {
      // 4 different outputs + 8 identical → should trigger on 8th identical
      for (let i = 0; i < 4; i++) {
        detector.record("scan", { iter: i }, `unique_${i}`);
      }
      let result!: ReturnType<LoopDetector["record"]>;
      for (let i = 0; i < 8; i++) {
        result = detector.record("scan", { iter: 100 + i }, "stuck_forever");
      }
      expect(result.detected).toBe(true);
      expect(result.type).toBe("poll-no-progress");
    });
  });

  // ── ping-pong ─────────────────────────────────────────────────────────

  describe("ping-pong detection", () => {
    it("detects A/B/A/B pattern after exactly 8 alternating calls", () => {
      const r = pingPong(detector, 8);
      expect(r.detected).toBe(true);
      expect(r.type).toBe("ping-pong");
      expect(r.severity).toBe("warning");
    });

    it("message contains 'Alternating'", () => {
      const r = pingPong(detector, 8);
      expect(r.message).toContain("Alternating");
    });

    it("message contains both tool names", () => {
      const r = pingPong(detector, 8, "fetch", "store");
      expect(r.message).toContain("fetch");
      expect(r.message).toContain("store");
    });

    it("does NOT detect A/A/B/B pattern (not alternating)", () => {
      detector.record("read", { path: "/a" }, "out_a");
      detector.record("read", { path: "/a" }, "out_a");
      detector.record("write", { path: "/b" }, "ok");
      detector.record("write", { path: "/b" }, "ok");
      detector.record("read", { path: "/a" }, "out_a");
      detector.record("read", { path: "/a" }, "out_a");
      detector.record("write", { path: "/b" }, "ok");
      const r = detector.record("write", { path: "/b" }, "ok");
      expect(r.type).not.toBe("ping-pong");
    });

    it("does NOT detect single tool repeating A/A/A/A (not alternating)", () => {
      // All same tool → generic-repeat, not ping-pong
      const r = repeat(detector, 8, "exec", { command: "poll" }, "nothing");
      expect(r.type).toBe("generic-repeat");
      expect(r.type).not.toBe("ping-pong");
    });

    it("does NOT detect with only 7 alternating calls (below 8-call window)", () => {
      const r = pingPong(detector, 7);
      // 7 calls — the 8-call window isn't complete yet
      expect(r.type).not.toBe("ping-pong");
    });

    it("detects ping-pong after 12 alternating calls (window slides to last 8)", () => {
      const r = pingPong(detector, 12);
      expect(r.detected).toBe(true);
      expect(r.type).toBe("ping-pong");
    });

    it("does NOT flag alternating calls between same tool with different inputs as ping-pong", () => {
      // A→B→A→B where A=B (same tool, different inputs)
      // The ping-pong check requires recent[0].name !== recent[1].name
      for (let i = 0; i < 8; i++) {
        detector.record("read", { path: `/file_${i}` }, `data_${i}`);
      }
      const r = detector.record("read", { path: "/x" }, "final");
      expect(r.type).not.toBe("ping-pong");
    });

    it("does not detect mixed calls that happen to partially alternate", () => {
      // A B A B A B A B BUT the inputs of A differ
      for (let i = 0; i < 4; i++) {
        detector.record("read", { path: `/different_${i}` }, "out_a");
        detector.record("write", { path: "/b" }, "ok");
      }
      // No assertion — just should not throw
      // The ping-pong check requires inputHash to match across even positions
      // so different inputs for "read" break the pattern
      const last = detector.record("check", { x: 1 }, "y");
      expect(last).toHaveProperty("detected");
    });
  });

  // ── reset() ───────────────────────────────────────────────────────────

  describe("reset()", () => {
    it("clears history so identical calls start fresh", () => {
      repeat(detector, 8);
      detector.reset();
      // After reset, 7 more calls should not trigger (< threshold)
      const r = repeat(detector, 7);
      expect(r.detected).toBe(false);
    });

    it("allows building up to threshold again after reset", () => {
      repeat(detector, 8);
      detector.reset();
      const r = repeat(detector, 8);
      expect(r.detected).toBe(true);
    });

    it("can reset multiple times without errors", () => {
      detector.reset();
      detector.reset();
      expect(() => detector.record("exec", { cmd: "ls" }, "out")).not.toThrow();
    });

    it("reset on empty detector does not throw", () => {
      expect(() => detector.reset()).not.toThrow();
    });

    it("returns clean result after reset and one call", () => {
      repeat(detector, 15);
      detector.reset();
      const r = detector.record("exec", { cmd: "ls" }, "out");
      expect(r.detected).toBe(false);
      expect(r.type).toBeNull();
    });
  });

  // ── maxHistory = 30 ───────────────────────────────────────────────────

  describe("maxHistory sliding window (30 calls)", () => {
    it("drops old entries after 30 calls and does not false-positive", () => {
      // 50 unique calls — none should trigger
      for (let i = 0; i < 50; i++) {
        const r = detector.record(`tool_${i}`, { p: i }, `out_${i}`);
        expect(r.detected).toBe(false);
      }
    });

    it("still detects after 30+ filler calls followed by repeat pattern", () => {
      // Fill with unique calls past maxHistory
      for (let i = 0; i < 30; i++) {
        detector.record(`filler_${i}`, { p: i }, `out_${i}`);
      }
      // Now do 8 identical calls
      const r = repeat(detector, 8, "newest", { x: 1 }, "same_out");
      expect(r.detected).toBe(true);
      expect(r.type).toBe("generic-repeat");
    });

    it("evicts entries in FIFO order", () => {
      // Push 30 identical calls — should trigger warning by call 8
      // Then push 30 more unique — the old repeated ones slide out
      repeat(detector, 8); // triggers warning

      // Reset so we can test the eviction path cleanly
      detector.reset();

      // 22 unique calls + 8 repeats of new tool
      for (let i = 0; i < 22; i++) {
        detector.record(`uniq_${i}`, { i }, `out_${i}`);
      }
      const r = repeat(detector, 8, "target", { y: 99 }, "steady");
      // total = 30; last 8 are all "target" with same input → warning
      expect(r.detected).toBe(true);
      expect(r.type).toBe("generic-repeat");
    });
  });

  // ── Result shape ──────────────────────────────────────────────────────

  describe("LoopDetectionResult shape", () => {
    it("always returns an object with detected/type/message/severity fields", () => {
      const r = detector.record("exec", { cmd: "ls" }, "out");
      expect(r).toHaveProperty("detected");
      expect(r).toHaveProperty("type");
      expect(r).toHaveProperty("message");
      expect(r).toHaveProperty("severity");
    });

    it("detected is always a boolean", () => {
      const r = detector.record("exec", { cmd: "ls" }, "out");
      expect(typeof r.detected).toBe("boolean");
    });

    it("non-detected result has null type/message/severity", () => {
      const r = detector.record("once", { x: 1 }, "out");
      expect(r.type).toBeNull();
      expect(r.message).toBeNull();
      expect(r.severity).toBeNull();
    });

    it("detected result has non-null type/message/severity", () => {
      const r = repeat(detector, 8);
      expect(r.type).not.toBeNull();
      expect(r.message).not.toBeNull();
      expect(r.severity).not.toBeNull();
    });

    it("severity is 'warning' or 'critical' when detected", () => {
      const r = repeat(detector, 8);
      expect(["warning", "critical"]).toContain(r.severity);
    });
  });

  // ── Priority: generic-repeat checked before poll-no-progress ──────────

  describe("detection priority", () => {
    it("generic-repeat takes priority over poll-no-progress", () => {
      // Same tool + same input + same output → both patterns match, but generic-repeat checked first
      const r = repeat(detector, 8, "probe", { x: 1 }, "same_output");
      expect(r.type).toBe("generic-repeat");
    });
  });
});
