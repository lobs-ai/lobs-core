import { describe, test, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

function createTasksTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      owner TEXT,
      work_state TEXT DEFAULT 'not_started',
      review_state TEXT,
      project_id TEXT,
      notes TEXT,
      artifact_path TEXT,
      started_at TEXT,
      finished_at TEXT,
      sort_order INTEGER DEFAULT 0,
      blocked_by TEXT,
      pinned INTEGER DEFAULT 0,
      shape TEXT,
      github_issue_number INTEGER,
      agent TEXT,
      model_tier TEXT,
      escalation_tier INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      failure_reason TEXT,
      last_retry_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function runMigration(db: Database.Database) {
  // Idempotent: add updated_at column if missing
  try { db.exec(`ALTER TABLE tasks ADD COLUMN updated_at TEXT`); } catch (_) { /* already exists */ }
  // Backfill updated_at = created_at for rows where it was never set
  db.exec(`UPDATE tasks SET updated_at = created_at WHERE updated_at IS NULL`);
}

describe("updated_at migration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createTasksTable(db);
  });

  test("adds updated_at column and backfills from created_at", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    db.prepare(`INSERT INTO tasks (id, title, status, created_at) VALUES (?, ?, ?, ?)`)
      .run("task-1", "Test task", "active", createdAt);

    runMigration(db);

    const row = db.prepare("SELECT updated_at, created_at FROM tasks WHERE id = ?").get("task-1") as {
      updated_at: string;
      created_at: string;
    };
    expect(row.updated_at).toBe(createdAt);
    expect(row.updated_at).toBe(row.created_at);
    db.close();
  });

  test("leaves existing updated_at values untouched", () => {
    // Pre-create the column and insert a row with an already-set updated_at
    db.exec(`ALTER TABLE tasks ADD COLUMN updated_at TEXT`);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const existingUpdatedAt = "2026-02-01T00:00:00.000Z";
    db.prepare(`INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run("task-2", "Another task", "active", createdAt, existingUpdatedAt);

    runMigration(db);

    const row = db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get("task-2") as {
      updated_at: string;
    };
    expect(row.updated_at).toBe(existingUpdatedAt);
    db.close();
  });

  test("idempotent — safe to run twice", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    db.prepare(`INSERT INTO tasks (id, title, status, created_at) VALUES (?, ?, ?, ?)`)
      .run("task-3", "Idempotent test", "active", createdAt);

    runMigration(db);
    runMigration(db); // run twice

    const row = db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get("task-3") as {
      updated_at: string;
    };
    expect(row.updated_at).toBe(createdAt);
    db.close();
  });
});
