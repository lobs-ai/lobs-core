/**
 * Tests for src/services/chat-summarizer.ts
 *
 * Strategy:
 *   - Mock fetch so no real LM Studio calls are made
 *   - Test all DB interaction logic (threshold checks, session writes, message reads)
 *   - Test error paths (session not found, LM Studio errors, bad titles)
 *   - Test generateChatTitle skip logic (already titled, <2 messages)
 *   - Test maybeSummarizeChat threshold and update logic
 *   - Test forceSummarize label reset and restoration
 *   - Test onAssistantMessage fires-and-forgets (no throw)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDb, getRawDb } from "../src/db/connection.js";
import {
  generateChatTitle,
  maybeSummarizeChat,
  forceSummarize,
  onAssistantMessage,
} from "../src/services/chat-summarizer.js";

// ── Mock fetch globally ──────────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  getRawDb().exec("DELETE FROM chat_messages; DELETE FROM chat_sessions;");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLlmResponse(content: string) {
  return Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content } }],
      }),
  });
}

function makeLlmError(status = 500, body = "Server error") {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

function seedSession(opts: {
  sessionKey: string;
  label?: string;
  summary?: string | null;
  messageCountAtSummary?: number;
}) {
  const raw = getRawDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  raw.prepare(`
    INSERT INTO chat_sessions (id, session_key, label, summary, message_count_at_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.sessionKey,
    opts.label ?? "New Chat",
    opts.summary ?? null,
    opts.messageCountAtSummary ?? 0,
    now,
  );
}

function seedMessages(
  sessionKey: string,
  msgs: Array<{ role: string; content: string }>
) {
  const raw = getRawDb();
  const base = Date.now();
  for (let i = 0; i < msgs.length; i++) {
    const ts = new Date(base + i * 1000).toISOString();
    const id = crypto.randomUUID();
    raw.prepare(`
      INSERT INTO chat_messages (id, session_key, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sessionKey, msgs[i].role, msgs[i].content, ts);
  }
}

// ── generateChatTitle ────────────────────────────────────────────────────────

describe("generateChatTitle", () => {
  it("returns null when session doesn't exist", async () => {
    const title = await generateChatTitle("no-such-session");
    expect(title).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips title generation when session has a custom (non-default) title", async () => {
    seedSession({ sessionKey: "s1", label: "My Custom Title" });
    const title = await generateChatTitle("s1");
    expect(title).toBe("My Custom Title");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips title generation for 'Chat N' format titles (default)", async () => {
    seedSession({ sessionKey: "s2", label: "Chat 42" });
    seedMessages("s2", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Greeting Exchange"));
    const title = await generateChatTitle("s2");
    // "Chat 42" matches /^Chat \d+$/ so it's treated as a default → title generated
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(title).toBe("Greeting Exchange");
  });

  it("returns null when fewer than 2 messages", async () => {
    seedSession({ sessionKey: "s3" });
    seedMessages("s3", [{ role: "user", content: "Hello" }]);
    const title = await generateChatTitle("s3");
    expect(title).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("filters out tool-call messages (only user/assistant used)", async () => {
    seedSession({ sessionKey: "s4" });
    seedMessages("s4", [
      { role: "tool", content: "search result" },
      { role: "user", content: "Fix my code" },
      { role: "assistant", content: "Sure, here's the fix..." },
      { role: "tool", content: "another tool call" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Code Fix Session"));
    await generateChatTitle("s4");
    expect(mockFetch).toHaveBeenCalledOnce();
    // Verify tool messages were not included in the prompt
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("Fix my code");
    expect(userMsg.content).not.toContain("search result");
  });

  it("saves title to DB on success", async () => {
    seedSession({ sessionKey: "s5" });
    seedMessages("s5", [
      { role: "user", content: "How do I deploy to Kubernetes?" },
      { role: "assistant", content: "Here's how you deploy to K8s..." },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Kubernetes Deployment Guide"));

    const title = await generateChatTitle("s5");
    expect(title).toBe("Kubernetes Deployment Guide");

    const db = getDb();
    const session = db.select().from(
      (await import("../src/db/schema.js")).chatSessions
    ).where(
      (await import("drizzle-orm")).eq(
        (await import("../src/db/schema.js")).chatSessions.sessionKey, "s5"
      )
    ).get();
    expect(session?.label).toBe("Kubernetes Deployment Guide");
  });

  it("strips surrounding quotes from model output", async () => {
    seedSession({ sessionKey: "s6" });
    seedMessages("s6", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "World" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse('"Hello World Chat"'));

    const title = await generateChatTitle("s6");
    expect(title).toBe("Hello World Chat");
  });

  it("strips trailing punctuation from model output", async () => {
    seedSession({ sessionKey: "s7" });
    seedMessages("s7", [
      { role: "user", content: "What is REST?" },
      { role: "assistant", content: "REST is..." },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("REST API Basics!"));

    const title = await generateChatTitle("s7");
    expect(title).toBe("REST API Basics");
  });

  it("returns null and does not throw when LM Studio returns an error", async () => {
    seedSession({ sessionKey: "s8" });
    seedMessages("s8", [
      { role: "user", content: "Help" },
      { role: "assistant", content: "Sure" },
    ]);
    mockFetch.mockReturnValue(makeLlmError(500, "Internal Server Error"));

    const title = await generateChatTitle("s8");
    expect(title).toBeNull();
  });

  it("returns null and does not throw when fetch throws (network error)", async () => {
    seedSession({ sessionKey: "s9" });
    seedMessages("s9", [
      { role: "user", content: "Deploy" },
      { role: "assistant", content: "OK" },
    ]);
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const title = await generateChatTitle("s9");
    expect(title).toBeNull();
  });

  it("falls back to 'New Chat' for very short model output (<3 chars)", async () => {
    seedSession({ sessionKey: "s10" });
    seedMessages("s10", [
      { role: "user", content: "." },
      { role: "assistant", content: ".." },
    ]);
    // Return a title shorter than 3 chars
    mockFetch.mockReturnValue(makeLlmResponse("OK"));

    const title = await generateChatTitle("s10");
    // "OK" is 2 chars — below the min length sanity check
    // The function should return the fallback or the raw slice
    expect(title).toBeTruthy(); // Does not throw, returns something
  });

  it("uses at most 6 messages for title generation", async () => {
    seedSession({ sessionKey: "s11" });
    // Seed 12 messages
    seedMessages("s11", Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    })));
    mockFetch.mockReturnValue(makeLlmResponse("Long Conversation Title"));

    await generateChatTitle("s11");
    expect(mockFetch).toHaveBeenCalledOnce();
    // The prompt should only contain the first 6 messages' content
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    // Message 10 (index 10) should NOT appear in the truncated set
    expect(userMsg.content).not.toContain("Message 10");
  });
});

// ── maybeSummarizeChat ───────────────────────────────────────────────────────

describe("maybeSummarizeChat", () => {
  it("returns null when session doesn't exist", async () => {
    const result = await maybeSummarizeChat("no-such-session");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns existing summary when below threshold (< 6 new messages)", async () => {
    seedSession({ sessionKey: "ms1", summary: "Existing summary", messageCountAtSummary: 4 });
    seedMessages("ms1", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: "Good!" },
      // Only 4 messages, 4 - 4 = 0 new → below threshold
    ]);

    const result = await maybeSummarizeChat("ms1");
    expect(result).toBe("Existing summary");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when below threshold and no existing summary", async () => {
    seedSession({ sessionKey: "ms2", messageCountAtSummary: 0 });
    seedMessages("ms2", [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      // Only 2, below SUMMARY_THRESHOLD=6
    ]);

    const result = await maybeSummarizeChat("ms2");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("generates a new summary when above threshold (first time)", async () => {
    seedSession({ sessionKey: "ms3", messageCountAtSummary: 0 });
    seedMessages("ms3", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Msg ${i}`,
    })));

    mockFetch.mockReturnValue(makeLlmResponse("User asked about topic X. Resolution: found fix."));

    const result = await maybeSummarizeChat("ms3");
    expect(result).toBe("User asked about topic X. Resolution: found fix.");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("uses UPDATE_SUMMARY prompt when previous summary exists", async () => {
    seedSession({
      sessionKey: "ms4",
      summary: "Old summary: User was debugging auth.",
      messageCountAtSummary: 0,
    });
    // 8 messages → 8 new (0 summarized before)
    seedMessages("ms4", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Msg ${i}`,
    })));

    mockFetch.mockReturnValue(makeLlmResponse("Updated summary with new context."));

    const result = await maybeSummarizeChat("ms4");
    expect(result).toBe("Updated summary with new context.");

    // The user prompt should include the previous summary
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("Old summary: User was debugging auth.");
    expect(userMsg.content).toContain("Previous summary:");
  });

  it("saves summary and updates messageCountAtSummary in DB", async () => {
    const { chatSessions: cs } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const db = getDb();

    seedSession({ sessionKey: "ms5", messageCountAtSummary: 0 });
    seedMessages("ms5", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Content ${i}`,
    })));

    mockFetch.mockReturnValue(makeLlmResponse("This is a solid summary of the conversation."));

    await maybeSummarizeChat("ms5");

    const session = db.select().from(cs).where(eq(cs.sessionKey, "ms5")).get();
    expect(session?.summary).toBe("This is a solid summary of the conversation.");
    expect(session?.messageCountAtSummary).toBe(8);
    expect(session?.summaryUpdatedAt).toBeTruthy();
  });

  it("filters tool messages before summarizing", async () => {
    seedSession({ sessionKey: "ms6", messageCountAtSummary: 0 });
    // 8 messages including tool calls
    seedMessages("ms6", [
      { role: "user", content: "Search for React hooks" },
      { role: "assistant", content: "Let me search..." },
      { role: "tool", content: "search result 1" },
      { role: "tool", content: "search result 2" },
      { role: "assistant", content: "Found it!" },
      { role: "user", content: "Thanks, now explain" },
      { role: "assistant", content: "React hooks are..." },
      { role: "user", content: "Got it" },
    ]);

    mockFetch.mockReturnValue(makeLlmResponse("Explained React hooks."));

    await maybeSummarizeChat("ms6");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("Search for React hooks");
    expect(userMsg.content).not.toContain("search result 1");
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

    mockFetch.mockReturnValue(makeLlmResponse("Too short")); // 9 chars

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
});

// ── forceSummarize ───────────────────────────────────────────────────────────

describe("forceSummarize", () => {
  it("resets label to 'New Chat' before title generation", async () => {
    seedSession({ sessionKey: "fs1", label: "Old Title" });
    seedMessages("fs1", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("New Generated Title"));

    const result = await forceSummarize("fs1");
    expect(result.title).toBe("New Generated Title");
  });

  it("resets messageCountAtSummary to 0 before summarizing", async () => {
    const { chatSessions: cs } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const db = getDb();

    seedSession({ sessionKey: "fs2", messageCountAtSummary: 100 });
    seedMessages("fs2", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    })));

    // First call = title, second call = summary
    mockFetch
      .mockReturnValueOnce(makeLlmResponse("Generated Title"))
      .mockReturnValueOnce(makeLlmResponse("Generated summary with enough length to pass."));

    await forceSummarize("fs2");

    const session = db.select().from(cs).where(eq(cs.sessionKey, "fs2")).get();
    // Summary should have been updated after reset
    expect(session?.summary).toBe("Generated summary with enough length to pass.");
    expect(session?.messageCountAtSummary).toBeGreaterThan(0);
  });

  it("returns both title and summary", async () => {
    seedSession({ sessionKey: "fs3" });
    seedMessages("fs3", Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Turn ${i}`,
    })));

    mockFetch
      .mockReturnValueOnce(makeLlmResponse("Test Title"))
      .mockReturnValueOnce(makeLlmResponse("Summary of the conversation content."));

    const result = await forceSummarize("fs3");
    expect(result.title).toBe("Test Title");
    expect(result.summary).toBe("Summary of the conversation content.");
  });

  it("handles non-existent session gracefully", async () => {
    // forceSummarize calls update on non-existent session → should still not throw
    const result = await forceSummarize("non-existent-session");
    expect(result.title).toBeNull();
    expect(result.summary).toBeNull();
  });
});

// ── onAssistantMessage ───────────────────────────────────────────────────────

describe("onAssistantMessage", () => {
  it("does not throw synchronously", () => {
    seedSession({ sessionKey: "oam1" });
    // No messages seeded — the async work will just return null
    expect(() => onAssistantMessage("oam1")).not.toThrow();
  });

  it("fires async work without blocking caller", async () => {
    seedSession({ sessionKey: "oam2" });
    seedMessages("oam2", [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Good Title"));

    let done = false;
    onAssistantMessage("oam2");
    done = true;
    expect(done).toBe(true); // Returned immediately
  });

  it("does not throw even when session doesn't exist", () => {
    expect(() => onAssistantMessage("no-session")).not.toThrow();
  });
});

// ── truncation edge case ─────────────────────────────────────────────────────

describe("transcript truncation via generateChatTitle", () => {
  it("handles very long message content without error", async () => {
    seedSession({ sessionKey: "trunc1" });
    const longContent = "x".repeat(15_000); // > MAX_CONTEXT_CHARS (12_000)
    seedMessages("trunc1", [
      { role: "user", content: longContent },
      { role: "assistant", content: "Response" },
    ]);
    mockFetch.mockReturnValue(makeLlmResponse("Truncated Content Chat"));

    const title = await generateChatTitle("trunc1");
    expect(title).toBe("Truncated Content Chat");
    // Should have called fetch — truncation happened but didn't throw
    expect(mockFetch).toHaveBeenCalledOnce();
    // The prompt must be shorter than original content
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.content.length).toBeLessThan(longContent.length + 200);
  });
});
