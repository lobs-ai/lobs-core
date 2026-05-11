/**
 * MemoryIndex — per-agent semantic search index.
 *
 * Each agent gets its own SQLite index (WAL mode, isolated).
 *
 * Index update strategy (per SPEC):
 *   1. on-change  → file watcher fires → incremental index update
 *   2. periodic   → fallback scan catches drift (1h default)
 *
 * Embedding: local LM Studio (text-embedding-qwen3-embedding-4b on port 7420)
 * Backup: 5-minute rotation
 * Versioning: Option A — plugin reports version, agent can verify
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync, existsSync, statSync, readFileSync, watch, readdirSync } from "node:fs";
import { join, extname, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { log } from "../../util/logger.js";
import type { MemoryPluginConfig } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryRecord {
  id: string;
  agentId: string;
  filePath: string;
  lineFrom: number;
  lineTo: number;
  content: string;
  chunkHash: string;
  vectorId: number | null; // FK into vectors table, null until indexed
  indexedAt: number | null; // unix ms
  createdAt: number;
  updatedAt: number;
}

export interface SearchResult {
  record: MemoryRecord;
  score: number;
  context: string; // pre/post surrounding lines
}

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  dbOk: boolean;
  embedderOk: boolean;
  lastIndex: number | null;
  indexSize: number; // total records
  backupOk: boolean;
  errors: string[];
}

export interface IndexStatus {
  indexedDocs: number;
  lastSync: number | null;
  collections: string[]; // unique file paths
  dbSizeKb: number;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory_records (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  line_from   INTEGER NOT NULL,
  line_to     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  chunk_hash  TEXT NOT NULL,
  vector_id   INTEGER,
  indexed_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_vectors (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL UNIQUE,
  vector    BLOB NOT NULL,
  FOREIGN KEY (record_id) REFERENCES memory_records(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_backup_meta (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_backup INTEGER NOT NULL,
  last_index  INTEGER,
  version     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path  TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- 'index' | 'delete' | 'backup'
  took_ms    INTEGER,
  records    INTEGER,
  error      TEXT,
  ts         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_agent   ON memory_records(agent_id);
CREATE INDEX IF NOT EXISTS idx_records_path    ON memory_records(file_path);
CREATE INDEX IF NOT EXISTS idx_records_hash   ON memory_records(chunk_hash);
CREATE INDEX IF NOT EXISTS idx_vectors_record ON memory_vectors(record_id);
`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function makeRecordId(filePath: string, lineFrom: number, lineTo: number): string {
  const input = `${filePath}:${lineFrom}-${lineTo}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Chunk text into line-bounded records of roughly chunkSize characters. */
function chunkFile(content: string, filePath: string, chunkSize = 400): Omit<MemoryRecord, "id" | "agentId" | "vectorId" | "indexedAt">[] {
  const lines = content.split("\n");
  const records: Omit<MemoryRecord, "id" | "agentId" | "vectorId" | "indexedAt">[] = [];
  let lineFrom = 1;
  let buffer: string[] = [];
  let lineCount = 0;

  for (const line of lines) {
    buffer.push(line);
    lineCount++;
    // Emit a chunk when large enough OR at end of file
    if (buffer.join("\n").length >= chunkSize || line === lines[lines.length - 1]) {
      const content = buffer.join("\n");
      const lineTo = lineFrom + lineCount - 1;
      records.push({
        filePath,
        lineFrom,
        lineTo,
        content,
        chunkHash: hashContent(content),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      lineFrom = lineTo + 1;
      buffer = [];
      lineCount = 0;
    }
  }
  return records;
}

/** Collect all watched file paths recursively. */
function collectWatchedFiles(paths: string[]): string[] {
  const files: string[] = [];
  const EXTENSIONS = new Set([".ts", ".js", ".md", ".txt", ".json", ".yaml", ".yml", ".sh", ".py", ".html", ".css"]);

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const stat = statSync(p);
    if (stat.isFile()) {
      if (EXTENSIONS.has(extname(p))) files.push(p);
    } else if (stat.isDirectory()) {
      try {
        const entries = readdirSync(p, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            files.push(...collectWatchedFiles([join(p, entry.name)]));
          } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
            files.push(join(p, entry.name));
          }
        }
      } catch {
        // skip inaccessible dirs
      }
    }
  }
  return files;
}

/** Read a text file safely, returning null on error. */
function readTextFile(p: string): string | null {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

// ── LM Studio Embedding ──────────────────────────────────────────────────────

interface EmbedderClient {
  embed(texts: string[]): Promise<number[][]>;
  ping(): Promise<boolean>;
}

function createEmbedderClient(url: string, model: string): EmbedderClient {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const res = await fetch(`${url}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: texts, model }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(`LM Studio embed failed ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as { data?: { embedding: number[] }[] };
      return (json.data ?? []).map((d) => d.embedding);
    },
    async ping(): Promise<boolean> {
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

// ── MemoryIndex ──────────────────────────────────────────────────────────────

export interface CreateMemoryIndexOptions {
  indexPath: string;
  backupDir: string;
  watchPaths: string[];
  embedder: { url: string; model: string };
  backupIntervalMs: number;
  scanIntervalMs: number;
  agentId?: string;
}

export interface MemoryIndex {
  search(query: string, limit?: number): Promise<SearchResult[]>;
  expandQuery(query: string): Promise<string>;
  refreshMemory(): Promise<number>;
  indexPaths(paths?: string[]): Promise<number>;
  health(): Promise<HealthStatus>;
  status(): Promise<IndexStatus>;
  close(): Promise<void>;
}

export async function createAgentMemory(opts: CreateMemoryIndexOptions): Promise<MemoryIndex> {
  const agentId = opts.agentId ?? "default";
  const indexDir = opts.indexPath;
  const backupDir = opts.backupDir;
  const embedder = createEmbedderClient(opts.embedder.url, opts.embedder.model);

  // ── Ensure directories exist ───────────────────────────────────────
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });

  // ── Open SQLite ──────────────────────────────────────────────────────
  const dbPath = join(indexDir, `${agentId}.db`);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  // ── Backup meta ─────────────────────────────────────────────────────
  const existingMeta = db
    .prepare("SELECT last_backup, last_index, version FROM memory_backup_meta WHERE id = 1")
    .get() as { last_backup: number; last_index: number | null; version: string } | undefined;
  if (!existingMeta) {
    db.prepare("INSERT INTO memory_backup_meta (id, last_backup, last_index, version) VALUES (1, 0, NULL, ?)").run("0.1.0");
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  function upsertRecords(
    records: Omit<MemoryRecord, "id" | "agentId" | "vectorId" | "indexedAt">[]
  ): number {
    const upsert = db.prepare(`
      INSERT INTO memory_records (id, agent_id, file_path, line_from, line_to, content, chunk_hash, vector_id, indexed_at, created_at, updated_at)
      VALUES (@id, @agentId, @filePath, @lineFrom, @lineTo, @content, @chunkHash, NULL, NULL, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        content     = excluded.content,
        chunk_hash  = excluded.chunk_hash,
        indexed_at  = NULL,
        vector_id   = NULL,
        updated_at  = excluded.updated_at
    `);
    let count = 0;
    const insertMany = db.transaction((recs: Omit<MemoryRecord, "id" | "agentId" | "vectorId" | "indexedAt">[]) => {
      for (const r of recs) {
        upsert.run({
          id: makeRecordId(r.filePath, r.lineFrom, r.lineTo),
          agentId,
          filePath: r.filePath,
          lineFrom: r.lineFrom,
          lineTo: r.lineTo,
          content: r.content,
          chunkHash: r.chunkHash,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        count++;
      }
      return count;
    });
    return insertMany(records);
  }

  async function indexRecordsWithVectors(
    records: Omit<MemoryRecord, "id" | "agentId" | "vectorId" | "indexedAt">[]
  ): Promise<number> {
    if (records.length === 0) return 0;
    const texts = records.map((r) => r.content);
    let vectors: number[][] = [];
    try {
      vectors = await embedder.embed(texts);
    } catch (err) {
      log().warn(`[lobs-memory] embedding batch failed: ${err}`);
    }
    const insert = db.prepare(`
      INSERT INTO memory_vectors (record_id, vector) VALUES (?, ?)
      ON CONFLICT(record_id) DO UPDATE SET vector = excluded.vector
    `);
    const updateRecord = db.prepare(`
      UPDATE memory_records SET vector_id = (
        SELECT id FROM memory_vectors WHERE record_id = memory_records.id
      ), indexed_at = ?
      WHERE id = ?
    `);
    let count = 0;
    const tx = db.transaction(() => {
      for (let i = 0; i < records.length; i++) {
        if (vectors[i] && vectors[i].length > 0) {
          const vecBlob = Buffer.from(new Float32Array(vectors[i]).buffer);
          const id = makeRecordId(records[i].filePath, records[i].lineFrom, records[i].lineTo);
          insert.run(id, vecBlob);
          updateRecord.run(Date.now(), id);
          count++;
        }
      }
    });
    tx();
    return count;
  }

  function logSync(filePath: string, eventType: string, tookMs: number, records = 0, error = ""): void {
    try {
      db.prepare(`
        INSERT INTO memory_sync_log (file_path, event_type, took_ms, records, error, ts)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(filePath, eventType, tookMs, records, error, Date.now());
    } catch {
      // non-fatal
    }
  }

  // ── Index a single file ───────────────────────────────────────────────
  async function indexFile(filePath: string): Promise<number> {
    const t0 = Date.now();
    const text = readTextFile(filePath);
    if (text === null) return 0;
    const chunks = chunkFile(text, filePath);
    const count = upsertRecords(chunks);
    const indexed = await indexRecordsWithVectors(chunks);
    logSync(filePath, "index", Date.now() - t0, indexed);
    return indexed;
  }

  // ── Periodic scan (fallback) ────────────────────────────────────────────
  let scanTimer: ReturnType<typeof setInterval> | null = null;

  async function periodicScan(): Promise<void> {
    log().info(`[lobs-memory] periodic scan starting`);
    const files = collectWatchedFiles(opts.watchPaths);
    let total = 0;
    for (const f of files) {
      try {
        total += await indexFile(f);
      } catch (err) {
        log().warn(`[lobs-memory] periodic scan: ${f}: ${err}`);
      }
    }
    db.prepare("UPDATE memory_backup_meta SET last_index = ? WHERE id = 1").run(Date.now());
    log().info(`[lobs-memory] periodic scan done — indexed ${total} records`);
  }

  // ── Backup (5-min rotation) ────────────────────────────────────────────
  let backupTimer: ReturnType<typeof setInterval> | null = null;
  const MAX_BACKUPS = 5;

  function runBackup(): void {
    const t0 = Date.now();
    try {
      // Rotate: remove oldest beyond MAX_BACKUPS
      const { readdirSync, unlinkSync, statSync } = require("node:fs");
      const files = readdirSync(backupDir)
        .filter((f: string) => f.startsWith(`${agentId}.backup`) && f.endsWith(".db"))
        .map((f: string) => ({ name: f, path: join(backupDir, f), mtime: statSync(join(backupDir, f)).mtime.getTime() }))
        .sort((a: { mtime: number }, b: { mtime: number }) => a.mtime - b.mtime);

      while (files.length >= MAX_BACKUPS) {
        const oldest = files.shift()!;
        unlinkSync(oldest.path);
      }

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = join(backupDir, `${agentId}.backup.${ts}.db`);
      db.backup(dest);
      db.prepare("UPDATE memory_backup_meta SET last_backup = ? WHERE id = 1").run(Date.now());
      log().info(`[lobs-memory] backup done in ${Date.now() - t0}ms → ${dest}`);
    } catch (err) {
      log().error(`[lobs-memory] backup failed: ${err}`);
    }
  }

  // ── File watcher ──────────────────────────────────────────────────────
  const watchedDirs = new Set<string>();

  function startWatcher(): void {
    for (const wp of opts.watchPaths) {
      const abs = isAbsolute(wp) ? wp : join(process.cwd(), wp);
      if (!existsSync(abs)) continue;
      if (watchedDirs.has(abs)) continue;
      watchedDirs.add(abs);
      try {
        watch(abs, { recursive: true }, async (_eventType, filename) => {
          if (!filename) return;
          const fullPath = join(abs, filename);
          if (!existsSync(fullPath)) return;
          try {
            await indexFile(fullPath);
          } catch (err) {
            log().warn(`[lobs-memory] watcher: ${fullPath}: ${err}`);
          }
        });
        log().info(`[lobs-memory] watching ${abs}`);
      } catch (err) {
        log().warn(`[lobs-memory] could not watch ${abs}: ${err}`);
      }
    }
  }

  // ── Start timers ─────────────────────────────────────────────────────
  startWatcher();
  backupTimer = setInterval(runBackup, opts.backupIntervalMs);
  scanTimer = setInterval(periodicScan, opts.scanIntervalMs);

  // Run an initial scan (non-blocking)
  periodicScan().catch((err) => log().warn(`[lobs-memory] initial scan: ${err}`));

  // ── Search ───────────────────────────────────────────────────────────
  async function search(query: string, limit = 5): Promise<SearchResult[]> {
    // Embed the query
    let queryVector: number[] = [];
    try {
      const [vec] = await embedder.embed([query]);
      queryVector = vec;
    } catch (err) {
      log().warn(`[lobs-memory] search embed failed: ${err}`);
      return [];
    }

    // cosine similarity via dot product (vectors stored as blobs, query vector as float[])
    // Pull candidate records (those with vectors) — limit to 100 for performance
    interface Row extends MemoryRecord {
      vector: Buffer | null;
    }
    const rows = db
      .prepare(
        `SELECT r.*
         FROM memory_records r
         JOIN memory_vectors v ON v.record_id = r.id
         WHERE r.agent_id = ?
         LIMIT 100`
      )
      .all(agentId) as Row[];

    if (rows.length === 0) return [];

    // Score each row using cosine similarity
    const scored = rows
      .map((row) => {
        if (!row.vector) return { row, score: 0 };
        const stored = new Float32Array(row.vector.buffer);
        let dot = 0,
          normQ = 0,
          normS = 0;
        for (let i = 0; i < stored.length && i < queryVector.length; i++) {
          dot += queryVector[i] * stored[i];
          normQ += queryVector[i] * queryVector[i];
          normS += stored[i] * stored[i];
        }
        const score = normQ && normS ? dot / (Math.sqrt(normQ) * Math.sqrt(normS)) : 0;
        return { row, score };
      })
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ row, score }) => ({
      record: row,
      score: Math.round(score * 1000) / 1000,
      context: row.content.slice(0, 300),
    }));
  }

  // ── Query expansion (synonym-based) ─────────────────────────────────
  const SYNONYMS: Record<string, string[]> = {
    // Programming
    bug: ["defect", "issue", "error", "fault"],
    feat: ["feature", "functionality", "enhancement"],
    refactor: ["restructure", "rework", "rewrite"],
    test: ["spec", "case", "coverage"],
    // Project
    memory: ["storage", "index", "persist"],
    search: ["find", "lookup", "query", "retrieve"],
    sync: ["sync", "synchronize", "backup"],
    config: ["configuration", "settings", "options"],
  };

  async function expandQuery(query: string): Promise<string> {
    const lower = query.toLowerCase();
    const terms = lower.split(/\s+/);
    const expanded = new Set<string>(terms);

    for (const term of terms) {
      const synonyms = SYNONYMS[term] ?? [];
      for (const syn of synonyms) {
        // Only add synonym if it adds information (not already in query)
        if (!lower.includes(syn)) {
          expanded.add(syn);
        }
      }
    }

    return Array.from(expanded).join(" ");
  }

  // ── Refresh (full re-index) ────────────────────────────────────────
  async function refreshMemory(): Promise<number> {
    log().info(`[lobs-memory] refreshMemory: forcing full re-index`);
    const files = collectWatchedFiles(opts.watchPaths);
    let total = 0;
    for (const f of files) {
      try {
        total += await indexFile(f);
      } catch (err) {
        log().warn(`[lobs-memory] refreshMemory: ${f}: ${err}`);
      }
    }
    db.prepare("UPDATE memory_backup_meta SET last_index = ? WHERE id = 1").run(Date.now());
    log().info(`[lobs-memory] refreshMemory done — indexed ${total} records`);
    return total;
  }

  // ── Public API ────────────────────────────────────────────────────────
  return {
    search,
    expandQuery,
    refreshMemory,
    async indexPaths(paths?: string[]): Promise<number> {
      const files = paths?.length ? paths : collectWatchedFiles(opts.watchPaths);
      let total = 0;
      for (const f of files) {
        try {
          total += await indexFile(f);
        } catch (err) {
          log().warn(`[lobs-memory] indexPaths: ${f}: ${err}`);
        }
      }
      db.prepare("UPDATE memory_backup_meta SET last_index = ? WHERE id = 1").run(Date.now());
      return total;
    },

    async health(): Promise<HealthStatus> {
      const errors: string[] = [];
      let dbOk = false;
      let embedderOk = false;
      let lastIndex: number | null = null;
      let indexSize = 0;
      let backupOk = false;

      try {
        db.prepare("SELECT count(*) as c FROM memory_records WHERE agent_id = ?").get(agentId);
        dbOk = true;
      } catch (err) {
        errors.push(`db: ${err}`);
      }

      try {
        embedderOk = await embedder.ping();
      } catch (err) {
        errors.push(`embedder: ${err}`);
      }

      try {
        const meta = db
          .prepare("SELECT last_index, last_backup FROM memory_backup_meta WHERE id = 1")
          .get() as { last_index: number | null; last_backup: number };
        lastIndex = meta.last_index;
        const interval = opts.backupIntervalMs;
        backupOk = meta.last_backup > Date.now() - interval * 2;
      } catch (err) {
        errors.push(`backup meta: ${err}`);
      }

      try {
        const { c } = db
          .prepare("SELECT count(*) as c FROM memory_records WHERE agent_id = ?")
          .get(agentId) as { c: number };
        indexSize = c;
      } catch {
        // already handled
      }

      const status: HealthStatus = {
        status: dbOk && embedderOk ? "ok" : dbOk ? "degraded" : "down",
        dbOk,
        embedderOk,
        lastIndex,
        indexSize,
        backupOk,
        errors,
      };
      return status;
    },

    async status(): Promise<IndexStatus> {
      const collections = db
        .prepare("SELECT DISTINCT file_path FROM memory_records WHERE agent_id = ?")
        .all(agentId) as { file_path: string }[];
      const lastIndexRow = db
        .prepare("SELECT last_index FROM memory_backup_meta WHERE id = 1")
        .get() as { last_index: number | null } | undefined;
      const { count } = db
        .prepare("SELECT count(*) as count FROM memory_records WHERE agent_id = ?")
        .get(agentId) as { count: number };

      let dbSizeKb = 0;
      try {
        const { statSync } = require("node:fs");
        dbSizeKb = Math.round(statSync(dbPath).size / 1024);
      } catch {}

      return {
        indexedDocs: count,
        lastSync: lastIndexRow?.last_index ?? null,
        collections: collections.map((c) => c.file_path),
        dbSizeKb,
      };
    },

    async close(): Promise<void> {
      if (backupTimer) clearInterval(backupTimer);
      if (scanTimer) clearInterval(scanTimer);
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}