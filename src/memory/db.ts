/**
 * Memory database — separate SQLite instance at ~/.lobs/memory.db.
 *
 * Manages its own connection lifecycle, schema creation, and WAL setup.
 * Uses better-sqlite3 directly (same as lobs.db) rather than drizzle-orm,
 * keeping the memory layer self-contained with no ORM dependency.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../util/logger.js";

let _db: Database.Database | null = null;

/**
 * Default path for the memory database.
 */
export const DEFAULT_MEMORY_DB_PATH = resolve(homedir(), ".lobs", "memory.db");

/**
 * DDL for all memory tables and indexes.
 * Executed once at startup via initMemoryDb().
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  scope TEXT NOT NULL DEFAULT 'session',
  project_id TEXT,
  signal_score REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_signal ON events(signal_score) WHERE signal_score > 0.5;

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  scope TEXT NOT NULL DEFAULT 'system',
  agent_type TEXT,
  project_id TEXT,
  source_authority INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER,
  derived_at TEXT NOT NULL,
  last_validated TEXT,
  expires_at TEXT,
  last_accessed TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  reflection_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type, status);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, agent_type);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(last_accessed);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id INTEGER PRIMARY KEY REFERENCES memories(id),
  embedding BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  relationship TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_memory ON evidence(memory_id);
CREATE INDEX IF NOT EXISTS idx_evidence_event ON evidence(event_id);

CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_a INTEGER NOT NULL REFERENCES memories(id),
  memory_b INTEGER NOT NULL REFERENCES memories(id),
  description TEXT NOT NULL,
  resolution TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reflection_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  clusters_processed INTEGER DEFAULT 0,
  events_processed INTEGER DEFAULT 0,
  memories_created INTEGER DEFAULT 0,
  memories_reinforced INTEGER DEFAULT 0,
  conflicts_detected INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'running',
  skip_reason TEXT
);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  query TEXT NOT NULL,
  agent_id TEXT,
  score REAL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_retrieval_memory ON retrieval_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_time ON retrieval_log(timestamp);

CREATE TABLE IF NOT EXISTS gc_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (memory_id) REFERENCES memories(id)
);

CREATE INDEX IF NOT EXISTS idx_gc_log_memory ON gc_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_gc_log_time ON gc_log(created_at);

-- FTS5 full-text index for memories.content (porter stemmer for better recall)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content_rowid='id', tokenize='porter');

-- Keep memories_fts in sync with the memories table
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories BEGIN
  UPDATE memories_fts SET content = NEW.content WHERE rowid = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = OLD.id;
END;
`;

/**
 * Initialise (or reuse) the memory database connection.
 *
 * Safe to call multiple times — only creates the DB and runs DDL once.
 * Call this early in the startup sequence, before hooks are registered.
 *
 * @param dbPath - Path to the SQLite file. Defaults to ~/.lobs/memory.db.
 */
export function initMemoryDb(dbPath?: string): Database.Database {
  if (_db) return _db;

  const resolvedPath = dbPath ?? DEFAULT_MEMORY_DB_PATH;

  // Ensure the directory exists
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  // Performance & safety pragmas — same as lobs.db
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Apply schema (idempotent — all statements use IF NOT EXISTS)
  db.exec(SCHEMA_SQL);

  // ── Additive migrations ───────────────────────────────────────────────────
  // Existing DBs won't pick up new columns from CREATE TABLE IF NOT EXISTS.
  // Each ALTER TABLE is wrapped in try/catch — it fails silently if the column
  // already exists (SQLite error: "duplicate column name").
  const addColumnIfMissing = (table: string, column: string, definition: string): void => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch {
      // Column already exists — ignore
    }
  };

  addColumnIfMissing("reflection_runs", "events_processed", "INTEGER DEFAULT 0");
  addColumnIfMissing("reflection_runs", "skip_reason", "TEXT");

  _db = db;
  log().info(`[memory-db] Opened memory database at ${resolvedPath}`);
  return db;
}

/**
 * Return the active memory DB connection.
 * Throws if initMemoryDb() has not been called yet.
 */
export function getMemoryDb(): Database.Database {
  if (!_db) {
    throw new Error(
      "[memory-db] Memory database not initialised. Call initMemoryDb() at startup.",
    );
  }
  return _db;
}

/**
 * Close the memory database connection (used in tests / graceful shutdown).
 */
export function closeMemoryDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
