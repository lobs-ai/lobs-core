/**
 * agent-main — lightweight entry point for standalone Discord agents.
 *
 * Runs a single agent (Briggs, Sam, Lena, etc.) using the full lobs-core
 * agent loop and tool system, but without Lobs-specific services like
 * cron, orchestrator, workers, voice, imagine, research, etc.
 *
 * Each agent gets its own root directory (via LOBS_ROOT env var):
 *   ~/.lobs-agents/briggs/
 *     config/discord.json         — Discord bot token + channel policies
 *     config/secrets/discord-token.json — bot token (separate from config)
 *     agents/main/SOUL.md         — agent personality
 *     agents/main/USER.md         — optional user context
 *     agents/main/MEMORY.md       — optional memory index
 *     agents/main/TOOLS.md        — optional tools reference
 *     agents/main/context/        — on-demand context files
 *     lobs.db                     — conversation history + spend tracking
 *     structured-memory.db        — memory system
 *
 * Usage:
 *   LOBS_ROOT=~/.lobs-agents/briggs AGENT_NAME=briggs node dist/agent-main.js
 */

// LOBS_ROOT must be set before any imports that call getLobsRoot().
// All downstream modules call getLobsRoot() lazily (at function-call time),
// so setting the env var here — before imports — is sufficient.
const AGENT_NAME = process.env.AGENT_NAME ?? "";
if (!AGENT_NAME) {
  console.error("[agent-main] AGENT_NAME env var is required (e.g. AGENT_NAME=briggs)");
  process.exit(1);
}
if (!process.env.LOBS_ROOT) {
  console.error("[agent-main] LOBS_ROOT env var is required (e.g. LOBS_ROOT=~/.lobs-agents/briggs)");
  process.exit(1);
}

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";

import { initDb, closeDb, getRawDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { initMemoryDb } from "./memory/db.js";
import { initToolGate } from "./runner/tool-gate.js";
import { initToolManager } from "./runner/tools/tool-manager.js";
import { initDynamicToolLoader } from "./runner/tools/dynamic-tools.js";
import { setDiscordToolDiscord } from "./runner/tools/index.js";
import { MainAgent } from "./services/main-agent.js";
import { buildSystemPrompt, loadWorkspaceContext } from "./services/workspace-loader.js";
import { loadDiscordConfig } from "./config/discord.js";
import { getLobsRoot } from "./config/lobs.js";
import { discordService } from "./services/discord.js";

// ── Config ──────────────────────────────────────────────────────────────────

const LOBS_ROOT = getLobsRoot();
const HTTP_PORT = parseInt(process.env.LOBS_PORT ?? "9421", 10);
const PID_FILE = resolve(LOBS_ROOT, "agent.pid");

// ── Timestamp logger ─────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string, ...args: unknown[]): void {
  console.log(`[${ts()}] [${AGENT_NAME}] ${msg}`, ...args);
}

function warn(msg: string, ...args: unknown[]): void {
  console.warn(`[${ts()}] [${AGENT_NAME}] WARN ${msg}`, ...args);
}

function err(msg: string, ...args: unknown[]): void {
  console.error(`[${ts()}] [${AGENT_NAME}] ERROR ${msg}`, ...args);
}

// ── Resolve a channel ID to a real Discord snowflake ───────────────────────

function resolveDiscordChannel(
  channelId: string,
  discordConfig: import("./services/discord.js").DiscordConfig | null,
): string | null {
  if (/^\d{15,}$/.test(channelId)) return channelId;
  if (!discordConfig) return null;
  if (discordConfig.channels?.alerts) return discordConfig.channels.alerts;
  const firstChannel = Object.keys(discordConfig.channelPolicies ?? {})[0];
  return firstChannel ?? null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`=== ${AGENT_NAME} starting ===`);
  log(`LOBS_ROOT=${LOBS_ROOT}`);

  // Write PID file
  mkdirSync(LOBS_ROOT, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
  log(`PID ${process.pid} written to ${PID_FILE}`);

  // ── DB ─────────────────────────────────────────────────────────────────────
  const dbPath = resolve(LOBS_ROOT, "lobs.db");
  const db = initDb(dbPath);
  runMigrations(db);
  log(`DB initialized at ${dbPath}`);

  // ── Memory DB ──────────────────────────────────────────────────────────────
  initMemoryDb();
  log("Memory DB initialized");

  // ── Tools ──────────────────────────────────────────────────────────────────
  initToolGate();
  initToolManager();
  initDynamicToolLoader();
  log("Tool gate, manager, and dynamic loader initialized");

  // ── Main Agent ─────────────────────────────────────────────────────────────
  const rawDb = getRawDb();
  const mainAgent = new MainAgent(rawDb);
  mainAgent.setSystemPrompt(buildSystemPrompt("main"));
  mainAgent.setWorkspaceContext(loadWorkspaceContext("main"));
  log("MainAgent created with system prompt and workspace context");

  // ── Discord ────────────────────────────────────────────────────────────────
  const discordConfig = loadDiscordConfig();
  if (discordConfig) {
    try {
      await discordService.connect(discordConfig);
      setDiscordToolDiscord(discordService);
      log("Connected to Discord");

      // Reply handler — agent replies go to Discord
      mainAgent.setReplyHandler(async (channelId, content) => {
        if (channelId.startsWith("nexus:")) return;
        if (channelId.startsWith("cron:")) return;
        if (channelId.startsWith("vim:")) return;
        if (channelId.startsWith("voice:")) return;
        if (channelId === "system" || channelId.startsWith("system:")) {
          const ownerId = discordConfig.ownerId;
          if (ownerId) {
            await discordService.sendDm(ownerId, content);
          } else {
            warn("system channel reply dropped — no ownerId configured in discord.json");
          }
          return;
        }
        const resolvedChannelId = resolveDiscordChannel(channelId, discordConfig);
        if (!resolvedChannelId) return;
        await discordService.send(resolvedChannelId, content);
      });

      // Typing handler
      mainAgent.setTypingHandler((channelId) => {
        if (channelId.startsWith("nexus:")) return;
        if (channelId.startsWith("cron:")) return;
        if (channelId.startsWith("vim:")) return;
        if (channelId.startsWith("voice:")) return;
        if (channelId === "system" || channelId.startsWith("system:")) return;
        const resolved = resolveDiscordChannel(channelId, discordConfig);
        if (!resolved) return;
        discordService.sendTyping(resolved).catch(() => {});
      });

      // Progress handler — tool steps
      mainAgent.setProgressHandler(async (channelId, content) => {
        if (channelId.startsWith("nexus:")) return;
        if (channelId.startsWith("cron:")) return;
        if (channelId.startsWith("vim:")) return;
        if (channelId.startsWith("voice:")) return;
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

      // Incoming messages — Discord → agent
      discordService.onMessage((msg) => {
        log(
          `[discord->agent] inbound id=${msg.messageId.slice(0, 8)} channel=${msg.channelId.slice(0, 16)} ` +
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
        }).catch((e) => {
          err(`handleMessage failed id=${msg.messageId.slice(0, 8)}:`, e);
        });
      });

      log("Discord handlers wired. Ready for messages.");
    } catch (e) {
      err("Failed to connect to Discord:", e);
    }
  } else {
    warn("No Discord config found — running without Discord");
  }

  // ── Health endpoint ────────────────────────────────────────────────────────
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agent: AGENT_NAME, uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(HTTP_PORT, () => {
    log(`Health endpoint on :${HTTP_PORT}`);
  });

  // ── Shutdown ───────────────────────────────────────────────────────────────
  async function shutdown(signal: string) {
    log(`Received ${signal}, shutting down...`);
    try {
      await mainAgent.prepareForShutdown();
    } catch (e) {
      err("prepareForShutdown error:", e);
    }
    try {
      await discordService.shutdown();
    } catch (e) {
      err("discordService.shutdown error:", e);
    }
    try {
      closeDb();
    } catch (e) {
      err("closeDb error:", e);
    }
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
    log("Shutdown complete.");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log(`${AGENT_NAME} ready`);
}

main().catch((e) => {
  console.error("[agent-main] Fatal startup error:", e);
  process.exit(1);
});
