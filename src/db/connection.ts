/**
 * SQLite connection management for PAW plugin.
 * Uses better-sqlite3 (sync) with drizzle-orm wrapper.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type PawDB = BetterSQLite3Database<typeof schema>;

let db: PawDB | null = null;
let rawDb: Database.Database | null = null;

export function getRawDb(): Database.Database {
  if (!rawDb) {
    throw new Error("PAW database not initialized. Call initDb() first.");
  }
  return rawDb;
}

export function getDb(): PawDB {
  if (!db) {
    throw new Error("PAW database not initialized. Call initDb() first.");
  }
  return db;
}

export function initDb(dbPath: string): PawDB {
  if (db) return db;

  // Ensure directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  rawDb = new Database(dbPath);

  // Enable WAL mode for concurrent read/write
  rawDb.pragma("journal_mode = WAL");
  rawDb.pragma("busy_timeout = 5000");
  rawDb.pragma("foreign_keys = ON");

  db = drizzle(rawDb, { schema });
  return db;
}

export function closeDb(): void {
  if (rawDb) {
    rawDb.close();
    rawDb = null;
    db = null;
  }
}
