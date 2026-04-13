#!/usr/bin/env node
/**
 * lobs — CLI for managing lobs-core
 *
 * Process management:
 *   lobs start                Start lobs-core (daemonized)
 *   lobs stop                 Stop the running instance
 *   lobs restart              Pull submodules + build + restart (--no-pull, --no-build)
 *   lobs status               System overview (server, tasks, workers)
 *   lobs health               Detailed health check (DB, memory, LM Studio)
 *   lobs preflight            Session startup: health + LM Studio model-availability check
 *
 * LM Studio diagnostics:
 *   lobs models               Model-availability diagnostic (which models are missing/loaded)
 *
 * Tasks & workers:
 *   lobs tasks [list|view]    Manage tasks
 *   lobs workers              Show active/recent worker runs
 *
 * Chat:
 *   lobs chat                 Start a new interactive chat
 *   lobs chat list            List saved chat sessions
 *   lobs chat show <key>      Show a saved transcript
 *   lobs chat resume <key>    Resume an existing chat
 *
 * Cron:
 *   lobs cron [list]                       List all cron jobs
 *   lobs cron add <n> <s> <p>              Add an agent cron job (LLM)
 *   lobs cron add --script <n> <s> <cmd>   Add a script job (shell command)
 *   lobs cron remove <id>                  Remove an agent cron job
 *   lobs cron toggle <id>                  Toggle enabled/disabled
 *   lobs cron run <id>                     Trigger immediate run
 *
 * Config:
 *   lobs config check         Validate all config files
 *   lobs config show          Dump current config file status
 *   lobs init                 Initialize config directory structure
 *
 * Logs:
 *   lobs logs [follow] [--tail N]  Show recent log output or follow logs
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { validateAllConfigs, printValidationResults } from "../config/validator.js";
import { getModelConfig, getModelForTier } from "../config/models.js";
import { loadKeyConfig, getEnvKeyForProvider } from "../config/keys.js";
import { getLobsRoot } from "../config/lobs.js";
import { runLmStudioDiagnostic, formatDiagnosticReport } from "../diagnostics/lmstudio.js";
import { cmdCodexAuth } from "./codex-auth.js";

const LOBS_PORT = parseInt(process.env.LOBS_PORT ?? "9420", 10);
const API_BASE = `http://localhost:${LOBS_PORT}/api`;
const CONFIG_DIR = resolve(getLobsRoot(), "config");
const SECRETS_DIR = resolve(CONFIG_DIR, "secrets");
const PID_FILE = resolve(getLobsRoot(), "lobs.pid");
const LOG_FILE = resolve(getLobsRoot(), "lobs.log");
const HOME = process.env.HOME ?? "";
const LOBS_CORE_DIR = resolve(HOME, "lobs/lobs-core");
const LAUNCHD_PLIST = resolve(HOME, "Library/LaunchAgents/com.lobs.core.plist");

// ── ANSI Colors ──────────────────────────────────────────────────────────────

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatTimestamp(iso?: string | null): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

// ── Fetch Helpers ────────────────────────────────────────────────────────────

async function fetchApi(endpoint: string): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    console.error(colorize(`Error: ${String(err)}`, "red"));
    console.log(colorize("\nIs lobs-core running? Try: npm start", "dim"));
    process.exit(1);
  }
}

async function postApi(endpoint: string, body: any): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    console.error(colorize(`Error: ${String(err)}`, "red"));
    console.log(colorize("\nIs lobs-core running? Try: npm start", "dim"));
    process.exit(1);
  }
}

async function deleteApi(endpoint: string): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, { method: "DELETE" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    console.error(colorize(`Error: ${String(err)}`, "red"));
    console.log(colorize("\nIs lobs-core running? Try: npm start", "dim"));
    process.exit(1);
  }
}

type ChatSessionSummary = {
  id: string;
  key: string;
  title: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
  compliance_required: boolean;
  disabled_tools: string[];
  unreadCount: number;
  processing: boolean;
  currentModel?: string;
  overrideModel?: string | null;
};

type ChatMessage = {
  role: string;
  content: string;
  timestamp: string;
  metadata?: string | Record<string, unknown> | null;
};

async function getChatSessions(): Promise<ChatSessionSummary[]> {
  const data = await fetchApi("/chat/sessions");
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

async function getChatSession(sessionKey: string): Promise<ChatSessionSummary | null> {
  const sessions = await getChatSessions();
  return sessions.find((session) => session.key === sessionKey) ?? null;
}

async function getChatMessages(sessionKey: string): Promise<ChatMessage[]> {
  const data = await fetchApi(`/chat/sessions/${sessionKey}/messages`);
  return Array.isArray(data?.messages) ? data.messages : [];
}

function parseChatMetadata(metadata: ChatMessage["metadata"]): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return metadata;
}

function printChatMessage(message: ChatMessage): void {
  const stamp = colorize(`[${formatTimestamp(message.timestamp)}]`, "gray");
  if (message.role === "user") {
    console.log(`${stamp} ${colorize("You", "cyan")}: ${message.content}`);
    return;
  }
  if (message.role === "assistant") {
    const cleaned = message.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    console.log(`${stamp} ${colorize("Assistant", "green")}: ${cleaned}`);
    return;
  }
  if (message.role === "tool") {
    const meta = parseChatMetadata(message.metadata);
    const toolName = typeof meta?.toolName === "string" ? meta.toolName : "tool";
    const status = meta?.status === "complete" ? "done" : "running";
    console.log(`${stamp} ${colorize("Tool", "yellow")} ${toolName} (${status})`);
    return;
  }
  console.log(`${stamp} ${message.role}: ${message.content}`);
}

function printChatTranscript(messages: ChatMessage[]): void {
  if (messages.length === 0) {
    console.log(colorize("No messages yet.", "dim"));
    return;
  }
  for (const message of messages) printChatMessage(message);
}

async function waitForChatTurn(sessionKey: string, since: string): Promise<void> {
  const seen = new Set<string>();
  const timeoutAt = Date.now() + 5 * 60_000;

  while (Date.now() < timeoutAt) {
    const poll = await fetchApi(`/chat/sessions/${sessionKey}/poll?since=${encodeURIComponent(since)}`);
    const messages: ChatMessage[] = Array.isArray(poll?.messages) ? poll.messages : [];
    let printedAssistant = false;

    for (const message of messages) {
      const id = `${message.timestamp}:${message.role}:${message.content}`;
      if (seen.has(id)) continue;
      seen.add(id);
      printChatMessage(message);
      if (message.role === "assistant") printedAssistant = true;
    }

    const status = await fetchApi(`/chat/sessions/${sessionKey}/status`);
    const idle = !status?.processing && (status?.queueDepth ?? 0) === 0;
    if (printedAssistant && idle) return;
    if (messages.length > 0 && idle) return;

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log(colorize("Timed out waiting for the assistant response.", "yellow"));
}

async function createChatSession(title?: string): Promise<ChatSessionSummary> {
  const created = await postApi("/chat/sessions", { title: title?.trim() || "New Chat" });
  return {
    id: created.id,
    key: created.key,
    title: created.title,
    summary: null,
    createdAt: created.createdAt,
    updatedAt: created.createdAt,
    isActive: true,
    compliance_required: Boolean(created.compliance_required),
    disabled_tools: [],
    unreadCount: 0,
    processing: false,
    currentModel: created.currentModel,
    overrideModel: created.overrideModel ?? null,
  };
}

async function markChatRead(sessionKey: string): Promise<void> {
  await postApi(`/chat/sessions/${sessionKey}/read`, {});
}

type ApiModelOption = {
  id: string;
  label: string;
  provider: string;
  source: string;
  tier?: string;
  loaded?: boolean;
};

type ModelCatalogResponse = {
  defaultModel: string;
  currentModel: string;
  overrideModel: string | null;
  options: ApiModelOption[];
  lmstudio: {
    baseUrl: string;
    reachable: boolean;
    loadedModels: string[];
  };
};

async function getModelCatalog(sessionKey?: string): Promise<ModelCatalogResponse> {
  const suffix = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : "";
  return await fetchApi(`/models${suffix}`);
}

async function setChatSessionModel(sessionKey: string, model: string | null): Promise<{ currentModel: string; overrideModel: string | null }> {
  return await postOrPatchApi(`/chat/sessions/${sessionKey}/model`, "PATCH", { model });
}

async function postOrPatchApi(endpoint: string, method: "POST" | "PATCH", body: any): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } catch (err) {
    console.error(colorize(`Error: ${String(err)}`, "red"));
    console.log(colorize("\nIs lobs-core running? Try: npm start", "dim"));
    process.exit(1);
  }
}

// ── Process Management ───────────────────────────────────────────────────────

/** Read PID from file and check if process is actually alive */
function getRunningPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is alive (signal 0 = no signal, just check existence)
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function getListeningPid(): number | null {
  try {
    const output = execSync(`lsof -tiTCP:${LOBS_PORT} -sTCP:LISTEN`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return null;
    const pid = parseInt(output.split(/\s+/)[0] ?? "", 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function getKnownPid(): number | null {
  return getRunningPid() ?? getListeningPid();
}

function isServerReachable(): Promise<boolean> {
  return fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok)
    .catch(() => false);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unloadLaunchdService(): void {
  if (!existsSync(LAUNCHD_PLIST)) return;
  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST}" 2>/dev/null`, { encoding: "utf-8" });
    console.log(colorize("Unloaded launchd service (won't auto-restart)", "dim"));
  } catch {
    // May already be unloaded
  }
}

async function cmdStart(opts: { useLaunchd?: boolean } = {}) {
  // Check if already running
  const pid = getRunningPid();
  if (pid) {
    const reachable = await isServerReachable();
    if (reachable) {
      console.log(colorize(`lobs-core is already running (PID ${pid})`, "yellow"));
      return;
    }
    // PID file exists but server not reachable — stale PID
    console.log(colorize(`Stale PID file found (PID ${pid} not responding). Cleaning up...`, "yellow"));
    try { unlinkSync(PID_FILE); } catch {}
  }

  const listeningPid = getListeningPid();
  if (listeningPid) {
    const reachable = await isServerReachable();
    if (reachable) {
      console.log(colorize(`lobs-core is already running (PID ${listeningPid})`, "yellow"));
      return;
    }
    console.error(colorize(`Port ${LOBS_PORT} is already in use by PID ${listeningPid}`, "red"));
    console.log(colorize("  Stop it with: lobs stop", "dim"));
    return;
  }

  // Check that dist/main.js exists
  const mainJs = resolve(LOBS_CORE_DIR, "dist/main.js");
  if (!existsSync(mainJs)) {
    console.error(colorize("Error: dist/main.js not found. Run 'npm run build' first.", "red"));
    console.log(colorize(`  cd ${LOBS_CORE_DIR} && npm run build`, "dim"));
    process.exit(1);
  }

  console.log(colorize("Starting lobs-core...", "cyan"));

  if (opts.useLaunchd && existsSync(LAUNCHD_PLIST)) {
    try {
      execSync(`launchctl load "${LAUNCHD_PLIST}" 2>/dev/null`, { encoding: "utf-8" });
      // launchd will start it for us — wait for it
      let launchdStarted = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await isServerReachable()) {
          launchdStarted = true;
          break;
        }
      }
      if (launchdStarted) {
        const newPid = getRunningPid();
        console.log(colorize(`✓ lobs-core started via launchd (PID ${newPid ?? "?"}, port ${LOBS_PORT})`, "green"));
        return;
      }
      // If launchd didn't start it, fall through to manual spawn
      console.log(colorize("launchd loaded but server not responding, starting manually...", "yellow"));
    } catch {
      // Fall through to manual spawn
    }
  } else if (existsSync(LAUNCHD_PLIST)) {
    unloadLaunchdService();
    console.log(colorize("launchd plist exists but was left disabled; use `lobs start --launchd` to opt in", "dim"));
  }

  let logFd: number | null = null;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    logFd = openSync(LOG_FILE, "a");
  } catch {
    // Best-effort only. In restricted environments (like sandboxes), we may not
    // be allowed to open ~/.lobs/lobs.log for stdio redirection.
  }
  const child = spawn("node", [mainJs], {
    cwd: LOBS_CORE_DIR,
    detached: true,
    stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
    env: { ...process.env, LOBS_PORT: String(LOBS_PORT), LOBS_LOG_TO_FILE: "1" },
  });
  if (logFd !== null) closeSync(logFd);

  child.unref();
  const childPid = child.pid;

  if (!childPid) {
    console.error(colorize("Failed to start lobs-core", "red"));
    process.exit(1);
  }

  // Wait up to 5 seconds for server to become reachable
  let started = false;
  let exitedEarly = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isServerReachable()) {
      started = true;
      break;
    }
    if (!isPidAlive(childPid)) {
      exitedEarly = true;
      break;
    }
  }

  const writtenPid = getRunningPid();
  const startupFailed = !started && (!writtenPid || writtenPid !== childPid);

  if (started) {
    console.log(colorize(`✓ lobs-core started (PID ${childPid}, port ${LOBS_PORT})`, "green"));
    console.log(colorize(`  Logs: ${LOG_FILE}`, "dim"));
  } else if (exitedEarly || startupFailed) {
    console.error(colorize(`✗ lobs-core exited during startup (PID ${childPid})`, "red"));
    console.log(colorize(`  Check logs: tail -n 80 ${LOG_FILE}`, "dim"));
  } else {
    console.log(colorize(`lobs-core spawned (PID ${childPid}) but not yet responding`, "yellow"));
    console.log(colorize(`  Check logs: tail -f ${LOG_FILE}`, "dim"));
  }
}

async function cmdStop() {
  unloadLaunchdService();

  const pid = getKnownPid();
  if (!pid) {
    console.log(colorize("lobs-core is not running", "yellow"));
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
    return;
  }

  console.log(colorize(`Stopping lobs-core (PID ${pid})...`, "cyan"));

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(colorize(`Failed to send signal: ${err}`, "red"));
    return;
  }

  // Wait up to 10 seconds for graceful shutdown
  // (Discord disconnect, DB flush, browser cleanup, memory server shutdown can take time)
  let stopped = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      process.kill(pid, 0);
    } catch {
      stopped = true;
      break;
    }
  }

  if (stopped) {
    console.log(colorize("✓ lobs-core stopped", "green"));
  } else {
    console.log(colorize("Graceful shutdown timed out, force killing...", "yellow"));
    try {
      process.kill(pid, "SIGKILL");
      console.log(colorize("✓ lobs-core killed", "green"));
    } catch {
      console.error(colorize("Failed to kill process", "red"));
    }
  }

  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE); } catch {}
  }
}

function ensureDependenciesInstalled(projectDir: string, label: string): boolean {
  const packageJson = resolve(projectDir, "package.json");
  if (!existsSync(packageJson)) return true;

  try {
    execSync("npm ls --depth=0", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 20_000,
    });
    return true;
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.stdout?.toString() || err.message || "";
    console.log(colorize(`${label}: missing or invalid dependencies detected, running npm install...`, "yellow"));
    if (stderr.trim()) {
      console.log(colorize(stderr.slice(-300), "dim"));
    }
  }

  try {
    execSync("npm install", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 180_000,
    });
    console.log(colorize(`✓ ${label} dependencies installed`, "green"));
    return true;
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.stdout?.toString() || err.message;
    console.error(colorize(`✗ ${label} dependency install failed:`, "red"));
    console.error(colorize(stderr.slice(-500), "dim"));
    return false;
  }
}

async function cmdBuild(): Promise<boolean> {
  // Build Nexus (frontend dashboard) first
  const nexusDir = resolve(LOBS_CORE_DIR, "nexus");
  if (existsSync(resolve(nexusDir, "package.json"))) {
    if (!ensureDependenciesInstalled(nexusDir, "Nexus")) {
      console.error(colorize("✗ Skipping Nexus build because dependency install failed", "yellow"));
    } else {
    console.log(colorize("Building nexus...", "cyan"));
    try {
      execSync("npm run build", {
        cwd: nexusDir,
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "pipe"],
        timeout: 60_000,
      });
      console.log(colorize("✓ Nexus build succeeded", "green"));
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message;
      console.error(colorize("✗ Nexus build failed (non-fatal):", "yellow"));
      console.error(colorize(stderr.slice(-300), "dim"));
    }
    }
  }

  // Build lobs-core
  if (!ensureDependenciesInstalled(LOBS_CORE_DIR, "lobs-core")) {
    return false;
  }
  console.log(colorize("Building lobs-core...", "cyan"));
  try {
    execSync("npm run build", {
      cwd: LOBS_CORE_DIR,
      encoding: "utf-8",
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 60_000,
    });
    console.log(colorize("✓ Build succeeded", "green"));
    return true;
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.message;
    console.error(colorize("✗ Build failed:", "red"));
    console.error(colorize(stderr.slice(-500), "dim"));
    return false;
  }
}

function cmdUpdateSubmodules(): boolean {
  console.log(colorize("Updating submodules...", "cyan"));
  try {
    execSync("git submodule foreach 'git checkout main && git pull origin main'", {
      cwd: LOBS_CORE_DIR,
      encoding: "utf-8",
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 30_000,
    });
    console.log(colorize("✓ Submodules updated", "green"));
    return true;
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.message;
    console.error(colorize("✗ Submodule update failed:", "red"));
    console.error(colorize(stderr.slice(-500), "dim"));
    return false;
  }
}

async function cmdRestart(skipBuild = false, skipPull = false, opts: { useLaunchd?: boolean } = {}) {
  // Pull latest submodules unless --no-pull
  if (!skipPull) {
    cmdUpdateSubmodules();
  }

  // Auto-build before restart unless --no-build
  if (!skipBuild) {
    const buildOk = await cmdBuild();
    if (!buildOk) {
      console.error(colorize("\nRestart aborted — fix build errors first.", "red"));
      console.log(colorize("  Use 'lobs restart --no-build' to skip build check", "dim"));
      return;
    }
  }

  const pid = getKnownPid();
  if (pid) {
    await cmdStop();
    
    // Wait until the old process is fully dead + port is released
    // 1s was too short — shutdown involves Discord disconnect, DB flush, browser cleanup, memory server
    let dead = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      const stillAlive = getKnownPid();
      const portFree = !stillAlive;
      if (!stillAlive && portFree) {
        dead = true;
        break;
      }
    }
    if (!dead) {
      console.log(colorize("Warning: old process may still be shutting down. Waiting 2s more...", "yellow"));
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  await cmdStart(opts);
}

async function cmdLogs(tail: number = 50, follow: boolean = false) {
  if (!existsSync(LOG_FILE)) {
    console.log(colorize("No log file found.", "yellow"));
    console.log(colorize(`  Expected at: ${LOG_FILE}`, "dim"));
    return;
  }

  try {
    if (follow) {
      console.log(colorize(`\n=== Following ${LOG_FILE} (last ${tail} lines) ===\n`, "bright"));
      const child = spawn("tail", ["-n", String(tail), "-f", LOG_FILE], {
        stdio: "inherit",
      });

      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.on("error", (err) => {
          console.error(colorize(`Error following logs: ${err}`, "red"));
          resolve();
        });
      });
      return;
    }

    const output = execSync(`tail -n ${tail} "${LOG_FILE}"`, { encoding: "utf-8" });
    console.log(colorize(`\n=== Last ${tail} lines of ${LOG_FILE} ===\n`, "bright"));
    console.log(output);
  } catch (err) {
    console.error(colorize(`Error reading logs: ${err}`, "red"));
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdStatus() {
  // Check if running first
  const pid = getKnownPid();
  if (!pid) {
    console.log(colorize("\n=== Lobs Core Status ===\n", "bright"));
    console.log(colorize("  ✗ Not running", "red"));
    console.log(colorize("  Start with: lobs start\n", "dim"));
    return;
  }

  const data = await fetchApi("/status/overview");
  
  console.log(colorize("\n=== Lobs Core Status ===\n", "bright"));
  
  console.log(colorize("Server", "cyan"));
  console.log(`  Status:  ${data.server.status === "healthy" ? colorize("✓ healthy", "green") : colorize("✗ unhealthy", "red")}`);
  console.log(`  PID:     ${pid}`);
  console.log(`  Port:    ${LOBS_PORT}`);
  console.log(`  Uptime:  ${formatUptime(data.server.uptime_seconds)}`);
  console.log(`  Version: ${data.server.version}`);
  console.log("");
  
  console.log(colorize("Workers", "cyan"));
  console.log(`  Active:    ${data.workers.active}`);
  console.log(`  Completed: ${data.workers.total_completed}`);
  console.log(`  Failed:    ${data.workers.total_failed} (${data.workers.infra_failures} infra, ${data.workers.quality_failures} quality)`);
  console.log("");
  
  console.log(colorize("Tasks", "cyan"));
  console.log(`  Active:    ${data.tasks.active}`);
  console.log(`  Waiting:   ${data.tasks.waiting}`);
  console.log(`  Blocked:   ${data.tasks.blocked}`);
  console.log(`  Completed today: ${data.tasks.completed_today}`);
  console.log("");
  
  console.log(colorize("Inbox", "cyan"));
  console.log(`  Unread:    ${data.inbox.unread}`);
  console.log("");
}

async function cmdTasks(subcommand?: string) {
  if (!subcommand || subcommand === "list") {
    const tasks = await fetchApi("/tasks?status=active&limit=20");
    console.log(colorize("\n=== Active Tasks ===\n", "bright"));
    
    if (tasks.length === 0) {
      console.log(colorize("No active tasks", "dim"));
      return;
    }
    
    for (const task of tasks) {
      const id = task.id.slice(0, 8);
      const agent = colorize(task.agent || "unknown", "magenta");
      const tier = colorize(task.model_tier || "standard", "yellow");
      console.log(`${colorize(id, "gray")} ${agent} [${tier}] ${task.title}`);
    }
    console.log("");
    return;
  }
  
  if (subcommand === "view") {
    console.log("Usage: lobs tasks view <id>");
    return;
  }
  
  console.log("Usage: lobs tasks [list|view]");
}

async function cmdWorkers() {
  const data = await fetchApi("/worker/recent?limit=10");
  
  console.log(colorize("\n=== Recent Workers ===\n", "bright"));
  
  if (data.length === 0) {
    console.log(colorize("No recent workers", "dim"));
    return;
  }
  
  for (const run of data) {
    const workerId = run.workerId.slice(0, 12);
    const status = run.succeeded ? colorize("✓", "green") : colorize("✗", "red");
    const agent = colorize(run.agentType, "magenta");
    const model = run.model ? colorize(run.model, "blue") : colorize("unknown", "gray");
    const summary = run.summary || "(no summary)";
    console.log(`${status} ${colorize(workerId, "gray")} ${agent} ${model}`);
    console.log(`   ${colorize(summary.slice(0, 80), "dim")}`);
  }
  console.log("");
}

async function cmdConfigCheck() {
  const result = validateAllConfigs();
  printValidationResults(result);
}

async function cmdConfigShow() {
  console.log(colorize("\n=== Current Config ===\n", "bright"));
  console.log(colorize("Config directory:", "cyan"));
  console.log(`  ${CONFIG_DIR}`);
  console.log(colorize("\nSecrets directory:", "cyan"));
  console.log(`  ${SECRETS_DIR}`);
  console.log("");
  
  console.log(colorize("Files:", "cyan"));
  const files = [
    "models.json",
    "discord.json",
    "secrets/keys.json",
    "secrets/discord-token.json",
  ];
  
  for (const file of files) {
    const path = resolve(CONFIG_DIR, file);
    const exists = existsSync(path);
    const status = exists ? colorize("✓", "green") : colorize("✗", "gray");
    console.log(`  ${status} ${file}`);
  }
  console.log("");
}

async function cmdHealth() {
  const data = await fetchApi("/health");
  
  console.log(colorize("\n=== Health Check ===\n", "bright"));
  
  const status = data.status === "healthy" ? colorize("✓ HEALTHY", "green") : colorize("✗ UNHEALTHY", "red");
  console.log(`Status:        ${status}`);
  console.log(`Uptime:        ${formatUptime(data.uptime)}`);
  console.log(`PID:           ${data.pid || "unknown"}`);
  console.log(`DB:            ${data.db === "ok" ? colorize("✓ ok", "green") : colorize("✗ error", "red")}`);
  console.log(`Memory Server: ${data.memory_server === "ok" ? colorize("✓ ok", "green") : colorize("✗ down", "yellow")}`);

  const lmOk = data.lm_studio === "ok";
  console.log(`LM Studio:     ${lmOk ? colorize("✓ ok", "green") : colorize("✗ down", "yellow")}`);

  // Voice sidecar
  const voice = data.voice as Record<string, unknown> | undefined;
  if (voice?.enabled) {
    const sttOk = voice.stt === "ok";
    const ttsOk = voice.tts === "ok";
    console.log(`Voice STT:     ${sttOk ? colorize("✓ ok", "green") : colorize("✗ down", "yellow")}`);
    console.log(`Voice TTS:     ${ttsOk ? colorize("✓ ok", "green") : colorize("✗ down", "yellow")}`);
  } else {
    console.log(`Voice:         ${colorize("disabled", "dim")}`);
  }

  // When LM Studio is down, surface the cross-link to full diagnostics.
  if (!lmOk) {
    console.log("");
    console.log(colorize("  → LM Studio is unreachable. Run diagnostics:", "yellow"));
    console.log(colorize("    lobs preflight", "bright") + "    — full session preflight (health + model check)");
    console.log(colorize("    lobs models", "bright") + "       — model-availability diagnostic only");
    console.log(`    API: ${colorize("GET /api/lm-studio", "dim")}`);
  }

  console.log("");
}

async function cmdModelsDiagnostic() {
  const { getModelConfig } = await import("../config/models.js");
  const { loadKeyConfig, getEnvKeyForProvider } = await import("../config/keys.js");

  loadKeyConfig();
  const modelConfig = getModelConfig();
  const tiers = modelConfig.tiers as Record<string, string>;
  const tierFallbacks = (modelConfig as unknown as Record<string, unknown>).tierFallbacks as Record<string, string[]> | undefined;

  console.log(colorize("\n=== Model Overview ===\n", "bright"));

  console.log(colorize("Configured Tiers", "cyan"));
  for (const [tier, model] of Object.entries(tiers)) {
    const fallbacks = tierFallbacks?.[tier] ?? [];
    const suffix = fallbacks.length > 0 ? colorize(`  → ${fallbacks.join(" → ")}`, "dim") : "";
    console.log(`  ${colorize(tier.padEnd(8), "bright")} ${model}${suffix}`);
  }
  console.log("");

  const usedProviders = new Set<string>();
  for (const model of Object.values(tiers)) {
    const provider = model.includes("/") ? model.split("/")[0] : undefined;
    if (provider) usedProviders.add(provider);
  }
  if (tierFallbacks) {
    for (const models of Object.values(tierFallbacks)) {
      for (const model of models) {
        const provider = model.includes("/") ? model.split("/")[0] : undefined;
        if (provider) usedProviders.add(provider);
      }
    }
  }

  console.log(colorize("Cloud Providers In Use", "cyan"));
  const cloudProviders = [...usedProviders].filter((p) => p !== "lmstudio");
  if (cloudProviders.length === 0) {
    console.log(`  ${colorize("(none)", "dim")}`);
  } else {
    for (const provider of cloudProviders) {
      const envKey = getEnvKeyForProvider(provider);
      const hasKey = Boolean(process.env[envKey]);
      console.log(`  ${colorize(provider, "bright")}  ${hasKey ? colorize("✓ key set", "green") : colorize(`✗ ${envKey} not set`, "red")}`);
    }
  }
  console.log("");

  const report = await runLmStudioDiagnostic();
  const lines = formatDiagnosticReport(report, { color: process.stdout.isTTY });
  for (const line of lines) console.log(line);
  process.exit(report.ok ? 0 : 1);
}

async function cmdModelsAvailable(): Promise<void> {
  const catalog = await getModelCatalog();
  console.log(colorize("\n=== Model Catalog ===\n", "bright"));
  console.log(`Default chat model: ${colorize(catalog.defaultModel, "cyan")}`);
  console.log(`LM Studio: ${catalog.lmstudio.reachable ? colorize("reachable", "green") : colorize("unreachable", "red")} ${colorize(catalog.lmstudio.baseUrl, "dim")}`);
  console.log("");

  if (catalog.lmstudio.loadedModels.length > 0) {
    console.log(colorize("LM Studio Loaded Models", "cyan"));
    for (const model of catalog.lmstudio.loadedModels) {
      console.log(`  ${colorize(`lmstudio/${model}`, "green")}`);
    }
    console.log("");
  }

  console.log(colorize("Selectable Models", "cyan"));
  for (const option of catalog.options) {
    const meta = [option.tier ? `tier:${option.tier}` : null, option.loaded ? "loaded" : null, option.source]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${colorize(option.id, "bright")}${meta ? colorize(`  [${meta}]`, "dim") : ""}`);
  }
  console.log("");
}

/**
 * `lobs preflight` — consolidated session startup check.
 *
 * Runs in two phases:
 *   1. System health (DB, memory server, LM Studio reachability)
 *   2. LM Studio model-availability diagnostic (always runs, not just when down)
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed (models missing / LM Studio down)
 */
async function cmdPreflight() {
  console.log(colorize("\n╔══════════════════════════════════╗", "cyan"));
  console.log(colorize("║  LM Studio Preflight Checklist   ║", "cyan"));
  console.log(colorize("╚══════════════════════════════════╝", "cyan"));
  console.log("");

  // ── Phase 1: System health ──────────────────────────────────────────────
  console.log(colorize("Phase 1 — System Health", "bright"));
  console.log(colorize("─────────────────────────────────", "dim"));

  let healthData: Record<string, unknown>;
  try {
    healthData = await fetchApi("/health");
  } catch {
    console.log(colorize("  ✗ lobs-core unreachable", "red") + " — is the server running? (lobs start)");
    console.log("");
    process.exit(1);
  }

  const dbOk        = healthData.db            === "ok";
  const memOk       = healthData.memory_server === "ok";
  const lmReachable = healthData.lm_studio     === "ok";

  console.log(`  DB:            ${dbOk  ? colorize("✓ ok", "green") : colorize("✗ error", "red")}`);
  console.log(`  Memory Server: ${memOk ? colorize("✓ ok", "green") : colorize("✗ down", "yellow")}`);
  console.log(`  LM Studio:     ${lmReachable ? colorize("✓ reachable", "green") : colorize("✗ unreachable", "red")}`);

  if (!lmReachable) {
    console.log("");
    console.log(colorize("  ✗ LM Studio is unreachable — model diagnostic skipped.", "red"));
    console.log("    Start LM Studio and load at least one model before spawning local agents.");
    console.log("    API docs: GET /api/lm-studio  (status, models, latency sub-routes)");
    console.log("");
    process.exit(1);
  }

  console.log("");

  // ── Phase 2: Model availability diagnostic ─────────────────────────────
  console.log(colorize("Phase 2 — Model Availability", "bright"));
  console.log(colorize("─────────────────────────────────", "dim"));

  const report = await runLmStudioDiagnostic();
  const lines  = formatDiagnosticReport(report, { color: process.stdout.isTTY });
  for (const line of lines) console.log("  " + line);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("");
  console.log(colorize("─────────────────────────────────", "dim"));
  if (report.ok) {
    console.log(colorize("✓ Preflight passed — system ready to spawn local agents.", "green"));
  } else {
    console.log(colorize("✗ Preflight failed — load missing models in LM Studio before spawning.", "red"));
    console.log("  Diagnostic API: GET /api/lm-studio/models  (for remote callers / paw-hub)");
  }
  console.log("");

  process.exit(report.ok ? 0 : 1);
}

function cmdInit() {
  console.log(colorize("\n=== Initializing Config ===\n", "bright"));
  
  // Create directories
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    console.log(colorize("✓", "green") + " Created " + CONFIG_DIR);
  } else {
    console.log(colorize("✓", "gray") + " Config dir exists: " + CONFIG_DIR);
  }
  
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true });
    console.log(colorize("✓", "green") + " Created " + SECRETS_DIR);
  } else {
    console.log(colorize("✓", "gray") + " Secrets dir exists: " + SECRETS_DIR);
  }
  
  // Create .gitignore
  const gitignorePath = resolve(CONFIG_DIR, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "secrets/\n*.log\n");
    console.log(colorize("✓", "green") + " Created .gitignore");
  } else {
    console.log(colorize("✓", "gray") + " .gitignore exists");
  }
  
  // Create skeleton config files (if they don't exist)
  const modelsPath = resolve(CONFIG_DIR, "models.json");
  if (!existsSync(modelsPath)) {
    const cfg = getModelConfig();
    const modelsTemplate = { tiers: cfg.tiers, agents: cfg.agents, local: cfg.local };
    writeFileSync(modelsPath, JSON.stringify(modelsTemplate, null, 2));
    console.log(colorize("✓", "green") + " Created models.json");
  } else {
    console.log(colorize("✓", "gray") + " models.json exists");
  }
  
  const identityPath = resolve(CONFIG_DIR, "identity.json");
  if (!existsSync(identityPath)) {
    const identityTemplate = {
      bot: { name: "YourBot", id: "yourbot" },
      owner: { name: "YourName", id: "yourname", discordId: "YOUR_DISCORD_USER_ID" },
    };
    writeFileSync(identityPath, JSON.stringify(identityTemplate, null, 2));
    console.log(colorize("✓", "green") + " Created identity.json (UPDATE WITH YOUR DETAILS)");
  } else {
    console.log(colorize("✓", "gray") + " identity.json exists");
  }
  
  const discordPath = resolve(CONFIG_DIR, "discord.json");
  if (!existsSync(discordPath)) {
    const discordTemplate = {
      enabled: false,
      guildId: "",
      dmAllowFrom: [],
      channels: {
        alerts: "",
        agentWork: "",
        completions: "",
      },
      channelPolicies: {},
    };
    writeFileSync(discordPath, JSON.stringify(discordTemplate, null, 2));
    console.log(colorize("✓", "green") + " Created discord.json");
  } else {
    console.log(colorize("✓", "gray") + " discord.json exists");
  }
  
  // Create placeholder secrets (if they don't exist)
  const keysPath = resolve(SECRETS_DIR, "keys.json");
  if (!existsSync(keysPath)) {
    const keysTemplate = {
      anthropic: [
        { key: "sk-ant-...", label: "main" }
      ],
    };
    writeFileSync(keysPath, JSON.stringify(keysTemplate, null, 2));
    console.log(colorize("✓", "green") + " Created secrets/keys.json (UPDATE WITH REAL KEYS)");
  } else {
    console.log(colorize("✓", "gray") + " secrets/keys.json exists");
  }
  
  const tokenPath = resolve(SECRETS_DIR, "discord-token.json");
  if (!existsSync(tokenPath)) {
    const tokenTemplate = { botToken: "YOUR_DISCORD_BOT_TOKEN_HERE" };
    writeFileSync(tokenPath, JSON.stringify(tokenTemplate, null, 2));
    console.log(colorize("✓", "green") + " Created secrets/discord-token.json (UPDATE WITH REAL TOKEN)");
  } else {
    console.log(colorize("✓", "gray") + " secrets/discord-token.json exists");
  }
  
  console.log("");
  console.log(colorize("✓ Config initialized", "green"));
  console.log("");
  console.log(colorize("Next steps:", "cyan"));
  console.log("  1. Update identity.json with your bot name and owner details");
  console.log("  2. Update secrets/keys.json with your API keys");
  console.log("  3. Update secrets/discord-token.json with your Discord bot token");
  console.log("  4. Update discord.json with your guild ID and channel IDs");
  console.log("  5. Run 'lobs config check' to validate");
  console.log("");
}

// ── Setup Wizard ──────────────────────────────────────────────────────────────

/** Prompt helper — shows question, returns answer (or defaultValue if Enter pressed) */
async function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue?: string
): Promise<string> {
  const hint = defaultValue ? colorize(` [${defaultValue}]`, "dim") : "";
  const answer = await rl.question(`  ${question}${hint}: `);
  return answer.trim() || defaultValue || "";
}

/** Confirm helper — returns true for "y", false for "n"/Enter (defaultYes=false) */
async function confirm(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultYes = false
): Promise<boolean> {
  const hint = defaultYes ? "(Y/n)" : "(y/N)";
  const answer = await rl.question(`  ${question} ${colorize(hint, "dim")} `);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

/** Masked input — reads a secret, showing only last 4 chars of any existing value */
function maskSecret(val: string): string {
  if (!val || val.length < 8) return val ? "****" : "";
  return "****" + val.slice(-4);
}

async function cmdSetup(): Promise<void> {
  const rl = createInterface({ input, output });

  console.log(colorize("\n╔══════════════════════════════════════╗", "cyan"));
  console.log(colorize("║       lobs setup wizard              ║", "cyan"));
  console.log(colorize("╚══════════════════════════════════════╝", "cyan"));
  console.log(colorize("\nThis walks you through configuring each part of the system.", "dim"));
  console.log(colorize("Press Enter to keep existing values. Type 'skip' to skip a section.\n", "dim"));

  // Ensure directories exist
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    console.log(colorize("✓", "green") + " Created " + CONFIG_DIR);
  }
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true });
    console.log(colorize("✓", "green") + " Created " + SECRETS_DIR);
  }
  // Ensure .gitignore exists
  const gitignorePath = resolve(CONFIG_DIR, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "secrets/\n*.log\n");
  }

  const configured: string[] = [];
  const skipped: string[] = [];

  // ── Section 1: Identity ────────────────────────────────────────────────────
  console.log(colorize("\n━━━ 1. Identity ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "bright"));
  const identityPath = resolve(CONFIG_DIR, "identity.json");

  let existingIdentity: { bot?: { name?: string; id?: string }; owner?: { name?: string; id?: string; discordId?: string } } = {};
  if (existsSync(identityPath)) {
    try {
      existingIdentity = JSON.parse(readFileSync(identityPath, "utf-8"));
      console.log(colorize("  Current values:", "dim"));
      console.log(colorize(`    bot name: ${existingIdentity.bot?.name ?? "—"}  id: ${existingIdentity.bot?.id ?? "—"}`, "dim"));
      console.log(colorize(`    owner: ${existingIdentity.owner?.name ?? "—"}  id: ${existingIdentity.owner?.id ?? "—"}  discordId: ${existingIdentity.owner?.discordId ?? "—"}`, "dim"));
    } catch { /* ignore parse errors */ }
  }

  const skipIdentity = await confirm(rl, "Skip identity setup?", false);
  if (skipIdentity) {
    skipped.push("identity.json");
  } else {
    const botName = await ask(rl, "Bot name", existingIdentity.bot?.name ?? "Lobs");
    const botId = await ask(rl, "Bot ID (lowercase, no spaces)", existingIdentity.bot?.id ?? "lobs");
    const ownerName = await ask(rl, "Owner name", existingIdentity.owner?.name ?? "");
    const ownerId = await ask(rl, "Owner ID (lowercase)", existingIdentity.owner?.id ?? "");
    const ownerDiscordId = await ask(rl, "Owner Discord ID (numeric)", existingIdentity.owner?.discordId ?? "");

    const identity = {
      bot: { name: botName, id: botId },
      owner: { name: ownerName, id: ownerId, discordId: ownerDiscordId },
    };
    writeFileSync(identityPath, JSON.stringify(identity, null, 2));
    console.log(colorize("  ✓ identity.json saved", "green"));
    configured.push("identity.json");
    existingIdentity = identity;
  }

  // ── Section 2: API Keys ───────────────────────────────────────────────────
  console.log(colorize("\n━━━ 2. API Keys ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "bright"));
  const keysPath = resolve(SECRETS_DIR, "keys.json");

  let existingKeys: Record<string, { key: string; label?: string }[]> = {};
  if (existsSync(keysPath)) {
    try {
      existingKeys = JSON.parse(readFileSync(keysPath, "utf-8"));
      const providers = Object.keys(existingKeys);
      console.log(colorize(`  API keys already configured for: ${providers.join(", ")}`, "dim"));
      for (const [provider, keys] of Object.entries(existingKeys)) {
        for (const k of keys) {
          console.log(colorize(`    ${provider}: ${maskSecret(k.key)}`, "dim"));
        }
      }
    } catch { /* ignore */ }
  }

  const skipKeys = await confirm(rl, "Skip API key setup?", false);
  if (skipKeys) {
    skipped.push("secrets/keys.json");
  } else {
    const newKeys: Record<string, { key: string; label: string }[]> = { ...existingKeys } as Record<string, { key: string; label: string }[]>;

    // Anthropic
    const existingAnthropic = existingKeys.anthropic?.[0]?.key ?? "";
    console.log(colorize(`  Anthropic API key${existingAnthropic ? ` (current: ${maskSecret(existingAnthropic)})` : " (required)"}`, "dim"));
    const anthropicKey = await ask(rl, "Anthropic key (sk-ant-...)", existingAnthropic);
    if (anthropicKey) {
      newKeys.anthropic = [{ key: anthropicKey, label: "main" }];
    }

    // OpenAI
    const existingOpenAI = existingKeys.openai?.[0]?.key ?? "";
    console.log(colorize(`  OpenAI API key${existingOpenAI ? ` (current: ${maskSecret(existingOpenAI)})` : " (optional, Enter to skip)"}`, "dim"));
    const openaiKey = await ask(rl, "OpenAI key (sk-...)", existingOpenAI);
    if (openaiKey) {
      newKeys.openai = [{ key: openaiKey, label: "main" }];
    }

    // Google
    const existingGoogle = existingKeys.google?.[0]?.key ?? "";
    console.log(colorize(`  Google API key${existingGoogle ? ` (current: ${maskSecret(existingGoogle)})` : " (optional, Enter to skip)"}`, "dim"));
    const googleKey = await ask(rl, "Google key", existingGoogle);
    if (googleKey) {
      newKeys.google = [{ key: googleKey, label: "main" }];
    }

    writeFileSync(keysPath, JSON.stringify(newKeys, null, 2));
    console.log(colorize("  ✓ secrets/keys.json saved", "green"));
    configured.push("secrets/keys.json");
  }

  // ── Section 3: Discord ────────────────────────────────────────────────────
  console.log(colorize("\n━━━ 3. Discord ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "bright"));
  const tokenPath = resolve(SECRETS_DIR, "discord-token.json");
  const discordPath = resolve(CONFIG_DIR, "discord.json");

  let existingToken = "";
  if (existsSync(tokenPath)) {
    try {
      const t = JSON.parse(readFileSync(tokenPath, "utf-8"));
      existingToken = t.botToken ?? "";
      console.log(colorize(`  Discord token: ${maskSecret(existingToken)}`, "dim"));
    } catch { /* ignore */ }
  }

  let existingDiscord: {
    enabled?: boolean;
    guildId?: string;
    ownerId?: string;
    channels?: { alerts?: string; agentWork?: string; completions?: string };
    dmAllowFrom?: string[];
    channelPolicies?: Record<string, unknown>;
  } = {};
  if (existsSync(discordPath)) {
    try {
      existingDiscord = JSON.parse(readFileSync(discordPath, "utf-8"));
      console.log(colorize(`  Guild ID: ${existingDiscord.guildId ?? "—"}`, "dim"));
      console.log(colorize(`  Alert channel: ${existingDiscord.channels?.alerts ?? "—"}`, "dim"));
    } catch { /* ignore */ }
  }

  const skipDiscord = await confirm(rl, "Skip Discord setup?", false);
  if (skipDiscord) {
    skipped.push("discord");
  } else {
    const botToken = await ask(rl, "Discord bot token (masked display)", existingToken);
    const guildId = await ask(rl, "Guild ID", existingDiscord.guildId ?? "");
    // Pre-fill owner Discord ID from identity if available
    const ownerDiscordId = await ask(
      rl,
      "Owner Discord ID",
      existingDiscord.ownerId ?? existingIdentity.owner?.discordId ?? ""
    );
    const alertChannel = await ask(rl, "Alert channel ID (optional)", existingDiscord.channels?.alerts ?? "");
    const agentWorkChannel = await ask(rl, "Agent work channel ID (optional)", existingDiscord.channels?.agentWork ?? "");

    if (botToken) {
      writeFileSync(tokenPath, JSON.stringify({ botToken }, null, 2));
      console.log(colorize("  ✓ secrets/discord-token.json saved", "green"));
    }

    const discordConfig = {
      enabled: !!(botToken && guildId),
      guildId,
      ownerId: ownerDiscordId,
      dmAllowFrom: existingDiscord.dmAllowFrom ?? [],
      channels: {
        alerts: alertChannel,
        agentWork: agentWorkChannel,
        completions: existingDiscord.channels?.completions ?? "",
      },
      channelPolicies: existingDiscord.channelPolicies ?? {},
    };
    writeFileSync(discordPath, JSON.stringify(discordConfig, null, 2));
    console.log(colorize("  ✓ discord.json saved", "green"));
    configured.push("discord");
  }

  // ── Section 4: Models ─────────────────────────────────────────────────────
  console.log(colorize("\n━━━ 4. Models ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "bright"));
  const modelsPath = resolve(CONFIG_DIR, "models.json");
  const { DEFAULT_CONFIG } = await import("../config/models.js");
  const defaultTiers = DEFAULT_CONFIG.tiers;

  let existingModels: { tiers?: Record<string, string> } = {};
  if (existsSync(modelsPath)) {
    try {
      existingModels = JSON.parse(readFileSync(modelsPath, "utf-8"));
    } catch { /* ignore */ }
  }

  console.log(colorize("  Default tier assignments:", "dim"));
  for (const [tier, model] of Object.entries(defaultTiers)) {
    const current = existingModels.tiers?.[tier];
    const display = current && current !== model ? colorize(current, "yellow") + colorize(` (default: ${model})`, "dim") : colorize(model, "dim");
    console.log(`    ${tier.padEnd(10)} → ${display}`);
  }

  const skipModels = await confirm(rl, "Skip model configuration?", false);
  if (skipModels) {
    skipped.push("models.json");
  } else {
    const useDefaults = await confirm(rl, "Use default model configuration?", true);
    if (useDefaults) {
      const modelsConfig = { tiers: { ...defaultTiers, ...(existingModels.tiers ?? {}) } };
      writeFileSync(modelsPath, JSON.stringify(modelsConfig, null, 2));
      console.log(colorize("  ✓ models.json saved (defaults)", "green"));
      configured.push("models.json");
    } else {
      console.log(colorize("  Enter model ID for each tier (Enter to keep current/default):", "dim"));
      const tiers: Record<string, string> = { ...defaultTiers, ...(existingModels.tiers ?? {}) };
      for (const tier of ["micro", "small", "medium", "standard", "strong"]) {
        const current = tiers[tier] ?? defaultTiers[tier as keyof typeof defaultTiers];
        tiers[tier] = await ask(rl, tier, current);
      }
      writeFileSync(modelsPath, JSON.stringify({ tiers }, null, 2));
      console.log(colorize("  ✓ models.json saved", "green"));
      configured.push("models.json");
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  rl.close();

  console.log(colorize("\n━━━ Setup complete ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "bright"));
  if (configured.length > 0) {
    console.log(colorize("  Configured:", "green") + " " + configured.join(", "));
  }
  if (skipped.length > 0) {
    console.log(colorize("  Skipped:   ", "yellow") + " " + skipped.join(", "));
  }
  console.log("");
  console.log(colorize("  Run 'lobs config check' to validate your setup.", "dim"));
  console.log("");
}

// ── Chat ─────────────────────────────────────────────────────────────────────

function printChatSessionList(sessions: ChatSessionSummary[]): void {
  console.log(colorize("\n=== Chat Sessions ===\n", "bright"));

  if (sessions.length === 0) {
    console.log(colorize("No chat sessions yet. Start one with `lobs chat`.", "dim"));
    return;
  }

  for (const session of sessions) {
    const key = colorize(session.key, "gray");
    const title = colorize(session.title || "New Chat", "bright");
    const updated = colorize(formatTimestamp(session.updatedAt), "dim");
    const flags = [
      session.processing ? colorize("processing", "yellow") : null,
      session.unreadCount > 0 ? colorize(`${session.unreadCount} unread`, "cyan") : null,
      session.compliance_required ? colorize("compliance", "magenta") : null,
    ].filter(Boolean).join(", ");

    console.log(`${title} ${key}`);
    console.log(`  Updated: ${updated}${flags ? `  ${flags}` : ""}`);
    if (session.summary) {
      console.log(`  ${colorize(session.summary, "dim")}`);
    }
  }
  console.log("");
}

async function cmdChatList(): Promise<void> {
  const sessions = await getChatSessions();
  printChatSessionList(sessions);
}

async function cmdChatShow(sessionKey?: string): Promise<void> {
  if (!sessionKey) {
    console.log(colorize("Usage: lobs chat show <session-key>", "yellow"));
    return;
  }

  const session = await getChatSession(sessionKey);
  if (!session) {
    console.log(colorize(`Chat session not found: ${sessionKey}`, "red"));
    return;
  }

  console.log(colorize(`\n=== ${session.title} ===\n`, "bright"));
  console.log(colorize(`Session: ${session.key}`, "dim"));
  console.log(colorize(`Updated: ${formatTimestamp(session.updatedAt)}`, "dim"));
  if (session.currentModel) console.log(colorize(`Model: ${session.currentModel}`, "dim"));
  if (session.summary) console.log(colorize(`Summary: ${session.summary}`, "dim"));
  console.log("");

  const messages = await getChatMessages(sessionKey);
  printChatTranscript(messages);
  console.log("");
  await markChatRead(sessionKey);
}

async function runChatSession(session: ChatSessionSummary, showHistory = false): Promise<void> {
  console.log(colorize(`\n=== ${session.title || "New Chat"} ===\n`, "bright"));
  console.log(colorize(`Session key: ${session.key}`, "dim"));
  if (session.currentModel) console.log(colorize(`Model: ${session.currentModel}`, "dim"));
  console.log(colorize("Commands: /exit, /quit, /history, /sessions, /models, /model <id|default>, /help", "dim"));
  console.log("");

  if (showHistory) {
    const messages = await getChatMessages(session.key);
    printChatTranscript(messages);
    if (messages.length > 0) console.log("");
  }

  await markChatRead(session.key);

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question(colorize("you> ", "cyan"))).trim();
      if (!line) continue;

      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") {
        console.log(colorize("Commands: /exit, /quit, /history, /sessions, /models, /model <id|default>, /help", "dim"));
        continue;
      }
      if (line === "/models") {
        const catalog = await getModelCatalog(session.key);
        console.log(colorize(`Current model: ${catalog.currentModel}`, "cyan"));
        if (catalog.lmstudio.loadedModels.length > 0) {
          console.log(colorize("LM Studio loaded:", "dim"));
          for (const model of catalog.lmstudio.loadedModels) {
            console.log(`  ${colorize(`lmstudio/${model}`, "green")}`);
          }
        }
        console.log(colorize("Available picks:", "dim"));
        for (const option of catalog.options.slice(0, 25)) {
          console.log(`  ${option.id}`);
        }
        continue;
      }
      if (line.startsWith("/model")) {
        const requested = line.replace(/^\/model\s*/, "").trim();
        if (!requested) {
          const catalog = await getModelCatalog(session.key);
          console.log(colorize(`Current model: ${catalog.currentModel}`, "cyan"));
          continue;
        }
        const nextModel = requested === "default" ? null : requested;
        const result = await setChatSessionModel(session.key, nextModel);
        session.currentModel = result.currentModel;
        session.overrideModel = result.overrideModel;
        console.log(colorize(`Model set to ${result.currentModel}`, "green"));
        continue;
      }
      if (line === "/sessions") {
        const sessions = await getChatSessions();
        printChatSessionList(sessions);
        continue;
      }
      if (line === "/history") {
        const messages = await getChatMessages(session.key);
        printChatTranscript(messages);
        continue;
      }

      const sentAt = new Date().toISOString();
      await postApi(`/chat/sessions/${session.key}/messages`, { content: line });
      console.log(colorize("assistant> thinking...", "dim"));
      await waitForChatTurn(session.key, sentAt);
      await markChatRead(session.key);
      console.log("");
    }
  } finally {
    rl.close();
  }
}

async function cmdChat(subCmd?: string, extraArgs: string[] = []): Promise<void> {
  if (!subCmd || subCmd === "new") {
    const title = extraArgs.join(" ").trim() || undefined;
    const session = await createChatSession(title);
    await runChatSession(session, false);
    return;
  }

  if (subCmd === "list") {
    await cmdChatList();
    return;
  }

  if (subCmd === "show") {
    await cmdChatShow(extraArgs[0]);
    return;
  }

  if (subCmd === "resume") {
    const sessionKey = extraArgs[0];
    if (!sessionKey) {
      console.log(colorize("Usage: lobs chat resume <session-key>", "yellow"));
      return;
    }
    const session = await getChatSession(sessionKey);
    if (!session) {
      console.log(colorize(`Chat session not found: ${sessionKey}`, "red"));
      return;
    }
    await runChatSession(session, true);
    return;
  }

  if (subCmd === "model") {
    const sessionKey = extraArgs[0];
    const requested = extraArgs.slice(1).join(" ").trim();
    if (!sessionKey) {
      console.log(colorize("Usage: lobs chat model <session-key> [model|default]", "yellow"));
      return;
    }
    if (!requested) {
      const catalog = await getModelCatalog(sessionKey);
      console.log(colorize(`Current model: ${catalog.currentModel}`, "cyan"));
      return;
    }
    const result = await setChatSessionModel(sessionKey, requested === "default" ? null : requested);
    console.log(colorize(`Model for ${sessionKey} set to ${result.currentModel}`, "green"));
    return;
  }

  console.log(colorize("Usage: lobs chat [new [title]|list|show <key>|resume <key>|model <key> [model|default]]", "yellow"));
}

// ── Cron ─────────────────────────────────────────────────────────────────────

function timeAgo(isoStr: string | null): string {
  if (!isoStr) return "never";
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) return "future";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function cmdCron(subCmd?: string, extraArgs: string[] = []) {
  // list (default)
  if (!subCmd || subCmd === "list") {
    const data = await fetchApi("/scheduler");
    const jobs = data.jobs as any[];

    console.log(colorize("\n=== Cron Jobs ===\n", "bright"));

    const systemJobs = jobs.filter((j: any) => j.kind === "system");
    const agentJobs = jobs.filter((j: any) => j.kind === "agent");

    console.log(colorize("System Jobs:", "cyan"));
    if (systemJobs.length === 0) {
      console.log("  (none)");
    } else {
      for (const j of systemJobs) {
        const check = j.enabled ? colorize("✓", "green") : colorize("✗", "red");
        const name = j.name.padEnd(22);
        const sched = j.schedule.padEnd(16);
        const last = `last: ${timeAgo(j.lastRun)}`;
        console.log(`  ${check} ${colorize(name, "bright")}${colorize(sched, "dim")}  ${colorize(last, "gray")}`);
      }
    }

    console.log("");
    console.log(colorize("Agent Jobs:", "cyan"));
    if (agentJobs.length === 0) {
      console.log("  (none)");
    } else {
      for (const j of agentJobs) {
        const check = j.enabled ? colorize("✓", "green") : colorize("✗", "red");
        const name = j.name.padEnd(22);
        const kindTag = j.payloadKind === "script"
          ? colorize("[script]", "yellow")
          : colorize("[agent]", "cyan");
        const sched = j.schedule.padEnd(16);
        const last = `last: ${timeAgo(j.lastRun)}`;
        const id = colorize(`[${j.id.slice(0, 8)}]`, "dim");
        console.log(`  ${check} ${colorize(name, "bright")}${kindTag}  ${colorize(sched, "dim")}  ${colorize(last, "gray")}  ${id}`);
      }
    }

    console.log("");
    return;
  }

  // add [--script] <name> <schedule> <payload>
  if (subCmd === "add") {
    const isScript = extraArgs.includes("--script");
    const filteredArgs = extraArgs.filter((a) => a !== "--script");
    const name = filteredArgs[0];
    const schedule = filteredArgs[1];
    const payload = filteredArgs.slice(2).join(" ");

    if (!name || !schedule || !payload) {
      console.log(colorize("Usage: lobs cron add <name> <schedule> <payload>", "yellow"));
      console.log(colorize("       lobs cron add --script <name> <schedule> <cmd>", "yellow"));
      console.log(colorize("Example: lobs cron add 'Daily Report' '0 9 * * *' 'Generate daily report'", "dim"));
      console.log(colorize("Example: lobs cron add --script 'Pulse Update' '0 3 * * *' 'node scripts/update-pulse.js'", "dim"));
      return;
    }

    const body: Record<string, unknown> = { name, schedule, payload };
    if (isScript) body.payload_kind = "script";

    const result = await postApi("/scheduler", body);
    console.log(colorize("✓", "green") + ` Created ${isScript ? "script" : "agent"} cron job: ${result.name}`);
    console.log(colorize(`  ID: ${result.id}`, "dim"));
    console.log(colorize(`  Schedule: ${result.schedule}`, "dim"));
    return;
  }

  // remove <id>
  if (subCmd === "remove" || subCmd === "rm" || subCmd === "delete") {
    const id = extraArgs[0];
    if (!id) {
      console.log(colorize("Usage: lobs cron remove <id>", "yellow"));
      return;
    }

    await deleteApi(`/scheduler/${id}`);
    console.log(colorize("✓", "green") + ` Removed cron job: ${id}`);
    return;
  }

  // toggle <id>
  if (subCmd === "toggle") {
    const id = extraArgs[0];
    if (!id) {
      console.log(colorize("Usage: lobs cron toggle <id>", "yellow"));
      return;
    }

    const result = await postApi(`/scheduler/${id}/toggle`, {});
    const state = result.enabled ? colorize("enabled", "green") : colorize("disabled", "red");
    console.log(colorize("✓", "green") + ` ${result.name} → ${state}`);
    return;
  }

  // run <id>
  if (subCmd === "run") {
    const id = extraArgs[0];
    if (!id) {
      console.log(colorize("Usage: lobs cron run <id>", "yellow"));
      return;
    }

    const result = await postApi(`/scheduler/${id}/run`, {});
    console.log(colorize("✓", "green") + ` Triggered: ${result.name}`);
    return;
  }

  // Unknown subcommand
  console.log(colorize("Usage: lobs cron [list|add|remove|toggle|run]", "yellow"));
  console.log("");
  console.log("  list                              List all cron jobs");
  console.log("  add <name> <sched> <payload>       Add an agent job (default: LLM)");
  console.log("  add --script <name> <sched> <cmd>  Add a script job (shell command)");
  console.log("  remove <id>                       Remove an agent job");
  console.log("  toggle <id>                       Toggle enabled/disabled");
  console.log("  run <id>                          Trigger immediate run");
}

// ── Memory Commands ───────────────────────────────────────────────────────────

async function handleMemoryCommand(subCmd?: string, extraArgs: string[] = []): Promise<void> {
  // Lazy-load memory DB only for subcommands that need it (list, status).
  // index subcommand talks directly to lobs-memory server via HTTP.
  const needDb = !subCmd || subCmd === "list" || subCmd === "status";
  const db = needDb ? (() => { const { getMemoryDb } = require("../memory/db.js"); return getMemoryDb(); })() : null;

  // ── lobs memory list ──────────────────────────────────────────────────────
  if (!subCmd || subCmd === "list") {
    // Parse flags: --type <type> --limit <n>
    let filterType: string | null = null;
    let limit = 20;
    for (let i = 0; i < extraArgs.length; i++) {
      if (extraArgs[i] === "--type" && extraArgs[i + 1]) {
        filterType = extraArgs[++i];
      } else if (extraArgs[i] === "--limit" && extraArgs[i + 1]) {
        limit = parseInt(extraArgs[++i], 10) || 20;
      }
    }

    const query = filterType
      ? db.prepare(
          "SELECT * FROM memories WHERE status = 'active' AND memory_type = ? ORDER BY created_at DESC LIMIT ?",
        )
      : db.prepare(
          "SELECT * FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT ?",
        );

    const rows: any[] = filterType
      ? (query.all(filterType, limit) as any[])
      : (query.all(limit) as any[]);

    console.log(colorize("\n=== Recent Active Memories ===\n", "bright"));

    if (rows.length === 0) {
      console.log(colorize("No active memories found.", "dim"));
      return;
    }

    const idW = 5;
    const typeW = 12;
    const confW = 11;
    const scopeW = 9;
    const dateW = 12;
    const header =
      "ID".padEnd(idW) +
      "Type".padEnd(typeW) +
      "Confidence".padEnd(confW) +
      "Scope".padEnd(scopeW) +
      "Created".padEnd(dateW) +
      "Content (truncated)";
    console.log(colorize(header, "cyan"));
    console.log(colorize("─".repeat(80), "dim"));

    for (const row of rows) {
      const id = String(row.id).padEnd(idW);
      const type = (row.memory_type as string).padEnd(typeW);
      const conf = String((row.confidence as number).toFixed(2)).padEnd(confW);
      const scope = (row.scope as string).padEnd(scopeW);
      const created = (row.created_at as string).slice(0, 10).padEnd(dateW);
      const content = (row.content as string).replace(/\n/g, " ").slice(0, 60);
      console.log(`${colorize(id, "gray")}${colorize(type, "yellow")}${conf}${scope}${colorize(created, "dim")}${content}`);
    }
    console.log("");
    return;
  }

  // ── lobs memory show <id> ─────────────────────────────────────────────────
  if (subCmd === "show") {
    const id = parseInt(extraArgs[0] ?? "", 10);
    if (!id) {
      console.log(colorize("Usage: lobs memory show <id>", "yellow"));
      return;
    }

    const row: any = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!row) {
      console.log(colorize(`Memory #${id} not found.`, "red"));
      return;
    }

    const authorityLabel = ["0 (low)", "1 (system)", "2 (agent/explicit)", "3 (user preference)"][
      row.source_authority as number
    ] ?? String(row.source_authority);

    console.log(colorize(`\nMemory #${row.id}`, "bright"));
    console.log(`Type:             ${colorize(row.memory_type, "yellow")}`);
    console.log(`Confidence:       ${row.confidence}`);
    console.log(`Scope:            ${row.scope}`);
    console.log(`Status:           ${row.status}`);
    console.log(`Source Authority: ${authorityLabel}`);
    console.log(`Created:          ${row.created_at}`);
    console.log(`Last Accessed:    ${row.last_accessed ?? "never"}`);
    console.log(`Access Count:     ${row.access_count}`);
    if (row.expires_at) console.log(`Expires At:       ${row.expires_at}`);
    if (row.project_id) console.log(`Project:          ${row.project_id}`);
    console.log(`\nContent:\n${row.content}`);

    // Evidence events
    const evidence: any[] = db
      .prepare(
        `SELECT e.*, ev.event_type, ev.created_at AS event_created
         FROM evidence e
         JOIN events ev ON ev.id = e.event_id
         WHERE e.memory_id = ?
         ORDER BY e.created_at DESC
         LIMIT 10`,
      )
      .all(id) as any[];

    if (evidence.length > 0) {
      console.log(`\nEvidence (${evidence.length} event${evidence.length !== 1 ? "s" : ""}):`);
      for (const ev of evidence) {
        console.log(
          `  - Event #${ev.event_id}: ${ev.event_type} (${(ev.event_created as string).slice(0, 19)})`,
        );
      }
    }
    console.log("");
    return;
  }

  // ── lobs memory conflicts ─────────────────────────────────────────────────
  if (subCmd === "conflicts") {
    const conflicts: any[] = db
      .prepare(
        "SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC",
      )
      .all() as any[];

    console.log(colorize("\n=== Unresolved Memory Conflicts ===\n", "bright"));

    if (conflicts.length === 0) {
      console.log(colorize("No unresolved conflicts.", "dim"));
      console.log("");
      return;
    }

    for (const conflict of conflicts) {
      const memA: any = db.prepare("SELECT * FROM memories WHERE id = ?").get(conflict.memory_a);
      const memB: any = db.prepare("SELECT * FROM memories WHERE id = ?").get(conflict.memory_b);
      const detected = (conflict.created_at as string).slice(0, 10);
      console.log(
        colorize(`Conflict #${conflict.id}`, "bright") +
          ` (${conflict.description}) — detected ${detected}`,
      );
      if (memA) {
        console.log(
          `  A: [${colorize(memA.memory_type, "yellow")}, ${memA.confidence}] ${(memA.content as string).replace(/\n/g, " ").slice(0, 100)}`,
        );
      }
      if (memB) {
        console.log(
          `  B: [${colorize(memB.memory_type, "yellow")}, ${memB.confidence}] ${(memB.content as string).replace(/\n/g, " ").slice(0, 100)}`,
        );
      }
      console.log("");
    }
    return;
  }

  // ── lobs memory resolve <conflict-id> <a|b|dismiss> ──────────────────────
  if (subCmd === "resolve") {
    const conflictId = parseInt(extraArgs[0] ?? "", 10);
    const choice = extraArgs[1]?.toLowerCase();

    if (!conflictId || !choice) {
      console.log(colorize("Usage: lobs memory resolve <conflict-id> <a|b|dismiss>", "yellow"));
      return;
    }

    const resolutionMap: Record<string, "choose_a" | "choose_b" | "dismiss"> = {
      a: "choose_a",
      b: "choose_b",
      dismiss: "dismiss",
    };

    const resolution = resolutionMap[choice];
    if (!resolution) {
      console.log(colorize(`Unknown choice '${choice}'. Use: a, b, or dismiss`, "red"));
      return;
    }

    const { resolveConflict } = await import("../memory/conflicts.js");
    await resolveConflict(conflictId, resolution);

    const resultMsg =
      resolution === "choose_a"
        ? "chose memory A, superseded memory B"
        : resolution === "choose_b"
          ? "chose memory B, superseded memory A"
          : "dismissed both memories";

    console.log(colorize(`✓ Resolved conflict #${conflictId}: ${resultMsg}.`, "green"));
    return;
  }

  // ── lobs memory promote <id> <authority> ──────────────────────────────────
  if (subCmd === "promote") {
    const memId = parseInt(extraArgs[0] ?? "", 10);
    const authority = parseInt(extraArgs[1] ?? "", 10) as 0 | 1 | 2 | 3;

    if (!memId || isNaN(authority) || authority < 0 || authority > 3) {
      console.log(colorize("Usage: lobs memory promote <id> <authority>", "yellow"));
      console.log(colorize("  authority: 0 (low) | 1 (system) | 2 (agent/explicit) | 3 (user preference)", "dim"));
      return;
    }

    const { promoteMemory } = await import("../memory/conflicts.js");
    promoteMemory(memId, authority);
    console.log(colorize(`✓ Memory #${memId} promoted to authority ${authority}.`, "green"));
    return;
  }

  // ── lobs memory gc ────────────────────────────────────────────────────────
  if (subCmd === "gc") {
    console.log(colorize("Running memory GC...", "cyan"));
    try {
      const { runMemoryGC } = await import("../memory/gc.js");
      const result = await runMemoryGC();
      console.log(colorize("✓ GC complete", "green"));
      console.log(`  Archived: ${(result as any).archived ?? (result as any).archivedCount ?? 0}`);
      console.log(`  Stale:    ${(result as any).stale ?? (result as any).staleCount ?? 0}`);
      console.log(`  Expired:  ${(result as any).expired ?? (result as any).expiredCount ?? 0}`);
    } catch (err) {
      if (String(err).includes("Cannot find module") || String(err).includes("ERR_MODULE_NOT_FOUND")) {
        console.log(colorize("GC module not available yet.", "yellow"));
      } else {
        console.error(colorize(`GC error: ${String(err)}`, "red"));
      }
    }
    return;
  }

  // ── lobs memory stats ─────────────────────────────────────────────────────
  if (subCmd === "stats") {
    // Count memories by status
    const statusCounts: any[] = db
      .prepare("SELECT status, COUNT(*) as cnt FROM memories GROUP BY status")
      .all() as any[];

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of statusCounts) {
      byStatus[row.status] = row.cnt;
      total += row.cnt;
    }

    // Count memories by type
    const typeCounts: any[] = db
      .prepare("SELECT memory_type, COUNT(*) as cnt FROM memories WHERE status = 'active' GROUP BY memory_type ORDER BY cnt DESC")
      .all() as any[];

    // Events count
    const eventsRow: any = db.prepare("SELECT COUNT(*) as cnt FROM events").get();
    const totalEvents: number = eventsRow?.cnt ?? 0;

    // Reflection runs
    const reflRow: any = db
      .prepare("SELECT COUNT(*) as cnt, MAX(completed_at) as last FROM reflection_runs")
      .get();
    const reflCount: number = reflRow?.cnt ?? 0;
    const reflLast: string | null = reflRow?.last ?? null;

    // Unresolved conflicts
    const conflRow: any = db
      .prepare("SELECT COUNT(*) as cnt FROM conflicts WHERE resolved_at IS NULL")
      .get();
    const unresolvedConflicts: number = conflRow?.cnt ?? 0;

    // DB size
    const { statSync } = await import("node:fs"); // statSync not in the top-level static import
    const dbPath = resolve(HOME, ".lobs/memory.db");
    let dbSize = "unknown";
    try {
      const stat = statSync(dbPath);
      const bytes = stat.size;
      if (bytes > 1_000_000) {
        dbSize = `${(bytes / 1_000_000).toFixed(1)} MB`;
      } else if (bytes > 1_000) {
        dbSize = `${(bytes / 1_000).toFixed(1)} KB`;
      } else {
        dbSize = `${bytes} B`;
      }
    } catch {
      // DB path may differ
    }

    console.log(colorize("\nMemory System Stats", "bright"));
    console.log(
      `  Total memories: ${colorize(String(total), "bright")} (${byStatus.active ?? 0} active, ${byStatus.stale ?? 0} stale, ${byStatus.archived ?? 0} archived, ${byStatus.contested ?? 0} contested, ${byStatus.superseded ?? 0} superseded)`,
    );

    if (typeCounts.length > 0) {
      const typeStr = typeCounts
        .map((r: any) => `${r.cnt} ${r.memory_type}`)
        .join(", ");
      console.log(`  By type: ${typeStr}`);
    }

    console.log(`  Total events: ${totalEvents.toLocaleString()}`);
    console.log(
      `  Reflection runs: ${reflCount}${reflLast ? ` (last: ${reflLast.slice(0, 19)})` : ""}`,
    );
    console.log(
      `  Unresolved conflicts: ${unresolvedConflicts > 0 ? colorize(String(unresolvedConflicts), "yellow") : colorize("0", "green")}`,
    );
    console.log(`  DB size: ${dbSize}`);
    console.log("");
    return;
  }

  // ── lobs memory index ────────────────────────────────────────────────────
  if (subCmd === "index") {
    const MEMORY_URL = "http://localhost:7420";
    const dryRun = extraArgs.includes("--dry-run");
    const watch = extraArgs.includes("--watch");

    if (dryRun) {
      try {
        const res = await fetch(`${MEMORY_URL}/status`);
        const data = await res.json();
        console.log(colorize("[dry-run] Would trigger re-index via POST /index", "yellow"));
        console.log(`  Current: ${data.index?.documents ?? "?"} docs / ${data.index?.chunks ?? "?"} chunks`);
        console.log(`  Collections: ${(data.index?.collections ?? []).join(", ")}`);
      } catch (err) {
        console.log(`  (Could not fetch status: ${err})`);
      }
      return;
    }

    console.log(colorize("Triggering lobs-memory re-index…", "cyan"));
    try {
      const triggerRes = await fetch(`${MEMORY_URL}/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const triggerData = await triggerRes.json();
      if (!triggerRes.ok || !triggerData.ok) {
        console.error(colorize(`✗ Re-index failed: ${JSON.stringify(triggerData)}`, "red"));
        return;
      }
      console.log(colorize(`✓ ${triggerData.message ?? "Re-indexing started in background"}`, "green"));

      if (watch) {
        console.log("Polling /status until complete…");
        let stable = 0;
        while (stable < 3) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const statusRes = await fetch(`${MEMORY_URL}/status`);
            const statusData = await statusRes.json();
            if (statusData.indexer?.isIndexing) { stable = 0; continue; }
            stable++;
          } catch { /* keep polling */ }
        }
        const finalStatus = await fetch(`${MEMORY_URL}/status`);
        const finalData = await finalStatus.json();
        console.log(colorize("✓ Re-index complete", "green"));
        console.log(`  Documents: ${finalData.index?.documents ?? "?"}  Chunks: ${finalData.index?.chunks ?? "?"}`);
      }
    } catch (err) {
      console.error(colorize(`✗ Cannot reach lobs-memory at ${MEMORY_URL}: ${String(err)}`, "red"));
      process.exit(1);
    }
    return;
  }

  // ── Unknown subcommand ────────────────────────────────────────────────────
  console.log(colorize("Usage: lobs memory <subcommand> [options]\n", "yellow"));
  console.log("  list [--type <type>] [--limit N]   List recent active memories");
  console.log("  index [--watch] [--dry-run]        Trigger lobs-memory re-index");
  console.log("  show <id>                          Show full memory details");
  console.log("  conflicts                          List unresolved conflicts");
  console.log("  resolve <conflict-id> <a|b|dismiss> Manually resolve a conflict");
  console.log("  promote <id> <authority>           Promote memory authority (0-3)");
  console.log("  gc                                 Run garbage collection");
  console.log("  stats                              Memory system overview");
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

(async () => {
  switch (command) {
    case "start":
      await cmdStart({ useLaunchd: args.includes("--launchd") });
      break;

    case "stop":
      await cmdStop();
      break;

    case "restart":
      await cmdRestart(args.includes("--no-build"), args.includes("--no-pull"), { useLaunchd: args.includes("--launchd") });
      break;

    case "build":
      await cmdBuild();
      break;

    case "status":
      await cmdStatus();
      break;
    
    case "tasks":
      await cmdTasks(subcommand);
      break;
    
    case "workers":
      await cmdWorkers();
      break;

    case "chat":
      await cmdChat(subcommand, args.slice(2));
      break;
    
    case "config":
      if (subcommand === "check") {
        cmdConfigCheck();
      } else {
        const { cmdConfig } = await import("./config-cli.js");
        await cmdConfig(subcommand || "show", args.slice(2));
      }
      break;
    
    case "logs": {
      const tailIdx = args.indexOf("--tail");
      const tail = tailIdx !== -1 ? parseInt(args[tailIdx + 1] || "50", 10) : 50;
      const follow = subcommand === "follow";
      await cmdLogs(tail, follow);
      break;
    }
    
    case "health":
      await cmdHealth();
      break;

    case "preflight":
      await cmdPreflight();
      break;

    case "models":
      if (subcommand === "available" || subcommand === "list") {
        await cmdModelsAvailable();
      } else if (["status", "providers", "usage", "route", "enable", "disable", "set-limit", "policy"].includes(subcommand || "")) {
        const { cmdModelRouter } = await import("./model-router-cli.js");
        await cmdModelRouter(subcommand!, args.slice(2));
      } else {
        await cmdModelsDiagnostic();
      }
      break;

    case "cron":
      await cmdCron(subcommand, args.slice(2));
      break;

    case "memory":
      await handleMemoryCommand(subcommand, args.slice(2));
      break;

    case "codex-auth":
      await cmdCodexAuth(subcommand);
      break;
    case "init":
      cmdInit();
      break;

    case "setup":
      await cmdSetup();
      break;

    case "--help":
    case "-h":
    case "help":
    default:
      console.log(colorize("\nlobs", "bright") + " — CLI for managing lobs-core\n");
      console.log(colorize("Process:", "cyan"));
      console.log("  lobs start [--launchd]   Start lobs-core (manual by default)");
      console.log("  lobs stop                Stop lobs-core and unload launchd");
      console.log("  lobs restart             Pull submodules, build + restart (--no-build, --no-pull)");
      console.log("  lobs build               Build without restarting");
      console.log("  lobs status              System overview");
      console.log("  lobs health              Detailed health check");
      console.log("");
      console.log(colorize("Tasks & Workers:", "cyan"));
      console.log("  lobs tasks [list|view]   Manage tasks");
      console.log("  lobs workers             Show active/recent worker runs");
      console.log("");
      console.log(colorize("Chat:", "cyan"));
      console.log("  lobs chat                Start a new interactive chat");
      console.log("  lobs chat list           List saved chat sessions");
      console.log("  lobs chat show <key>     Show a saved transcript");
      console.log("  lobs chat resume <key>   Resume an existing chat");
      console.log("  lobs chat model <k> [m]  Show or set a chat session model");
      console.log("");
      console.log(colorize("Cron:", "cyan"));
      console.log("  lobs cron [list]              List all cron jobs");
      console.log("  lobs cron add <n> <s> <p>     Add an agent cron job (LLM)");
      console.log("  lobs cron add --script <n> <s> <cmd>  Add a script job (shell)");
      console.log("  lobs cron remove <id>         Remove an agent cron job");
      console.log("  lobs cron toggle <id>         Toggle enabled/disabled");
      console.log("  lobs cron run <id>            Trigger immediate run");
      console.log("");
      console.log(colorize("Models:", "cyan"));
      console.log("  lobs models              Diagnose LM Studio model availability");
      console.log("  lobs models available    List selectable models + loaded LM Studio models");
      console.log("  lobs models status       Show router status and routing policy");
      console.log("  lobs models providers    List all providers and their models");
      console.log("  lobs models usage        Show usage breakdown per provider");
      console.log("  lobs models route <cat>  Show what model would be selected for a task");
      console.log("  lobs models enable <id>  Enable a provider");
      console.log("  lobs models disable <id> Disable a provider");
      console.log("  lobs models set-limit <p> <period> <$>  Set usage limit");
      console.log("  lobs models policy       Show routing policy details");
      console.log("");
      console.log(colorize("Config:", "cyan"));
      console.log("  config show              Full config overview");
      console.log("  config check             Validate config files");
      console.log("  config keys              List API keys (masked)");
      console.log("  config set-key ...       Add/update API key (provider key [--label name])");
      console.log("  config remove-key ...    Remove API key (provider [--label name])");
      console.log("  config set-fallback ...  Set tier fallback chain (tier model1 model2...)");
      console.log("  config set-agent-fallback ... Set agent fallback chain (agent model1 model2...)");
      console.log("  config routes            Show task→tier routing");
      console.log("  config set-route ...     Set task category route (category tier)");
      console.log("  lobs init                Initialize config directory");
      console.log("  lobs setup               Interactive setup wizard (configure identity, keys, Discord, models)");
      console.log("");
      console.log(colorize("Codex Auth:", "cyan"));
      console.log("  lobs codex-auth login    OAuth login for openai-codex provider");
      console.log("  lobs codex-auth status   Show token status and expiry");
      console.log("  lobs codex-auth refresh  Refresh the access token");
      console.log("");
      console.log(colorize("Logs:", "cyan"));
      console.log("  lobs logs [--tail N]     Show recent log output");
      console.log("  lobs logs follow         Follow live log output");
      console.log("");
      console.log(colorize("Config dir:", "dim") + ` ${CONFIG_DIR}`);
      console.log(colorize("Logs:", "dim") + `       ${LOG_FILE}`);
      console.log(colorize("PID file:", "dim") + `   ${PID_FILE}`);
      console.log("");
  }
})();
