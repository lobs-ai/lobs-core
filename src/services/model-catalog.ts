import { getModelConfig, getModelForTier } from "../config/models.js";
import { getEnvKeyForProvider, loadKeyConfig } from "../config/keys.js";
import { fetchLoadedModels } from "../diagnostics/lmstudio.js";
import { parseModelString } from "../runner/providers.js";
import { getRawDb } from "../db/connection.js";

export type ModelOptionSource = "tier" | "configured" | "lmstudio" | "available";

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  source: ModelOptionSource;
  tier?: string;
  loaded?: boolean;
}

export interface ModelCatalog {
  defaultModel: string;
  options: ModelOption[];
  lmstudio: {
    baseUrl: string;
    reachable: boolean;
    loadedModels: string[];
  };
}

const TIER_NAMES = ["micro", "small", "medium", "standard", "strong"] as const;
const FRIENDLY_ALIASES: Record<string, string> = {
  haiku: "small",
  sonnet: "medium",
  opus: "strong",
  micro: "micro",
  small: "small",
  medium: "medium",
  standard: "standard",
  strong: "strong",
};

const AVAILABLE_PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
  ],
  "opencode-go": [
    "opencode-go/minimax-m2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/glm-5",
    "opencode-go/kimi-k2.5",
  ],
};

function ensureProviderPrefix(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("/")) return trimmed;
  const parsed = parseModelString(trimmed);
  switch (parsed.provider) {
    case "anthropic":
      return `anthropic/${parsed.modelId}`;
    case "openai":
      return `openai/${parsed.modelId}`;
    case "openrouter":
      return `openrouter/${parsed.modelId}`;
    case "lmstudio":
      return `lmstudio/${parsed.modelId}`;
    default:
      return trimmed;
  }
}

export function getDefaultChatModel(): string {
  return ensureProviderPrefix(process.env.LOBS_MODEL || getModelForTier("strong"));
}

export function getChannelModelOverride(channelId: string): string | null {
  try {
    const db = getRawDb();
    const row = db.prepare(
      `SELECT model_override FROM channel_sessions WHERE channel_id = ?`
    ).get(channelId) as { model_override: string | null } | undefined;
    return row?.model_override ? ensureProviderPrefix(row.model_override) : null;
  } catch {
    return null;
  }
}

export function setChannelModelOverride(channelId: string, model: string | null): void {
  const db = getRawDb();
  db.prepare(`
    INSERT INTO channel_sessions (channel_id, status, last_activity, model_override)
    VALUES (?, 'idle', datetime('now'), ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      model_override = excluded.model_override,
      last_activity = datetime('now')
  `).run(channelId, model);
}

export async function getModelCatalog(timeoutMs = 2500): Promise<ModelCatalog> {
  const cfg = getModelConfig();
  const defaultModel = getDefaultChatModel();
  const loaded = await fetchLoadedModels(cfg.local.baseUrl, timeoutMs);
  const loadedIds = (loaded ?? []).map((m) => m.id);
  const keyConfig = loadKeyConfig();
  const seen = new Map<string, ModelOption>();

  const add = (model: string, source: ModelOptionSource, extra: Partial<ModelOption> = {}) => {
    const normalized = ensureProviderPrefix(model);
    if (!normalized) return;
    if (!seen.has(normalized)) {
      const parsed = parseModelString(normalized);
      seen.set(normalized, {
        id: normalized,
        label: normalized,
        provider: parsed.provider,
        source,
        ...extra,
      });
      return;
    }
    const existing = seen.get(normalized)!;
    seen.set(normalized, { ...existing, ...extra, source: existing.source });
  };

  for (const tier of TIER_NAMES) {
    add(cfg.tiers[tier], "tier", {
      tier,
      label: `${tier} -> ${ensureProviderPrefix(cfg.tiers[tier])}`,
    });
  }

  add(cfg.local.chatModel, "configured", {
    label: `local.chatModel -> ${ensureProviderPrefix(cfg.local.chatModel)}`,
  });

  for (const chain of Object.values(cfg.agents)) {
    add(chain.primary, "configured");
    for (const fallback of chain.fallbacks) add(fallback, "configured");
  }

  for (const [provider, models] of Object.entries(AVAILABLE_PROVIDER_MODELS)) {
    if (!hasProviderCredentials(provider, keyConfig)) continue;
    for (const model of models) {
      add(model, "available", {
        label: `${provider} -> ${model}`,
      });
    }
  }

  for (const modelId of loadedIds) {
    add(`lmstudio/${modelId}`, "lmstudio", {
      label: `LM Studio -> ${modelId}`,
      loaded: true,
    });
  }

  for (const option of seen.values()) {
    if (option.provider === "lmstudio" && option.loaded !== true) {
      const bare = option.id.replace(/^lmstudio\//, "");
      option.loaded = loadedIds.includes(bare);
    }
  }

  const options = Array.from(seen.values()).sort((a, b) => {
    const aLoaded = a.loaded ? 0 : 1;
    const bLoaded = b.loaded ? 0 : 1;
    if (aLoaded !== bLoaded) return aLoaded - bLoaded;
    return a.label.localeCompare(b.label);
  });

  return {
    defaultModel,
    options,
    lmstudio: {
      baseUrl: cfg.local.baseUrl,
      reachable: loaded !== null,
      loadedModels: loadedIds,
    },
  };
}

function hasProviderCredentials(
  provider: string,
  keyConfig: ReturnType<typeof loadKeyConfig>,
): boolean {
  const pool = keyConfig[provider];
  if (pool?.keys?.length) return true;
  const envKey = getEnvKeyForProvider(provider);
  return Boolean(process.env[envKey]?.trim());
}

export async function normalizeModelSelection(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  // If it's a tier name, keep it as-is — main-agent resolves tiers dynamically
  if (["micro", "small", "medium", "standard", "strong"].includes(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }

  const alias = FRIENDLY_ALIASES[trimmed.toLowerCase()];
  if (alias) return ensureProviderPrefix(getModelForTier(alias));

  if (trimmed.includes("/")) return ensureProviderPrefix(trimmed);

  const catalog = await getModelCatalog(1500);
  if (catalog.lmstudio.loadedModels.includes(trimmed)) {
    return `lmstudio/${trimmed}`;
  }

  return ensureProviderPrefix(trimmed);
}

export async function isLoadedLocalModel(model: string): Promise<boolean> {
  const normalized = ensureProviderPrefix(model);
  if (!normalized.startsWith("lmstudio/")) return false;
  const catalog = await getModelCatalog(1500);
  return catalog.lmstudio.loadedModels.includes(normalized.replace(/^lmstudio\//, ""));
}
