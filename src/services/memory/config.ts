/**
 * Memory configuration loading with priority: CLI args > env vars > config.json > defaults
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return join(process.env.HOME || "~", path.slice(2));
  }
  return path;
}

export function loadMemoryConfig(configPath?: string): MemoryConfig {
  // Look for config.json in the lobs-memory directory
  const defaultConfigPath = join(process.env.HOME || "~", "lobs", "lobs-memory", "config.json");
  const jsonPath = expandTilde(configPath || defaultConfigPath);

  let config: MemoryConfig;
  try {
    const json = readFileSync(jsonPath, "utf-8");
    config = JSON.parse(json);
  } catch (err) {
    console.warn(`[memory] Could not read config at ${jsonPath}, using defaults`);
    config = getDefaultConfig();
  }

  // Environment variable overrides
  if (process.env.LMSTUDIO_URL) {
    config.lmstudio = config.lmstudio || { baseUrl: "", embeddingModel: "", chatModel: "" };
    config.lmstudio.baseUrl = process.env.LMSTUDIO_URL;
  }
  if (process.env.EMBEDDING_MODEL) {
    config.lmstudio = config.lmstudio || { baseUrl: "", embeddingModel: "", chatModel: "" };
    config.lmstudio.embeddingModel = process.env.EMBEDDING_MODEL;
  }
  if (process.env.RERANKER_MODE) {
    config.reranker = config.reranker || { mode: "none" };
    config.reranker.mode = process.env.RERANKER_MODE as "sidecar" | "lmstudio" | "none";
  }

  // Keep memory embeddings local-only by default
  const baseUrl = config.lmstudio?.baseUrl ?? "";
  if (baseUrl && !isLocalBaseUrl(baseUrl)) {
    console.warn(`[memory] Non-local LM Studio base URL configured (${baseUrl}); falling back to localhost`);
    config.lmstudio.baseUrl = "http://localhost:1234/v1";
  }

  // Expand tildes in paths
  if (config.collections) {
    for (const col of config.collections) {
      col.path = expandTilde(col.path);
    }
  }

  return config;
}

function getDefaultConfig(): MemoryConfig {
  return {
    lmstudio: {
      baseUrl: "http://localhost:1234/v1",
      embeddingModel: "text-embedding-qwen3-embedding-4b",
      chatModel: "qwen/qwen3.5-9b",
    },
    reranker: {
      mode: "none",
    },
    collections: [
      {
        name: "memory",
        path: "~/.lobs/workspace",
        pattern: ["MEMORY.md", "memory/**/*.md"],
      },
    ],
    search: {
      vectorWeight: 0.7,
      textWeight: 0.3,
      candidateMultiplier: 4,
      maxResults: 8,
      mmr: { enabled: true, lambda: 0.7 },
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      reranking: { enabled: true, candidateCount: 20 },
      queryExpansion: { enabled: false },
    },
    chunking: {
      targetTokens: 400,
      overlapTokens: 80,
    },
    indexing: {
      debounceMs: 2000,
      watchEnabled: true,
      syncIntervalMs: 15 * 60 * 1000,
    },
  };
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
