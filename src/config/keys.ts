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
  "openai-codex"?: KeyPool;
  openrouter?: KeyPool;
}

// ── Config Loading ───────────────────────────────────────────────────────────

const CONFIG_DIR = resolve(process.env.HOME ?? "~", ".lobs", "config");
const NEW_KEYS_PATH = resolve(CONFIG_DIR, "secrets", "keys.json");
const LEGACY_KEYS_PATH = resolve(CONFIG_DIR, "keys.json");

/**
 * Load key config from secrets/keys.json (new layout) or keys.json (legacy).
 */
function normalizeKeyEntries(entries: unknown): KeyEntry[] {
  if (!Array.isArray(entries)) return [];

  const normalized: Array<KeyEntry | undefined> = entries.map((entry, idx) => {
      if (typeof entry === "string") {
        const key = entry.trim();
        return key ? { key, label: `key-${idx + 1}` } : undefined;
      }

      if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
        const key = (entry as { key: string }).key.trim();
        if (!key) return undefined;
        const label = typeof (entry as { label?: unknown }).label === "string"
          ? (entry as { label?: string }).label
          : undefined;
        return { key, label };
      }

      return undefined;
    });

  return normalized.filter((entry): entry is KeyEntry => entry !== undefined);
}

function dedupeKeyEntries(entries: KeyEntry[], provider?: string): KeyEntry[] {
  const seen = new Set<string>();
  const deduped: KeyEntry[] = [];

  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    deduped.push(entry);
  }

  if (provider && deduped.length !== entries.length) {
    console.warn(`[keys] Removed ${entries.length - deduped.length} duplicate ${provider} key entr${entries.length - deduped.length === 1 ? "y" : "ies"}`);
  }

  return deduped;
}

function normalizePool(pool: unknown): KeyPool | undefined {
  // Current format: { keys: [...], strategy: "sticky-failover" }
  if (pool && typeof pool === "object" && Array.isArray((pool as { keys?: unknown }).keys)) {
    const keys = dedupeKeyEntries(normalizeKeyEntries((pool as { keys: unknown }).keys));
    if (keys.length === 0) return undefined;
    return { keys, strategy: "sticky-failover" };
  }

  // Legacy/init format: [ { key, label } ] or [ "sk-..." ]
  const keys = dedupeKeyEntries(normalizeKeyEntries(pool));
  if (keys.length === 0) return undefined;
  return { keys, strategy: "sticky-failover" };
}

export function normalizeKeyConfig(data: unknown): KeyConfig {
  if (!data || typeof data !== "object") return {};

  const raw = data as Record<string, unknown>;
  const config: KeyConfig = {};

  const anthropic = normalizePool(raw.anthropic);
  if (anthropic) config.anthropic = anthropic;

  const openai = normalizePool(raw.openai);
  if (openai) config.openai = openai;

  const openaiCodex = normalizePool(raw["openai-codex"]);
  if (openaiCodex) config["openai-codex"] = openaiCodex;

  const openrouter = normalizePool(raw.openrouter);
  if (openrouter) config.openrouter = openrouter;

  return config;
}

function loadConfigFile(): KeyConfig | undefined {
  // Try new layout first
  if (existsSync(NEW_KEYS_PATH)) {
    try {
      const data = JSON.parse(readFileSync(NEW_KEYS_PATH, "utf-8"));
      return normalizeKeyConfig(data);
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
      return normalizeKeyConfig(data);
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
    config.anthropic = { keys: dedupeKeyEntries(anthropicKeys, "anthropic"), strategy: "sticky-failover" };
  }

  const openaiKeys = parseEnvKeys("OPENAI_API_KEYS");
  if (openaiKeys) {
    config.openai = { keys: dedupeKeyEntries(openaiKeys, "openai"), strategy: "sticky-failover" };
  }

  const openrouterKeys = parseEnvKeys("OPENROUTER_API_KEYS");
  if (openrouterKeys) {
    config.openrouter = { keys: dedupeKeyEntries(openrouterKeys, "openrouter"), strategy: "sticky-failover" };
  }

  const codexKeys = parseEnvKeys("OPENAI_CODEX_TOKENS");
  if (codexKeys) {
    config["openai-codex"] = { keys: dedupeKeyEntries(codexKeys, "openai-codex"), strategy: "sticky-failover" };
  }

  return config;
}
