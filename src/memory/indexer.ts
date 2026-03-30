/**
 * FileIndexer — indexes markdown files into structured-memory.db as document chunks.
 *
 * Runs in-process (no Worker thread). Replaces the Worker-based indexer in
 * src/services/memory/ as part of the ADR-007 memory unification.
 *
 * Chunks are stored as memories with memory_type='document'.
 * Embeddings are queued async and batched to avoid overwhelming LM Studio.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getMemoryDb } from "./db.js";
import { log } from "../util/logger.js";

// ── Config ────────────────────────────────────────────────────────────────────

export interface FileIndexerConfig {
  watchDirs: Array<{
    path: string;
    collection: string;
    recursive: boolean;
    glob?: string; // default: '**/*.md'
  }>;
  chunkStrategy?: "heading" | "fixed"; // default: 'heading'
  maxChunkTokens?: number; // default: 400
  rescanIntervalMs?: number; // default: 900_000 (15 min)
  batchSize?: number; // embedding batch size, default: 10
}

// ── Internal types ────────────────────────────────────────────────────────────

interface EmbeddingJob {
  memoryId: number;
  text: string;
}

interface Chunk {
  title: string | null;
  content: string;
  index: number;
  hash: string;
}

// ── Module state ──────────────────────────────────────────────────────────────

let _config: FileIndexerConfig | null = null;
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _embeddingQueue: EmbeddingJob[] = [];
let _drainInProgress = false;
let _totalFiles = 0;
let _totalChunks = 0;
const _EMBED_URL = "http://localhost:1234/v1/embeddings";
const _EMBED_MODEL = "text-embedding-qwen3-embedding-4b";
const _SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the file indexer. Triggers a non-blocking initial scan and sets up
 * periodic rescans.
 */
export function initFileIndexer(config: FileIndexerConfig): void {
  _config = config;

  const interval = config.rescanIntervalMs ?? 900_000;

  // Non-blocking initial scan
  void runScan();

  _intervalId = setInterval(() => {
    void runScan();
  }, interval);
}

/**
 * Stop the file indexer and cancel background work.
 */
export function stopFileIndexer(): void {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  _embeddingQueue = [];
  _config = null;
}

/**
 * Force an immediate rescan (useful in tests).
 */
export async function forceRescan(): Promise<void> {
  await runScan();
}

/**
 * Return current indexer stats.
 */
export function getIndexerStats(): {
  files: number;
  chunks: number;
  pendingEmbeddings: number;
} {
  return {
    files: _totalFiles,
    chunks: _totalChunks,
    pendingEmbeddings: _embeddingQueue.length,
  };
}

// ── Scan logic ────────────────────────────────────────────────────────────────

async function runScan(): Promise<void> {
  if (!_config) return;

  for (const dir of _config.watchDirs) {
    try {
      const files = collectMarkdownFiles(dir.path, dir.recursive);
      for (const filePath of files) {
        try {
          await indexFile(filePath, dir.collection);
        } catch (err) {
          log().warn(
            `[file-indexer] Error indexing ${filePath}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      log().warn(
        `[file-indexer] Error scanning directory ${dir.path}: ${String(err)}`,
      );
    }
  }
}

/**
 * Recursively collect .md files under a directory, up to depth 5.
 */
function collectMarkdownFiles(
  dir: string,
  recursive: boolean,
  depth = 0,
): string[] {
  if (depth > 5) return [];
  if (!fs.existsSync(dir)) return [];

  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (_SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    } else if (entry.isDirectory() && recursive) {
      results.push(...collectMarkdownFiles(fullPath, recursive, depth + 1));
    }
  }

  return results;
}

// ── Indexing ──────────────────────────────────────────────────────────────────

async function indexFile(
  filePath: string,
  collection: string,
): Promise<void> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return; // unreadable — skip silently
  }

  const fileHash = sha1(content);

  const db = getMemoryDb();

  // Check if already indexed with same hash
  const existing = db
    .prepare(
      "SELECT content_hash FROM indexed_files WHERE path = ?",
    )
    .get(filePath) as { content_hash: string } | undefined;

  if (existing && existing.content_hash === fileHash) {
    return; // unchanged — skip
  }

  const chunks = chunkMarkdown(
    content,
    filePath,
    _config?.chunkStrategy ?? "heading",
    _config?.maxChunkTokens ?? 400,
  );

  const now = new Date().toISOString();
  const newMemoryIds: number[] = [];

  const tx = db.transaction(() => {
    // Remove old chunks
    db.prepare(
      "DELETE FROM memories WHERE source_path = ? AND memory_type = 'document'",
    ).run(filePath);

    // Remove old indexed_files entry
    db.prepare("DELETE FROM indexed_files WHERE path = ?").run(filePath);

    // Insert new chunks
    const insertMemory = db.prepare(
      `INSERT INTO memories
        (memory_type, title, content, confidence, scope, source_authority,
         derived_at, status, source_path, content_hash, chunk_index, created_at, updated_at)
       VALUES
        ('document', ?, ?, 1.0, 'system', 1,
         ?, 'active', ?, ?, ?, ?, ?)`,
    );

    for (const chunk of chunks) {
      const result = insertMemory.run(
        chunk.title,
        chunk.content,
        now,
        filePath,
        chunk.hash,
        chunk.index,
        now,
        now,
      );
      newMemoryIds.push(result.lastInsertRowid as number);
    }

    // Record in indexed_files
    db.prepare(
      `INSERT OR REPLACE INTO indexed_files
        (path, content_hash, last_indexed, chunk_count, collection, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(filePath, fileHash, now, chunks.length, collection, now, now);
  });

  tx();

  // Update stats
  _totalFiles += existing ? 0 : 1;
  _totalChunks += chunks.length;

  // Queue embeddings for new chunks
  for (let i = 0; i < chunks.length; i++) {
    const id = newMemoryIds[i];
    if (id !== undefined) {
      _embeddingQueue.push({ memoryId: id, text: chunks[i].content });
    }
  }

  // Drain in background
  void drainEmbeddingQueue();
}

// ── Chunking ──────────────────────────────────────────────────────────────────

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** Rough token estimate: 1 token ≈ 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function chunkMarkdown(
  content: string,
  _filePath: string,
  strategy: "heading" | "fixed",
  maxChunkTokens: number,
): Chunk[] {
  if (strategy === "fixed" || !content.includes("\n#")) {
    return fixedChunks(content, maxChunkTokens);
  }
  return headingChunks(content, maxChunkTokens);
}

/**
 * Split markdown on ## and ### headings. Each section becomes one chunk.
 * Oversized sections are further split at paragraph boundaries.
 */
function headingChunks(content: string, maxChunkTokens: number): Chunk[] {
  const MIN_CHUNK_CHARS = 50;
  const chunks: Chunk[] = [];

  // Split at heading lines (## or ###), keeping the heading with its section
  const sections: Array<{ title: string; body: string }> = [];
  const lines = content.split("\n");

  let currentTitle = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line)) {
      // Save previous section if it has content
      if (currentBody.length > 0 || currentTitle) {
        sections.push({
          title: currentTitle,
          body: currentBody.join("\n").trim(),
        });
      }
      currentTitle = line.replace(/^#+\s+/, "").trim();
      currentBody = [line]; // include the heading in body for context
    } else {
      currentBody.push(line);
    }
  }

  // Final section
  if (currentBody.length > 0 || currentTitle) {
    sections.push({ title: currentTitle, body: currentBody.join("\n").trim() });
  }

  // No headings found — fall back to fixed chunking
  if (sections.length === 0 || (sections.length === 1 && !sections[0].title)) {
    return fixedChunks(content, maxChunkTokens);
  }

  let chunkIndex = 0;

  for (const section of sections) {
    if (section.body.length < MIN_CHUNK_CHARS) continue;

    const maxChunkChars = maxChunkTokens * 4;

    if (estimateTokens(section.body) <= maxChunkTokens) {
      chunks.push({
        title: section.title || null,
        content: section.body,
        index: chunkIndex++,
        hash: sha1(section.body),
      });
    } else {
      // Split oversized section at paragraph boundaries
      const paragraphs = section.body.split(/\n\n+/);
      let buffer = "";

      for (const para of paragraphs) {
        if (buffer.length + para.length + 2 > maxChunkChars && buffer.length >= MIN_CHUNK_CHARS) {
          chunks.push({
            title: section.title || null,
            content: buffer.trim(),
            index: chunkIndex++,
            hash: sha1(buffer.trim()),
          });
          buffer = para;
        } else {
          buffer = buffer ? `${buffer}\n\n${para}` : para;
        }
      }

      if (buffer.trim().length >= MIN_CHUNK_CHARS) {
        chunks.push({
          title: section.title || null,
          content: buffer.trim(),
          index: chunkIndex++,
          hash: sha1(buffer.trim()),
        });
      }
    }
  }

  // Fallback if no chunks were produced (e.g., all sections too small)
  if (chunks.length === 0) {
    return fixedChunks(content, maxChunkTokens);
  }

  return chunks;
}

/**
 * Fixed-size chunking with 20% overlap (for non-markdown or headingless files).
 */
function fixedChunks(content: string, maxChunkTokens: number): Chunk[] {
  const MIN_CHUNK_CHARS = 50;
  const maxChars = maxChunkTokens * 4;
  const overlapChars = Math.floor(maxChars * 0.2);
  const chunks: Chunk[] = [];

  let start = 0;
  let index = 0;

  while (start < content.length) {
    const end = Math.min(start + maxChars, content.length);
    const slice = content.slice(start, end).trim();

    if (slice.length >= MIN_CHUNK_CHARS) {
      chunks.push({
        title: null,
        content: slice,
        index: index++,
        hash: sha1(slice),
      });
    }

    if (end >= content.length) break;
    start = end - overlapChars;
  }

  return chunks;
}

// ── Embedding queue ───────────────────────────────────────────────────────────

const _BATCH_RATE_MS = 500;
let _lastBatchAt = 0;

async function drainEmbeddingQueue(): Promise<void> {
  if (_drainInProgress || _embeddingQueue.length === 0) return;
  _drainInProgress = true;

  try {
    const batchSize = _config?.batchSize ?? 10;

    while (_embeddingQueue.length > 0) {
      // Rate limit: at most one batch per 500ms
      const now = Date.now();
      const elapsed = now - _lastBatchAt;
      if (elapsed < _BATCH_RATE_MS) {
        await sleep(_BATCH_RATE_MS - elapsed);
      }

      const batch = _embeddingQueue.splice(0, batchSize);
      _lastBatchAt = Date.now();

      await embedBatchWithRetry(batch, 3);
    }
  } finally {
    _drainInProgress = false;
  }
}

async function embedBatchWithRetry(
  batch: EmbeddingJob[],
  maxRetries: number,
): Promise<void> {
  const texts = batch.map((j) => j.text);
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(_EMBED_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: _EMBED_MODEL, input: texts }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };

      if (!data.data || data.data.length === 0) return;

      const db = getMemoryDb();

      const insertEmbed = db.prepare(
        `INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, created_at)
         VALUES (?, ?, ?)`,
      );

      const now = new Date().toISOString();

      const tx = db.transaction(() => {
        for (const item of data.data!) {
          const idx = item.index ?? 0;
          const job = batch[idx];
          if (!job || !item.embedding) continue;

          const vec = new Float32Array(item.embedding);
          const buf = Buffer.from(vec.buffer);
          insertEmbed.run(job.memoryId, buf, now);
        }
      });

      tx();
      return; // success
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        await sleep(500 * Math.pow(2, attempt)); // exponential backoff
      }
    }
  }

  // All retries failed — log and move on (FTS5 still works without embeddings)
  log().warn(
    `[file-indexer] Embedding batch failed after ${maxRetries} retries: ${String(lastError)}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
