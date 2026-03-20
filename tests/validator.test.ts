/**
 * Tests for src/config/validator.ts
 *
 * validateAllConfigs() reads files from ~/.lobs/config/. We mock the fs
 * module to control what files "exist" and what they contain, letting us
 * test all validation rules without touching the real filesystem.
 *
 * printValidationResults() just calls console.log — we verify it doesn't
 * crash and respects the valid/invalid flags.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AllConfigsResult } from "../src/config/validator.js";

// ─── fs mock — must be declared before importing the module ──────────────────

vi.mock("node:fs");

import * as fs from "node:fs";
import { validateAllConfigs, printValidationResults } from "../src/config/validator.js";

const { existsSync, readFileSync } = vi.mocked(fs);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Set up fake file system. Keys are path suffixes (matched via endsWith).
 * Values are file content strings. Pass `false` to mark as non-existent.
 */
function mockFs(files: Record<string, string | false>) {
  existsSync.mockImplementation((p: unknown) => {
    const path = String(p);
    for (const [key, val] of Object.entries(files)) {
      if (path.endsWith(key)) return val !== false;
    }
    return false;
  });
  readFileSync.mockImplementation((p: unknown) => {
    const path = String(p);
    for (const [key, val] of Object.entries(files)) {
      if (path.endsWith(key)) {
        if (val === false) throw new Error(`ENOENT: ${path}`);
        return val;
      }
    }
    throw new Error(`ENOENT: unregistered path — ${path}`);
  });
}

afterEach(() => vi.clearAllMocks());

// ─── Minimal valid configs ────────────────────────────────────────────────────

const VALID_MODELS = JSON.stringify({
  tiers: {
    micro: "anthropic/claude-haiku-3",
    small: "anthropic/claude-3-5-sonnet",
    medium: "anthropic/claude-3-5-sonnet",
    standard: "anthropic/claude-opus-4",
    strong: "anthropic/claude-opus-4",
  },
  agents: {
    programmer: { primary: "standard", fallbacks: ["small"] },
    reviewer: { primary: "small" },
  },
});

const VALID_DISCORD = JSON.stringify({
  guildId: "12345678",
  dmAllowFrom: ["user1"],
  channels: { tasks: "987654321" },
});

const VALID_TOKEN = JSON.stringify({ botToken: "Bot.token.goes.here" });

const VALID_KEYS = JSON.stringify({
  openai: ["sk-abc123"],
  anthropic: ["sk-ant-abc"],
});

// New-layout: secrets/ dir exists, all new-style files present
function newLayoutFs(overrides: Record<string, string | false> = {}) {
  return {
    "models.json": VALID_MODELS,
    "discord.json": VALID_DISCORD,
    // existsSync("secrets") dir — key handled by custom existsSync
    "secrets/keys.json": VALID_KEYS,
    "secrets/discord-token.json": VALID_TOKEN,
    ...overrides,
  };
}

/** Set up new-layout mock: secrets/ dir present + customisable files */
function mockNewLayout(overrides: Record<string, string | false> = {}) {
  const files = newLayoutFs(overrides);

  existsSync.mockImplementation((p: unknown) => {
    const path = String(p);
    // The secrets/ DIRECTORY check
    if (path.endsWith("secrets") && !path.endsWith("keys.json") && !path.endsWith("discord-token.json")) {
      return true;
    }
    // old keys.json (legacy) — not present in new layout
    if (path.endsWith("keys.json") && !path.includes("secrets")) return false;
    // specific file checks
    for (const [key, val] of Object.entries(files)) {
      if (path.endsWith(key)) return val !== false;
    }
    return false;
  });

  readFileSync.mockImplementation((p: unknown) => {
    const path = String(p);
    for (const [key, val] of Object.entries(files)) {
      if (path.endsWith(key)) {
        if (val === false) throw new Error(`ENOENT: ${path}`);
        return val;
      }
    }
    throw new Error(`ENOENT: ${path}`);
  });
}

/** Set up legacy-layout mock: no secrets/ dir, old-style files in config root.
 *
 * The legacy layout has:
 *   config/keys.json       ← old-style
 *   config/models.json
 *   config/discord.json
 *   NO config/secrets/keys.json
 *   NO config/secrets/discord-token.json
 */
function mockLegacyLayout(overrides: Record<string, string | false> = {}) {
  const files: Record<string, string | false> = {
    "models.json": VALID_MODELS,
    "discord.json": VALID_DISCORD,
    "keys.json": VALID_KEYS, // at config root (legacy)
    ...overrides,
  };

  existsSync.mockImplementation((p: unknown) => {
    const path = String(p);
    // No secrets/ directory itself
    if (path.endsWith("/secrets") || path.endsWith("\\secrets")) return false;
    // secrets/keys.json → NOT present in legacy layout
    if (path.includes("secrets/keys.json") || path.includes("secrets\\keys.json")) return false;
    // secrets/discord-token.json → NOT present in legacy layout
    if (path.includes("discord-token.json")) return false;
    // config-root "keys.json" → present
    if (path.endsWith("keys.json") && !path.includes("secrets")) {
      return files["keys.json"] !== false;
    }
    // other files
    for (const [key, val] of Object.entries(files)) {
      if (path.endsWith(key) && !key.includes("keys.json")) return val !== false;
    }
    return false;
  });

  readFileSync.mockImplementation((p: unknown) => {
    const path = String(p);
    // secrets/ files → ENOENT
    if (path.includes("secrets/") || path.includes("secrets\\")) throw new Error(`ENOENT: ${path}`);
    for (const [key, val] of Object.entries(files)) {
      if (path.endsWith(key)) {
        if (val === false) throw new Error(`ENOENT: ${path}`);
        return val;
      }
    }
    throw new Error(`ENOENT: ${path}`);
  });
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("validateAllConfigs — happy path (all valid, new layout)", () => {
  beforeEach(() => mockNewLayout());

  it("returns valid=true overall", () => {
    expect(validateAllConfigs().valid).toBe(true);
  });

  it("returns results array with 4 entries", () => {
    expect(validateAllConfigs().results).toHaveLength(4);
  });

  it("does not flag legacy_layout", () => {
    expect(validateAllConfigs().legacy_layout).toBe(false);
  });

  it("secrets.api_keys is true", () => {
    expect(validateAllConfigs().secrets.api_keys).toBe(true);
  });

  it("secrets.discord_token is true", () => {
    expect(validateAllConfigs().secrets.discord_token).toBe(true);
  });
});

// ─── models.json validation ───────────────────────────────────────────────────

describe("validateModelsConfig — via validateAllConfigs", () => {
  function setupModels(modelsJson: string | false) {
    mockNewLayout({ "models.json": modelsJson });
  }

  it("valid models.json → valid result entry, zero errors", () => {
    setupModels(VALID_MODELS);
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("missing tiers → error, valid=false", () => {
    setupModels(JSON.stringify({ agents: { programmer: { primary: "standard" } } }));
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("tiers"))).toBe(true);
  });

  it("missing a required tier ('strong') → error", () => {
    setupModels(
      JSON.stringify({
        tiers: { micro: "a", small: "b", medium: "c", standard: "d" }, // no 'strong'
        agents: { programmer: { primary: "standard" } },
      })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("strong"))).toBe(true);
  });

  it("each required tier is validated ('micro', 'small', 'medium', 'standard', 'strong')", () => {
    // Remove a different tier each time; confirm the error message names it
    for (const missingTier of ["micro", "small", "medium", "standard", "strong"]) {
      const tiers: Record<string, string> = {
        micro: "a", small: "b", medium: "c", standard: "d", strong: "e",
      };
      delete tiers[missingTier];
      setupModels(
        JSON.stringify({
          tiers,
          agents: { programmer: { primary: "standard" } },
        })
      );
      const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
      expect(r.errors.some((e) => e.includes(missingTier))).toBe(true);
    }
  });

  it("tier value is not a string → error mentioning that tier", () => {
    setupModels(
      JSON.stringify({
        tiers: { micro: 42, small: "b", medium: "c", standard: "d", strong: "e" },
        agents: {},
      })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("micro"))).toBe(true);
  });

  it("unknown tier key → warning only (valid remains true)", () => {
    setupModels(
      JSON.stringify({
        tiers: { micro: "a", small: "b", medium: "c", standard: "d", strong: "e", ultra: "x" },
        agents: { programmer: { primary: "standard" } },
      })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes("ultra"))).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("missing agents object → error", () => {
    setupModels(
      JSON.stringify({ tiers: { micro: "a", small: "b", medium: "c", standard: "d", strong: "e" } })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("agents"))).toBe(true);
  });

  it("agent missing primary → error mentioning agent name", () => {
    setupModels(
      JSON.stringify({
        tiers: { micro: "a", small: "b", medium: "c", standard: "d", strong: "e" },
        agents: { programmer: { fallbacks: ["small"] } }, // no primary
      })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("programmer") && e.includes("primary"))).toBe(true);
  });

  it("agent fallbacks is not an array → error", () => {
    setupModels(
      JSON.stringify({
        tiers: { micro: "a", small: "b", medium: "c", standard: "d", strong: "e" },
        agents: { programmer: { primary: "standard", fallbacks: "small" } },
      })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("fallbacks"))).toBe(true);
  });

  it("agent fallbacks is empty array → warning (valid=true)", () => {
    setupModels(
      JSON.stringify({
        tiers: { micro: "a", small: "b", medium: "c", standard: "d", strong: "e" },
        agents: { programmer: { primary: "standard", fallbacks: [] } },
      })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes("programmer") && w.includes("fallbacks"))).toBe(true);
  });

  it("valid local config → zero local-related warnings", () => {
    setupModels(
      JSON.stringify({
        tiers: { micro: "a", small: "b", medium: "c", standard: "d", strong: "e" },
        agents: { programmer: { primary: "standard" } },
        local: { baseUrl: "http://localhost:11434", chatModel: "ollama/llama3" },
      })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(true);
    expect(r.warnings.filter((w) => w.includes("local"))).toHaveLength(0);
  });

  it("local config missing baseUrl → warning", () => {
    setupModels(
      JSON.stringify({
        tiers: { micro: "a", small: "b", medium: "c", standard: "d", strong: "e" },
        agents: { programmer: { primary: "standard" } },
        local: { chatModel: "ollama/llama3" },
      })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.warnings.some((w) => w.includes("baseUrl"))).toBe(true);
  });

  it("local config missing chatModel → warning", () => {
    setupModels(
      JSON.stringify({
        tiers: { micro: "a", small: "b", medium: "c", standard: "d", strong: "e" },
        agents: { programmer: { primary: "standard" } },
        local: { baseUrl: "http://localhost:11434" },
      })
    );
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.warnings.some((w) => w.includes("chatModel"))).toBe(true);
  });

  it("models.json does not exist → valid=false, 'does not exist' error", () => {
    setupModels(false);
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("does not exist"))).toBe(true);
  });

  it("models.json contains invalid JSON → 'Invalid JSON' error", () => {
    setupModels('{ not valid json !!!');
    const r = validateAllConfigs().results.find((r) => r.file === "models.json")!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("Invalid JSON"))).toBe(true);
  });
});

// ─── discord.json validation ──────────────────────────────────────────────────

describe("validateDiscordConfig — via validateAllConfigs", () => {
  function setupDiscord(discordJson: string | false) {
    mockNewLayout({ "discord.json": discordJson });
  }

  it("valid discord.json → valid=true, zero errors", () => {
    setupDiscord(VALID_DISCORD);
    const r = validateAllConfigs().results.find((r) => r.file === "discord.json")!;
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("botToken present in discord.json → deprecation warning", () => {
    setupDiscord(JSON.stringify({ botToken: "Bot.my-token", guildId: "123" }));
    const r = validateAllConfigs().results.find((r) => r.file === "discord.json")!;
    expect(r.warnings.some((w) => w.toLowerCase().includes("deprecated") || w.includes("secrets"))).toBe(true);
  });

  it("guildId is not a string → warning", () => {
    setupDiscord(JSON.stringify({ guildId: 12345 }));
    const r = validateAllConfigs().results.find((r) => r.file === "discord.json")!;
    expect(r.warnings.some((w) => w.includes("guildId"))).toBe(true);
  });

  it("dmAllowFrom is not an array → warning", () => {
    setupDiscord(JSON.stringify({ dmAllowFrom: "user1" }));
    const r = validateAllConfigs().results.find((r) => r.file === "discord.json")!;
    expect(r.warnings.some((w) => w.includes("dmAllowFrom"))).toBe(true);
  });

  it("channels is not an object → warning", () => {
    setupDiscord(JSON.stringify({ channels: "tasks-channel" }));
    const r = validateAllConfigs().results.find((r) => r.file === "discord.json")!;
    expect(r.warnings.some((w) => w.includes("channels"))).toBe(true);
  });

  it("channelPolicies is a string (not an object) → warning", () => {
    // typeof "read-only" !== "object" → triggers warning
    // Note: arrays ARE objects, so use a string to trigger the warning
    setupDiscord(JSON.stringify({ channelPolicies: "read-only" }));
    const r = validateAllConfigs().results.find((r) => r.file === "discord.json")!;
    expect(r.warnings.some((w) => w.includes("channelPolicies"))).toBe(true);
  });

  it("discord.json does not exist → valid=false", () => {
    setupDiscord(false);
    const r = validateAllConfigs().results.find((r) => r.file === "discord.json")!;
    expect(r.valid).toBe(false);
  });

  it("discord.json invalid JSON → valid=false, 'Invalid JSON' error", () => {
    setupDiscord("{ broken");
    const r = validateAllConfigs().results.find((r) => r.file === "discord.json")!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("Invalid JSON"))).toBe(true);
  });
});

// ─── secrets/keys.json validation ────────────────────────────────────────────

describe("validateKeysConfig — new layout", () => {
  function setupKeys(keysJson: string | false) {
    mockNewLayout({ "secrets/keys.json": keysJson });
  }

  it("valid keys.json → valid=true, zero errors", () => {
    setupKeys(VALID_KEYS);
    const r = validateAllConfigs().results.find((r) => r.file.includes("keys.json"))!;
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("missing keys.json → warning (optional file)", () => {
    setupKeys(false);
    const r = validateAllConfigs().results.find((r) => r.file.includes("keys.json"))!;
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("pool value is not an array → error", () => {
    setupKeys(JSON.stringify({ openai: "sk-abc123" }));
    const r = validateAllConfigs().results.find((r) => r.file.includes("keys.json"))!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("openai"))).toBe(true);
  });

  it("pool is empty array → warning (valid=true)", () => {
    setupKeys(JSON.stringify({ openai: [] }));
    const r = validateAllConfigs().results.find((r) => r.file.includes("keys.json"))!;
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes("openai"))).toBe(true);
  });

  it("secrets.api_keys=true when keys.json is present", () => {
    setupKeys(VALID_KEYS);
    expect(validateAllConfigs().secrets.api_keys).toBe(true);
  });

  it("secrets.api_keys=false when keys.json is missing", () => {
    setupKeys(false);
    expect(validateAllConfigs().secrets.api_keys).toBe(false);
  });
});

// ─── secrets/discord-token.json validation ────────────────────────────────────

describe("validateDiscordToken — new layout", () => {
  function setupToken(tokenJson: string | false) {
    mockNewLayout({ "secrets/discord-token.json": tokenJson });
  }

  it("valid discord-token.json → valid=true, zero errors", () => {
    setupToken(VALID_TOKEN);
    const r = validateAllConfigs().results.find((r) => r.file.includes("discord-token.json"))!;
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("missing discord-token.json → warning only (Discord disabled)", () => {
    setupToken(false);
    const r = validateAllConfigs().results.find((r) => r.file.includes("discord-token"))!;
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.toLowerCase().includes("disabled"))).toBe(true);
  });

  it("botToken field missing → error", () => {
    setupToken(JSON.stringify({ guildId: "123" }));
    const r = validateAllConfigs().results.find((r) => r.file.includes("discord-token.json"))!;
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("botToken"))).toBe(true);
  });

  it("botToken is not a string → error", () => {
    setupToken(JSON.stringify({ botToken: 42 }));
    const r = validateAllConfigs().results.find((r) => r.file.includes("discord-token.json"))!;
    expect(r.valid).toBe(false);
  });

  it("secrets.discord_token=true when token file present", () => {
    setupToken(VALID_TOKEN);
    expect(validateAllConfigs().secrets.discord_token).toBe(true);
  });

  it("secrets.discord_token=false when token file missing", () => {
    setupToken(false);
    expect(validateAllConfigs().secrets.discord_token).toBe(false);
  });
});

// ─── Legacy layout detection ──────────────────────────────────────────────────

describe("validateAllConfigs — legacy layout", () => {
  it("detects legacy layout when old keys.json exists and secrets/keys.json does not", () => {
    mockLegacyLayout();
    const result = validateAllConfigs();
    expect(result.legacy_layout).toBe(true);
  });

  it("does NOT detect legacy layout when secrets/keys.json exists", () => {
    mockNewLayout(); // new layout: secrets/keys.json present
    expect(validateAllConfigs().legacy_layout).toBe(false);
  });

  it("keys.json in legacy layout produces a warning about migrating", () => {
    mockLegacyLayout();
    const r = validateAllConfigs().results.find((r) => r.file.includes("keys.json"))!;
    expect(r.warnings.some((w) => w.toLowerCase().includes("legacy") || w.toLowerCase().includes("migrate"))).toBe(true);
  });

  it("secrets.api_keys=true in legacy layout when keys.json exists", () => {
    mockLegacyLayout();
    expect(validateAllConfigs().secrets.api_keys).toBe(true);
  });
});

// ─── AllConfigsResult shape contract ─────────────────────────────────────────

describe("validateAllConfigs — result shape", () => {
  beforeEach(() => {
    existsSync.mockReturnValue(false);
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
  });

  it("always returns an object with valid/results/secrets/legacy_layout fields", () => {
    const r = validateAllConfigs();
    expect(r).toHaveProperty("valid");
    expect(r).toHaveProperty("results");
    expect(r).toHaveProperty("secrets");
    expect(r).toHaveProperty("legacy_layout");
  });

  it("secrets has discord_token and api_keys booleans", () => {
    const r = validateAllConfigs();
    expect(typeof r.secrets.discord_token).toBe("boolean");
    expect(typeof r.secrets.api_keys).toBe("boolean");
  });

  it("results is always an array", () => {
    expect(Array.isArray(validateAllConfigs().results)).toBe(true);
  });

  it("each result has file/valid/errors/warnings", () => {
    for (const r of validateAllConfigs().results) {
      expect(r).toHaveProperty("file");
      expect(r).toHaveProperty("valid");
      expect(Array.isArray(r.errors)).toBe(true);
      expect(Array.isArray(r.warnings)).toBe(true);
    }
  });

  it("valid=false when any result has errors (no files → errors)", () => {
    expect(validateAllConfigs().valid).toBe(false);
  });
});

// ─── printValidationResults ───────────────────────────────────────────────────

describe("printValidationResults()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { logSpy = vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  function makeResult(overrides: Partial<AllConfigsResult> = {}): AllConfigsResult {
    return {
      valid: true,
      results: [],
      secrets: { discord_token: true, api_keys: true },
      legacy_layout: false,
      ...overrides,
    };
  }

  it("does not throw with valid result", () => {
    expect(() => printValidationResults(makeResult())).not.toThrow();
  });

  it("does not throw with errors and warnings", () => {
    const r = makeResult({
      valid: false,
      results: [{
        file: "models.json",
        valid: false,
        errors: ["Missing tiers"],
        warnings: ["Unknown tier: ultra"],
      }],
    });
    expect(() => printValidationResults(r)).not.toThrow();
  });

  it("logs 'LEGACY' warning when legacy_layout=true", () => {
    const logLines: string[] = [];
    logSpy.mockImplementation((...args) => { logLines.push(args.join(" ")); });
    printValidationResults(makeResult({ legacy_layout: true, valid: false }));
    expect(logLines.some((l) => l.includes("LEGACY"))).toBe(true);
  });

  it("does NOT log 'LEGACY' when legacy_layout=false", () => {
    const logLines: string[] = [];
    logSpy.mockImplementation((...args) => { logLines.push(args.join(" ")); });
    printValidationResults(makeResult({ legacy_layout: false }));
    expect(logLines.some((l) => l.includes("LEGACY"))).toBe(false);
  });

  it("logs 'All configs valid' when valid=true", () => {
    const logLines: string[] = [];
    logSpy.mockImplementation((...args) => { logLines.push(args.join(" ")); });
    printValidationResults(makeResult({ valid: true }));
    expect(logLines.some((l) => l.includes("All configs valid"))).toBe(true);
  });

  it("logs error indicator when a result has errors", () => {
    const logLines: string[] = [];
    logSpy.mockImplementation((...args) => { logLines.push(args.join(" ")); });
    printValidationResults(makeResult({
      valid: false,
      results: [{ file: "x.json", valid: false, errors: ["Bad format"], warnings: [] }],
    }));
    expect(logLines.some((l) => l.includes("Bad format"))).toBe(true);
  });

  it("logs warnings when a result has warnings", () => {
    const logLines: string[] = [];
    logSpy.mockImplementation((...args) => { logLines.push(args.join(" ")); });
    printValidationResults(makeResult({
      results: [{ file: "x.json", valid: true, errors: [], warnings: ["Some warning"] }],
    }));
    expect(logLines.some((l) => l.includes("Some warning"))).toBe(true);
  });

  it("shows discord_token presence in output", () => {
    const logLines: string[] = [];
    logSpy.mockImplementation((...args) => { logLines.push(args.join(" ")); });
    printValidationResults(makeResult({ secrets: { discord_token: true, api_keys: false } }));
    expect(logLines.some((l) => l.toLowerCase().includes("discord") && l.includes("✓"))).toBe(true);
  });

  it("shows api_keys missing when absent", () => {
    const logLines: string[] = [];
    logSpy.mockImplementation((...args) => { logLines.push(args.join(" ")); });
    printValidationResults(makeResult({ secrets: { discord_token: false, api_keys: false } }));
    expect(logLines.some((l) => l.toLowerCase().includes("api keys") || l.toLowerCase().includes("api_keys"))).toBe(true);
  });
});
