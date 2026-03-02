/**
 * Data migration tool — import existing lobs-server SQLite data into PAW plugin DB.
 *
 * Usage: Run once during cutover to copy tasks, projects, agents, worker runs,
 * workflow definitions, etc. from the old lobs-server database.
 *
 * This is a standalone script, not part of the plugin runtime.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const OLD_DB_PATH = process.env.OLD_DB ?? `${process.env.HOME}/lobs-server/lobs.db`;
const NEW_DB_PATH = process.env.NEW_DB ?? `${process.env.HOME}/.openclaw/plugins/paw/paw.db`;

// Tables to migrate in order (respecting foreign key dependencies)
const TABLES_IN_ORDER = [
  "projects",
  "tasks",
  "agent_profiles",
  "agent_status",
  "worker_runs",
  "inbox_items",
  "workflow_definitions",
  "workflow_runs",
  "workflow_events",
  "workflow_subscriptions",
  "control_loop_events",
  "model_usage_events",
  "agent_reflections",
  "agent_initiatives",
  "scheduled_events",
  "orchestrator_settings",
  // Phase 3-5 tables
  "agent_capabilities",
  "agent_identity_versions",
  "system_sweeps",
  "initiative_decision_records",
  "task_outcomes",
  "outcome_learnings",
  "routine_registry",
  "routine_audit_events",
  "learning_plans",
  "learning_lessons",
  "chat_sessions",
  "chat_messages",
  "diagnostic_trigger_events",
  "model_pricing",
  "research_memos",
];

function migrate(): void {
  console.log(`Migrating from ${OLD_DB_PATH} → ${NEW_DB_PATH}`);

  const oldDb = new Database(OLD_DB_PATH, { readonly: true });
  const newDb = new Database(NEW_DB_PATH);

  newDb.pragma("journal_mode = WAL");
  newDb.pragma("foreign_keys = OFF"); // Disable during migration

  let totalRows = 0;

  for (const table of TABLES_IN_ORDER) {
    try {
      // Check if source table exists
      const exists = oldDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(table);

      if (!exists) {
        console.log(`  ⏭  ${table}: not in source DB, skipping`);
        continue;
      }

      // Check if destination table exists
      const destExists = newDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(table);

      if (!destExists) {
        console.log(`  ⏭  ${table}: not in destination DB, skipping`);
        continue;
      }

      const rows = oldDb.prepare(`SELECT * FROM ${table}`).all();
      if (rows.length === 0) {
        console.log(`  ⏭  ${table}: empty`);
        continue;
      }

      // Get column names from destination
      const destCols = newDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const destColNames = new Set(destCols.map(c => c.name));

      // Get column names from source
      const srcCols = oldDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const commonCols = srcCols.filter(c => destColNames.has(c.name)).map(c => c.name);

      if (commonCols.length === 0) {
        console.log(`  ⚠️  ${table}: no common columns`);
        continue;
      }

      const placeholders = commonCols.map(() => "?").join(", ");
      const colList = commonCols.join(", ");
      const insertStmt = newDb.prepare(
        `INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`
      );

      const insertMany = newDb.transaction((data: unknown[][]) => {
        for (const row of data) {
          insertStmt.run(...row);
        }
      });

      const rowData = rows.map(row => {
        const r = row as Record<string, unknown>;
        return commonCols.map(col => r[col]);
      });

      insertMany(rowData);
      totalRows += rows.length;
      console.log(`  ✅ ${table}: ${rows.length} rows migrated (${commonCols.length} cols)`);
    } catch (e) {
      console.error(`  ❌ ${table}: ${e}`);
    }
  }

  newDb.pragma("foreign_keys = ON");
  oldDb.close();
  newDb.close();

  console.log(`\nMigration complete: ${totalRows} total rows across ${TABLES_IN_ORDER.length} tables`);
}

migrate();
