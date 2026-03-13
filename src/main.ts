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
import { startServer } from "./server.js";
import { setLogger, log } from "./util/logger.js";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { initToolGate } from "./runner/tool-gate.js";
import { getCronManager } from "./orchestrator/cron.js";
import { runHeartbeat } from "./orchestrator/heartbeat.js";
import { runReflection } from "./orchestrator/reflection.js";
import { browserService } from "./services/browser.js";
import { skillsService } from "./services/skills.js";
import { discordService } from "./services/discord.js";
import { loadDiscordConfig } from "./config/discord.js";

const HOME = process.env.HOME ?? "";
const DB_PATH = resolve(HOME, ".openclaw/plugins/lobs/lobs.db");
const SCAN_INTERVAL_MS = 10_000;
const HTTP_PORT = parseInt(process.env.LOBS_PORT ?? "9420", 10);

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

  // Initialize hook system and tool gating
  console.log("Initializing hook system...");
  initToolGate();

  // Load skills
  console.log("Loading skills...");
  skillsService.loadAll();
  console.log(`Loaded ${skillsService.getAll().length} skills`);

  // Set up cron jobs
  console.log("Setting up cron jobs...");
  const cronManager = getCronManager();
  
  // Heartbeat: every 30 minutes
  cronManager.addJob({
    id: "heartbeat",
    name: "System Heartbeat",
    schedule: "*/30 * * * *",
    enabled: true,
    handler: async () => {
      await runHeartbeat();
    },
  });
  
  // Reflection: every 6 hours
  cronManager.addJob({
    id: "reflection",
    name: "Self-Reflection",
    schedule: "0 */6 * * *",
    enabled: true,
    handler: async () => {
      await runReflection();
    },
  });
  
  cronManager.start();
  console.log("Cron manager started");

  // Start the control loop
  startControlLoop({} as any, SCAN_INTERVAL_MS);
  console.log(`Control loop started (scan every ${SCAN_INTERVAL_MS / 1000}s)`);

  // Start HTTP server (Nexus dashboard + API)
  startServer(HTTP_PORT);
  
  // Connect Discord bot if configured
  const discordConfig = loadDiscordConfig();
  if (discordConfig) {
    discordService.connect(discordConfig).catch(err => {
      console.error("[discord] Failed to connect:", err);
    });
  }
  
  console.log("=== lobs-core ready ===");

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await browserService.shutdown();
    await discordService.shutdown();
    cronManager.stop();
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
