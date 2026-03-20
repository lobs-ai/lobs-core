/**
 * Tests for src/services/chat-summarizer.ts
 *
 * Strategy:
 *   - Stub fetch at module level (before imports) so callLocalModel is intercepted
 *   - Test all DB interaction logic (threshold checks, session writes, message reads)
 *   - Test error paths (session not found, LM Studio errors, bad titles)
 *   - Test generateChatTitle skip logic (already titled, <2 messages)
 *   - Test maybeSummarizeChat threshold and update logic
 *   - Test forceSummarize label reset and restoration
 *   - Test onAssistantMessage fires-and-forgets (no throw)
 *
 * NOTE: vi.stubGlobal must happen BEFORE the service import for the fetch mock
 * to be in place when callLocalModel executes (fetch is resolved at call time,
 * but vitest doesn't hoist stubGlobal, so we stub at module level first).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Stub fetch BEFORE any service imports ────────────────────────────────────
// This must come before the chat-summarizer import so the global is patched.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Now import the rest ───────────────────────────────────────────────────────

import { getDb, getRawDb } from "../src/db/connection.js";
import {
  generateChatTitle,
  maybeSummarizeChat,
  forceSummarize,
  onAssistantMessage,
} from "../src/services/chat-summarizer.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeLlmResponse(content: string) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  });
}

function makeLlmError(status = 500, body = "Server error") {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

function clearDb() {
  const raw = getRawDb();
  raw.exec("DELETE FROM chat_messages; DELETE FROM chat_sessions;");
}

function seedSession(opts: {
  sessionKey: string;
  label?: string;
  summary?: string | null;
  messageCountAtSummary?: number;
}) {
  const raw = getRawDb();
  const now = new Date().toISOString();
  raw.prepare(`
    INSERT INTO chat_sessions (id, session_key, label, summary, message_count_at_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    opts.sessionKey,
    opts.label ?? "New Chat",
    opts.summary ?? null,
    opts.messageCountAtSummary ?? 0,
    now,
  );
}

function seedMessages(
  sessionKey: string,
  msgs: Array<{ role: string; content: string }>,
) {
  const raw = getRawDb();
  const base = Date.now();
  for (let i = 0; i < msgs.length; i++) {
    const ts = new Date(base + i * 1000).toISOString();
    raw.prepare(`
      INSERT INTO chat_messages (id, session_key, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), sessionKey, msgs[i].role, msgs[i].content, ts);
  }
}

// Reset between tests
beforeEach(() => {
  mockFetch.mockReset();
  clearDb();
});

afterEach(() => {
  // keep stubGlobal — don't unstub, only reset mock state
});

// ── generateChatTitle ────────────────────────────────────────────────────────

describe("generateChatTitle", () => {
  it("returns null when session doesn't exist", async () => {
    const title = await generateChatTitle("no-such-session");
    expect(title).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips title generation when session has a custom (non-default) title", async () => {
    seedSession({ sessionKey: "s1", label: "My Custom Title" });
    seedMessages("s1", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);

    const title = await generateChatTitle("s1");
    // Custom title → returned as-is, no LLM call
    expect(title).toBe("My Custom Title");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("generates title for 'Chat N' default titles", async () => {
    seedSession({ sessionKey: "s2", label: "Chat 42" });
    seedMessages("s2", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Greeting Exchange"));

    const title = await generateChatTitle("s2");
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(title).toBe("Greeting Exchange");
  });

  it("generates title for 'New Chat' default title", async () => {
    seedSession({ sessionKey: "s3", label: "New Chat" });
    seedMessages("s3", [
      { role: "user", content: "Deploy help" },
      { role: "assistant", content: "Sure!" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Deploy Assistance"));

    const title = await generateChatTitle("s3");
    expect(title).toBe("Deploy Assistance");
  });

  it("returns null when no messages exist", async () => {
    seedSession({ sessionKey: "s4" });
    // No messages seeded — empty conversation

    const title = await generateChatTitle("s4");
    expect(title).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("filters out tool-call messages when building the prompt", async () => {
    seedSession({ sessionKey: "s5" });
    seedMessages("s5", [
      { role: "tool", content: "search result" },
      { role: "user", content: "Fix my code" },
      { role: "assistant", content: "Sure, here's the fix..." },
      { role: "tool", content: "another tool call" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Code Fix Session"));

    await generateChatTitle("s5");
    expect(mockFetch).toHaveBeenCalledOnce();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // The assembled user/assistant messages should not contain tool content
    const msgStr = JSON.stringify(body.messages);
    expect(msgStr).toContain("Fix my code");
    expect(msgStr).not.toContain("search result");
    expect(msgStr).not.toContain("another tool call");
  });

  it("saves title to DB on success", async () => {
    seedSession({ sessionKey: "s6" });
    seedMessages("s6", [
      { role: "user", content: "How do I deploy to Kubernetes?" },
      { role: "assistant", content: "Here's how you deploy to K8s..." },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Kubernetes Deployment Guide"));

    const title = await generateChatTitle("s6");
    expect(title).toBe("Kubernetes Deployment Guide");

    const raw = getRawDb();
    const row = raw.prepare("SELECT label FROM chat_sessions WHERE session_key = ?").get("s6") as any;
    expect(row?.label).toBe("Kubernetes Deployment Guide");
  });

  it("strips surrounding quotes from model output", async () => {
    seedSession({ sessionKey: "s7" });
    seedMessages("s7", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "World" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse('"Hello World Chat"'));

    const title = await generateChatTitle("s7");
    expect(title).toBe("Hello World Chat");
  });

  it("strips trailing punctuation from model output", async () => {
    seedSession({ sessionKey: "s8" });
    seedMessages("s8", [
      { role: "user", content: "What is REST?" },
      { role: "assistant", content: "REST is..." },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("REST API Basics."));

    const title = await generateChatTitle("s8");
    // Trailing punctuation should be stripped
    expect(title).not.toMatch(/[.!?]$/);
    expect(title).toContain("REST API Basics");
  });

  it("returns null and does not throw when LM Studio returns an error", async () => {
    seedSession({ sessionKey: "s9" });
    seedMessages("s9", [
      { role: "user", content: "Help" },
      { role: "assistant", content: "Sure" },
    ]);
    mockFetch.mockReturnValue(makeLlmError(500, "Internal Server Error"));

    const title = await generateChatTitle("s9");
    expect(title).toBeNull();
  });

  it("returns null and does not throw when fetch throws (network error)", async () => {
    seedSession({ sessionKey: "s10" });
    seedMessages("s10", [
      { role: "user", content: "Deploy" },
      { role: "assistant", content: "OK" },
    ]);
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const title = await generateChatTitle("s10");
    expect(title).toBeNull();
  });

  it("uses at most 6 messages for title generation (truncates)", async () => {
    seedSession({ sessionKey: "s11" });
    // 12 messages — only first 6 should be used
    seedMessages("s11", Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    })));
    mockFetch.mockReturnValue(makeLlmResponse("Long Conversation Title"));

    await generateChatTitle("s11");
    expect(mockFetch).toHaveBeenCalledOnce();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const allContent = JSON.stringify(body.messages);
    // Message 10 and 11 should NOT appear in the truncated set
    expect(allContent).not.toContain("Message 10");
    expect(allContent).not.toContain("Message 11");
  });

  it("handles very long message content without error (truncates)", async () => {
    seedSession({ sessionKey: "s12" });
    const longContent = "x".repeat(15_000); // > MAX_CONTEXT_CHARS (12_000)
    seedMessages("s12", [
      { role: "user", content: longContent },
      { role: "assistant", content: "Response" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Truncated Content Chat"));

    const title = await generateChatTitle("s12");
    expect(title).toBe("Truncated Content Chat");
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

// ── maybeSummarizeChat ───────────────────────────────────────────────────────

describe("maybeSummarizeChat", () => {
  it("returns null when session doesn't exist", async () => {
    const result = await maybeSummarizeChat("no-such-session");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null and does not fetch when below SUMMARY_THRESHOLD", async () => {
    seedSession({ sessionKey: "ms1", messageCountAtSummary: 0 });
    seedMessages("ms1", [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      // Only 2, < threshold (default 6)
    ]);

    const result = await maybeSummarizeChat("ms1");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns existing summary when below threshold", async () => {
    seedSession({
      sessionKey: "ms2",
      summary: "Existing summary from before",
      messageCountAtSummary: 4,
    });
    // Only 4 messages total → 4 - 4 = 0 new → below threshold
    seedMessages("ms2", Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Msg ${i}`,
    })));

    const result = await maybeSummarizeChat("ms2");
    expect(result).toBe("Existing summary from before");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("generates a new summary when above threshold (first time)", async () => {
    seedSession({ sessionKey: "ms3", messageCountAtSummary: 0 });
    seedMessages("ms3", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    })));
    mockFetch.mockReturnValue(makeLlmResponse("User asked about topic X. Resolution: found fix."));

    const result = await maybeSummarizeChat("ms3");
    expect(result).toBe("User asked about topic X. Resolution: found fix.");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("includes previous summary in prompt for UPDATE path", async () => {
    seedSession({
      sessionKey: "ms4",
      summary: "Previous summary: debugging auth flow.",
      messageCountAtSummary: 0,
    });
    seedMessages("ms4", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Msg ${i}`,
    })));
    mockFetch.mockReturnValue(makeLlmResponse("Updated summary with new context added."));

    const result = await maybeSummarizeChat("ms4");
    expect(result).toBe("Updated summary with new context added.");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("Previous summary:");
    expect(userMsg.content).toContain("debugging auth flow");
  });

  it("saves summary and updates messageCountAtSummary in DB", async () => {
    seedSession({ sessionKey: "ms5", messageCountAtSummary: 0 });
    seedMessages("ms5", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Content ${i}`,
    })));
    mockFetch.mockReturnValue(
      makeLlmResponse("A solid summary of what happened in the conversation."),
    );

    await maybeSummarizeChat("ms5");

    const raw = getRawDb();
    const row = raw.prepare("SELECT summary, message_count_at_summary FROM chat_sessions WHERE session_key = ?").get("ms5") as any;
    expect(row?.summary).toBe("A solid summary of what happened in the conversation.");
    expect(row?.message_count_at_summary).toBe(8);
  });

  it("filters out tool messages before building summary prompt", async () => {
    seedSession({ sessionKey: "ms6", messageCountAtSummary: 0 });
    seedMessages("ms6", [
      { role: "user", content: "Search for React hooks" },
      { role: "assistant", content: "Let me search..." },
      { role: "tool", content: "search result 1" },
      { role: "tool", content: "search result 2" },
      { role: "assistant", content: "Found it!" },
      { role: "user", content: "Thanks, explain" },
      { role: "assistant", content: "React hooks are..." },
      { role: "user", content: "Got it" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Explained React hooks to user."));

    await maybeSummarizeChat("ms6");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const allContent = JSON.stringify(body.messages);
    expect(allContent).toContain("Search for React hooks");
    expect(allContent).not.toContain("search result 1");
  });

  it("returns existing summary if generated summary is too short (<10 chars)", async () => {
    seedSession({
      sessionKey: "ms7",
      summary: "Good summary that should be kept.",
      messageCountAtSummary: 0,
    });
    seedMessages("ms7", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Msg ${i}`,
    })));
    mockFetch.mockReturnValue(makeLlmResponse("Short")); // 5 chars < 10

    const result = await maybeSummarizeChat("ms7");
    expect(result).toBe("Good summary that should be kept.");
  });

  it("returns null and does not throw when LM Studio fails", async () => {
    seedSession({ sessionKey: "ms8", messageCountAtSummary: 0 });
    seedMessages("ms8", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Msg ${i}`,
    })));
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await maybeSummarizeChat("ms8");
    expect(result).toBeNull();
  });

  it("exactly at threshold triggers summarization (newMessages === SUMMARY_THRESHOLD)", async () => {
    // Default SUMMARY_THRESHOLD is 6
    seedSession({ sessionKey: "ms9", messageCountAtSummary: 0 });
    seedMessages("ms9", Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Msg ${i}`,
    })));
    mockFetch.mockReturnValue(makeLlmResponse("Threshold summary reached exactly."));

    const result = await maybeSummarizeChat("ms9");
    expect(result).toBe("Threshold summary reached exactly.");
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

// ── forceSummarize ───────────────────────────────────────────────────────────

describe("forceSummarize", () => {
  it("resets label to default before calling generateChatTitle", async () => {
    seedSession({ sessionKey: "fs1", label: "Old Title" });
    seedMessages("fs1", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Newly Generated Title"));

    const result = await forceSummarize("fs1");
    expect(result.title).toBe("Newly Generated Title");
  });

  it("resets messageCountAtSummary to 0 before summarizing", async () => {
    seedSession({ sessionKey: "fs2", messageCountAtSummary: 100 });
    seedMessages("fs2", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    })));
    // First call = title, second call = summary
    mockFetch
      .mockReturnValueOnce(makeLlmResponse("Generated Title"))
      .mockReturnValueOnce(
        makeLlmResponse("Generated summary with enough length to pass."),
      );

    await forceSummarize("fs2");

    const raw = getRawDb();
    const row = raw.prepare("SELECT summary, message_count_at_summary FROM chat_sessions WHERE session_key = ?").get("fs2") as any;
    expect(row?.summary).toBe("Generated summary with enough length to pass.");
    expect(row?.message_count_at_summary).toBeGreaterThan(0);
  });

  it("returns both title and summary", async () => {
    seedSession({ sessionKey: "fs3" });
    seedMessages("fs3", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Turn ${i}`,
    })));
    mockFetch
      .mockReturnValueOnce(makeLlmResponse("Test Title"))
      .mockReturnValueOnce(makeLlmResponse("Summary of the conversation content here."));

    const result = await forceSummarize("fs3");
    expect(result.title).toBe("Test Title");
    expect(result.summary).toBe("Summary of the conversation content here.");
  });

  it("handles non-existent session gracefully", async () => {
    // forceSummarize updates non-existent session → should not throw
    const result = await forceSummarize("non-existent-session");
    expect(result.title).toBeNull();
    expect(result.summary).toBeNull();
  });
});

// ── onAssistantMessage ───────────────────────────────────────────────────────

describe("onAssistantMessage", () => {
  it("does not throw synchronously", () => {
    seedSession({ sessionKey: "oam1" });
    expect(() => onAssistantMessage("oam1")).not.toThrow();
  });

  it("returns immediately (fire-and-forget)", async () => {
    seedSession({ sessionKey: "oam2" });
    seedMessages("oam2", [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Good Title"));

    let syncDone = false;
    onAssistantMessage("oam2");
    syncDone = true;

    expect(syncDone).toBe(true); // returned synchronously
  });

  it("does not throw even when session doesn't exist", () => {
    expect(() => onAssistantMessage("no-session")).not.toThrow();
  });
});
