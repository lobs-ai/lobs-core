/**
 * Multi-key OAuth configuration for LLM providers.
 * Supports loading from JSON config file or environment variables.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface KeyEntry {
  key: string;
  label?: string;
}

export interface KeyPool {
  keys: KeyEntry[];
  strategy: "sticky-failover";
}

export interface KeyConfig {
  anthropic?: KeyPool;
  openai?: KeyPool;
  openrouter?: KeyPool;
}

// ── Config Loading ───────────────────────────────────────────────────────────

const CONFIG_DIR = resolve(process.env.HOME ?? "~", ".lobs", "config");
const NEW_KEYS_PATH = resolve(CONFIG_DIR, "secrets", "keys.json");
const LEGACY_KEYS_PATH = resolve(CONFIG_DIR, "keys.json");

/**
 * Load key config from secrets/keys.json (new layout) or keys.json (legacy).
 */
function loadConfigFile(): KeyConfig | undefined {
  // Try new layout first
  if (existsSync(NEW_KEYS_PATH)) {
    try {
      const data = JSON.parse(readFileSync(NEW_KEYS_PATH, "utf-8"));
      return data as KeyConfig;
    } catch (error) {
      console.warn(`Failed to load keys config from ${NEW_KEYS_PATH}:`, error);
      return undefined;
    }
  }

  // Fall back to legacy layout
  if (existsSync(LEGACY_KEYS_PATH)) {
    console.warn("[keys] DEPRECATED: keys.json in config root — migrate to secrets/keys.json");
    try {
      const data = JSON.parse(readFileSync(LEGACY_KEYS_PATH, "utf-8"));
      return data as KeyConfig;
    } catch (error) {
      console.warn(`Failed to load keys config from ${LEGACY_KEYS_PATH}:`, error);
      return undefined;
    }
  }

  return undefined;
}

/**
 * Parse comma-separated keys from environment variable.
 * Example: ANTHROPIC_API_KEYS=sk-ant-xxx,sk-ant-yyy
 */
function parseEnvKeys(envVar: string): KeyEntry[] | undefined {
  const value = process.env[envVar];
  if (!value) return undefined;

  const keys = value.split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return undefined;

  return keys.map((key, idx) => ({
    key,
    label: `env-${idx + 1}`,
  }));
}

/**
 * Load all key pools from config file + environment variables.
 * Environment variables take precedence over config file.
 */
export function loadKeyConfig(): KeyConfig {
  const fileConfig = loadConfigFile() ?? {};
  const config: KeyConfig = { ...fileConfig };

  // Environment variables (plural form) override config file
  const anthropicKeys = parseEnvKeys("ANTHROPIC_API_KEYS");
  if (anthropicKeys) {
    config.anthropic = { keys: anthropicKeys, strategy: "sticky-failover" };
  }

  const openaiKeys = parseEnvKeys("OPENAI_API_KEYS");
  if (openaiKeys) {
    config.openai = { keys: openaiKeys, strategy: "sticky-failover" };
  }

  const openrouterKeys = parseEnvKeys("OPENROUTER_API_KEYS");
  if (openrouterKeys) {
    config.openrouter = { keys: openrouterKeys, strategy: "sticky-failover" };
  }

  return config;
}
