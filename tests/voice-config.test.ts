/**
 * Tests for src/services/voice/config.ts
 *
 * Covers path resolution, defaults, config merging, caching, reload, and
 * invalid-JSON fallback. All filesystem access is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must precede imports) ──────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Must match the path as resolved from the *test* directory
vi.mock("../src/config/lobs.js", () => ({
  getLobsRoot: vi.fn(() => "/home/testuser/.lobs"),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { getLobsRoot } from "../src/config/lobs.js";
import {
  getVoiceConfigPath,
  loadVoiceConfig,
  reloadVoiceConfig,
} from "../src/services/voice/config.js";
import { DEFAULT_VOICE_CONFIG } from "../src/services/voice/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockExistsSync   = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockGetLobsRoot  = vi.mocked(getLobsRoot);

/** Serialise a value to a UTF-8 string as readFileSync would return. */
function jsonBuffer(obj: unknown): string {
  return JSON.stringify(obj);
}

/** Reset the internal config cache by calling reloadVoiceConfig with "file absent" set up. */
function resetCache() {
  mockExistsSync.mockReturnValue(false);
  reloadVoiceConfig();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getVoiceConfigPath", () => {
  it("returns the resolved path under lobsRoot/config/voice.json", () => {
    mockGetLobsRoot.mockReturnValue("/home/testuser/.lobs");
    const p = getVoiceConfigPath();
    expect(p).toMatch(/[/\\]home[/\\]testuser[/\\]\.lobs[/\\]config[/\\]voice\.json$/);
  });

  it("honours a different lobsRoot", () => {
    mockGetLobsRoot.mockReturnValue("/custom/root");
    const p = getVoiceConfigPath();
    expect(p).toMatch(/[/\\]custom[/\\]root[/\\]config[/\\]voice\.json$/);
  });

  it("always ends with voice.json", () => {
    mockGetLobsRoot.mockReturnValue("/any/path");
    expect(getVoiceConfigPath()).toMatch(/voice\.json$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadVoiceConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("loadVoiceConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLobsRoot.mockReturnValue("/home/testuser/.lobs");
    resetCache();
    vi.clearAllMocks(); // clear calls made by resetCache itself
    mockGetLobsRoot.mockReturnValue("/home/testuser/.lobs");
  });

  // ── Missing file ──────────────────────────────────────────────────────────

  it("returns DEFAULT_VOICE_CONFIG when voice.json does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const cfg = loadVoiceConfig();
    expect(cfg).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("does NOT call readFileSync when the file is absent", () => {
    mockExistsSync.mockReturnValue(false);
    loadVoiceConfig();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  // ── Valid file — simple override ──────────────────────────────────────────

  it("parses voice.json and returns enabled:true when set in file", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: true }));
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(true);
  });

  it("fills unspecified top-level keys from DEFAULT_VOICE_CONFIG", () => {
    mockExistsSync.mockReturnValue(true);
    // Only override enabled — everything else should fall back to defaults
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: true }));
    const cfg = loadVoiceConfig();
    expect(cfg.stt).toEqual(DEFAULT_VOICE_CONFIG.stt);
    expect(cfg.tts).toEqual(DEFAULT_VOICE_CONFIG.tts);
    expect(cfg.vad).toEqual(DEFAULT_VOICE_CONFIG.vad);
    expect(cfg.conversation).toEqual(DEFAULT_VOICE_CONFIG.conversation);
  });

  it("overrides an entire nested key when provided in the file", () => {
    // The implementation does a shallow spread, so providing stt replaces it wholesale
    const customStt = { url: "http://stt.custom:9000", model: "large", language: "fr" };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ stt: customStt }));
    const cfg = loadVoiceConfig();
    expect(cfg.stt.url).toBe("http://stt.custom:9000");
    expect(cfg.stt.model).toBe("large");
    expect(cfg.stt.language).toBe("fr");
  });

  it("overrides vad when provided in the file", () => {
    const customVad = { silenceThresholdMs: 1200, energyThreshold: 0.05 };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ vad: customVad }));
    const cfg = loadVoiceConfig();
    expect(cfg.vad.silenceThresholdMs).toBe(1200);
    expect(cfg.vad.energyThreshold).toBe(0.05);
  });

  it("overrides conversation settings when provided in the file", () => {
    const customConv = {
      maxContextExchanges: 10,
      triggerMode: "always",
      triggerWords: ["yo"],
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ conversation: customConv }));
    const cfg = loadVoiceConfig();
    expect(cfg.conversation.triggerMode).toBe("always");
    expect(cfg.conversation.triggerWords).toEqual(["yo"]);
  });

  // ── Caching ───────────────────────────────────────────────────────────────

  it("returns the same object reference on successive calls (cached)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: true }));
    const first  = loadVoiceConfig();
    const second = loadVoiceConfig();
    expect(first).toBe(second);
  });

  it("only reads the file once even when called three times", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: true }));
    loadVoiceConfig();
    loadVoiceConfig();
    loadVoiceConfig();
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  // ── Invalid JSON ──────────────────────────────────────────────────────────

  it("returns DEFAULT_VOICE_CONFIG when voice.json contains invalid JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("{ this is not json }");
    const cfg = loadVoiceConfig();
    expect(cfg).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("returns defaults (enabled:false) on JSON parse failure", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("bad json");
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reloadVoiceConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("reloadVoiceConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLobsRoot.mockReturnValue("/home/testuser/.lobs");
    resetCache();
    vi.clearAllMocks();
    mockGetLobsRoot.mockReturnValue("/home/testuser/.lobs");
  });

  it("clears the cache so an updated file value is picked up", () => {
    // Load with enabled:false
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: false }));
    const first = loadVoiceConfig();
    expect(first.enabled).toBe(false);

    // Swap the mock — without reloadVoiceConfig() this would still be cached
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: true }));
    const reloaded = reloadVoiceConfig();
    expect(reloaded.enabled).toBe(true);
  });

  it("re-reads the file after reload (readFileSync called again)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: true }));
    loadVoiceConfig();            // populate the cache
    vi.clearAllMocks();           // reset call count
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: true }));

    reloadVoiceConfig();
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns defaults when the file disappears between load and reload", () => {
    // Seed a valid cache first
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: true }));
    loadVoiceConfig();

    // File disappears
    mockExistsSync.mockReturnValue(false);
    const cfg = reloadVoiceConfig();
    expect(cfg).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("a new loadVoiceConfig call after reload returns fresh data", () => {
    // Populate cache with enabled:true
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonBuffer({ enabled: true }));
    loadVoiceConfig();

    // Reload clears, then file is now absent
    mockExistsSync.mockReturnValue(false);
    reloadVoiceConfig();

    // Next regular load should also see absent file
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(false);
  });
});
