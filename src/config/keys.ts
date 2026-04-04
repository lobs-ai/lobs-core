/**
 * Multi-key configuration for LLM providers.
 * Generic — any provider in keys.json is loaded automatically.
 * Keys are injected into process.env so providers.ts can find them.
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

/** Provider name → key pool. Any provider string is valid. */
export type KeyConfig = Record<string, KeyPool>;

// ── Provider → env var mapping ───────────────────────────────────────────────

/** Maps provider names to environment variable names for API keys. */
const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_CODEX_TOKEN",
  openrouter: "OPENROUTER_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "opencode-zen": "OPENCODE_API_KEY",
  "z-ai": "ZAI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  kimi: "KIMI_API_KEY",
};

/** Plural env vars that can hold comma-separated keys (override config file). */
const PROVIDER_PLURAL_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEYS",
  openai: "OPENAI_API_KEYS",
  openrouter: "OPENROUTER_API_KEYS",
  "openai-codex": "OPENAI_CODEX_TOKENS",
};

/** Get the env var name for a provider. Falls back to PROVIDER_API_KEY pattern. */
export function getEnvKeyForProvider(provider: string): string {
  return PROVIDER_ENV_MAP[provider] ??
    `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

// ── Config Loading ───────────────────────────────────────────────────────────

const CONFIG_DIR = resolve(process.env.HOME ?? "~", ".lobs", "config");
const NEW_KEYS_PATH = resolve(CONFIG_DIR, "secrets", "keys.json");
const LEGACY_KEYS_PATH = resolve(CONFIG_DIR, "keys.json");

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

/** Normalize raw JSON into KeyConfig. Reads ALL providers, not a hardcoded list. */
export function normalizeKeyConfig(data: unknown): KeyConfig {
  if (!data || typeof data !== "object") return {};

  const raw = data as Record<string, unknown>;
  const config: KeyConfig = {};

  for (const [provider, poolData] of Object.entries(raw)) {
    const pool = normalizePool(poolData);
    if (pool) {
      config[provider] = pool;
    }
  }

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
 * Plural env vars (e.g. ANTHROPIC_API_KEYS) override config file.
 * After loading, injects first key of each provider into process.env
 * so providers.ts can resolve keys via process.env fallback.
 */
export function loadKeyConfig(): KeyConfig {
  const fileConfig = loadConfigFile() ?? {};
  const config: KeyConfig = { ...fileConfig };

  // Plural environment variables override config file
  for (const [provider, envVar] of Object.entries(PROVIDER_PLURAL_ENV)) {
    const keys = parseEnvKeys(envVar);
    if (keys) {
      config[provider] = { keys: dedupeKeyEntries(keys, provider), strategy: "sticky-failover" };
    }
  }

  // Inject first key of each provider into process.env so createClient() can find them
  for (const [provider, pool] of Object.entries(config)) {
    if (pool.keys.length > 0 && pool.keys[0].key) {
      const envKey = getEnvKeyForProvider(provider);
      if (!process.env[envKey]) {
        process.env[envKey] = pool.keys[0].key;
      }
    }
  }

  return config;
}
