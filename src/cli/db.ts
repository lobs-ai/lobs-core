/**
 * Shared DB connection for CLI tools.
 * Uses the same path as the PAW plugin runtime.
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = process.env.PAW_DB_PATH ?? join(homedir(), ".openclaw/plugins/paw/paw.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
  }
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
