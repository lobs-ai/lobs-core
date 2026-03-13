/**
 * lobs-core — standalone entry point
 *
 * Runs the orchestrator control loop independently of OpenClaw.
 * OpenClaw is only used for the main session (Lobs ↔ Rafe chat).
 * Worker agents run through our own agent runner.
 */

import { initDb, closeDb, getRawDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { seedDefaultWorkflows } from "./workflow/seeds.js";
import { startControlLoop, stopControlLoop } from "./orchestrator/control-loop.js";
import { setLogger, log } from "./util/logger.js";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const HOME = process.env.HOME ?? "";
const DB_PATH = resolve(HOME, ".openclaw/plugins/lobs/lobs.db");
const SCAN_INTERVAL_MS = 10_000;

// Simple console logger matching the OpenClaw logger interface
const consoleLogger = {
  info: (msg: string) => console.log(`[lobs] ${msg}`),
  warn: (msg: string) => console.warn(`[lobs] WARN ${msg}`),
  error: (msg: string) => console.error(`[lobs] ERROR ${msg}`),
  debug: (msg: string) => {
    if (process.env.LOBS_DEBUG) console.log(`[lobs] DEBUG ${msg}`);
  },
};

async function main() {
  console.log("=== lobs-core starting (standalone) ===");

  // Set up logger
  setLogger(consoleLogger as any);

  // Ensure DB directory exists
  const dbDir = resolve(DB_PATH, "..");
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  // Initialize database
  const db = initDb(DB_PATH);
  console.log(`Database initialized: ${DB_PATH}`);

  // Run migrations
  try {
    runMigrations(db);
    console.log("Migrations complete");
  } catch (err) {
    console.warn(`Migration warning: ${err}`);
  }

  // Seed default workflows
  try {
    seedDefaultWorkflows();
  } catch (err) {
    console.warn(`Workflow seed warning: ${err}`);
  }

  // Start the control loop
  startControlLoop({} as any, SCAN_INTERVAL_MS);
  console.log(`Control loop started (scan every ${SCAN_INTERVAL_MS / 1000}s)`);
  console.log("=== lobs-core ready ===");

  // Handle shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    stopControlLoop();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
