/**
 * SQLite database with FTS5 support
 * Uses better-sqlite3 (Node.js compatible, replaces bun:sqlite)
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync, existsSync, statSync } from "node:fs";
import type { Chunk } from "./types.js";

export interface Document {
  id?: number;
  path: string;
  collection: string;
  mtime: number;
  hash: string;
  updatedAt?: string;
}

let db: DatabaseType | null = null;

export function initDb(dbPath?: string): DatabaseType {
  const home = process.env.HOME || "~";
  const path = dbPath || `${home}/.lobs/plugins/lobs-memory/index.db`;

  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(path);

  // Enable WAL mode for better concurrency
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  createTables(db);
  return db;
}

export function getDb(): DatabaseType {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

function createTables(db: DatabaseType): void {
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      collection TEXT NOT NULL,
      mtime REAL NOT NULL,
      hash TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      token_count INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id)`);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content=chunks,
      content_rowid=id,
      tokenize='porter unicode61'
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_chunk_id ON chunk_embeddings(chunk_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      text_hash TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Entity extraction tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 1.0
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_entities_type_value ON chunk_entities(type, value)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_entities_chunk ON chunk_entities(chunk_id)`);

  // Knowledge graph tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity1 TEXT NOT NULL,
      entity1_type TEXT NOT NULL,
      relation TEXT NOT NULL,
      entity2 TEXT NOT NULL,
      entity2_type TEXT NOT NULL,
      source_chunk_id INTEGER REFERENCES chunks(id) ON DELETE CASCADE,
      confidence REAL DEFAULT 1.0
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_entity1 ON graph_edges(entity1)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_entity2 ON graph_edges(entity2)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_relation ON graph_edges(relation)`);

  console.log("[memory] Database tables initialized");
}

// Document operations
export function upsertDocument(doc: Document): number {
  const stmt = db!.prepare(`
    INSERT INTO documents (path, collection, mtime, hash)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      collection = excluded.collection,
      mtime = excluded.mtime,
      hash = excluded.hash,
      updated_at = datetime('now')
    RETURNING id
  `);

  const result = stmt.get(doc.path, doc.collection, doc.mtime, doc.hash) as { id: number };
  return result.id;
}

export function getDocument(path: string): Document | null {
  const stmt = db!.prepare("SELECT * FROM documents WHERE path = ?");
  return stmt.get(path) as Document | null;
}

export function deleteDocument(path: string): void {
  db!.prepare("DELETE FROM documents WHERE path = ?").run(path);
}

// Chunk operations
export function insertChunks(chunks: Chunk[]): void {
  const stmt = db!.prepare(`
    INSERT INTO chunks (doc_id, text, start_line, end_line, token_count)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db!.transaction((items: Chunk[]) => {
    for (const chunk of items) {
      stmt.run(chunk.docId, chunk.text, chunk.startLine, chunk.endLine, chunk.tokenCount);
    }
  });

  insertMany(chunks);
}

export function deleteChunks(docId: number): void {
  db!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId);
  embeddingCache = null;
}

export function deleteEmbeddings(chunkIds: number[]): void {
  if (chunkIds.length === 0) return;

  const placeholders = chunkIds.map(() => "?").join(",");
  const stmt = db!.prepare(`DELETE FROM chunk_embeddings WHERE chunk_id IN (${placeholders})`);
  stmt.run(...chunkIds);
  embeddingCache = null;
}

export function getAllChunks(docId: number): Chunk[] {
  const stmt = db!.prepare("SELECT * FROM chunks WHERE doc_id = ?");
  return stmt.all(docId) as Chunk[];
}

// Vector operations — in-memory cosine similarity
export function insertEmbeddings(chunkId: number, embedding: Float32Array): void {
  const stmt = db!.prepare("INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)");
  stmt.run(chunkId, Buffer.from(embedding.buffer));
  embeddingCache = null;
}

let embeddingCache: Array<{ chunkId: number; embedding: Float32Array }> | null = null;

function loadEmbeddingCache(): Array<{ chunkId: number; embedding: Float32Array }> {
  if (embeddingCache) return embeddingCache;
  const rows = db!.prepare("SELECT chunk_id, embedding FROM chunk_embeddings").all() as Array<{ chunk_id: number; embedding: Buffer }>;
  embeddingCache = rows.map(r => ({
    chunkId: r.chunk_id,
    embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
  }));
  console.log(`[memory] Loaded ${embeddingCache.length} embeddings into memory cache`);
  return embeddingCache;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function vectorSearch(queryEmbedding: Float32Array, limit: number, collections?: string[]): Array<{ chunkId: number; distance: number }> {
  const cache = loadEmbeddingCache();
  if (cache.length === 0) return [];

  let allowedChunkIds: Set<number> | null = null;
  if (collections && collections.length > 0) {
    const placeholders = collections.map(() => "?").join(",");
    const rows = db!.prepare(`
      SELECT c.id FROM chunks c
      JOIN documents d ON c.doc_id = d.id
      WHERE d.collection IN (${placeholders})
    `).all(...collections) as Array<{ id: number }>;
    allowedChunkIds = new Set(rows.map(r => r.id));
  }

  const scored: Array<{ chunkId: number; similarity: number }> = [];
  for (const entry of cache) {
    if (allowedChunkIds && !allowedChunkIds.has(entry.chunkId)) continue;
    scored.push({
      chunkId: entry.chunkId,
      similarity: cosineSimilarity(queryEmbedding, entry.embedding),
    });
  }

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, limit).map(s => ({
    chunkId: s.chunkId,
    distance: 1 - s.similarity,
  }));
}

export function invalidateEmbeddingCache(): void {
  embeddingCache = null;
}

function preprocessQuery(query: string): string {
  return query
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/~\//g, "")
    .replace(/\.lobs\//g, "")
    .replace(/workspace\//g, "");
}

export function bm25Search(query: string, limit: number, collections?: string[]): Array<{ id: number; rank: number }> {
  const processedQuery = preprocessQuery(query);

  const escapedQuery = processedQuery
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => `"${w.replace(/"/g, '""')}"`)
    .join(" ");

  try {
    if (collections && collections.length > 0) {
      const placeholders = collections.map(() => "?").join(",");
      const stmt = db!.prepare(`
        SELECT f.rowid as id, f.rank as rank
        FROM chunks_fts f
        JOIN chunks c ON c.id = f.rowid
        JOIN documents d ON d.id = c.doc_id
        WHERE chunks_fts MATCH ?
          AND d.collection IN (${placeholders})
        ORDER BY f.rank
        LIMIT ?
      `);
      return stmt.all(escapedQuery, ...collections, limit) as Array<{ id: number; rank: number }>;
    } else {
      const stmt = db!.prepare(`
        SELECT rowid as id, rank as rank
        FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      return stmt.all(escapedQuery, limit) as Array<{ id: number; rank: number }>;
    }
  } catch (err) {
    console.error("[memory] BM25 search error (returning empty results):", err);
    return [];
  }
}

// Embedding cache
export function getCachedEmbedding(textHash: string, model: string): Float32Array | null {
  const stmt = db!.prepare("SELECT embedding FROM embedding_cache WHERE text_hash = ? AND model = ?");
  const row = stmt.get(textHash, model) as { embedding: Buffer } | undefined;
  if (row) {
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }
  return null;
}

export function setCachedEmbedding(textHash: string, model: string, embedding: Float32Array): void {
  const stmt = db!.prepare(`
    INSERT OR REPLACE INTO embedding_cache (text_hash, model, embedding)
    VALUES (?, ?, ?)
  `);
  stmt.run(textHash, model, Buffer.from(embedding.buffer));
}

// Entity operations
export function insertEntities(chunkId: number, entities: Array<{ type: string; value: string; confidence: number }>): void {
  if (entities.length === 0) return;

  const stmt = db!.prepare(`
    INSERT INTO chunk_entities (chunk_id, type, value, confidence)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = db!.transaction((items: Array<{ type: string; value: string; confidence: number }>) => {
    for (const entity of items) {
      stmt.run(chunkId, entity.type, entity.value, entity.confidence);
    }
  });

  insertMany(entities);
}

export function getEntities(chunkId: number): Array<{ type: string; value: string; confidence: number }> {
  const stmt = db!.prepare("SELECT type, value, confidence FROM chunk_entities WHERE chunk_id = ?");
  return stmt.all(chunkId) as Array<{ type: string; value: string; confidence: number }>;
}

export function searchByEntity(type: string, value: string): Array<{ chunkId: number }> {
  const stmt = db!.prepare(`
    SELECT DISTINCT chunk_id as chunkId
    FROM chunk_entities
    WHERE type = ? AND LOWER(value) = LOWER(?)
  `);
  return stmt.all(type, value) as Array<{ chunkId: number }>;
}

// Graph operations
export function insertRelationships(relationships: Array<{
  entity1: string;
  entity1Type: string;
  relation: string;
  entity2: string;
  entity2Type: string;
  sourceChunkId: number;
  confidence: number;
}>): void {
  if (relationships.length === 0) return;

  const stmt = db!.prepare(`
    INSERT INTO graph_edges (entity1, entity1_type, relation, entity2, entity2_type, source_chunk_id, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db!.transaction((items: typeof relationships) => {
    for (const rel of items) {
      stmt.run(
        rel.entity1,
        rel.entity1Type,
        rel.relation,
        rel.entity2,
        rel.entity2Type,
        rel.sourceChunkId,
        rel.confidence,
      );
    }
  });

  insertMany(relationships);
}

export function queryGraph(entity: string, depth: number): Array<{
  entity1: string;
  entity1_type: string;
  relation: string;
  entity2: string;
  entity2_type: string;
  source_chunk_id: number;
}> {
  const stmt = db!.prepare(`
    SELECT entity1, entity1_type, relation, entity2, entity2_type, source_chunk_id
    FROM graph_edges
    WHERE LOWER(entity1) = LOWER(?) OR LOWER(entity2) = LOWER(?)
  `);

  return stmt.all(entity, entity) as Array<{
    entity1: string;
    entity1_type: string;
    relation: string;
    entity2: string;
    entity2_type: string;
    source_chunk_id: number;
  }>;
}

export function deleteEntities(chunkId: number): void {
  db!.prepare("DELETE FROM chunk_entities WHERE chunk_id = ?").run(chunkId);
}

export function deleteRelationships(chunkId: number): void {
  db!.prepare("DELETE FROM graph_edges WHERE source_chunk_id = ?").run(chunkId);
}

// Stats
export function getIndexStats() {
  const docCount = db!.prepare("SELECT COUNT(*) as count FROM documents").get() as { count: number };
  const chunkCount = db!.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };
  const collections = db!.prepare("SELECT DISTINCT collection FROM documents").all() as Array<{ collection: string }>;
  const lastUpdate = db!.prepare("SELECT MAX(updated_at) as lastUpdate FROM documents").get() as { lastUpdate: string | null };

  return {
    documents: docCount.count,
    chunks: chunkCount.count,
    collections: collections.map(c => c.collection),
    lastUpdate: lastUpdate.lastUpdate,
  };
}

export function getDetailedStats() {
  const collections = db!.prepare(`
    SELECT
      d.collection,
      COUNT(DISTINCT d.id) as documents,
      COUNT(c.id) as chunks,
      MAX(d.updated_at) as lastUpdate,
      SUM(c.token_count) as totalTokens
    FROM documents d
    LEFT JOIN chunks c ON c.doc_id = d.id
    GROUP BY d.collection
    ORDER BY d.collection
  `).all() as Array<{
    collection: string;
    documents: number;
    chunks: number;
    lastUpdate: string | null;
    totalTokens: number | null;
  }>;

  const embeddingCount = db!.prepare("SELECT COUNT(*) as count FROM chunk_embeddings").get() as { count: number };
  const cacheCount = db!.prepare("SELECT COUNT(*) as count FROM embedding_cache").get() as { count: number };

  const dbPath = db!.name;
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath).size;
  } catch { /* ignore */ }

  return {
    collections,
    embeddings: embeddingCount.count,
    embeddingCache: cacheCount.count,
    dbSizeBytes,
    dbSizeMB: Math.round(dbSizeBytes / 1024 / 1024 * 10) / 10,
  };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
