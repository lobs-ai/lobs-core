/**
 * lobs-memory — in-process memory service
 * 
 * Replaces the separate Bun HTTP server with direct function imports.
 * Initialize once with `initMemory(config)`, then use search/indexer directly.
 */

import { Worker } from "node:worker_threads";
import { initDb, closeDb, getIndexStats, getDetailedStats } from "./db.js";
import { initEmbedder, checkEmbedderHealth } from "./embedder.js";
import { initReranker, shutdownReranker } from "./reranker.js";
import { initSearch, search, invalidateSearchCache, clearFileCache } from "./search.js";
import { loadMemoryConfig } from "./config.js";
import type { MemoryConfig, SearchRequest, SearchResponse, HealthResponse, BatchSearchItem } from "./types.js";

let initialized = false;
let startTime = 0;
let currentConfig: MemoryConfig | null = null;
let indexerWorker: Worker | null = null;
let nextRequestId = 1;
const pendingWorkerRequests = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
let indexerStatus = {
  isIndexing: false,
  isPaused: false,
  pendingFiles: 0,
  pendingCollections: 0,
  watchersActive: 0,
  workerOnline: false,
  startupComplete: false,
  lastError: null as string | null,
};

type IndexerWorkerCommandType = "pause" | "resume" | "reindex" | "status" | "shutdown";

type IndexerWorkerMessage =
  | {
      type: "response";
      requestId: number;
      ok: boolean;
      error?: string;
    }
  | {
      type: "status";
      status: Partial<typeof indexerStatus>;
    }
  | {
      type: "ready";
    }
  | {
      type: "error";
      error: string;
    };

function updateIndexerStatus(partial: Partial<typeof indexerStatus>): void {
  indexerStatus = { ...indexerStatus, ...partial };
}

function handleIndexerWorkerMessage(message: IndexerWorkerMessage): void {
  if (message.type === "status") {
    updateIndexerStatus(message.status);
    return;
  }

  if (message.type === "ready") {
    updateIndexerStatus({ startupComplete: true, workerOnline: true, lastError: null });
    console.log("[memory] Indexer worker ready");
    return;
  }

  if (message.type === "error") {
    updateIndexerStatus({ lastError: message.error });
    console.error(`[memory] Indexer worker error: ${message.error}`);
    return;
  }

  const pending = pendingWorkerRequests.get(message.requestId);
  if (!pending) return;
  pendingWorkerRequests.delete(message.requestId);
  if (message.ok) pending.resolve();
  else pending.reject(new Error(message.error ?? "Indexer worker request failed"));
}

async function startIndexerWorker(config: MemoryConfig, dbPath: string): Promise<void> {
  if (indexerWorker) return;

  const workerUrl = new URL("./indexer-worker.js", import.meta.url);
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { config, dbPath },
    });

    let settled = false;
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    worker.on("message", handleIndexerWorkerMessage);
    worker.once("online", () => {
      updateIndexerStatus({ workerOnline: true, lastError: null });
      finishResolve();
    });
    worker.once("error", (error) => {
      updateIndexerStatus({ workerOnline: false, lastError: error.message });
      finishReject(error);
    });
    worker.on("exit", (code) => {
      indexerWorker = null;
      updateIndexerStatus({
        workerOnline: false,
        startupComplete: false,
        watchersActive: 0,
        lastError: code === 0 ? indexerStatus.lastError : `Indexer worker exited with code ${code}`,
      });

      for (const [requestId, pending] of pendingWorkerRequests) {
        pending.reject(new Error("Indexer worker exited before responding"));
        pendingWorkerRequests.delete(requestId);
      }
    });

    indexerWorker = worker;
  });
}

function sendIndexerWorkerCommand(type: IndexerWorkerCommandType): Promise<void> {
  if (!indexerWorker) {
    return Promise.reject(new Error("Indexer worker is not running"));
  }

  const requestId = nextRequestId++;
  return new Promise<void>((resolve, reject) => {
    pendingWorkerRequests.set(requestId, { resolve, reject });
    indexerWorker!.postMessage({ requestId, type });
  });
}

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

  initialized = true;
  await startIndexerWorker(config, dbPath);
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
 * Batch search — multiple queries in parallel.
 * Returns results keyed by each search item's `id`.
 */
export async function searchMemoryBatch(
  searches: BatchSearchItem[],
): Promise<{ results: Record<string, SearchResponse>; timings: { totalMs: number } }> {
  if (!initialized) {
    throw new Error("Memory service not initialized. Call initMemory() first.");
  }
  const start = Date.now();
  const entries = await Promise.all(
    searches.map(async (item) => {
      const response = await search({
        query: item.query,
        maxResults: item.maxResults,
        minScore: item.minScore,
        collections: item.collections,
        conversationContext: item.conversationContext,
      });
      return [item.id, response] as const;
    }),
  );
  return {
    results: Object.fromEntries(entries),
    timings: { totalMs: Date.now() - start },
  };
}

/**
 * Check if the memory service is initialized and ready.
 */
export function isMemoryReady(): boolean {
  return initialized;
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
  if (indexerWorker) {
    try {
      await sendIndexerWorkerCommand("shutdown");
    } catch (err) {
      console.warn(`[memory] Indexer worker shutdown command failed: ${err}`);
    }
    await indexerWorker.terminate();
    indexerWorker = null;
  }
  shutdownReranker();
  closeDb();
  updateIndexerStatus({
    isIndexing: false,
    isPaused: false,
    pendingFiles: 0,
    pendingCollections: 0,
    watchersActive: 0,
    workerOnline: false,
    startupComplete: false,
  });
  initialized = false;
  console.log("[memory] Shutdown complete");
}

/**
 * Force re-index all collections.
 */
export async function forceReindex(): Promise<void> {
  if (!initialized) throw new Error("Memory service not initialized");
  await sendIndexerWorkerCommand("reindex");
}

export async function pauseIndexing(): Promise<void> {
  if (!initialized) throw new Error("Memory service not initialized");
  await sendIndexerWorkerCommand("pause");
}

export async function resumeIndexing(): Promise<void> {
  if (!initialized) throw new Error("Memory service not initialized");
  await sendIndexerWorkerCommand("resume");
}

export function getIndexerStatus() {
  return { ...indexerStatus };
}

// Re-export types and key functions for convenience
export type {
  MemoryConfig, SearchRequest, SearchResponse, SearchResult,
  HealthResponse, Collection, Chunk, ScoredChunk,
  BatchSearchRequest, BatchSearchResponse, BatchSearchItem,
  GraphRequest, GraphResponse,
} from "./types.js";
export { invalidateSearchCache, clearFileCache };
export { getIndexStats, getDetailedStats } from "./db.js";
export { resetEmbedderCache } from "./search.js";
