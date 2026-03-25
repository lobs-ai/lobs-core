/**
 * Tests for VoiceTranscript class and voice config module.
 *
 * VoiceTranscript is pure logic — no DB, no setup required.
 * Voice config tests use vi.mock (hoisted) to intercept fs calls, with a
 * shared __fsMock object that each test flips before calling the module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VoiceTranscript } from "../src/services/voice/transcript.js";

// ─────────────────────────────────────────────────────────────────────────────
// fs mock — must be declared before any imports that touch node:fs
// ─────────────────────────────────────────────────────────────────────────────

// Shared state object so individual tests can control what the mock returns.
const __fsMock = {
  exists: false as boolean,
  content: null as string | null,
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => __fsMock.exists),
    readFileSync: vi.fn(() => __fsMock.content ?? ""),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Config module imports (after vi.mock so they pick up the mocked fs)
// ─────────────────────────────────────────────────────────────────────────────

import {
  loadVoiceConfig,
  reloadVoiceConfig,
  getVoiceConfigPath,
} from "../src/services/voice/config.js";
import { DEFAULT_VOICE_CONFIG } from "../src/services/voice/types.js";
import { existsSync, readFileSync } from "node:fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// ─────────────────────────────────────────────────────────────────────────────
// VoiceTranscript helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTranscript({
  maxExchanges = 10,
  triggerMode = "keyword" as const,
  triggerWords = ["lobs"],
} = {}) {
  return new VoiceTranscript(maxExchanges, triggerMode, triggerWords);
}

// ─────────────────────────────────────────────────────────────────────────────
// VoiceTranscript
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceTranscript", () => {
  // ── addUserUtterance ───────────────────────────────────────────────────────

  describe("addUserUtterance", () => {
    it("increments length by 1", () => {
      const t = makeTranscript();
      expect(t.length).toBe(0);
      t.addUserUtterance("u1", "Alice", "hello");
      expect(t.length).toBe(1);
    });

    it("adds an entry with the correct fields visible in toContext()", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Alice", "hello there");
      expect(t.toContext()).toBe("Alice: hello there");
    });

    it("stores displayName in the userNames map (visible in toSystemContext)", () => {
      const t = makeTranscript();
      t.addUserUtterance("u-42", "Bob", "yo");
      expect(t.toSystemContext()).toContain("Bob (u-42)");
    });

    it("updates userNames when the same userId speaks again", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Alice", "first");
      t.addUserUtterance("u1", "AliceRenamed", "second");
      const sys = t.toSystemContext();
      expect(sys).toContain("AliceRenamed (u1)");
      expect(sys).not.toContain("Alice (u1)");
    });

    it("accumulates multiple utterances from different users", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Alice", "ping");
      t.addUserUtterance("u2", "Bob", "pong");
      expect(t.length).toBe(2);
    });
  });

  // ── addAssistantResponse ──────────────────────────────────────────────────

  describe("addAssistantResponse", () => {
    it("increments length by 1", () => {
      const t = makeTranscript();
      t.addAssistantResponse("I am here.");
      expect(t.length).toBe(1);
    });

    it("formats as 'Lobs: <text>' in toContext()", () => {
      const t = makeTranscript();
      t.addAssistantResponse("Sure thing.");
      expect(t.toContext()).toBe("Lobs: Sure thing.");
    });

    it("does not add a userId or displayName to assistant entries", () => {
      const t = makeTranscript();
      t.addAssistantResponse("Hi.");
      // No user has spoken, so 'Users present' should not appear
      expect(t.toSystemContext()).not.toContain("Users present");
    });

    it("interleaves correctly with user entries", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Alice", "What time is it?");
      t.addAssistantResponse("It is noon.");
      expect(t.toContext()).toBe("Alice: What time is it?\nLobs: It is noon.");
    });
  });

  // ── checkTrigger (keyword mode) ───────────────────────────────────────────

  describe("checkTrigger — keyword mode", () => {
    it("returns null when no trigger word is present", () => {
      const t = makeTranscript({ triggerWords: ["lobs"] });
      expect(t.checkTrigger("hey how are you")).toBeNull();
    });

    it("returns text after trigger when trigger is at the start", () => {
      const t = makeTranscript({ triggerWords: ["lobs"] });
      expect(t.checkTrigger("lobs what time is it")).toBe("what time is it");
    });

    it("returns '(listening)' when the utterance is just the trigger word", () => {
      const t = makeTranscript({ triggerWords: ["lobs"] });
      expect(t.checkTrigger("lobs")).toBe("(listening)");
    });

    it("returns '(listening)' when utterance is the trigger word plus trailing whitespace", () => {
      const t = makeTranscript({ triggerWords: ["lobs"] });
      expect(t.checkTrigger("lobs   ")).toBe("(listening)");
    });

    it("strips trigger found in the middle and joins surrounding text", () => {
      const t = makeTranscript({ triggerWords: ["lobs"] });
      // "hey can you lobs help me" → "hey can you" + "help me" → "hey can you help me"
      expect(t.checkTrigger("hey can you lobs help me")).toBe("hey can you help me");
    });

    it("strips trigger at the end and returns only the text before it", () => {
      const t = makeTranscript({ triggerWords: ["lobs"] });
      expect(t.checkTrigger("okay so lobs")).toBe("okay so");
    });

    it("is case-insensitive — uppercase trigger word matches", () => {
      const t = makeTranscript({ triggerWords: ["lobs"] });
      expect(t.checkTrigger("LOBS turn the lights on")).toBe("turn the lights on");
    });

    it("is case-insensitive — mixed-case input", () => {
      const t = makeTranscript({ triggerWords: ["lobs"] });
      expect(t.checkTrigger("Lobs what is the weather")).toBe("what is the weather");
    });

    it("matches a multi-word trigger at the start", () => {
      const t = makeTranscript({ triggerWords: ["hey lobs"] });
      expect(t.checkTrigger("hey lobs can you help")).toBe("can you help");
    });

    it("returns null when only part of the multi-word trigger is present", () => {
      const t = makeTranscript({ triggerWords: ["hey lobs"] });
      expect(t.checkTrigger("lobs do something")).toBeNull();
    });

    it("checks all trigger words — first word in list matches", () => {
      const t = makeTranscript({ triggerWords: ["lobs", "hey lobs"] });
      expect(t.checkTrigger("lobs remind me")).toBe("remind me");
    });

    it("checks all trigger words — second word in list matches", () => {
      const t = makeTranscript({ triggerWords: ["nope", "lobs"] });
      expect(t.checkTrigger("lobs play music")).toBe("play music");
    });

    it("returns null when input is completely unrelated to any trigger", () => {
      const t = makeTranscript({ triggerWords: ["lobs", "hey lobs"] });
      expect(t.checkTrigger("the quick brown fox")).toBeNull();
    });

    it("handles an empty trigger words list — always returns null", () => {
      const t = makeTranscript({ triggerMode: "keyword", triggerWords: [] });
      expect(t.checkTrigger("lobs anything")).toBeNull();
    });
  });

  // ── checkTrigger (always mode) ────────────────────────────────────────────

  describe("checkTrigger — always mode", () => {
    it("returns the text unchanged for normal input", () => {
      const t = makeTranscript({ triggerMode: "always" });
      expect(t.checkTrigger("what is the capital of France")).toBe(
        "what is the capital of France"
      );
    });

    it("returns text even when it contains no trigger word", () => {
      const t = makeTranscript({ triggerMode: "always", triggerWords: ["lobs"] });
      expect(t.checkTrigger("random utterance with no keyword")).toBe(
        "random utterance with no keyword"
      );
    });

    it("returns the text unchanged for whitespace-only input", () => {
      const t = makeTranscript({ triggerMode: "always" });
      expect(t.checkTrigger("  ")).toBe("  ");
    });
  });

  // ── setTriggerMode ────────────────────────────────────────────────────────

  describe("setTriggerMode", () => {
    it("switching keyword → always makes checkTrigger return non-null for any text", () => {
      const t = makeTranscript({ triggerMode: "keyword", triggerWords: ["lobs"] });
      expect(t.checkTrigger("no keyword here")).toBeNull();
      t.setTriggerMode("always");
      expect(t.checkTrigger("no keyword here")).toBe("no keyword here");
    });

    it("switching always → keyword restores trigger-word gating", () => {
      const t = makeTranscript({ triggerMode: "always", triggerWords: ["lobs"] });
      expect(t.checkTrigger("no keyword here")).toBe("no keyword here");
      t.setTriggerMode("keyword");
      expect(t.checkTrigger("no keyword here")).toBeNull();
    });

    it("switching always → keyword still triggers when the keyword is present", () => {
      const t = makeTranscript({ triggerMode: "always", triggerWords: ["lobs"] });
      t.setTriggerMode("keyword");
      expect(t.checkTrigger("lobs play something")).toBe("play something");
    });
  });

  // ── toContext ─────────────────────────────────────────────────────────────

  describe("toContext", () => {
    it("returns empty string for an empty transcript", () => {
      expect(makeTranscript().toContext()).toBe("");
    });

    it("formats a single user entry as 'DisplayName: text'", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Charlie", "hello");
      expect(t.toContext()).toBe("Charlie: hello");
    });

    it("formats a single assistant entry as 'Lobs: text'", () => {
      const t = makeTranscript();
      t.addAssistantResponse("Hello there.");
      expect(t.toContext()).toBe("Lobs: Hello there.");
    });

    it("joins multiple entries with newlines", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Dana", "first");
      t.addAssistantResponse("second");
      t.addUserUtterance("u2", "Eve", "third");
      expect(t.toContext()).toBe("Dana: first\nLobs: second\nEve: third");
    });
  });

  // ── toSystemContext ───────────────────────────────────────────────────────

  describe("toSystemContext", () => {
    it("always contains the Discord voice call preamble", () => {
      expect(makeTranscript().toSystemContext()).toContain("You are in a Discord voice call.");
    });

    it("contains formatting guidance about spoken responses", () => {
      const sys = makeTranscript().toSystemContext();
      expect(sys).toContain("Don't use markdown");
      expect(sys).toContain("Keep responses short");
    });

    it("includes 'Users present' when users have spoken", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Frank", "hi");
      expect(t.toSystemContext()).toContain("Users present: Frank (u1)");
    });

    it("lists multiple users in 'Users present'", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Frank", "hi");
      t.addUserUtterance("u2", "Grace", "hey");
      const sys = t.toSystemContext();
      expect(sys).toContain("Frank (u1)");
      expect(sys).toContain("Grace (u2)");
    });

    it("does not include 'Users present' when no users have spoken", () => {
      expect(makeTranscript().toSystemContext()).not.toContain("Users present");
    });

    it("includes the conversation section when entries exist", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Heidi", "test question");
      const sys = t.toSystemContext();
      expect(sys).toContain("Recent conversation:");
      expect(sys).toContain("Heidi: test question");
    });

    it("does NOT include conversation section when transcript is empty", () => {
      expect(makeTranscript().toSystemContext()).not.toContain("Recent conversation:");
    });

    it("assistant-only transcript shows conversation but not Users present", () => {
      const t = makeTranscript();
      t.addAssistantResponse("Just me talking.");
      const sys = t.toSystemContext();
      expect(sys).not.toContain("Users present");
      expect(sys).toContain("Recent conversation:");
      expect(sys).toContain("Lobs: Just me talking.");
    });
  });

  // ── trim / maxExchanges ───────────────────────────────────────────────────

  describe("trim (maxExchanges)", () => {
    it("does not trim when under the limit", () => {
      const t = makeTranscript({ maxExchanges: 3 });
      t.addUserUtterance("u1", "Ivy", "one");
      t.addAssistantResponse("two");
      t.addUserUtterance("u1", "Ivy", "three");
      // maxEntries = 3*2 = 6; we have 3 entries
      expect(t.length).toBe(3);
    });

    it("trims to maxExchanges*2 entries when limit is exceeded", () => {
      const t = makeTranscript({ maxExchanges: 2 });
      for (let i = 0; i < 5; i++) {
        t.addUserUtterance("u1", "Jack", `user msg ${i}`);
        t.addAssistantResponse(`bot msg ${i}`);
      }
      // 5 pairs = 10 entries → trimmed to 4
      expect(t.length).toBe(4);
    });

    it("keeps the MOST RECENT entries after trimming", () => {
      const t = makeTranscript({ maxExchanges: 2 });
      for (let i = 0; i < 4; i++) {
        t.addUserUtterance("u1", "Kai", `msg ${i}`);
        t.addAssistantResponse(`reply ${i}`);
      }
      // maxEntries = 4 → last 4: msg 2, reply 2, msg 3, reply 3
      const ctx = t.toContext();
      expect(ctx).toContain("msg 2");
      expect(ctx).toContain("reply 2");
      expect(ctx).toContain("msg 3");
      expect(ctx).toContain("reply 3");
      expect(ctx).not.toContain("msg 0");
      expect(ctx).not.toContain("msg 1");
    });

    it("with maxExchanges=1 only keeps the last 2 entries", () => {
      const t = makeTranscript({ maxExchanges: 1 });
      t.addUserUtterance("u1", "Leo", "early");
      t.addAssistantResponse("early reply");
      t.addUserUtterance("u1", "Leo", "recent");
      t.addAssistantResponse("recent reply");
      expect(t.length).toBe(2);
      const ctx = t.toContext();
      expect(ctx).toContain("recent");
      expect(ctx).not.toContain("early");
    });

    it("trimming after an odd-numbered entry keeps correct tail", () => {
      const t = makeTranscript({ maxExchanges: 1 });
      // Entries: A B C — after adding C (length=3 > maxEntries=2), keeps B and C
      t.addUserUtterance("u1", "Mia", "A");
      t.addAssistantResponse("B");
      t.addUserUtterance("u1", "Mia", "C");
      expect(t.length).toBe(2);
      const ctx = t.toContext();
      expect(ctx).toContain("Lobs: B");
      expect(ctx).toContain("Mia: C");
      expect(ctx).not.toContain("Mia: A");
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  describe("clear", () => {
    it("resets length to 0", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Nora", "hi");
      t.addAssistantResponse("hello");
      t.clear();
      expect(t.length).toBe(0);
    });

    it("toContext returns empty string after clear", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Omar", "test");
      t.clear();
      expect(t.toContext()).toBe("");
    });

    it("allows adding entries again after clear", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Pat", "before clear");
      t.clear();
      t.addUserUtterance("u1", "Pat", "after clear");
      expect(t.length).toBe(1);
      expect(t.toContext()).toBe("Pat: after clear");
    });
  });

  // ── length ────────────────────────────────────────────────────────────────

  describe("length", () => {
    it("starts at 0", () => {
      expect(makeTranscript().length).toBe(0);
    });

    it("increments with each addUserUtterance", () => {
      const t = makeTranscript();
      t.addUserUtterance("u1", "Quinn", "a");
      t.addUserUtterance("u1", "Quinn", "b");
      expect(t.length).toBe(2);
    });

    it("increments with each addAssistantResponse", () => {
      const t = makeTranscript();
      t.addAssistantResponse("x");
      t.addAssistantResponse("y");
      t.addAssistantResponse("z");
      expect(t.length).toBe(3);
    });

    it("reflects trimming when maxExchanges is small", () => {
      const t = makeTranscript({ maxExchanges: 1 });
      t.addUserUtterance("u1", "Ray", "first");
      t.addAssistantResponse("reply");
      t.addUserUtterance("u1", "Ray", "third"); // triggers trim → capped at 2
      expect(t.length).toBe(2);
    });

    it("returns 0 after clear regardless of prior entries", () => {
      const t = makeTranscript();
      for (let i = 0; i < 8; i++) t.addAssistantResponse(`line ${i}`);
      t.clear();
      expect(t.length).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Voice Config module
// ─────────────────────────────────────────────────────────────────────────────

describe("voice config module", () => {
  beforeEach(() => {
    // Always bust the module-level cache before each test so tests are independent
    reloadVoiceConfig();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Reset shared mock state to a safe default
    __fsMock.exists = false;
    __fsMock.content = null;
  });

  // ── getVoiceConfigPath ────────────────────────────────────────────────────

  it("getVoiceConfigPath returns a path ending in config/voice.json", () => {
    expect(getVoiceConfigPath()).toMatch(/config[/\\]voice\.json$/);
  });

  // ── loadVoiceConfig — missing file ────────────────────────────────────────

  it("returns DEFAULT_VOICE_CONFIG when voice.json does not exist", () => {
    __fsMock.exists = false;
    expect(loadVoiceConfig()).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("does NOT call readFileSync when the file is absent", () => {
    __fsMock.exists = false;
    loadVoiceConfig();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  // ── loadVoiceConfig — valid file ──────────────────────────────────────────

  it("parses voice.json and merges with defaults", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: true });
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(true);
    // Non-overridden keys come from defaults
    expect(cfg.stt.url).toBe(DEFAULT_VOICE_CONFIG.stt.url);
    expect(cfg.tts.url).toBe(DEFAULT_VOICE_CONFIG.tts.url);
  });

  it("overrides nested top-level keys from the file", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({
      stt: { url: "http://stt.custom:9000", model: "large" },
    });
    const cfg = loadVoiceConfig();
    expect(cfg.stt.url).toBe("http://stt.custom:9000");
    expect(cfg.stt.model).toBe("large");
  });

  it("merges vad and conversation settings from file", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({
      vad: { silenceThresholdMs: 1200 },
      conversation: { maxContextExchanges: 10, triggerMode: "always", triggerWords: ["yo"] },
    });
    const cfg = loadVoiceConfig();
    expect(cfg.vad.silenceThresholdMs).toBe(1200);
    expect(cfg.conversation.triggerMode).toBe("always");
    expect(cfg.conversation.triggerWords).toEqual(["yo"]);
    // Unset top-level key still comes from defaults
    expect(cfg.enabled).toBe(DEFAULT_VOICE_CONFIG.enabled);
  });

  // ── loadVoiceConfig — caching ─────────────────────────────────────────────

  it("returns the same object reference on successive calls (cached)", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: true });
    const first = loadVoiceConfig();
    const second = loadVoiceConfig();
    expect(first).toBe(second);
  });

  it("only reads the file once even when called multiple times", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: true });
    loadVoiceConfig();
    loadVoiceConfig();
    loadVoiceConfig();
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });

  // ── loadVoiceConfig — invalid JSON ────────────────────────────────────────

  it("falls back to DEFAULT_VOICE_CONFIG when voice.json contains invalid JSON", () => {
    __fsMock.exists = true;
    __fsMock.content = "{ this is not valid json !!!";
    expect(loadVoiceConfig()).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("returns defaults (not null/undefined) after a parse error", () => {
    __fsMock.exists = true;
    __fsMock.content = "bad json";
    const cfg = loadVoiceConfig();
    expect(cfg).toBeTruthy();
    expect(cfg.enabled).toBe(DEFAULT_VOICE_CONFIG.enabled);
  });

  // ── reloadVoiceConfig ─────────────────────────────────────────────────────

  it("clears the cache so the next load re-reads from disk", () => {
    // First load — file says enabled:false
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: false });
    const first = loadVoiceConfig();
    expect(first.enabled).toBe(false);

    // File changes — but without reload the cache would serve the old value
    __fsMock.content = JSON.stringify({ enabled: true });
    // Still cached
    expect(loadVoiceConfig().enabled).toBe(false);

    // Now reload — picks up the new value
    const reloaded = reloadVoiceConfig();
    expect(reloaded.enabled).toBe(true);
  });

  it("returns defaults when file is missing after a reload", () => {
    // Seed a valid cache
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: true });
    loadVoiceConfig();

    // File disappears
    __fsMock.exists = false;
    const cfg = reloadVoiceConfig();
    expect(cfg).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("re-reads the file after reload (existsSync called again)", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: true });
    loadVoiceConfig(); // populate cache
    vi.clearAllMocks();
    reloadVoiceConfig();
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });
});
