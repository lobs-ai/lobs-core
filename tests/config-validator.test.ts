/**
 * Tests for src/config/validator.ts
 *
 * Validates config files on startup.
 * The fs module is mocked so no real files are touched.
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

// ── Imports ────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import {
  validateAllConfigs,
  type AllConfigsResult,
  type ValidationResult,
} from "../src/config/validator.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

/** Build a valid models.json object */
function validModels() {
  return {
    tiers: {
      micro: "claude-haiku-3",
      small: "claude-haiku-3-5",
      medium: "claude-sonnet-3-5",
      standard: "claude-sonnet-3-7",
      strong: "claude-opus-4",
    },
    agents: {
      programmer: { primary: "claude-sonnet-3-7", fallbacks: ["claude-sonnet-3-5"] },
      writer: { primary: "claude-sonnet-3-5" },
    },
  };
}

/** Build a valid discord.json object */
function validDiscord() {
  return {
    guildId: "123456789",
    dmAllowFrom: ["user1"],
    channels: { general: "987654321" },
    channelPolicies: {},
  };
}

/** Build a valid keys.json (secrets) */
function validKeys() {
  return {
    anthropic: ["sk-ant-abc123"],
    openai: ["sk-openai-xyz"],
  };
}

/** Build a valid discord-token.json */
function validDiscordToken() {
  return { botToken: "Bot.DISCORD.TOKEN.HERE" };
}

/**
 * Configure the mocks so that all required files exist and are valid.
 * Uses the new secrets/ layout (not legacy).
 */
function setupValidNewLayout() {
  const home = process.env.HOME ?? "";
  const configDir = `${home}/.lobs/config`;
  const secretsDir = `${configDir}/secrets`;

  mockExistsSync.mockImplementation((p: unknown) => {
    const path = p as string;
    // secrets/ dir exists
    if (path === secretsDir) return true;
    // new layout secrets exist
    if (path === `${secretsDir}/keys.json`) return true;
    if (path === `${secretsDir}/discord-token.json`) return true;
    // old layout does NOT exist
    if (path === `${configDir}/keys.json`) return false;
    // config files exist
    if (path === `${configDir}/models.json`) return true;
    if (path === `${configDir}/discord.json`) return true;
    return false;
  });

  mockReadFileSync.mockImplementation((p: unknown) => {
    const path = p as string;
    if ((path as string).endsWith("models.json")) return JSON.stringify(validModels());
    if ((path as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
    if ((path as string).endsWith("keys.json")) return JSON.stringify(validKeys());
    if ((path as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
    throw new Error(`Unexpected readFileSync call: ${path}`);
  });
}

// ── validateAllConfigs — happy path ───────────────────────────────────────────

describe("validateAllConfigs — valid new-layout configs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidNewLayout();
  });

  it("returns valid:true overall", () => {
    const result = validateAllConfigs();
    expect(result.valid).toBe(true);
  });

  it("detects the new (non-legacy) layout", () => {
    const result = validateAllConfigs();
    expect(result.legacy_layout).toBe(false);
  });

  it("reports api_keys as present", () => {
    const result = validateAllConfigs();
    expect(result.secrets.api_keys).toBe(true);
  });

  it("reports discord_token as present", () => {
    const result = validateAllConfigs();
    expect(result.secrets.discord_token).toBe(true);
  });

  it("returns four ValidationResult entries", () => {
    const result = validateAllConfigs();
    expect(result.results).toHaveLength(4);
  });

  it("all result entries have valid:true", () => {
    const result = validateAllConfigs();
    for (const r of result.results) {
      expect(r.valid).toBe(true);
    }
  });

  it("includes models.json in results", () => {
    const result = validateAllConfigs();
    const files = result.results.map(r => r.file);
    expect(files).toContain("models.json");
  });

  it("includes discord.json in results", () => {
    const result = validateAllConfigs();
    const files = result.results.map(r => r.file);
    expect(files).toContain("discord.json");
  });
});

// ── models.json validation ─────────────────────────────────────────────────────

describe("models.json validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidNewLayout();
  });

  it("is invalid when models.json does not exist", () => {
    const home = process.env.HOME ?? "";
    mockExistsSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return false;
      // re-use helper logic for everything else
      const path = p as string;
      const configDir = `${home}/.lobs/config`;
      const secretsDir = `${configDir}/secrets`;
      if (path === secretsDir) return true;
      if (path.endsWith("keys.json")) return true;
      if (path.endsWith("discord-token.json")) return true;
      if (path.endsWith("discord.json")) return true;
      if (path === `${configDir}/keys.json`) return false;
      return false;
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.valid).toBe(false);
    expect(modelsResult.errors.some(e => e.includes("does not exist"))).toBe(true);
  });

  it("is invalid when models.json contains invalid JSON", () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return "{ not valid json }}}";
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.valid).toBe(false);
    expect(modelsResult.errors.some(e => e.includes("Invalid JSON"))).toBe(true);
  });

  it("is invalid when tiers is missing", () => {
    const broken = { ...validModels(), tiers: undefined };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(broken);
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.valid).toBe(false);
    expect(modelsResult.errors.some(e => e.includes("tiers"))).toBe(true);
  });

  it("is invalid when a required tier is missing", () => {
    const tiersWithoutStrong = { ...validModels().tiers } as Record<string, unknown>;
    delete tiersWithoutStrong["strong"];
    const broken = { ...validModels(), tiers: tiersWithoutStrong };

    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(broken);
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.valid).toBe(false);
    expect(modelsResult.errors.some(e => e.includes("strong"))).toBe(true);
  });

  it("warns about unknown tier keys but stays valid", () => {
    const withExtra = {
      ...validModels(),
      tiers: { ...validModels().tiers, experimental: "claude-sonnet-5" },
    };

    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(withExtra);
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.valid).toBe(true);
    expect(modelsResult.warnings.some(w => w.includes("experimental"))).toBe(true);
  });

  it("is invalid when agents object is missing", () => {
    const broken = { tiers: validModels().tiers }; // no agents
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(broken);
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.valid).toBe(false);
    expect(modelsResult.errors.some(e => e.includes("agents"))).toBe(true);
  });

  it("is invalid when an agent config has no primary model", () => {
    const broken = {
      ...validModels(),
      agents: {
        programmer: { fallbacks: ["claude-haiku"] }, // missing primary
      },
    };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(broken);
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.valid).toBe(false);
    expect(modelsResult.errors.some(e => e.includes("programmer") && e.includes("primary"))).toBe(true);
  });

  it("is invalid when an agent's fallbacks is not an array", () => {
    const broken = {
      ...validModels(),
      agents: {
        programmer: { primary: "claude-sonnet", fallbacks: "not-an-array" },
      },
    };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(broken);
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.valid).toBe(false);
    expect(modelsResult.errors.some(e => e.includes("fallbacks"))).toBe(true);
  });

  it("warns about empty fallbacks array", () => {
    const withEmpty = {
      ...validModels(),
      agents: {
        programmer: { primary: "claude-sonnet", fallbacks: [] },
      },
    };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(withEmpty);
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.valid).toBe(true);
    expect(modelsResult.warnings.some(w => w.includes("empty fallbacks"))).toBe(true);
  });

  it("warns about missing local.baseUrl when local config is present", () => {
    const withLocal = {
      ...validModels(),
      local: { chatModel: "qwen3" }, // missing baseUrl
    };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(withLocal);
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const modelsResult = result.results.find(r => r.file === "models.json")!;
    expect(modelsResult.warnings.some(w => w.includes("baseUrl"))).toBe(true);
  });
});

// ── discord.json validation ────────────────────────────────────────────────────

describe("discord.json validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidNewLayout();
  });

  it("is valid with a minimal discord.json (no required fields)", () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify({});
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const discordResult = result.results.find(r => r.file === "discord.json")!;
    expect(discordResult.valid).toBe(true);
    expect(discordResult.errors).toHaveLength(0);
  });

  it("warns when botToken is found directly in discord.json", () => {
    const discordWithToken = { ...validDiscord(), botToken: "Bot.token.here" };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(discordWithToken);
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const discordResult = result.results.find(r => r.file === "discord.json")!;
    expect(discordResult.valid).toBe(true); // still valid — just deprecated
    expect(discordResult.warnings.some(w => w.includes("botToken"))).toBe(true);
  });

  it("warns when guildId is not a string", () => {
    const badDiscord = { ...validDiscord(), guildId: 12345 };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(badDiscord);
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const discordResult = result.results.find(r => r.file === "discord.json")!;
    expect(discordResult.warnings.some(w => w.includes("guildId"))).toBe(true);
  });

  it("warns when dmAllowFrom is not an array", () => {
    const badDiscord = { ...validDiscord(), dmAllowFrom: "user1" };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(badDiscord);
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const discordResult = result.results.find(r => r.file === "discord.json")!;
    expect(discordResult.warnings.some(w => w.includes("dmAllowFrom"))).toBe(true);
  });

  it("is invalid when discord.json does not exist", () => {
    const home = process.env.HOME ?? "";
    mockExistsSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("discord.json")) return false;
      const path = p as string;
      const configDir = `${home}/.lobs/config`;
      const secretsDir = `${configDir}/secrets`;
      if (path === secretsDir) return true;
      if (path.endsWith("keys.json")) return true;
      if (path.endsWith("discord-token.json")) return true;
      if (path.endsWith("models.json")) return true;
      if (path === `${configDir}/keys.json`) return false;
      return false;
    });

    const result = validateAllConfigs();
    const discordResult = result.results.find(r => r.file === "discord.json")!;
    expect(discordResult.valid).toBe(false);
  });
});

// ── secrets/keys.json validation ──────────────────────────────────────────────

describe("secrets/keys.json validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidNewLayout();
  });

  it("warns (but stays valid) when keys.json does not exist", () => {
    const home = process.env.HOME ?? "";
    mockExistsSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("keys.json")) return false;
      const path = p as string;
      const configDir = `${home}/.lobs/config`;
      const secretsDir = `${configDir}/secrets`;
      if (path === secretsDir) return true;
      if (path.endsWith("discord-token.json")) return true;
      if (path.endsWith("models.json")) return true;
      if (path.endsWith("discord.json")) return true;
      return false;
    });

    const result = validateAllConfigs();
    const keysResult = result.results.find(r => r.file === "secrets/keys.json")!;
    expect(keysResult.valid).toBe(true);
    expect(keysResult.warnings.length).toBeGreaterThan(0);
  });

  it("is invalid when a pool contains non-array value", () => {
    const badKeys = { anthropic: "not-an-array" };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(badKeys);
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const keysResult = result.results.find(r => r.file === "secrets/keys.json")!;
    expect(keysResult.valid).toBe(false);
    expect(keysResult.errors.some(e => e.includes("not an array"))).toBe(true);
  });

  it("warns about empty key pools", () => {
    const emptyPool = { anthropic: [] };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(emptyPool);
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const keysResult = result.results.find(r => r.file === "secrets/keys.json")!;
    expect(keysResult.warnings.some(w => w.includes("no keys"))).toBe(true);
  });
});

// ── secrets/discord-token.json validation ─────────────────────────────────────

describe("secrets/discord-token.json validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidNewLayout();
  });

  it("warns (but stays valid) when discord-token.json does not exist", () => {
    const home = process.env.HOME ?? "";
    mockExistsSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("discord-token.json")) return false;
      const path = p as string;
      const configDir = `${home}/.lobs/config`;
      const secretsDir = `${configDir}/secrets`;
      if (path === secretsDir) return true;
      if (path.endsWith("keys.json")) return true;
      if (path.endsWith("models.json")) return true;
      if (path.endsWith("discord.json")) return true;
      if (path === `${configDir}/keys.json`) return false;
      return false;
    });

    const result = validateAllConfigs();
    const tokenResult = result.results.find(r => r.file === "secrets/discord-token.json")!;
    expect(tokenResult.valid).toBe(true);
    expect(tokenResult.warnings.some(w => w.includes("Discord disabled"))).toBe(true);
  });

  it("is invalid when botToken field is missing from discord-token.json", () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify({ wrongField: "xxx" });
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const tokenResult = result.results.find(r => r.file === "secrets/discord-token.json")!;
    expect(tokenResult.valid).toBe(false);
    expect(tokenResult.errors.some(e => e.includes("botToken"))).toBe(true);
  });

  it("is invalid when botToken is not a string", () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify({ botToken: 42 });
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    const tokenResult = result.results.find(r => r.file === "secrets/discord-token.json")!;
    expect(tokenResult.valid).toBe(false);
  });
});

// ── Legacy layout detection ────────────────────────────────────────────────────

describe("legacy layout detection", () => {
  it("detects legacy layout when old keys.json exists and new one does not", () => {
    const home = process.env.HOME ?? "";
    const configDir = `${home}/.lobs/config`;
    const secretsDir = `${configDir}/secrets`;

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = p as string;
      if (path === secretsDir) return false;
      if (path === `${configDir}/keys.json`) return true;   // old layout key
      if (path === `${secretsDir}/keys.json`) return false;  // new not present
      if (path === `${secretsDir}/discord-token.json`) return false;
      if (path.endsWith("models.json")) return true;
      if (path.endsWith("discord.json")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    expect(result.legacy_layout).toBe(true);
  });

  it("does not flag legacy layout when both old and new keys exist", () => {
    // When new keys exist — new layout regardless
    setupValidNewLayout();
    const result = validateAllConfigs();
    expect(result.legacy_layout).toBe(false);
  });
});

// ── overall validity and secrets summary ──────────────────────────────────────

describe("AllConfigsResult shape and aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidNewLayout();
  });

  it("overall valid is false when any result is invalid", () => {
    // Inject an invalid models config
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify({ /* no tiers/agents */ });
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    expect(result.valid).toBe(false);
  });

  it("api_keys is false when no keys files exist", () => {
    const home = process.env.HOME ?? "";
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = p as string;
      const configDir = `${home}/.lobs/config`;
      const secretsDir = `${configDir}/secrets`;
      if (path === secretsDir) return true;
      if (path.endsWith("keys.json")) return false; // neither old nor new
      if (path.endsWith("discord-token.json")) return true;
      if (path.endsWith("models.json")) return true;
      if (path.endsWith("discord.json")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord());
      if ((p as string).endsWith("discord-token.json")) return JSON.stringify(validDiscordToken());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    expect(result.secrets.api_keys).toBe(false);
  });

  it("discord_token is false when neither token source exists", () => {
    const home = process.env.HOME ?? "";
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = p as string;
      const configDir = `${home}/.lobs/config`;
      const secretsDir = `${configDir}/secrets`;
      if (path === secretsDir) return true;
      if (path.endsWith("keys.json")) return true;
      if (path.endsWith("discord-token.json")) return false;
      if (path.endsWith("models.json")) return true;
      if (path.endsWith("discord.json")) return true;
      if (path === `${configDir}/keys.json`) return false;
      return false;
    });
    mockReadFileSync.mockImplementation((p: unknown) => {
      if ((p as string).endsWith("models.json")) return JSON.stringify(validModels());
      if ((p as string).endsWith("discord.json")) return JSON.stringify(validDiscord()); // no botToken
      if ((p as string).endsWith("keys.json")) return JSON.stringify(validKeys());
      throw new Error(`Unexpected: ${p}`);
    });

    const result = validateAllConfigs();
    expect(result.secrets.discord_token).toBe(false);
  });
});
