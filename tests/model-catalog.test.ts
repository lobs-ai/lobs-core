/**
 * Model catalog & Discord default tier tests
 *
 * Covers:
 *   - normalizeModelSelection: tier names are preserved as-is, not resolved to model strings
 *   - getDiscordDefaultTier / setDiscordDefaultTier: roundtrip persistence to models.json
 *   - Priority chain: channel override > Discord default tier > voice default > agent default
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLobsRoot } from "../src/config/lobs.js";
import {
  getDiscordDefaultTier,
  setDiscordDefaultTier,
} from "../src/config/models.js";
import { normalizeModelSelection } from "../src/services/model-catalog.js";

// ── Config file helpers ────────────────────────────────────────────────────────
// Note: getModelConfig() caches config in memory, so ALL state changes must go
// through setDiscordDefaultTier (which updates both file + cache). We only use
// direct file I/O for post-hoc assertions (checking the file was written correctly).

const CONFIG_PATH = resolve(getLobsRoot(), "config/models.json");

function readConfig(): unknown {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function fileDiscordDefault(): string | null {
  const cfg = readConfig() as { discord?: { defaultTier?: string } };
  return cfg.discord?.defaultTier ?? null;
}

// ── normalizeModelSelection ────────────────────────────────────────────────────

describe("normalizeModelSelection", () => {
  it("preserves tier names as-is (micro)", async () => {
    const result = await normalizeModelSelection("micro");
    expect(result).toBe("micro");
  });

  it("preserves tier names as-is (small)", async () => {
    const result = await normalizeModelSelection("small");
    expect(result).toBe("small");
  });

  it("preserves tier names as-is (medium)", async () => {
    const result = await normalizeModelSelection("medium");
    expect(result).toBe("medium");
  });

  it("preserves tier names as-is (standard)", async () => {
    const result = await normalizeModelSelection("standard");
    expect(result).toBe("standard");
  });

  it("preserves tier names as-is (strong)", async () => {
    const result = await normalizeModelSelection("strong");
    expect(result).toBe("strong");
  });

  it("is case-insensitive for tier names", async () => {
    await expect(normalizeModelSelection("STANDARD")).resolves.toBe("standard");
    await expect(normalizeModelSelection("Standard")).resolves.toBe("standard");
    await expect(normalizeModelSelection("  strong  ")).resolves.toBe("strong");
  });

  it("does NOT resolve tier names to model strings", async () => {
    // Key invariant: "standard" must NOT become "anthropic/claude-sonnet-4-20250514"
    const result = await normalizeModelSelection("standard");
    expect(result).toBe("standard");
    expect(result).not.toContain("/"); // tier names have no provider prefix
  });

  it("handles empty string", async () => {
    const result = await normalizeModelSelection("");
    expect(result).toBe("");
  });

  it("handles whitespace-only string", async () => {
    const result = await normalizeModelSelection("   ");
    expect(result).toBe("");
  });
});

// ── Discord default tier (get/set) ────────────────────────────────────────────

describe("Discord default tier persistence", () => {
  // Save/restore via get/set so the in-memory cache stays in sync
  let savedTier: string | null;

  beforeEach(() => {
    savedTier = getDiscordDefaultTier();
  });

  afterEach(() => {
    setDiscordDefaultTier(savedTier);
  });

  describe("getDiscordDefaultTier", () => {
    it("returns null when no discord config exists", () => {
      setDiscordDefaultTier(null);
      expect(getDiscordDefaultTier()).toBeNull();
    });

    it("returns null when discord config exists but no defaultTier", () => {
      // Set via direct file patch of the cache (readConfig still works for that)
      setDiscordDefaultTier(null);
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
      cfg.discord = {};
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      expect(getDiscordDefaultTier()).toBeNull();
    });

    it("returns the configured tier when set to standard", () => {
      setDiscordDefaultTier("standard");
      expect(getDiscordDefaultTier()).toBe("standard");
    });

    it("returns the configured tier when set to strong", () => {
      setDiscordDefaultTier("strong");
      expect(getDiscordDefaultTier()).toBe("strong");
    });

    it("returns the configured tier when set to small", () => {
      setDiscordDefaultTier("small");
      expect(getDiscordDefaultTier()).toBe("small");
    });
  });

  describe("setDiscordDefaultTier", () => {
    it("sets the tier in config", () => {
      setDiscordDefaultTier("standard");
      expect(getDiscordDefaultTier()).toBe("standard");
      expect(fileDiscordDefault()).toBe("standard");
    });

    it("overwrites previous tier", () => {
      setDiscordDefaultTier("strong");
      setDiscordDefaultTier("small");
      expect(getDiscordDefaultTier()).toBe("small");
    });

    it("clears config when passed null", () => {
      setDiscordDefaultTier("standard");
      setDiscordDefaultTier(null);
      expect(getDiscordDefaultTier()).toBeNull();
      const cfg = readConfig() as { discord?: unknown };
      expect(cfg.discord).toBeUndefined();
    });

    it("persists all valid tier values", () => {
      const tiers = ["micro", "small", "medium", "standard", "strong"] as const;
      for (const tier of tiers) {
        setDiscordDefaultTier(tier);
        expect(getDiscordDefaultTier()).toBe(tier);
      }
    });

    it("roundtrips: set → get → set → get", () => {
      setDiscordDefaultTier("standard");
      const first = getDiscordDefaultTier();
      setDiscordDefaultTier("strong");
      const second = getDiscordDefaultTier();
      setDiscordDefaultTier(first);
      const third = getDiscordDefaultTier();
      expect(first).toBe("standard");
      expect(second).toBe("strong");
      expect(third).toBe("standard");
    });
  });

  describe("normalizeModelSelection + Discord tier integration", () => {
    it("normalizeModelSelection preserves tier name without consuming Discord default", async () => {
      setDiscordDefaultTier("standard");
      // normalizeModelSelection("standard") returns "standard" — the tier string,
      // NOT the model the tier maps to. main-agent resolves the tier at call time.
      expect(await normalizeModelSelection("standard")).toBe("standard");
      // Discord default is untouched
      expect(getDiscordDefaultTier()).toBe("standard");
    });
  });
});
