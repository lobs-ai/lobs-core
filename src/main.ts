/**
 * lobs-core — standalone entry point
 *
 * Runs the orchestrator control loop independently of any external host.
 * Lobs owns the main session and worker execution paths.
 * Worker agents run through our own agent runner.
 */

import { initDb, closeDb, getRawDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { seedDefaultWorkflows } from "./workflow/seeds.js";
import { startControlLoop, stopControlLoop, flushWorkerCheckpoints } from "./orchestrator/control-loop.js";
import { startServer } from "./server.js";
import { purgeOldArchivedSessions } from "./api/chat.js";
import { setLogger, log } from "./util/logger.js";
import { resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync, statSync, appendFileSync } from "node:fs";
import { initToolGate } from "./runner/tool-gate.js";
import { runHeartbeat } from "./orchestrator/heartbeat.js";
import { initCronService } from "./services/cron.js";
import { runSentinelCheck } from "./services/system-sentinel.js";
import { runCalendarSentinel } from "./services/calendar-sentinel.js";
import { refreshSchedulerIntelligence } from "./services/scheduler-intelligence.js";
import { runNightlyPlanner } from "./services/nightly-planner.js";
import { randomUUID } from "node:crypto";
import { browserService } from "./services/browser.js";
import { skillsService } from "./services/skills.js";
import { discordService } from "./services/discord.js";
import { loadDiscordConfig } from "./config/discord.js";
import { MainAgent } from "./services/main-agent.js";
import { loadWorkspaceContext, buildMainAgentPrompt } from "./services/workspace-loader.js";
import { setDiscordToolDiscord } from "./runner/tools/index.js";
import { validateAllConfigs } from "./config/validator.js";
import { initMemory, shutdownMemory } from "./services/memory/index.js";
import { initMemoryDb } from "./memory/db.js";
import { initFileIndexer, stopFileIndexer } from "./memory/indexer.js";
import { registerEventRecorderHook } from "./hooks/event-recorder.js";
import { registerReflectionTriggerHook } from "./hooks/reflection-trigger.js";
import { runDailyReflection } from "./memory/daily-reflection.js";
import { imagineService } from "./services/imagine.js";
import { countActiveWorkers, getActiveWorkers } from "./orchestrator/worker-manager.js";
import { runStartupTelemetry, startDiskSpaceMonitor } from "./services/restart-telemetry.js";
import { getGatewayConfig } from "./config/lobs.js";
import { WorkerRegistry } from "./workers/index.js";
import { MemoryProcessorWorker } from "./workers/memory-processor.js";
import { ResearchProcessorWorker } from "./workers/research-processor.js";
import { IntelSweepWorker } from "./workers/intel-sweep.js";
import { ResearchRadarWorker } from "./workers/research-radar.js";
import { initResearchQueueService } from "./services/research-queue.js";
import { initIntelSweepService } from "./services/intel-sweep.js";
import { initResearchRadarService } from "./services/research-radar.js";
import { runLmStudioAlertCheck } from "./services/lm-studio-monitor.js";
import { runDbMaintenance } from "./services/db-maintenance.js";
import { VoiceManager } from "./services/voice/index.js";

const HOME = process.env.HOME ?? "";
const DB_PATH = resolve(HOME, ".lobs/lobs.db");
const PID_FILE = resolve(HOME, ".lobs/lobs.pid");
const LOG_FILE = resolve(HOME, ".lobs/lobs.log");
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const LOG_KEEP = 3; // keep lobs.log.1, .2, .3
const SCAN_INTERVAL_MS = 10_000;
const HTTP_PORT = parseInt(process.env.LOBS_PORT ?? "9420", 10);
const ACTIVITY_LOG_INTERVAL_MS = 30_000;
const LOG_TO_FILE = process.env.LOBS_LOG_TO_FILE !== "0";

/** Rotate log file if it exceeds LOG_MAX_BYTES. Returns previous size when rotated. */
function rotateLogFile(): number | null {
  try {
    if (!existsSync(LOG_FILE)) return null;
    const size = statSync(LOG_FILE).size;
    if (size < LOG_MAX_BYTES) return null;

    // Shift existing rotated logs: .3 → delete, .2 → .3, .1 → .2
    for (let i = LOG_KEEP; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (i === LOG_KEEP && existsSync(from)) unlinkSync(from);
      else if (existsSync(from)) renameSync(from, to);
    }

    // Current → .1
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
    return size;
  } catch (err) {
    return null;
  }
}

function installRuntimeLogging(): void {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const mirrorToStdio = process.stdout.isTTY || process.stderr.isTTY || process.env.LOBS_LOG_MIRROR_STDIO === "1";
  let fileWriteFailed = false;

  const stringifyArg = (arg: unknown): string => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  };

  const writeRaw = (stream: "stdout" | "stderr", line: string) => {
    if (mirrorToStdio) {
      (stream === "stderr" ? stderr : stdout)(`${line}\n`);
    }
  };

  const appendToLogFile = (line: string) => {
    if (!LOG_TO_FILE) return;
    try {
      mkdirSync(resolve(LOG_FILE, ".."), { recursive: true });
      const payload = `${line}\n`;
      const currentSize = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
      if (currentSize + Buffer.byteLength(payload) > LOG_MAX_BYTES) {
        const rotatedBytes = rotateLogFile();
        if (rotatedBytes !== null) {
          const notice = `[${new Date().toISOString()}] INFO [log] Rotated log (was ${(rotatedBytes / 1024 / 1024).toFixed(1)} MB)`;
          appendFileSync(LOG_FILE, `${notice}\n`);
          writeRaw("stdout", notice);
        }
      }
      appendFileSync(LOG_FILE, payload);
      fileWriteFailed = false;
    } catch (err) {
      if (!fileWriteFailed) {
        writeRaw("stderr", `[${new Date().toISOString()}] ERROR [log] Failed to append to ${LOG_FILE}: ${String(err)}`);
      }
      fileWriteFailed = true;
    }
  };

  const writeLine = (stream: "stdout" | "stderr", level: string, args: unknown[]) => {
    const timestamp = new Date().toISOString();
    const message = args.map(stringifyArg).join(" ");
    const line = `[${timestamp}] ${level} ${message}`;
    writeRaw(stream, line);
    appendToLogFile(line);
  };

  console.log = (...args: unknown[]) => writeLine("stdout", "INFO", args);
  console.info = (...args: unknown[]) => writeLine("stdout", "INFO", args);
  console.warn = (...args: unknown[]) => writeLine("stderr", "WARN", args);
  console.error = (...args: unknown[]) => writeLine("stderr", "ERROR", args);
  console.debug = (...args: unknown[]) => {
    if (process.env.LOBS_DEBUG) writeLine("stdout", "DEBUG", args);
  };
}

// Simple console logger matching the plugin logger interface
const consoleLogger = {
  info: (msg: string) => console.log(`[lobs] ${msg}`),
  warn: (msg: string) => console.warn(`[lobs] WARN ${msg}`),
  error: (msg: string) => console.error(`[lobs] ERROR ${msg}`),
  debug: (msg: string) => {
    if (process.env.LOBS_DEBUG) console.log(`[lobs] DEBUG ${msg}`);
  },
};

/**
 * Resolve an internal channel ID (e.g. "cron", "system") to a real Discord
 * channel snowflake. Real Discord snowflakes are all-numeric and >15 chars.
 * Internal names are routed to the configured alerts channel, then to the
 * first channel in channelPolicies. Returns null if no Discord channel can
 * be determined.
 */
function resolveDiscordChannel(
  channelId: string,
  discordConfig: import("./services/discord.js").DiscordConfig | null,
): string | null {
  // Already a real Discord snowflake (all-numeric, 15+ chars)
  if (/^\d{15,}$/.test(channelId)) return channelId;
  // Internal/synthetic channels: route to alerts channel or first policy channel
  if (!discordConfig) return null;
  if (discordConfig.channels.alerts) return discordConfig.channels.alerts;
  const firstChannel = Object.keys(discordConfig.channelPolicies ?? {})[0];
  return firstChannel ?? null;
}

async function main() {
  // Rotate oversized log before any output
  rotateLogFile();
  installRuntimeLogging();

  console.log("=== lobs-core starting (standalone) ===");
  console.log(`[log] debug=${process.env.LOBS_DEBUG ? "enabled" : "disabled"} file_append=${LOG_TO_FILE ? "enabled" : "disabled"}`);

  // Set up logger
  setLogger(consoleLogger as any);

  // ── Runtime Failsafes ────────────────────────────────────────────────────

  // Uncaught exception handler — log and continue for non-critical errors
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    console.error("[FATAL] Uncaught exception:", err);
    // Exit for fatal errors: DB corruption, OOM, port conflicts, missing modules
    const fatal = [
      "SQLITE_CORRUPT", "Cannot allocate memory", "EADDRINUSE",
      "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND",
    ];
    // ENOSPC: disk full — always fatal; clean PID before exit so next start isn't blocked
    if (err.code === "ENOSPC") {
      console.error(
        "[FATAL] ENOSPC: no space left on device — lobs-core is shutting down.\n" +
          "  Free disk space and restart with: lobs start\n" +
          "  Run `df -h` to check disk usage.",
      );
      if (existsSync(PID_FILE)) try { unlinkSync(PID_FILE); } catch {}
      process.exit(1);
    }
    if (fatal.some(f => err.message?.includes(f) || err.code === f)) {
      console.error("[FATAL] Critical error — shutting down");
      if (existsSync(PID_FILE)) try { unlinkSync(PID_FILE); } catch {}
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

  // ── Startup Telemetry ── (post-mortem: 2026-03-16 restart cascade) ───────
  {
    let gatewayToken: string | undefined;
    try { gatewayToken = getGatewayConfig().token; } catch {}
    const telemetry = await runStartupTelemetry(gatewayToken);
    if (telemetry.hasCritical) {
      console.error("[startup-telemetry] One or more CRITICAL probes fired — review logs above");
    }
  }
  const stopDiskMonitor = startDiskSpaceMonitor();

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

  // Structured memory DB (separate from lobs.db)
  try {
    initMemoryDb();
    console.log("Structured memory database ready");
  } catch (err) {
    console.warn(`Structured memory init warning: ${err}`);
  }

  // File indexer — index markdown docs into structured-memory.db as document chunks
  // (ADR-007 Phase 1: coexists with lobs-memory service)
  try {
    const HOME = process.env.HOME ?? "/Users/lobs";
    initFileIndexer({
      watchDirs: [
        { path: `${HOME}/lobs-shared-memory`, collection: "workspace", recursive: true },
        { path: `${HOME}/lobs/lobs-core/docs`, collection: "lobs-core", recursive: true },
        { path: `${HOME}/.lobs/agents/main/context`, collection: "sessions", recursive: true },
        { path: `${HOME}/paw/bot-shared`, collection: "paw-shared", recursive: true },
      ],
      chunkStrategy: "heading",
      maxChunkTokens: 400,
      rescanIntervalMs: 15 * 60 * 1000,
      batchSize: 10,
    });
    console.log("File indexer started (ADR-007 Phase 1)");
  } catch (err) {
    console.warn(`File indexer init warning: ${err}`);
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

  // Register structured memory hooks (event recording + reflection trigger)
  // These wire into the runner lifecycle via HookRegistry — must come after
  // initMemoryDb() and initToolGate().
  registerEventRecorderHook(null as never);  // _api param is unused
  registerReflectionTriggerHook();
  console.log("Structured memory hooks registered (event recorder + reflection trigger)");

  // Load skills
  console.log("Loading skills...");
  skillsService.loadAll();
  console.log(`Loaded ${skillsService.getAll().length} skills`);

  // Set up unified cron service
  console.log("Setting up cron service...");
  const cronService = initCronService(getRawDb());
  cronService.seedDefaults();
  const researchQueue = initResearchQueueService(getRawDb());
  const workerRegistry = new WorkerRegistry(getRawDb(), cronService);
  workerRegistry.register(new MemoryProcessorWorker());

  // Intelligence sweep system (init before research processor so insights can flow)
  const intelSweep = initIntelSweepService(getRawDb(), researchQueue);
  workerRegistry.register(new ResearchProcessorWorker(researchQueue, intelSweep));
  workerRegistry.register(new IntelSweepWorker(intelSweep));

  // Research radar — identifies novel paper opportunities from intel insights
  const researchRadar = initResearchRadarService(getRawDb());
  workerRegistry.register(new ResearchRadarWorker(researchRadar, intelSweep));

  // Register system jobs (code handlers, not DB-backed)
  cronService.registerSystemJob({
    id: "heartbeat",
    name: "System Heartbeat",
    schedule: "*/30 * * * *",
    enabled: true,
    handler: async () => {
      const result = await runHeartbeat();
      // Only alert the main agent if there are actual issues
      if (result.alerts.length > 0) {
        const mainAgent = (globalThis as any).__lobsMainAgent;
        if (mainAgent) {
          const alertText = `[HEARTBEAT ALERT] ${result.alerts.join("; ")}`;
          await mainAgent.handleSystemEvent(alertText);
        }
      }
    },
  });

  cronService.registerSystemJob({
    id: "system-sentinel",
    name: "System Sentinel",
    schedule: "*/15 * * * *", // every 15 minutes
    enabled: true,
    handler: async () => {
      const result = await runSentinelCheck();
      if (result.shouldAlert && result.alertMessage) {
        const mainAgent = (globalThis as any).__lobsMainAgent;
        if (mainAgent) {
          await mainAgent.handleSystemEvent(result.alertMessage);
        }
      }
    },
  });

  cronService.registerSystemJob({
    id: "calendar-sentinel",
    name: "Calendar Sentinel",
    schedule: "*/15 * * * *", // every 15 minutes
    enabled: true,
    handler: async () => {
      const result = await runCalendarSentinel();
      if (result.shouldAlert && result.alertMessage) {
        const mainAgent = (globalThis as any).__lobsMainAgent;
        if (mainAgent) {
          await mainAgent.handleSystemEvent(result.alertMessage);
        }
      }
    },
  });

  cronService.registerSystemJob({
    id: "training-harvest",
    name: "Training Data Harvest",
    schedule: "0 5 * * *", // daily at 5am, after memory condensation at 4am
    enabled: true,
    handler: async () => {
      const { runHarvest } = await import("./services/training-harvester.js");
      const results = await runHarvest();
      const total = results.reduce((sum, r) => sum + r.extracted, 0);
      if (total > 0) {
        console.log(`[training-harvest] Harvested ${total} new training samples`);
      }
    },
  });

  cronService.registerSystemJob({
    id: "scheduler-intelligence-refresh",
    name: "Scheduler Intelligence Refresh",
    schedule: "*/10 * * * *", // every 10 minutes — keeps Nexus scheduler tab instant
    enabled: true,
    handler: async () => {
      await refreshSchedulerIntelligence();
    },
  });

  cronService.registerSystemJob({
    id: "nightly-planner",
    name: "Nightly Planner",
    schedule: "0 22 * * *", // 10pm ET every night
    enabled: true,
    handler: async () => {
      const result = await runNightlyPlanner();
      if (result.eventsCreated > 0) {
        const mainAgent = (globalThis as any).__lobsMainAgent;
        if (mainAgent) {
          await mainAgent.handleSystemEvent(result.summary);
        }
      }
    },
  });

  cronService.registerSystemJob({
    id: "lm-studio-monitor",
    name: "LM Studio Health Monitor",
    schedule: "*/5 * * * *", // every 5 minutes — fast enough to catch load issues, slow enough not to spam
    enabled: true,
    handler: async () => {
      const result = await runLmStudioAlertCheck();
      if (result.alerts.inserted > 0) {
        console.log(
          `[lm-studio-monitor] ${result.status} — ${result.alerts.inserted} alert(s) fired: ${result.alerts.fired.join(", ")}`,
        );
      }
    },
  });

  cronService.registerSystemJob({
    id: "db-maintenance",
    name: "DB Maintenance",
    schedule: "0 3 * * *", // daily at 3am — prune old rows and VACUUM
    enabled: true,
    handler: async () => {
      const result = await runDbMaintenance();
      const totalPruned = Object.values(result.pruned).reduce((a, b) => a + b, 0);
      if (totalPruned > 0) {
        console.log(
          `[db-maintenance] Pruned ${totalPruned} rows, saved ${((result.dbSizeBefore - result.dbSizeAfter) / 1048576).toFixed(1)}MB`,
        );
      }
    },
  });

  // Daily reflection — run at 03:00 local time, after daily db-maintenance
  let lastDailyReflectionDate = "";
  const DAILY_REFLECTION_HOUR = 3;
  const dailyReflectionTimer = setInterval(() => {
    const now = new Date();
    if (now.getHours() !== DAILY_REFLECTION_HOUR || now.getMinutes() !== 0) return;
    const today = now.toISOString().slice(0, 10);
    if (lastDailyReflectionDate === today) return;
    lastDailyReflectionDate = today;
    log().info("[daily-reflection] Cron trigger firing");
    void runDailyReflection();
  }, 60_000);
  (globalThis as any).__dailyReflectionTimer = dailyReflectionTimer;

  // Event handler wired after mainAgent is created (see below)
  cronService.start();
  console.log("Cron service started");

  // Start the control loop
  startControlLoop({} as any, SCAN_INTERVAL_MS);
  console.log(`Control loop started (scan every ${SCAN_INTERVAL_MS / 1000}s)`);

  // Start HTTP server (Nexus dashboard + API)
  startServer(HTTP_PORT);

  // Purge archived chat sessions older than 30 days on startup
  purgeOldArchivedSessions();

  // Initialize in-process memory service in the background so memory indexing
  // cannot block the main system from reaching the main agent + Discord/API.
  void initMemory().catch((err) => {
    console.error("[memory] Failed to initialize memory service:", err);
    console.warn("[memory] Continuing without memory — grep fallback will be used");
  });

  // Start imagine service (background, non-blocking)
  imagineService.start();
  
  // Create and configure the main agent (always available — for Discord and/or Nexus chat)
  const rawDb = getRawDb();
  const mainAgent = new MainAgent(rawDb);
  mainAgent.setSystemPrompt(buildMainAgentPrompt());
  mainAgent.setWorkspaceContext(loadWorkspaceContext());
  
  // Export main agent globally so API handlers can access it
  (globalThis as any).__lobsMainAgent = mainAgent;

  // Export worker registry globally so API handlers can trigger workers on demand
  (globalThis as any).__lobsWorkerRegistry = workerRegistry;

  // Export intel sweep service globally so the sweep API can target individual feeds
  (globalThis as any).__lobsIntelSweep = intelSweep;

  const activityTimer = setInterval(async () => {
    const workers = getActiveWorkers();
    const activeChannels = mainAgent.getProcessingChannels();
    const queuedChannels = mainAgent.getQueueDepth();
    const workerSummary = workers.length > 0
      ? workers
          .slice(0, 5)
          .map((worker) => `${worker.agentType ?? "unknown"}:${worker.taskId?.slice(0, 8) ?? "none"}`)
          .join(", ")
      : "none";
    const channelSummary = activeChannels.length > 0
      ? activeChannels.slice(0, 5).map((channelId) => channelId.slice(0, 16)).join(", ")
      : "none";

    let memoryLabel = "down";
    try {
      const { isMemoryReady } = await import("./services/memory/index.js");
      memoryLabel = isMemoryReady() ? "in-process" : "not-ready";
    } catch { /* ignore */ }

    console.log(
      `[runtime] workers=${countActiveWorkers()} [${workerSummary}] ` +
      `main-agent active=${mainAgent.getActiveChannelCount()}/${mainAgent.getMaxConcurrent()} ` +
      `queued=${queuedChannels} channels=[${channelSummary}] ` +
      `memory=${memoryLabel}`,
    );
  }, ACTIVITY_LOG_INTERVAL_MS);
  
  // Wire main agent into Discord slash commands
  const { setMainAgentForCommands, setVoiceManagerForCommands } = await import("./services/discord-commands.js");
  setMainAgentForCommands(mainAgent);

  // Wire cron events to main agent
  cronService.setEventHandler(async (text: string, channelId?: string) => {
    console.log(`[cron] Firing event to main agent (channel=${channelId ?? "system"}): ${text.slice(0, 80)}...`);
    await mainAgent.handleSystemEvent(text, channelId);
  });

  // Connect Discord bot (optional)
  const discordConfig = loadDiscordConfig();
  if (discordConfig) {
    try {
      await discordService.connect(discordConfig);

      // Wire Discord to unified discord tool
      setDiscordToolDiscord(discordService);

      // ── Voice Manager ─────────────────────────────────────────────
      let voiceManager: VoiceManager | null = null;
      const discordClient = discordService.getClient();
      if (discordClient) {
        voiceManager = new VoiceManager(discordClient);
        if (voiceManager.isEnabled) {
          // Initialize sidecar services (auto-start if configured)
          await voiceManager.initialize();

          // Wire voice transcriptions → main agent
          voiceManager.setMessageHandler(async (text, userId, displayName, channelId) => {
            await mainAgent.handleMessage({
              id: randomUUID(),
              content: text,
              authorId: userId,
              authorName: displayName,
              channelId, // voice:GUILD_ID
              timestamp: Date.now(),
              chatType: "dm", // Voice is direct-style (always respond)
            });
          });
          console.log("[voice] VoiceManager initialized and wired to main agent");
        } else {
          console.log("[voice] Voice disabled in config — VoiceManager not activated");
          voiceManager = null;
        }
      }
      // Export for API/commands
      (globalThis as any).__lobsVoiceManager = voiceManager;
      if (voiceManager) {
        setVoiceManagerForCommands(voiceManager);
      }

      // Wire reply handler — agent replies go to Discord
      mainAgent.setReplyHandler(async (channelId, content) => {
        // Voice channels — route to VoiceManager TTS, not Discord text
        if (channelId.startsWith("voice:") && voiceManager) {
          const guildId = channelId.replace("voice:", "");
          await voiceManager.onVoiceReply(guildId, content);
          return;
        }
        // Nexus channels are handled via the API, not Discord
        if (channelId.startsWith("nexus:")) return;
        // Cron channels are internal — the agent sends to Discord via the message tool
        if (channelId.startsWith("cron:")) return;
        // Vim channels are handled via WebSocket, not Discord
        if (channelId.startsWith("vim:")) return;
        // System channel (heartbeats, alerts, internal events) → owner DMs only, never a guild channel
        if (channelId === "system" || channelId.startsWith("system:")) {
          const ownerId = discordConfig.ownerId;
          if (ownerId) {
            await discordService.sendDm(ownerId, content);
          } else {
            console.warn("[main] system channel reply dropped — no ownerId configured in discord.json");
          }
          return;
        }
        const resolvedChannelId = resolveDiscordChannel(channelId, discordConfig);
        if (!resolvedChannelId) return; // No Discord configured, drop silently
        await discordService.send(resolvedChannelId, content);
      });

      // Wire typing handler
      mainAgent.setTypingHandler((channelId) => {
        if (channelId.startsWith("nexus:")) return;
        if (channelId.startsWith("cron:")) return;
        if (channelId.startsWith("vim:")) return;
        if (channelId.startsWith("voice:")) return; // No typing indicators in voice
        // System channel — no typing indicator needed for DMs from system events
        if (channelId === "system" || channelId.startsWith("system:")) return;
        const resolved = resolveDiscordChannel(channelId, discordConfig);
        if (!resolved) return;
        discordService.sendTyping(resolved).catch(() => {});
      });

      // Wire progress handler — shows tool steps in DMs only
      mainAgent.setProgressHandler(async (channelId, content) => {
        // Voice channels — suppress progress (tool steps are silent in voice)
        if (channelId.startsWith("voice:")) return;
        // For Nexus channels, progress is delivered via the API (not Discord)
        if (channelId.startsWith("nexus:")) return;
        // Cron channels are internal
        if (channelId.startsWith("cron:")) return;
        // Vim channels are handled via WebSocket, not Discord
        if (channelId.startsWith("vim:")) return;
        // System channel progress → owner DMs
        if (channelId === "system" || channelId.startsWith("system:")) {
          const ownerId = discordConfig.ownerId;
          if (ownerId) {
            await discordService.sendDm(ownerId, content);
          }
          return;
        }
        const resolved = resolveDiscordChannel(channelId, discordConfig);
        if (!resolved) return;
        await discordService.send(resolved, content);
      });

      // Wire incoming messages — Discord messages go to agent
      discordService.onMessage((msg) => {
        console.log(
          `[discord->main-agent] inbound id=${msg.messageId.slice(0, 8)} channel=${msg.channelId.slice(0, 16)} ` +
          `dm=${msg.isDm} mentioned=${msg.isMentioned} author=${msg.displayName} len=${msg.content.length}`,
        );
        mainAgent.handleMessage({
          id: randomUUID(),
          messageId: msg.messageId,
          content: msg.content,
          authorId: msg.authorId,
          authorName: msg.displayName,
          channelId: msg.channelId,
          timestamp: Date.now(),
          isDm: msg.isDm,
          isMentioned: msg.isMentioned,
          guildId: msg.guildId,
          chatType: msg.isDm ? "dm" : "group",
          images: msg.images,
        }).catch((err) => {
          console.error(
            `[discord->main-agent] failed id=${msg.messageId.slice(0, 8)} channel=${msg.channelId.slice(0, 16)}:`,
            err,
          );
        });
      });

      console.log("[main-agent] Connected to Discord, ready for messages");
    } catch (err) {
      console.error("[discord] Failed to connect:", err);
    }
  }
  
  console.log("[main-agent] Ready (Discord: " + (discordConfig ? "enabled" : "disabled") + ")");

  // Resume any sessions that were active before restart
  // Delay slightly to let Discord fully connect first
  setTimeout(() => {
    mainAgent.resumeAfterRestart().catch(err => {
      console.error("[main-agent] Resume after restart failed:", err);
    });

    // NOTE: Worker restart cleanup is intentionally NOT done here.
    //
    // The paw plugin's processPendingResumes() (called from the first orchestrator
    // control-loop tick) owns orphaned-worker recovery. It:
    //   1. Calls failStaleSpawnRuns() to handle spawn-node stuck runs
    //   2. Verifies each candidate session is alive via the gateway API
    //   3. Sends a resume message if alive, or resets work_state to not_started if dead
    //
    // Running a competing bulk-UPDATE here (marking ALL open worker_runs as
    // 'orphaned on restart') created a race: processPendingResumes and this block
    // both fired at ~3 seconds and stomped on each other, causing the recurring
    // 'orphaned on restart' flood (4× in 6 hours, ~15k seconds total).
    //
    // The only safe cleanup this block does is reset tasks whose status is literally
    // 'running' (which is set at the DB level by the orchestrator, separate from
    // paw's work_state='in_progress').  These can't be recovered — the orchestrator
    // process itself is what was running them.
    const rawDb = getRawDb();

    // Reset busy agent_status rows — these are cosmetic/advisory, safe to clear immediately.
    rawDb.prepare(`
      UPDATE agent_status SET status = 'idle', current_task_id = NULL
      WHERE status = 'busy'
    `).run();

    // Reset tasks stuck in status='running' that have NO open worker_runs and are
    // NOT already being handled by processPendingResumes (work_state != 'in_progress').
    // These are tasks the orchestrator itself was orchestrating (not worker sessions).
    const stuckOrchTasks = rawDb.prepare(`
      SELECT id FROM tasks
      WHERE status = 'running'
        AND work_state != 'in_progress'
        AND id NOT IN (
          SELECT DISTINCT task_id FROM worker_runs WHERE ended_at IS NULL AND task_id IS NOT NULL
        )
    `).all() as Array<{ id: string }>;

    if (stuckOrchTasks.length > 0) {
      console.log(`[restart] Resetting ${stuckOrchTasks.length} orchestrator-level stuck task(s) to active`);
      for (const task of stuckOrchTasks) {
        rawDb.prepare(`
          UPDATE tasks SET status = 'active',
            crash_count = COALESCE(crash_count, 0) + 1,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(task.id);
      }
    }
  }, 3000);
  
  console.log("=== lobs-core ready ===");

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    clearInterval(activityTimer);

    // Persist session state before anything else
    await mainAgent.prepareForShutdown();

    // Checkpoint in-flight worker agents — signal them to finish their current
    // tool call and write a transcript checkpoint so they can resume on restart.
    // Must happen before stopControlLoop() so the control-loop timer doesn't
    // re-queue anything while we're waiting.
    await flushWorkerCheckpoints(20_000);

    // Clean up PID file
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
      console.log("PID file removed");
    }
    
    stopDiskMonitor();
    clearInterval(dailyReflectionTimer);
    imagineService.stop();
    // Clean up voice sessions
    const vm = (globalThis as any).__lobsVoiceManager as VoiceManager | null;
    if (vm) vm.destroyAll();

    // Stop file indexer (cancels rescan timer + pending embeddings)
    stopFileIndexer();

    await shutdownMemory();
    await browserService.shutdown();
    await discordService.shutdown();
    cronService.stop();
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
