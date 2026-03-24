/**
 * lobs-memory — in-process memory service
 * 
 * Replaces the separate Bun HTTP server with direct function imports.
 * Initialize once with `initMemory(config)`, then use search/indexer directly.
 */

import { initDb, closeDb, getIndexStats, getDetailedStats } from "./db.js";
import { initEmbedder, checkEmbedderHealth } from "./embedder.js";
import { initReranker, shutdownReranker } from "./reranker.js";
import { initSearch, search, invalidateSearchCache, clearFileCache } from "./search.js";
import { startIndexer, stopIndexer, reindexAll, pauseIndexing, resumeIndexing, getIndexerStatus } from "./indexer.js";
import { loadMemoryConfig } from "./config.js";
import type { MemoryConfig, SearchRequest, SearchResponse, HealthResponse } from "./types.js";

let initialized = false;
let startTime = 0;
let currentConfig: MemoryConfig | null = null;

/**
 * Initialize the memory service. Call once at startup.
 * Loads config, opens DB, starts indexer + embedder + reranker.
 */
export async function initMemory(configOverrides?: Partial<MemoryConfig>): Promise<void> {
  if (initialized) {
    console.log("[memory] Already initialized, skipping");
    return;
  }

  startTime = Date.now();
  console.log("[memory] Initializing in-process memory service...");

  // Load config
  const config = loadMemoryConfig();
  if (configOverrides) {
    Object.assign(config, configOverrides);
  }
  currentConfig = config;

  // Initialize DB
  const dbPath = process.env.MEMORY_DB_PATH || `${process.env.HOME}/.lobs/memory.db`;
  initDb(dbPath);

  // Initialize embedder
  initEmbedder(config);

  // Initialize reranker (may start sidecar)
  await initReranker(config);

  // Initialize search pipeline
  initSearch(config);

  // Start indexer (file watching + initial sync)
  await startIndexer(config);

  initialized = true;
  console.log("[memory] Memory service ready");
}

/**
 * Search memory. Main entry point for agents.
 */
export async function searchMemory(request: SearchRequest): Promise<SearchResponse> {
  if (!initialized) {
    throw new Error("Memory service not initialized. Call initMemory() first.");
  }
  return search(request);
}

/**
 * Get health/status of the memory service.
 */
export async function getMemoryHealth(): Promise<HealthResponse> {
  const embedderHealth = await checkEmbedderHealth();
  const stats = getIndexStats();
  const indexerStatus = getIndexerStatus();

  return {
    status: initialized ? (embedderHealth.available ? "ok" : "degraded") : "error",
    uptime: initialized ? Date.now() - startTime : 0,
    models: {
      embedding: {
        loaded: embedderHealth.available,
        model: currentConfig?.lmstudio.embeddingModel || "unknown",
      },
      reranker: {
        loaded: false, // TODO: wire up reranker status
        mode: currentConfig?.reranker?.mode || "none",
      },
      queryExpansion: {
        loaded: currentConfig?.search.queryExpansion.enabled || false,
        path: currentConfig?.lmstudio.chatModel || "none",
      },
    },
    index: {
      documents: stats.documents,
      chunks: stats.chunks,
      collections: stats.collections,
      lastUpdate: stats.lastUpdate,
    },
  };
}

/**
 * Shutdown the memory service cleanly.
 */
export async function shutdownMemory(): Promise<void> {
  if (!initialized) return;

  console.log("[memory] Shutting down...");
  await stopIndexer();
  shutdownReranker();
  closeDb();
  initialized = false;
  console.log("[memory] Shutdown complete");
}

/**
 * Force re-index all collections.
 */
export async function forceReindex(): Promise<void> {
  if (!initialized) throw new Error("Memory service not initialized");
  await reindexAll();
}

// Re-export types and key functions for convenience
export type {
  MemoryConfig, SearchRequest, SearchResponse, SearchResult,
  HealthResponse, Collection, Chunk, ScoredChunk,
  BatchSearchRequest, BatchSearchResponse, BatchSearchItem,
  GraphRequest, GraphResponse,
} from "./types.js";
export { invalidateSearchCache, clearFileCache };
export { pauseIndexing, resumeIndexing, getIndexerStatus };
export { getIndexStats, getDetailedStats } from "./db.js";
