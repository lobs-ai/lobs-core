/**
 * Tests for tool loop detection in agent-loop.ts
 */

import { describe, it, expect } from "vitest";

// We'll test the detection logic by simulating tool calls
// The actual implementation is in agent-loop.ts, but we can test the hash/detection logic

import { createHash } from "node:crypto";

interface ToolCallRecord {
  name: string;
  argsHash: string;
}

function hashToolArgs(args: Record<string, unknown>): string {
  const normalized = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function detectToolLoop(recentCalls: ToolCallRecord[]): number {
  if (recentCalls.length < 3) return 0;

  const latest = recentCalls[recentCalls.length - 1];
  let consecutiveCount = 0;

  for (let i = recentCalls.length - 1; i >= 0; i--) {
    const call = recentCalls[i];
    if (call.name === latest.name && call.argsHash === latest.argsHash) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  return consecutiveCount;
}

describe("Tool Loop Detection", () => {
  describe("hashToolArgs", () => {
    it("should produce same hash for identical args", () => {
      const args1 = { file: "test.ts", content: "hello" };
      const args2 = { file: "test.ts", content: "hello" };
      
      expect(hashToolArgs(args1)).toBe(hashToolArgs(args2));
    });

    it("should produce same hash regardless of key order", () => {
      const args1 = { file: "test.ts", content: "hello" };
      const args2 = { content: "hello", file: "test.ts" };
      
      expect(hashToolArgs(args1)).toBe(hashToolArgs(args2));
    });

    it("should produce different hash for different args", () => {
      const args1 = { file: "test.ts", content: "hello" };
      const args2 = { file: "test.ts", content: "world" };
      
      expect(hashToolArgs(args1)).not.toBe(hashToolArgs(args2));
    });
  });

  describe("detectToolLoop", () => {
    it("should return 0 when less than 3 calls", () => {
      const calls: ToolCallRecord[] = [
        { name: "read", argsHash: "abc123" },
        { name: "read", argsHash: "abc123" },
      ];

      expect(detectToolLoop(calls)).toBe(0);
    });

    it("should return 3 when same tool called 3 times consecutively", () => {
      const hash = hashToolArgs({ file: "test.ts" });
      const calls: ToolCallRecord[] = [
        { name: "read", argsHash: hash },
        { name: "read", argsHash: hash },
        { name: "read", argsHash: hash },
      ];

      expect(detectToolLoop(calls)).toBe(3);
    });

    it("should return 5 when same tool called 5 times consecutively", () => {
      const hash = hashToolArgs({ file: "test.ts" });
      const calls: ToolCallRecord[] = [
        { name: "read", argsHash: hash },
        { name: "read", argsHash: hash },
        { name: "read", argsHash: hash },
        { name: "read", argsHash: hash },
        { name: "read", argsHash: hash },
      ];

      expect(detectToolLoop(calls)).toBe(5);
    });

    it("should reset count when a different tool is called", () => {
      const hash1 = hashToolArgs({ file: "test.ts" });
      const hash2 = hashToolArgs({ command: "ls" });
      const calls: ToolCallRecord[] = [
        { name: "read", argsHash: hash1 },
        { name: "read", argsHash: hash1 },
        { name: "exec", argsHash: hash2 }, // different tool
        { name: "read", argsHash: hash1 },
        { name: "read", argsHash: hash1 },
      ];

      expect(detectToolLoop(calls)).toBe(2); // only last 2 are consecutive
    });

    it("should reset count when same tool called with different args", () => {
      const hash1 = hashToolArgs({ file: "test.ts" });
      const hash2 = hashToolArgs({ file: "other.ts" });
      const calls: ToolCallRecord[] = [
        { name: "read", argsHash: hash1 },
        { name: "read", argsHash: hash1 },
        { name: "read", argsHash: hash2 }, // same tool, different args
        { name: "read", argsHash: hash2 },
      ];

      expect(detectToolLoop(calls)).toBe(2); // only last 2 are consecutive
    });

    it("should handle complex interleaved patterns", () => {
      const hashA = hashToolArgs({ file: "a.ts" });
      const hashB = hashToolArgs({ file: "b.ts" });
      const calls: ToolCallRecord[] = [
        { name: "read", argsHash: hashA },
        { name: "read", argsHash: hashB },
        { name: "read", argsHash: hashA },
        { name: "read", argsHash: hashA },
        { name: "read", argsHash: hashA },
      ];

      expect(detectToolLoop(calls)).toBe(3); // last 3 are the same
    });
  });
});
