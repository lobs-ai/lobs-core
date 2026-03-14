/**
 * Tests for compaction.ts (services/compaction.ts)
 * Focus on non-LLM parts: calculateContextSize, pruneToolResults
 */

import { describe, it, expect } from "vitest";
import { calculateContextSize, pruneToolResults } from "../src/services/compaction.js";
import type { LLMMessage } from "../src/runner/providers.js";

describe("Compaction Service", () => {
  describe("calculateContextSize", () => {
    it("should calculate size for string content", () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "Hello world" }, // 11 chars
        { role: "assistant", content: "Hi there!" }, // 9 chars
      ];

      const size = calculateContextSize(messages);
      expect(size).toBe(20);
    });

    it("should calculate size for array content with text blocks", () => {
      const messages: LLMMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" }, // 5 chars
            { type: "text", text: "World" }, // 5 chars
          ],
        },
      ];

      const size = calculateContextSize(messages);
      expect(size).toBe(10);
    });

    it("should calculate size for tool_result blocks with string content", () => {
      const messages: LLMMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool123",
              content: "This is tool output", // 19 chars
            },
          ],
        },
      ];

      const size = calculateContextSize(messages);
      expect(size).toBe(19);
    });

    it("should calculate size for tool_result blocks with object content", () => {
      const messages: LLMMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool123",
              content: { result: "success", data: "test" },
            },
          ],
        },
      ];

      const size = calculateContextSize(messages);
      const expectedSize = JSON.stringify({ result: "success", data: "test" }).length;
      expect(size).toBe(expectedSize);
    });

    it("should handle mixed content types", () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "String message" }, // 14 chars
        {
          role: "assistant",
          content: [
            { type: "text", text: "Array text" }, // 10 chars
            { type: "tool_use", name: "read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "Result" }, // 6 chars
          ],
        },
      ];

      const size = calculateContextSize(messages);
      // 14 + 10 + JSON.stringify(tool_use) + 6
      expect(size).toBeGreaterThan(30);
    });

    it("should return 0 for empty messages array", () => {
      const size = calculateContextSize([]);
      expect(size).toBe(0);
    });

    it("should handle messages with empty content", () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "" },
        { role: "assistant", content: [] },
      ];

      const size = calculateContextSize(messages);
      expect(size).toBe(0);
    });
  });

  describe("pruneToolResults", () => {
    it("should keep recent assistant turns intact", () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "Old message with lots of content that should be truncated because it's really long and goes on and on".repeat(10) },
        { role: "assistant", content: "Old reply" },
        { role: "user", content: "Recent short message" },
        { role: "assistant", content: "Recent reply" },
      ];

      const pruned = pruneToolResults(messages, 1, 300);

      // Last assistant turn + surrounding messages should be kept intact
      expect(pruned[pruned.length - 1].content).toBe("Recent reply");
      expect(pruned[pruned.length - 2].content).toBe("Recent short message");
    });

    it("should truncate old large tool outputs", () => {
      const longOutput = "x".repeat(2000);
      const messages: LLMMessage[] = [
        { role: "user", content: longOutput }, // Old, should be truncated
        { role: "assistant", content: "Middle" },
        { role: "user", content: "New message" },
        { role: "assistant", content: "Recent reply" },
      ];

      const pruned = pruneToolResults(messages, 1, 300);

      // First message should be truncated
      expect(pruned[0].content).toContain("[Earlier output truncated");
      expect((pruned[0].content as string).length).toBeLessThan(longOutput.length);
      
      // Recent messages should be intact
      expect(pruned[2].content).toBe("New message");
    });

    it("should handle array content tool_result blocks", () => {
      const longResult = "y".repeat(2000);
      const messages: LLMMessage[] = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "old", content: longResult },
          ],
        },
        { role: "assistant", content: "Middle" },
        { role: "user", content: "New" },
        { role: "assistant", content: "Recent" },
      ];

      const pruned = pruneToolResults(messages, 1, 300);

      // Old tool result should be truncated
      const oldContent = pruned[0].content as Array<{ type: string; content: string }>;
      expect(oldContent[0].content).toContain("[Truncated]");
      expect(oldContent[0].content.length).toBeLessThan(longResult.length);
    });

    it("should preserve short old messages", () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "Short" }, // Should NOT be truncated
        { role: "assistant", content: "Also short" },
        { role: "user", content: "Recent" },
        { role: "assistant", content: "Latest" },
      ];

      const pruned = pruneToolResults(messages, 1, 300);

      // All messages should be intact (all under threshold)
      expect(pruned[0].content).toBe("Short");
      expect(pruned[1].content).toBe("Also short");
    });

    it("should not truncate assistant messages", () => {
      const longAssistantMsg = "assistant output ".repeat(200);
      const messages: LLMMessage[] = [
        { role: "user", content: "User" },
        { role: "assistant", content: longAssistantMsg },
        { role: "user", content: "Recent" },
        { role: "assistant", content: "Latest" },
      ];

      const pruned = pruneToolResults(messages, 1, 300);

      // Assistant messages should never be truncated
      expect(pruned[1].content).toBe(longAssistantMsg);
    });

    it("should return empty array for empty input", () => {
      const pruned = pruneToolResults([], 8, 300);
      expect(pruned).toEqual([]);
    });

    it("should handle keepRecentTurns parameter", () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "x".repeat(2000) },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "y".repeat(2000) },
        { role: "assistant", content: "Reply 2" },
        { role: "user", content: "z".repeat(2000) },
        { role: "assistant", content: "Reply 3" },
      ];

      // Keep last 2 assistant turns intact
      const pruned = pruneToolResults(messages, 2, 300);

      // Last 2 assistant turns and their surrounding messages should be intact
      expect((pruned[4].content as string).length).toBe(2000); // Recent, kept full
      expect((pruned[2].content as string).length).toBe(2000); // Recent, kept full
      expect((pruned[0].content as string).length).toBeLessThan(2000); // Old, truncated
    });

    it("should handle maxOldToolOutputChars parameter", () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "x".repeat(2000) },
        { role: "assistant", content: "Reply" },
        { role: "user", content: "Recent" },
        { role: "assistant", content: "Latest" },
      ];

      const pruned = pruneToolResults(messages, 1, 100);

      // Should truncate to ~100 chars (maxOldToolOutputChars)
      expect((pruned[0].content as string).length).toBeLessThan(200);
      expect(pruned[0].content).toContain("[Earlier output truncated");
    });

    it("should handle messages with multiple tool_result blocks", () => {
      const messages: LLMMessage[] = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "x".repeat(2000) },
            { type: "tool_result", tool_use_id: "t2", content: "y".repeat(2000) },
            { type: "text", text: "Some text" },
          ],
        },
        { role: "assistant", content: "Reply" },
        { role: "user", content: "Recent" },
        { role: "assistant", content: "Latest" },
      ];

      const pruned = pruneToolResults(messages, 1, 300);

      const oldContent = pruned[0].content as Array<{ type: string; content?: string; text?: string }>;
      
      // Both tool results should be truncated
      expect(oldContent[0].content).toContain("[Truncated]");
      expect(oldContent[1].content).toContain("[Truncated]");
      
      // Text block should be unchanged
      expect(oldContent[2].text).toBe("Some text");
    });

    it("should not modify messages when all are within recent threshold", () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "User 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "User 2" },
        { role: "assistant", content: "Reply 2" },
      ];

      const pruned = pruneToolResults(messages, 10, 300);

      // All should be intact (within keepRecentTurns)
      expect(pruned).toEqual(messages);
    });
  });
});
