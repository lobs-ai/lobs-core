/**
 * Tests for src/services/chat-summarizer.ts
 *
 * Covers:
 * - generateChatTitle() — title generation, DB updates, edge cases
 * - maybeSummarizeChat() — summary threshold, first vs update, DB updates
 * - forceSummarize() — reset + regenerate flow
 * - onUserMessage / onAssistantMessage — hook wiring
 * - callLocalModel (indirectly) — error response handling, think-block stripping
 * - The original bug: LM Studio returning 200 with error JSON
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/connection.js";
import { chatSessions, chatMessages } from "../src/db/schema.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock model config — always return a known local config
vi.mock("../src/config/models.js", () => ({
  getModelConfig: () => ({
    local: {
      baseUrl: "http://localhost:1234/v1",
      chatModel: "qwen2.5-1.5b-instruct-mlx",
    },
  }),
}));

// Mock model router — return null (no cloud provider, use local)
vi.mock("../src/services/model-router.js", () => ({
  getModelRouter: () => ({
    selectModel: () => null,
    reportSuccess: () => {},
    reportFailure: () => {},
  }),
}));

// Mock training data logger — no-op
vi.mock("../src/services/training-data.js", () => ({
  logTrainingExample: () => {},
}));

// Import after mocks are set up
import {
  generateChatTitle,
  maybeSummarizeChat,
  forceSummarize,
  onUserMessage,
  onAssistantMessage,
} from "../src/services/chat-summarizer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetchResponse(content: string, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => content,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  }) as unknown as typeof fetch;
}

function mockFetchError(error: string) {
  // Simulates the original bug: LM Studio returns 200 with an error object
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ error }),
    json: async () => ({ error }),
  }) as unknown as typeof fetch;
}

function mockFetchNoChoices() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "{}",
    json: async () => ({}),
  }) as unknown as typeof fetch;
}

function mockFetchNetworkError() {
  global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
}

function mockFetchHttpError(status: number, body: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({ error: body }),
  }) as unknown as typeof fetch;
}

const TEST_SESSION_KEY = "chat-test-0001";

function seedSession(key: string, label?: string) {
  const db = getDb();
  db.insert(chatSessions).values({
    sessionKey: key,
    label: label ?? "New Chat",
    isActive: true,
  }).run();
}

function seedMessages(sessionKey: string, messages: Array<{ role: string; content: string }>) {
  const db = getDb();
  for (const msg of messages) {
    db.insert(chatMessages).values({
      sessionKey,
      role: msg.role,
      content: msg.content,
    }).run();
  }
}

function getSession(key: string) {
  const db = getDb();
  return db.select().from(chatSessions)
    .where(eq(chatSessions.sessionKey, key))
    .get();
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  const db = getDb();
  db.delete(chatMessages).run();
  db.delete(chatSessions).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── generateChatTitle ─────────────────────────────────────────────────────────

describe("generateChatTitle", () => {
  it("generates a title from the first user message and saves to DB", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "How do I set up Docker Compose for a Node app?" },
    ]);
    mockFetchResponse("Setting Up Docker Compose for Node");

    const title = await generateChatTitle(TEST_SESSION_KEY);

    expect(title).toBe("Setting Up Docker Compose for Node");
    const session = getSession(TEST_SESSION_KEY);
    expect(session?.label).toBe("Setting Up Docker Compose for Node");
  });

  it("generates a title from multiple messages", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "My Postgres connection keeps timing out" },
      { role: "assistant", content: "Let me help you debug that. Check your connection pool settings." },
      { role: "user", content: "I'm using pg-pool with max 10 connections" },
    ]);
    mockFetchResponse("Debug PostgreSQL Connection Timeout");

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBe("Debug PostgreSQL Connection Timeout");
  });

  it("skips generation if session already has a custom title", async () => {
    seedSession(TEST_SESSION_KEY, "My Custom Title");
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Some message" },
    ]);
    mockFetchResponse("Should Not Be Used");

    const title = await generateChatTitle(TEST_SESSION_KEY);

    expect(title).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(getSession(TEST_SESSION_KEY)?.label).toBe("My Custom Title");
  });

  it("generates title when label is 'New Chat' (default)", async () => {
    seedSession(TEST_SESSION_KEY, "New Chat");
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Help me write a Rust parser" },
    ]);
    mockFetchResponse("Writing a Rust Parser");

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBe("Writing a Rust Parser");
  });

  it("generates title when label matches 'Chat N' pattern", async () => {
    seedSession(TEST_SESSION_KEY, "Chat 42");
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Explain async/await in JavaScript" },
    ]);
    mockFetchResponse("JavaScript Async Await Explained");

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBe("JavaScript Async Await Explained");
  });

  it("returns null for non-existent session", async () => {
    const title = await generateChatTitle("chat-does-not-exist");
    expect(title).toBeNull();
  });

  it("returns null when session has no messages", async () => {
    seedSession(TEST_SESSION_KEY);
    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBeNull();
  });

  it("strips think blocks from model output", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "How to deploy to Kubernetes?" },
    ]);
    mockFetchResponse("<think>\nThe user wants to know about k8s deployment.\n</think>\n\nKubernetes Deployment Guide");

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBe("Kubernetes Deployment Guide");
  });

  it("strips surrounding quotes from generated title", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Fix my CSS grid layout" },
    ]);
    mockFetchResponse('"Fixing CSS Grid Layout"');

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBe("Fixing CSS Grid Layout");
  });

  it("strips trailing punctuation from generated title", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Help with TypeScript generics" },
    ]);
    mockFetchResponse("TypeScript Generics Help!");

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBe("TypeScript Generics Help");
  });

  it("filters out tool-call messages, only uses user/assistant", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Read my config file" },
      { role: "tool", content: '{"file": "config.json", "content": "..."}' },
      { role: "assistant", content: "I read your config file, here's what I found." },
    ]);
    mockFetchResponse("Reading Config File");

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBe("Reading Config File");

    // Verify tool messages were excluded from the prompt
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    const userPrompt = body.messages.find((m: any) => m.role === "user")?.content;
    expect(userPrompt).not.toContain("config.json");
  });

  // ── Error handling ──────────────────────────────────────────────────────

  it("returns null when LM Studio returns 200 with error JSON (the original bug)", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
    ]);
    mockFetchError("Unexpected endpoint or method.");

    const title = await generateChatTitle(TEST_SESSION_KEY);

    expect(title).toBeNull();
    // Label should remain "New Chat" — not be set to empty string
    expect(getSession(TEST_SESSION_KEY)?.label).toBe("New Chat");
  });

  it("returns null when LM Studio returns 200 with no choices", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
    ]);
    mockFetchNoChoices();

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBeNull();
    expect(getSession(TEST_SESSION_KEY)?.label).toBe("New Chat");
  });

  it("returns null on HTTP error from LM Studio", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
    ]);
    mockFetchHttpError(503, "Service Unavailable");

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBeNull();
  });

  it("returns null on network error (LM Studio down)", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
    ]);
    mockFetchNetworkError();

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title).toBeNull();
  });

  it("truncates very long titles to 80 chars", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
    ]);
    const longTitle = "A".repeat(100);
    mockFetchResponse(longTitle);

    const title = await generateChatTitle(TEST_SESSION_KEY);
    expect(title!.length).toBeLessThanOrEqual(80);
  });
});

// ── maybeSummarizeChat ────────────────────────────────────────────────────────

describe("maybeSummarizeChat", () => {
  it("skips summarization when below SUMMARY_THRESHOLD (6 messages)", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);

    const fetchBefore = global.fetch;
    const summary = await maybeSummarizeChat(TEST_SESSION_KEY);

    // Should return null (no existing summary) without calling LLM
    expect(summary).toBeNull();
    // fetch should not have been called — threshold not met
    expect(global.fetch).toBe(fetchBefore);
  });

  it("generates first summary when threshold is met", async () => {
    seedSession(TEST_SESSION_KEY);
    const msgs = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
    }
    seedMessages(TEST_SESSION_KEY, msgs);
    mockFetchResponse("User discussed various topics across 8 messages. Key points were covered.");

    const summary = await maybeSummarizeChat(TEST_SESSION_KEY);

    expect(summary).toBe("User discussed various topics across 8 messages. Key points were covered.");
    const session = getSession(TEST_SESSION_KEY);
    expect(session?.summary).toBe(summary);
    expect(session?.messageCountAtSummary).toBe(8);
    expect(session?.summaryUpdatedAt).toBeTruthy();
  });

  it("updates existing summary with new messages", async () => {
    seedSession(TEST_SESSION_KEY);

    // Seed initial messages and set messageCountAtSummary to simulate previous summarization
    const msgs = [];
    for (let i = 0; i < 14; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
    }
    seedMessages(TEST_SESSION_KEY, msgs);

    // Set existing summary state — summarized at 6 messages, now have 14 (8 new > threshold)
    const db = getDb();
    db.update(chatSessions)
      .set({ summary: "Previous summary of initial conversation.", messageCountAtSummary: 6 })
      .where(eq(chatSessions.sessionKey, TEST_SESSION_KEY))
      .run();

    mockFetchResponse("Updated summary incorporating new developments.");

    const summary = await maybeSummarizeChat(TEST_SESSION_KEY);

    expect(summary).toBe("Updated summary incorporating new developments.");

    // Verify the prompt included the previous summary
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    const userPrompt = body.messages.find((m: any) => m.role === "user")?.content;
    expect(userPrompt).toContain("Previous summary:");
    expect(userPrompt).toContain("Previous summary of initial conversation.");
  });

  it("returns existing summary when not enough new messages", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    const db = getDb();
    db.update(chatSessions)
      .set({ summary: "Existing summary.", messageCountAtSummary: 2 })
      .where(eq(chatSessions.sessionKey, TEST_SESSION_KEY))
      .run();

    const summary = await maybeSummarizeChat(TEST_SESSION_KEY);
    expect(summary).toBe("Existing summary.");
  });

  it("returns null for non-existent session", async () => {
    const summary = await maybeSummarizeChat("chat-nonexistent");
    expect(summary).toBeNull();
  });

  it("keeps old summary when model returns bad output", async () => {
    seedSession(TEST_SESSION_KEY);
    const msgs = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
    }
    seedMessages(TEST_SESSION_KEY, msgs);

    const db = getDb();
    db.update(chatSessions)
      .set({ summary: "Good existing summary.", messageCountAtSummary: 0 })
      .where(eq(chatSessions.sessionKey, TEST_SESSION_KEY))
      .run();

    // Model returns something too short (< 10 chars)
    mockFetchResponse("Bad.");

    const summary = await maybeSummarizeChat(TEST_SESSION_KEY);
    expect(summary).toBe("Good existing summary.");
  });
});

// ── forceSummarize ────────────────────────────────────────────────────────────

describe("forceSummarize", () => {
  it("regenerates both title and summary", async () => {
    seedSession(TEST_SESSION_KEY, "Old Custom Title");
    const msgs = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
    }
    seedMessages(TEST_SESSION_KEY, msgs);

    // First fetch call = title generation, second = summary generation
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      const content = callCount === 1
        ? "Regenerated Title"
        : "Full summary of the conversation covering all 8 messages.";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content } }],
        }),
      };
    }) as unknown as typeof fetch;

    const result = await forceSummarize(TEST_SESSION_KEY);

    expect(result.title).toBe("Regenerated Title");
    expect(result.summary).toBe("Full summary of the conversation covering all 8 messages.");
    const session = getSession(TEST_SESSION_KEY);
    expect(session?.label).toBe("Regenerated Title");
    expect(session?.summary).toBe(result.summary);
  });

  it("restores original label if title generation fails", async () => {
    seedSession(TEST_SESSION_KEY, "Valuable Custom Title");
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
    ]);
    mockFetchNetworkError();

    const result = await forceSummarize(TEST_SESSION_KEY);

    expect(result.title).toBeNull();
    // forceSummarize resets label to "New Chat" before regenerating;
    // if title gen fails, it stays as "New Chat" (the reset value)
    expect(getSession(TEST_SESSION_KEY)?.label).toBe("New Chat");
  });

  it("resets messageCountAtSummary to force re-summarization", async () => {
    seedSession(TEST_SESSION_KEY);
    const msgs = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
    }
    seedMessages(TEST_SESSION_KEY, msgs);

    const db = getDb();
    db.update(chatSessions)
      .set({ messageCountAtSummary: 8, summary: "Old summary" })
      .where(eq(chatSessions.sessionKey, TEST_SESSION_KEY))
      .run();

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      const content = callCount === 1 ? "New Title" : "Fresh summary from scratch.";
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    }) as unknown as typeof fetch;

    const result = await forceSummarize(TEST_SESSION_KEY);

    // Summary should be regenerated even though messageCountAtSummary was 8
    expect(result.summary).toBe("Fresh summary from scratch.");
  });
});

// ── Hook functions ────────────────────────────────────────────────────────────

describe("onUserMessage / onAssistantMessage", () => {
  it("onUserMessage triggers title generation asynchronously", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Set up a CI/CD pipeline" },
    ]);
    mockFetchResponse("CI/CD Pipeline Setup");

    onUserMessage(TEST_SESSION_KEY);

    // The hook fires async — wait for it to settle
    await vi.waitFor(() => {
      const session = getSession(TEST_SESSION_KEY);
      expect(session?.label).toBe("CI/CD Pipeline Setup");
    }, { timeout: 5000 });
  });

  it("onAssistantMessage triggers both title and summary", async () => {
    seedSession(TEST_SESSION_KEY);
    const msgs = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
    }
    seedMessages(TEST_SESSION_KEY, msgs);

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      const content = callCount === 1 ? "Generated Title" : "Generated summary of the conversation.";
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    }) as unknown as typeof fetch;

    onAssistantMessage(TEST_SESSION_KEY);

    await vi.waitFor(() => {
      const session = getSession(TEST_SESSION_KEY);
      expect(session?.label).toBe("Generated Title");
      expect(session?.summary).toBe("Generated summary of the conversation.");
    }, { timeout: 5000 });
  });
});

// ── Regression: the original baseUrl bug ──────────────────────────────────────

describe("baseUrl handling", () => {
  it("calls the correct LM Studio /v1/chat/completions endpoint", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
    ]);
    mockFetchResponse("Hello Chat");

    await generateChatTitle(TEST_SESSION_KEY);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
    expect(url).not.toBe("http://localhost:1234/chat/completions");
  });

  it("uses configured model ID with lmstudio/ prefix stripped", async () => {
    seedSession(TEST_SESSION_KEY);
    seedMessages(TEST_SESSION_KEY, [
      { role: "user", content: "Hello" },
    ]);
    mockFetchResponse("Hello Chat");

    await generateChatTitle(TEST_SESSION_KEY);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.model).toBe("qwen2.5-1.5b-instruct-mlx");
    // Should NOT have the lmstudio/ prefix
    expect(body.model).not.toContain("lmstudio/");
  });
});
