/**
 * Config validation — validate all config files on startup or via CLI.
 * 
 * Layout:
 *   ~/.lobs/config/              ← committable config (models, discord, lobs.json)
 *   ~/.lobs/config/secrets/      ← gitignored secrets (keys, discord-token)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const HOME = process.env.HOME ?? "";
const CONFIG_DIR = resolve(HOME, ".lobs/config");
const SECRETS_DIR = resolve(CONFIG_DIR, "secrets");

export interface ValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface AllConfigsResult {
  valid: boolean;
  results: ValidationResult[];
  secrets: {
    discord_token: boolean;
    api_keys: boolean;
  };
  legacy_layout: boolean;
}

function validateJson(path: string): { valid: boolean; data?: any; error?: string } {
  if (!existsSync(path)) {
    return { valid: false, error: "File does not exist" };
  }
  try {
    const content = readFileSync(path, "utf-8");
    const data = JSON.parse(content);
    return { valid: true, data };
  } catch (err) {
    return { valid: false, error: `Invalid JSON: ${String(err)}` };
  }
}

function validateModelsConfig(path: string): ValidationResult {
  const result: ValidationResult = {
    file: "models.json",
    valid: true,
    errors: [],
    warnings: [],
  };

  const parsed = validateJson(path);
  if (!parsed.valid) {
    result.valid = false;
    result.errors.push(parsed.error!);
    return result;
  }

  const data = parsed.data;

  // Check tiers
  if (!data.tiers || typeof data.tiers !== "object") {
    result.errors.push("Missing or invalid 'tiers' object");
    result.valid = false;
  } else {
    const requiredTiers = ["micro", "small", "medium", "standard", "strong"];
    for (const tier of requiredTiers) {
      if (!data.tiers[tier] || typeof data.tiers[tier] !== "string") {
        result.errors.push(`Tier '${tier}' is missing or not a string`);
        result.valid = false;
      }
    }
    
    // Unknown tier keys (warning only)
    for (const key of Object.keys(data.tiers)) {
      if (!requiredTiers.includes(key)) {
        result.warnings.push(`Unknown tier key: '${key}'`);
      }
    }
  }

  // Check agents
  if (!data.agents || typeof data.agents !== "object") {
    result.errors.push("Missing or invalid 'agents' object");
    result.valid = false;
  } else {
    for (const [agentType, config] of Object.entries(data.agents)) {
      if (typeof config !== "object" || config === null) {
        result.errors.push(`Agent '${agentType}' config is not an object`);
        result.valid = false;
        continue;
      }

      const agentConfig = config as any;
      if (!agentConfig.primary || typeof agentConfig.primary !== "string") {
        result.errors.push(`Agent '${agentType}' missing or invalid 'primary' model`);
        result.valid = false;
      }

      if (agentConfig.fallbacks) {
        if (!Array.isArray(agentConfig.fallbacks)) {
          result.errors.push(`Agent '${agentType}' fallbacks is not an array`);
          result.valid = false;
        } else if (agentConfig.fallbacks.length === 0) {
          result.warnings.push(`Agent '${agentType}' has empty fallbacks array`);
        }
      }
    }
  }

  // Check local config (optional)
  if (data.local) {
    if (typeof data.local !== "object") {
      result.errors.push("'local' config is not an object");
      result.valid = false;
    } else {
      if (!data.local.baseUrl || typeof data.local.baseUrl !== "string") {
        result.warnings.push("'local.baseUrl' missing or invalid");
      }
      if (!data.local.chatModel || typeof data.local.chatModel !== "string") {
        result.warnings.push("'local.chatModel' missing or invalid");
      }
    }
  }

  return result;
}

function validateDiscordConfig(path: string): ValidationResult {
  const result: ValidationResult = {
    file: "discord.json",
    valid: true,
    errors: [],
    warnings: [],
  };

  const parsed = validateJson(path);
  if (!parsed.valid) {
    result.valid = false;
    result.errors.push(parsed.error!);
    return result;
  }

  const data = parsed.data;

  // botToken should NOT be in discord.json anymore
  if (data.botToken) {
    result.warnings.push("botToken found in discord.json — should be in secrets/discord-token.json (deprecated layout)");
  }

  // Check optional fields
  if (data.guildId && typeof data.guildId !== "string") {
    result.warnings.push("'guildId' is not a string");
  }

  if (data.dmAllowFrom && !Array.isArray(data.dmAllowFrom)) {
    result.warnings.push("'dmAllowFrom' is not an array");
  }

  if (data.channels) {
    if (typeof data.channels !== "object") {
      result.warnings.push("'channels' is not an object");
    }
  }

  if (data.channelPolicies) {
    if (typeof data.channelPolicies !== "object") {
      result.warnings.push("'channelPolicies' is not an object");
    }
  }

  return result;
}

function validateKeysConfig(path: string, isLegacy: boolean): ValidationResult {
  const result: ValidationResult = {
    file: isLegacy ? "keys.json (legacy)" : "secrets/keys.json",
    valid: true,
    errors: [],
    warnings: [],
  };

  const parsed = validateJson(path);
  if (!parsed.valid) {
    // keys.json is optional
    result.warnings.push("File does not exist (optional)");
    return result;
  }

  if (isLegacy) {
    result.warnings.push("Using legacy layout — migrate secrets to secrets/ directory");
  }

  const data = parsed.data;

  if (typeof data !== "object" || data === null) {
    result.errors.push("Root must be an object");
    result.valid = false;
    return result;
  }

  // Each pool should have at least one key
  for (const [pool, keys] of Object.entries(data)) {
    if (!Array.isArray(keys)) {
      result.errors.push(`Pool '${pool}' is not an array`);
      result.valid = false;
    } else if (keys.length === 0) {
      result.warnings.push(`Pool '${pool}' has no keys`);
    }
  }

  return result;
}

function validateDiscordToken(path: string, isLegacy: boolean): ValidationResult {
  const result: ValidationResult = {
    file: isLegacy ? "discord.json (legacy botToken)" : "secrets/discord-token.json",
    valid: true,
    errors: [],
    warnings: [],
  };

  if (isLegacy) {
    // Token is in discord.json
    const parsed = validateJson(resolve(CONFIG_DIR, "discord.json"));
    if (!parsed.valid || !parsed.data?.botToken) {
      result.warnings.push("No botToken found (Discord disabled)");
      return result;
    }
    result.warnings.push("Using legacy layout — migrate botToken to secrets/discord-token.json");
    return result;
  }

  // Check secrets/discord-token.json
  const parsed = validateJson(path);
  if (!parsed.valid) {
    result.warnings.push("File does not exist (Discord disabled)");
    return result;
  }

  const data = parsed.data;
  if (!data.botToken || typeof data.botToken !== "string") {
    result.errors.push("Missing or invalid 'botToken' field");
    result.valid = false;
  }

  return result;
}

export function validateAllConfigs(): AllConfigsResult {
  const results: ValidationResult[] = [];

  // Check which layout we're using
  const newSecretsDir = existsSync(SECRETS_DIR);
  const oldKeysPath = resolve(CONFIG_DIR, "keys.json");
  const oldKeysExist = existsSync(oldKeysPath);
  const newKeysPath = resolve(SECRETS_DIR, "keys.json");
  const newKeysExist = existsSync(newKeysPath);
  const newTokenPath = resolve(SECRETS_DIR, "discord-token.json");
  const newTokenExist = existsSync(newTokenPath);
  
  // Legacy layout if old keys exist and new ones don't
  const legacyLayout = oldKeysExist && !newKeysExist;

  // Validate committable configs
  results.push(validateModelsConfig(resolve(CONFIG_DIR, "models.json")));
  results.push(validateDiscordConfig(resolve(CONFIG_DIR, "discord.json")));

  // Validate secrets (check both old and new locations)
  if (legacyLayout) {
    results.push(validateKeysConfig(oldKeysPath, true));
    results.push(validateDiscordToken("", true));
  } else {
    results.push(validateKeysConfig(newKeysPath, false));
    results.push(validateDiscordToken(newTokenPath, false));
  }

  const valid = results.every(r => r.valid);

  return {
    valid,
    results,
    secrets: {
      discord_token: newTokenExist || (legacyLayout && existsSync(resolve(CONFIG_DIR, "discord.json"))),
      api_keys: newKeysExist || oldKeysExist,
    },
    legacy_layout: legacyLayout,
  };
}

export function printValidationResults(result: AllConfigsResult): void {
  console.log("=== Config Validation ===\n");

  if (result.legacy_layout) {
    console.log("⚠️  Using LEGACY layout — secrets are in config root");
    console.log("    Run 'lobs init' to create the new secrets/ directory\n");
  }

  for (const r of result.results) {
    const status = r.valid ? "✓" : "✗";
    console.log(`${status} ${r.file}`);

    if (r.errors.length > 0) {
      console.log("  Errors:");
      for (const err of r.errors) {
        console.log(`    - ${err}`);
      }
    }

    if (r.warnings.length > 0) {
      console.log("  Warnings:");
      for (const warn of r.warnings) {
        console.log(`    - ${warn}`);
      }
    }

    console.log("");
  }

  console.log("Secrets status:");
  console.log(`  Discord token: ${result.secrets.discord_token ? "✓ present" : "✗ missing"}`);
  console.log(`  API keys:      ${result.secrets.api_keys ? "✓ present" : "✗ missing"}`);
  console.log("");

  console.log(result.valid ? "All configs valid ✓" : "Some configs have errors ✗");
}
