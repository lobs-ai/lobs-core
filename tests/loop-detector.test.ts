/**
 * Tests for loop-detector.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LoopDetector } from "../src/runner/loop-detector.js";

describe("LoopDetector", () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector();
  });

  it("should not detect loop with varied calls", () => {
    for (let i = 0; i < 10; i++) {
      const result = detector.record(`tool_${i}`, { param: `value_${i}` }, `output_${i}`);
      expect(result.detected).toBe(false);
    }
  });

  it("should detect generic repeat at warning threshold (8 times)", () => {
    let result;
    for (let i = 0; i < 7; i++) {
      result = detector.record("read", { path: "/same/file" }, "content");
      expect(result.detected).toBe(false);
    }
    
    // 8th call should trigger warning
    result = detector.record("read", { path: "/same/file" }, "content");
    expect(result.detected).toBe(true);
    expect(result.type).toBe("generic-repeat");
    expect(result.severity).toBe("warning");
    expect(result.message).toContain("read");
    expect(result.message).toContain("8 times");
  });

  it("should detect generic repeat at critical threshold (15 times)", () => {
    let result;
    for (let i = 0; i < 14; i++) {
      result = detector.record("exec", { command: "ls -la" }, "files...");
    }
    
    // 15th call should trigger critical
    result = detector.record("exec", { command: "ls -la" }, "files...");
    expect(result.detected).toBe(true);
    expect(result.type).toBe("generic-repeat");
    expect(result.severity).toBe("critical");
    expect(result.message).toContain("CRITICAL");
    expect(result.message).toContain("15 times");
  });

  it("should detect poll with no progress (same output, different input)", () => {
    let result;
    const sameOutput = "Process not found";
    
    for (let i = 0; i < 7; i++) {
      result = detector.record("process", { action: "poll", sessionId: `session_${i}` }, sameOutput);
      expect(result.detected).toBe(false);
    }
    
    // 8th call with same output should trigger warning
    result = detector.record("process", { action: "poll", sessionId: "session_7" }, sameOutput);
    expect(result.detected).toBe(true);
    expect(result.type).toBe("poll-no-progress");
    expect(result.severity).toBe("warning");
    expect(result.message).toContain("No progress detected");
  });

  it("should detect ping-pong pattern (alternating A/B/A/B)", () => {
    const toolA = "read";
    const toolB = "write";
    const inputA = { path: "/file/a" };
    const inputB = { path: "/file/b" };
    
    let result;
    for (let i = 0; i < 4; i++) {
      result = detector.record(toolA, inputA, "output_a");
      if (result.detected) break;
      result = detector.record(toolB, inputB, "output_b");
      if (result.detected) break;
    }
    
    expect(result.detected).toBe(true);
    expect(result.type).toBe("ping-pong");
    expect(result.severity).toBe("warning");
    expect(result.message).toContain("Alternating");
    expect(result.message).toContain(toolA);
    expect(result.message).toContain(toolB);
  });

  it("should reset and clear history", () => {
    // Build up a loop
    for (let i = 0; i < 8; i++) {
      detector.record("exec", { command: "same" }, "output");
    }
    
    detector.reset();
    
    // Same calls again should not trigger (history cleared)
    for (let i = 0; i < 8; i++) {
      const result = detector.record("exec", { command: "same" }, "output");
      if (i < 7) {
        expect(result.detected).toBe(false);
      }
    }
  });

  it("should not trigger on mixed calls that don't form a pattern", () => {
    const calls = [
      { tool: "read", input: { path: "/a" }, output: "content_a" },
      { tool: "read", input: { path: "/a" }, output: "content_a" },
      { tool: "write", input: { path: "/b" }, output: "ok" },
      { tool: "read", input: { path: "/a" }, output: "content_a" },
      { tool: "read", input: { path: "/a" }, output: "content_a" },
      { tool: "write", input: { path: "/b" }, output: "ok" },
    ];
    
    for (const call of calls) {
      const result = detector.record(call.tool, call.input, call.output);
      expect(result.detected).toBe(false);
    }
  });

  it("should not detect with 7 repeats (under threshold)", () => {
    for (let i = 0; i < 7; i++) {
      const result = detector.record("exec", { command: "test" }, "output");
      expect(result.detected).toBe(false);
    }
  });

  it("should maintain max history of 30 calls", () => {
    // Add 50 different calls
    for (let i = 0; i < 50; i++) {
      detector.record(`tool_${i}`, { param: i }, `output_${i}`);
    }
    
    // Now add 8 repeats of a new tool
    for (let i = 0; i < 8; i++) {
      const result = detector.record("newest_tool", { data: "same" }, "same_output");
      if (i === 7) {
        // Should still detect since the last 30 calls include these 8
        expect(result.detected).toBe(true);
      }
    }
  });

  it("should not detect ping-pong with non-alternating pattern", () => {
    // A A B B pattern — not ping-pong
    const result1 = detector.record("read", { path: "/x" }, "content");
    const result2 = detector.record("read", { path: "/x" }, "content");
    const result3 = detector.record("write", { path: "/y" }, "ok");
    const result4 = detector.record("write", { path: "/y" }, "ok");
    
    expect(result1.detected).toBe(false);
    expect(result2.detected).toBe(false);
    expect(result3.detected).toBe(false);
    expect(result4.detected).toBe(false);
  });

  it("should distinguish between different inputs for same tool", () => {
    // Same tool, different inputs — should NOT trigger generic repeat
    for (let i = 0; i < 10; i++) {
      const result = detector.record("read", { path: `/file_${i}` }, `content_${i}`);
      expect(result.detected).toBe(false);
    }
  });
});
