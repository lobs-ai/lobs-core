/**
 * Tests for src/services/voice/config.ts
 *
 * Covers path resolution, defaults, config merging, caching, reload, and
 * invalid-JSON fallback. Uses vi.mock on node:fs with a shared mock-state
 * object so each test controls what the fs calls return.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Identity mock (voice/types.ts calls getBotId() at load time) ─────────────

vi.mock("../src/config/identity.js", () => ({
  getBotName: () => "Lobs",
  getBotId: () => "lobs",
  getOwnerName: () => "Rafe",
  getOwnerId: () => "rafe",
  getOwnerDiscordId: () => "644578016298795010",
  getIdentity: () => ({
    bot: { name: "Lobs", id: "lobs" },
    owner: { name: "Rafe", id: "rafe", discordId: "644578016298795010" },
  }),
  resetIdentityCache: () => {},
}));

// ── Mock state (each test flips these before calling the module) ──────────────

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

// ── Imports (after vi.mock so they pick up mocked fs) ─────────────────────────

import { existsSync, readFileSync } from "node:fs";
import {
  getVoiceConfigPath,
  loadVoiceConfig,
  reloadVoiceConfig,
} from "../src/services/voice/config.js";
import { DEFAULT_VOICE_CONFIG } from "../src/services/voice/types.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getVoiceConfigPath", () => {
  it("returns a path ending in config/voice.json", () => {
    expect(getVoiceConfigPath()).toMatch(/config[/\\]voice\.json$/);
  });

  it("contains .lobs in the path", () => {
    expect(getVoiceConfigPath()).toContain(".lobs");
  });
});

describe("loadVoiceConfig", () => {
  beforeEach(() => {
    // Bust the module-level cache before each test
    reloadVoiceConfig();
    vi.clearAllMocks();
  });

  afterEach(() => {
    __fsMock.exists = false;
    __fsMock.content = null;
  });

  // ── Missing file ──────────────────────────────────────────────────────────

  it("returns DEFAULT_VOICE_CONFIG when voice.json does not exist", () => {
    __fsMock.exists = false;
    expect(loadVoiceConfig()).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("does NOT call readFileSync when the file is absent", () => {
    __fsMock.exists = false;
    loadVoiceConfig();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  // ── Valid file ────────────────────────────────────────────────────────────

  it("parses voice.json and merges with defaults", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: true });
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(true);
    // Non-overridden keys come from defaults
    expect(cfg.stt.url).toBe(DEFAULT_VOICE_CONFIG.stt.url);
    expect(cfg.tts.url).toBe(DEFAULT_VOICE_CONFIG.tts.url);
    expect(cfg.vad.silenceThresholdMs).toBe(DEFAULT_VOICE_CONFIG.vad.silenceThresholdMs);
  });

  it("overrides nested top-level keys from the file (shallow spread)", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({
      enabled: true,
      stt: { url: "http://stt.custom:9000", model: "large", language: "en" },
    });
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.stt.url).toBe("http://stt.custom:9000");
    expect(cfg.stt.model).toBe("large");
    // TTS unmodified → default
    expect(cfg.tts).toEqual(DEFAULT_VOICE_CONFIG.tts);
  });

  it("overrides vad and conversation settings from file", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({
      vad: { silenceThresholdMs: 1200, energyThreshold: 0.05 },
      conversation: {
        maxContextExchanges: 10,
        triggerMode: "always",
        triggerWords: ["yo"],
      },
    });
    const cfg = loadVoiceConfig();
    expect(cfg.vad.silenceThresholdMs).toBe(1200);
    expect(cfg.vad.energyThreshold).toBe(0.05);
    expect(cfg.conversation.triggerMode).toBe("always");
    expect(cfg.conversation.triggerWords).toEqual(["yo"]);
    // enabled not in override → still default (false)
    expect(cfg.enabled).toBe(DEFAULT_VOICE_CONFIG.enabled);
  });

  // ── Caching ───────────────────────────────────────────────────────────────

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

  // ── Invalid JSON ──────────────────────────────────────────────────────────

  it("returns DEFAULT_VOICE_CONFIG when voice.json contains invalid JSON", () => {
    __fsMock.exists = true;
    __fsMock.content = "{ this is not json }";
    expect(loadVoiceConfig()).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("returns defaults (not null/undefined) after a parse error", () => {
    __fsMock.exists = true;
    __fsMock.content = "bad json";
    const cfg = loadVoiceConfig();
    expect(cfg).toBeTruthy();
    expect(cfg.enabled).toBe(DEFAULT_VOICE_CONFIG.enabled);
  });

  // ── No-cache on miss/error ────────────────────────────────────────────────

  it("does NOT cache when file is missing — retries on next call", () => {
    __fsMock.exists = false;
    const first = loadVoiceConfig();
    expect(first).toEqual(DEFAULT_VOICE_CONFIG);

    // File appears
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: true });
    const second = loadVoiceConfig();
    expect(second.enabled).toBe(true);
  });

  it("does NOT cache after a parse error — retries on next call", () => {
    __fsMock.exists = true;
    __fsMock.content = "bad json";
    const first = loadVoiceConfig();
    expect(first).toEqual(DEFAULT_VOICE_CONFIG);

    // Fix the file
    __fsMock.content = JSON.stringify({ enabled: true });
    const second = loadVoiceConfig();
    expect(second.enabled).toBe(true);
  });
});

describe("reloadVoiceConfig", () => {
  beforeEach(() => {
    reloadVoiceConfig();
    vi.clearAllMocks();
  });

  afterEach(() => {
    __fsMock.exists = false;
    __fsMock.content = null;
  });

  it("clears the cache so the next call re-reads the file", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: false });
    const first = loadVoiceConfig();
    expect(first.enabled).toBe(false);

    // File changes — without reload, cache serves old value
    __fsMock.content = JSON.stringify({ enabled: true });
    expect(loadVoiceConfig().enabled).toBe(false); // still cached

    // Reload picks up the new value
    const reloaded = reloadVoiceConfig();
    expect(reloaded.enabled).toBe(true);
  });

  it("re-reads the file after reload (existsSync called again)", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: true });
    loadVoiceConfig(); // populate cache
    vi.clearAllMocks();
    reloadVoiceConfig();
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });

  it("returns defaults when file is missing after reload", () => {
    __fsMock.exists = true;
    __fsMock.content = JSON.stringify({ enabled: true });
    loadVoiceConfig();

    // File disappears
    __fsMock.exists = false;
    const cfg = reloadVoiceConfig();
    expect(cfg).toEqual(DEFAULT_VOICE_CONFIG);
  });
});
