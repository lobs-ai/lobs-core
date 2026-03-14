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
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { initToolGate } from "./runner/tool-gate.js";
import { getCronManager } from "./orchestrator/cron.js";
import { runHeartbeat } from "./orchestrator/heartbeat.js";
import { initCronService } from "./services/cron.js";
import { randomUUID } from "node:crypto";
import { browserService } from "./services/browser.js";
import { skillsService } from "./services/skills.js";
import { discordService } from "./services/discord.js";
import { loadDiscordConfig } from "./config/discord.js";
import { MainAgent } from "./services/main-agent.js";
import { loadWorkspaceContext, buildMainAgentPrompt } from "./services/workspace-loader.js";
import { setDiscordService as setMessageDiscord } from "./runner/tools/message.js";
import { validateAllConfigs } from "./config/validator.js";

const HOME = process.env.HOME ?? "";
const DB_PATH = resolve(HOME, ".lobs/lobs.db");
const PID_FILE = resolve(HOME, ".lobs/lobs.pid");
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

  // ── Runtime Failsafes ────────────────────────────────────────────────────

  // Uncaught exception handler — log and continue for non-critical errors
  process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught exception:", err);
    // Don't exit for non-critical errors (e.g., network timeouts, API errors)
    // Only exit for truly fatal errors (DB corruption, OOM, etc.)
    if (err.message?.includes("SQLITE_CORRUPT") || err.message?.includes("Cannot allocate memory")) {
      console.error("[FATAL] Critical error — shutting down");
      process.exit(1);
    }
  });

  // Unhandled rejection handler — log and continue
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[WARN] Unhandled rejection:", reason);
    // Don't crash on unhandled rejections (e.g., failed API calls, network timeouts)
  });

  // ── PID File Management ──────────────────────────────────────────────────

  if (existsSync(PID_FILE)) {
    const existingPid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    let alive = false;
    if (!isNaN(existingPid)) {
      try { process.kill(existingPid, 0); alive = true; } catch {}
    }
    if (alive) {
      console.error(`[FATAL] Another instance is already running (PID ${existingPid})`);
      console.error(`  Stop it first: lobs stop`);
      process.exit(1);
    }
    console.warn(`[WARN] Stale PID file found (PID ${existingPid}). Cleaning up.`);
    unlinkSync(PID_FILE);
  }

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`[PID] ${process.pid} (written to ${PID_FILE})`);

  // ── Startup Checks ───────────────────────────────────────────────────────

  // Ensure DB directory exists
  const dbDir = resolve(DB_PATH, "..");
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  // Validate config files
  console.log("Validating config...");
  const configValidation = validateAllConfigs();
  if (!configValidation.valid) {
    console.warn("[WARN] Config validation failed:");
    for (const result of configValidation.results) {
      if (!result.valid) {
        console.warn(`  - ${result.file}: ${result.errors.join(", ")}`);
      }
    }
    console.warn("[WARN] Continuing with degraded config...");
  } else {
    console.log("Config validation passed ✓");
  }

  if (configValidation.legacy_layout) {
    console.warn("[WARN] Using legacy config layout — run 'lobs init' to migrate");
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
  
  // Reflection: disabled (reflection.ts removed during simplification)
  // cronManager.addJob({
  //   id: "reflection",
  //   name: "Self-Reflection",
  //   schedule: "0 */6 * * *",
  //   enabled: true,
  //   handler: async () => {
  //     // await runReflection();
  //   },
  // });
  
  cronManager.start();
  console.log("Cron manager started");

  // Set up DB-backed cron service (agent-managed jobs / reminders)
  console.log("Setting up cron service...");
  const cronService = initCronService(getRawDb());
  cronService.seedDefaults();
  // Event handler wired after mainAgent is created (see below)
  cronService.start();

  // Start the control loop
  startControlLoop({} as any, SCAN_INTERVAL_MS);
  console.log(`Control loop started (scan every ${SCAN_INTERVAL_MS / 1000}s)`);

  // Start HTTP server (Nexus dashboard + API)
  startServer(HTTP_PORT);
  
  // Create and configure the main agent (always available — for Discord and/or Nexus chat)
  const rawDb = getRawDb();
  const mainAgent = new MainAgent(rawDb);
  mainAgent.setSystemPrompt(buildMainAgentPrompt());
  mainAgent.setWorkspaceContext(loadWorkspaceContext());
  
  // Export main agent globally so API handlers can access it
  (globalThis as any).__lobsMainAgent = mainAgent;

  // Wire cron events to main agent
  cronService.setEventHandler(async (text: string) => {
    console.log(`[cron] Firing event to main agent: ${text.slice(0, 80)}...`);
    await mainAgent.handleSystemEvent(text);
  });

  // Connect Discord bot (optional)
  const discordConfig = loadDiscordConfig();
  if (discordConfig) {
    try {
      await discordService.connect(discordConfig);

      // Wire Discord to message tool
      setMessageDiscord(discordService);

      // Wire reply handler — agent replies go to Discord
      mainAgent.setReplyHandler(async (channelId, content) => {
        await discordService.send(channelId, content);
      });

      // Wire typing handler
      mainAgent.setTypingHandler((channelId) => {
        discordService.sendTyping(channelId).catch(() => {});
      });

      // Wire incoming messages — Discord messages go to agent
      discordService.onMessage((msg) => {
        mainAgent.handleMessage({
          id: randomUUID(),
          content: msg.content,
          authorId: msg.authorId,
          authorName: msg.authorTag,
          channelId: msg.channelId,
          timestamp: Date.now(),
        });
      });

      console.log("[main-agent] Connected to Discord, ready for messages");
    } catch (err) {
      console.error("[discord] Failed to connect:", err);
    }
  }
  
  console.log("[main-agent] Ready (Discord: " + (discordConfig ? "enabled" : "disabled") + ")");
  
  console.log("=== lobs-core ready ===");

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    
    // Clean up PID file
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
      console.log("PID file removed");
    }
    
    await browserService.shutdown();
    await discordService.shutdown();
    cronService.stop();
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
