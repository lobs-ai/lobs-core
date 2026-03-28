/**
 * File indexing with watching and embedding cache
 * Ported from lobs-memory — uses chokidar for file watching, batched sync
 */

import { watch, type FSWatcher } from "chokidar";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { glob } from "glob";
import {
  upsertDocument,
  getDocument,
  deleteDocument,
  insertChunks,
  deleteChunks,
  insertEmbeddings,
  getCachedEmbedding,
  setCachedEmbedding,
  getDb,
  insertEntities,
  insertRelationships,
  deleteEntities,
  deleteRelationships,
} from "./db.js";
import { chunkMarkdown } from "./chunker.js";
import { embedBatch, checkEmbedderHealth } from "./embedder.js";
import { clearFileCache, invalidateSearchCache } from "./search.js";
import { parseFile } from "./parsers.js";
import { patternExtract } from "./entities.js";
import { extractRelationships } from "./graph.js";
import type { MemoryConfig, Collection } from "./types.js";

interface IndexerState {
  config: MemoryConfig | null;
  watchers: Map<string, FSWatcher>;
  isIndexing: boolean;
  isPaused: boolean;
  pendingFiles: Map<string, string>;
  pendingCollections: Set<string>;
  syncIntervalHandle: ReturnType<typeof setInterval> | null;
  embedderDownLogged: boolean;
  lastEmbedderHealthCheckAt: number;
  embedderAvailable: boolean;
  embedderError?: string;
  lastEmbedderWarningAt: number;
}

const state: IndexerState = {
  config: null,
  watchers: new Map(),
  isIndexing: false,
  isPaused: false,
  pendingFiles: new Map(),
  pendingCollections: new Set(),
  embedderDownLogged: false,
  syncIntervalHandle: null,
  lastEmbedderHealthCheckAt: 0,
  embedderAvailable: true,
  embedderError: undefined,
  lastEmbedderWarningAt: 0,
};

interface CollectionSyncPlan {
  collection: Collection;
  diskFiles: number;
  unchanged: number;
  toIndex: string[];
  toDelete: string[];
}

interface FileIndexTask {
  path: string;
  collectionName: string;
}

const DEFAULT_EXCLUDE_SEGMENTS = [
  "/node_modules/",
  "/.git/",
  "/dist/",
  "/build/",
  "/Pods/",
  "/.build/",
];

function shouldIgnorePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return DEFAULT_EXCLUDE_SEGMENTS.some((segment) => normalized.includes(segment));
}

async function ensureEmbedderAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now - state.lastEmbedderHealthCheckAt < 30_000) {
    if (!state.embedderAvailable && now - state.lastEmbedderWarningAt > 30_000) {
      console.warn(`Embedder unavailable — skipping indexing until LM Studio recovers (${state.embedderError ?? "unknown error"})`);
      state.lastEmbedderWarningAt = now;
    }
    return state.embedderAvailable;
  }

  state.lastEmbedderHealthCheckAt = now;
  const health = await checkEmbedderHealth();
  state.embedderAvailable = health.available;
  state.embedderError = health.error;
  if (health.available) {
    state.embedderDownLogged = false;
  }

  if (!health.available) {
    console.warn(`Embedder unavailable — skipping indexing until LM Studio recovers (${health.error ?? "unknown error"})`);
    state.lastEmbedderWarningAt = now;
  }

  return health.available;
}

/**
 * Initialize indexer and start file watchers
 */
export async function startIndexer(config: MemoryConfig): Promise<void> {
  state.config = config;

  console.log("[memory] Starting batched index sync...");
  await runBatchSync("startup", true);

  if (config.indexing.watchEnabled) {
    console.log("[memory] Starting file watchers...");
    startWatchers();
  }

  const syncIntervalMs = config.indexing.syncIntervalMs || 15 * 60 * 1000;
  console.log(`[memory] Starting background batch sweep (interval: ${syncIntervalMs}ms)`);
  state.syncIntervalHandle = setInterval(async () => {
    if (!state.isPaused && !state.isIndexing) {
      await runBatchSync("scheduled", true);
    }
  }, syncIntervalMs);

  console.log("[memory] Indexer ready");
}

function queueFileForBatch(path: string, collectionName: string, reason: "add" | "change" | "delete"): void {
  if (shouldIgnorePath(path)) return;
  state.pendingFiles.set(path, collectionName);
  state.pendingCollections.add(collectionName);
  const relPath = path.replace(process.env.HOME || "", "~");
  console.log(`[indexer.queue] ${reason} queued for batch: ${relPath} (${collectionName})`);
}

async function buildCollectionSyncPlan(collection: Collection): Promise<CollectionSyncPlan> {
  const patterns = Array.isArray(collection.pattern) ? collection.pattern : [collection.pattern];
  const diskFiles = new Set<string>();

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: collection.path,
      absolute: true,
      nodir: true,
      ignore: collection.exclude || [
        "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**",
        "**/venv/**", "**/site-packages/**", "**/.venv/**",
        "**/tools-venv/**", "**/__pycache__/**",
      ],
    });
    matches.forEach(f => diskFiles.add(f));
  }

  const db = getDb();
  const collectionPath = collection.path.endsWith("/") ? collection.path : collection.path + "/";
  const existingDocs = db.prepare("SELECT path, hash, mtime FROM documents WHERE collection = ? AND path LIKE ?")
    .all(collection.name, collectionPath + "%") as Array<{ path: string; hash: string; mtime: number }>;

  const existingPaths = new Set(existingDocs.map(d => d.path));
  const existingByPath = new Map(existingDocs.map(d => [d.path, d]));

  const toIndex: string[] = [];
  const toDelete: string[] = [];

  for (const path of diskFiles) {
    const existing = existingByPath.get(path);
    if (!existing) {
      toIndex.push(path);
    } else {
      try {
        const stats = statSync(path);
        if (stats.mtimeMs !== existing.mtime) {
          const content = readFileSync(path, "utf-8");
          const hash = createHash("sha256").update(content).digest("hex");
          if (hash !== existing.hash) {
            toIndex.push(path);
          } else {
            db.prepare("UPDATE documents SET mtime = ? WHERE path = ?").run(stats.mtimeMs, path);
          }
        }
      } catch (err) {
        console.error(`Error checking ${path}:`, err);
      }
    }
  }

  for (const path of existingPaths) {
    if (!diskFiles.has(path)) {
      toDelete.push(path);
    }
  }

  return {
    collection,
    diskFiles: diskFiles.size,
    unchanged: diskFiles.size - toIndex.length,
    toIndex,
    toDelete,
  };
}

async function runBatchSync(reason: string, forceFullSweep = false): Promise<void> {
  if (!state.config || state.isIndexing) return;

  state.isIndexing = true;
  const startedAt = Date.now();
  const pendingFilesSnapshot = new Map(state.pendingFiles);
  const pendingCollectionsSnapshot = new Set(state.pendingCollections);
  state.pendingFiles.clear();
  state.pendingCollections.clear();

  try {
    const collections = state.config.collections;
    const collectionScope = forceFullSweep ? collections : collections.filter(c => pendingCollectionsSnapshot.has(c.name));
    const targetCollections = collectionScope.length > 0 ? collectionScope : collections;

    console.log(
      `[indexer.batch] start reason=${reason} collections=${targetCollections.length}/${collections.length} ` +
      `queued_files=${pendingFilesSnapshot.size} queued_collections=${pendingCollectionsSnapshot.size}`,
    );

    const plans = await Promise.all(targetCollections.map((collection) => buildCollectionSyncPlan(collection)));
    const toDelete = plans.flatMap((plan) => plan.toDelete);
    const toIndex: FileIndexTask[] = plans.flatMap((plan) =>
      plan.toIndex.map((path) => ({ path, collectionName: plan.collection.name })),
    );

    for (const path of toDelete) {
      deleteDocument(path);
      clearFileCache(path);
    }

    let indexed = 0;
    for (const task of toIndex) {
      const changed = await indexFile(task.path, task.collectionName);
      if (changed) indexed++;
    }

    const totalDiskFiles = plans.reduce((sum, plan) => sum + plan.diskFiles, 0);
    const totalUnchanged = plans.reduce((sum, plan) => sum + plan.unchanged, 0);
    console.log(
      `[indexer.batch] done reason=${reason} indexed=${indexed}/${toIndex.length} deleted=${toDelete.length} ` +
      `unchanged=${totalUnchanged} scanned_files=${totalDiskFiles} elapsed_ms=${Date.now() - startedAt}`,
    );
  } catch (err) {
    console.error(`[indexer.batch] failed reason=${reason}:`, err);
  } finally {
    state.isIndexing = false;
  }
}

async function indexFile(path: string, collectionName: string): Promise<boolean> {
  if (!state.config) return false;
  if (shouldIgnorePath(path)) return false;

  try {
    const stats = statSync(path);
    const rawContent = readFileSync(path, "utf-8");
    const hash = createHash("sha256").update(rawContent).digest("hex");

    const existing = getDocument(path);
    if (existing && existing.hash === hash && existing.mtime === stats.mtimeMs) {
      return false;
    }

    if (!(await ensureEmbedderAvailable())) {
      return false;
    }

    const relPath = path.replace(process.env.HOME || "", "~");
    console.log(`Indexing: ${relPath}`);

    const parsed = parseFile(rawContent, path);
    const content = parsed.text;

    const docId = upsertDocument({
      path,
      collection: collectionName,
      mtime: stats.mtimeMs,
      hash,
    });

    if (existing) {
      const oldChunks = getInsertedChunks(docId);
      for (const chunk of oldChunks) {
        deleteEntities(chunk.id);
        deleteRelationships(chunk.id);
      }
      deleteChunks(docId);
    }

    const chunkResults = chunkMarkdown(content, state.config.chunking, path);
    console.log(`  → ${chunkResults.length} chunks created`);

    const chunks = chunkResults.map(chunk => ({
      docId,
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokenCount: chunk.tokenCount,
    }));

    insertChunks(chunks);

    const insertedChunks = getInsertedChunks(docId);

    for (const chunk of insertedChunks) {
      const entities = patternExtract(chunk.text);
      if (entities.length > 0) {
        insertEntities(chunk.id, entities);
      }

      const relationships = extractRelationships(chunk.text, chunk.id);
      if (relationships.length > 0) {
        insertRelationships(relationships);
      }
    }

    const modelName = state.config.lmstudio.embeddingModel;
    const textsToEmbed: string[] = [];
    const chunkIndices: number[] = [];

    for (let i = 0; i < insertedChunks.length; i++) {
      const chunk = insertedChunks[i];
      const textHash = createHash("sha256").update(chunk.text).digest("hex");
      const cached = getCachedEmbedding(textHash, modelName);

      if (cached) {
        insertEmbeddings(chunk.id!, cached);
      } else {
        textsToEmbed.push(chunk.text);
        chunkIndices.push(i);
      }
    }

    if (textsToEmbed.length > 0) {
      try {
        const embeddings = await embedBatch(textsToEmbed);

        for (let i = 0; i < embeddings.length; i++) {
          const embedding = embeddings[i];
          const chunkIdx = chunkIndices[i];
          const chunk = insertedChunks[chunkIdx];
          const textHash = createHash("sha256").update(chunk.text).digest("hex");

          insertEmbeddings(chunk.id!, embedding);
          setCachedEmbedding(textHash, modelName, embedding);
        }
      } catch (err) {
        if (!state.embedderDownLogged) {
          console.warn(`[indexer] Embedder unavailable — indexing without vector embeddings. BM25 search still works. (${err instanceof Error ? err.message : err})`);
          state.embedderDownLogged = true;
        }
      }
    }

    clearFileCache(path);
    invalidateSearchCache();

    return true;
  } catch (err) {
    console.error(`Error indexing ${path}:`, err);
    return false;
  }
}

function getInsertedChunks(docId: number): Array<{ id: number; text: string }> {
  const db = getDb();
  const stmt = db.prepare("SELECT id, text FROM chunks WHERE doc_id = ?");
  return stmt.all(docId) as Array<{ id: number; text: string }>;
}

function startWatchers(): void {
  if (!state.config) return;

  for (const collection of state.config.collections) {
    const patterns = Array.isArray(collection.pattern) ? collection.pattern : [collection.pattern];

    const watcher = watch(patterns, {
      cwd: collection.path,
      ignoreInitial: true,
      ignored: collection.exclude || [
        "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**",
        "**/venv/**", "**/site-packages/**", "**/.venv/**",
        "**/tools-venv/**", "**/__pycache__/**",
      ],
      awaitWriteFinish: {
        stabilityThreshold: state.config.indexing.debounceMs,
        pollInterval: 100,
      },
    });

    watcher
      .on("add", (path) => handleFileChange(join(collection.path, path), collection.name))
      .on("change", (path) => handleFileChange(join(collection.path, path), collection.name))
      .on("unlink", (path) => handleFileDelete(join(collection.path, path), collection.name));

    state.watchers.set(collection.name, watcher);
    console.log(`Watching: ${collection.name} (${collection.path})`);
  }
}

function handleFileChange(path: string, collectionName: string): void {
  queueFileForBatch(path, collectionName, "change");
}

function handleFileDelete(path: string, collectionName: string): void {
  queueFileForBatch(path, collectionName, "delete");
}

export function pauseIndexing(): void {
  state.isPaused = true;
}

export async function resumeIndexing(): Promise<void> {
  state.isPaused = false;

  if (state.pendingFiles.size > 0 || state.pendingCollections.size > 0) {
    console.log(
      `[indexer.batch] resume requested with queued_files=${state.pendingFiles.size} queued_collections=${state.pendingCollections.size}`,
    );
    await runBatchSync("resume", true);
  }
}

export async function reindexAll(): Promise<void> {
  console.log("Manual batched re-sync triggered");
  await runBatchSync("manual", true);
}

export async function stopIndexer(): Promise<void> {
  console.log("[memory] Stopping indexer...");

  if (state.syncIntervalHandle) {
    clearInterval(state.syncIntervalHandle);
    state.syncIntervalHandle = null;
  }

  for (const [name, watcher] of state.watchers) {
    await watcher.close();
    console.log(`Stopped watcher: ${name}`);
  }

  state.watchers.clear();
}

export function getIndexerStatus() {
  return {
    isIndexing: state.isIndexing,
    isPaused: state.isPaused,
    pendingFiles: state.pendingFiles.size,
    pendingCollections: state.pendingCollections.size,
    watchersActive: state.watchers.size,
  };
}
