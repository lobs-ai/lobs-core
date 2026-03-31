import { describe, expect, it } from "vitest";
import { compactMessages } from "../src/runner/context-manager.js";
import type { LLMMessage } from "../src/runner/providers.js";

describe("runner context-manager compaction", () => {
  it("adds an earlier-session summary when older messages are compacted", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Implement auth and fix the login bug." },
      { role: "assistant", content: "I found the issue in auth.ts and decided to use JWT refresh tokens." },
      { role: "user", content: "Keep going." },
      { role: "assistant", content: "Currently the middleware is fixed but still need to add tests." },
      { role: "user", content: "Recent question" },
      { role: "assistant", content: "Recent answer" },
      { role: "user", content: "Newest question" },
      { role: "assistant", content: "Newest answer" },
    ];

    const compacted = compactMessages(messages, 2);

    expect(compacted[0]).toEqual(messages[0]);
    expect(compacted[1]?.role).toBe("assistant");
    expect(compacted[1]?.content).toContain("Earlier session summary");
    expect(compacted[1]?.content).toContain("WORKING STATE:");
    expect(compacted[1]?.content).toContain("DECISIONS MADE:");
    expect(compacted[1]?.content).toContain("REMAINING WORK:");
  });

  it("preserves recent tool_result pairing while truncating large outputs", () => {
    const longOutput = "x".repeat(1200);
    const messages: LLMMessage[] = [
      { role: "user", content: "Task prompt" },
      { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: longOutput }] },
      { role: "assistant", content: "Wrapped up the file read." },
    ];

    const compacted = compactMessages(messages, 1);
    const toolResultMessage = compacted.at(-2);
    expect(toolResultMessage?.role).toBe("user");
    expect(Array.isArray(toolResultMessage?.content)).toBe(true);

    const blocks = toolResultMessage?.content as Array<{ type: string; tool_use_id?: string; content?: string }>;
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("tool-1");
    expect(blocks[0].content).toContain("[truncated]");
  });

  it("leaves very short conversations untouched", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Task prompt" },
      { role: "assistant", content: "Done." },
    ];

    expect(compactMessages(messages, 2)).toEqual(messages);
  });
});
