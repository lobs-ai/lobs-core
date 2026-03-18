#!/usr/bin/env node
/**
 * lobs — CLI for managing lobs-core
 *
 * Process management:
 *   lobs start                Start lobs-core (daemonized)
 *   lobs stop                 Stop the running instance
 *   lobs restart              Restart lobs-core
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
 *   lobs cron [list]           List all cron jobs
 *   lobs cron add <n> <s> <p>  Add an agent cron job
 *   lobs cron remove <id>      Remove an agent cron job
 *   lobs cron toggle <id>      Toggle enabled/disabled
 *   lobs cron run <id>         Trigger immediate run
 *
 * Config:
 *   lobs config check         Validate all config files
 *   lobs config show          Dump current config file status
 *   lobs init                 Initialize config directory structure
 *
 * Logs:
 *   lobs logs [follow] [--tail N]  Show recent log output or follow logs
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { validateAllConfigs, printValidationResults } from "../config/validator.js";
import { getModelConfig } from "../config/models.js";
import { runLmStudioDiagnostic, formatDiagnosticReport } from "../diagnostics/lmstudio.js";

const HOME = process.env.HOME ?? "";
const LOBS_PORT = parseInt(process.env.LOBS_PORT ?? "9420", 10);
const API_BASE = `http://localhost:${LOBS_PORT}/api`;
const CONFIG_DIR = resolve(HOME, ".lobs/config");
const SECRETS_DIR = resolve(CONFIG_DIR, "secrets");
const PID_FILE = resolve(HOME, ".lobs/lobs.pid");
const LOG_FILE = resolve(HOME, ".lobs/lobs.log");
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

function isServerReachable(): Promise<boolean> {
  return fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok)
    .catch(() => false);
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

  const child = spawn("node", [mainJs], {
    cwd: LOBS_CORE_DIR,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, LOBS_PORT: String(LOBS_PORT), LOBS_LOG_TO_FILE: "1" },
  });

  child.unref();
  const childPid = child.pid;

  if (!childPid) {
    console.error(colorize("Failed to start lobs-core", "red"));
    process.exit(1);
  }

  // Wait up to 5 seconds for server to become reachable
  let started = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isServerReachable()) {
      started = true;
      break;
    }
  }

  if (started) {
    console.log(colorize(`✓ lobs-core started (PID ${childPid}, port ${LOBS_PORT})`, "green"));
    console.log(colorize(`  Logs: ${LOG_FILE}`, "dim"));
  } else {
    console.log(colorize(`lobs-core spawned (PID ${childPid}) but not yet responding`, "yellow"));
    console.log(colorize(`  Check logs: tail -f ${LOG_FILE}`, "dim"));
  }
}

async function cmdStop() {
  unloadLaunchdService();

  const pid = getRunningPid();
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

async function cmdBuild(): Promise<boolean> {
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

async function cmdRestart(skipBuild = false, opts: { useLaunchd?: boolean } = {}) {
  // Auto-build before restart unless --no-build
  if (!skipBuild) {
    const buildOk = await cmdBuild();
    if (!buildOk) {
      console.error(colorize("\nRestart aborted — fix build errors first.", "red"));
      console.log(colorize("  Use 'lobs restart --no-build' to skip build check", "dim"));
      return;
    }
  }

  const pid = getRunningPid();
  if (pid) {
    await cmdStop();
    
    // Wait until the old process is fully dead + port is released
    // 1s was too short — shutdown involves Discord disconnect, DB flush, browser cleanup, memory server
    let dead = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      const stillAlive = getRunningPid();
      const portFree = !(await isServerReachable());
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
  const pid = getRunningPid();
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
  console.log("  1. Update secrets/keys.json with your API keys");
  console.log("  2. Update secrets/discord-token.json with your Discord bot token");
  console.log("  3. Run 'lobs config check' to validate");
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
        const last = `last: ${timeAgo(j.last_run)}`;
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
        const sched = j.schedule.padEnd(16);
        const last = `last: ${timeAgo(j.last_run)}`;
        const id = colorize(`[${j.id.slice(0, 8)}]`, "dim");
        console.log(`  ${check} ${colorize(name, "bright")}${colorize(sched, "dim")}  ${colorize(last, "gray")}  ${id}`);
      }
    }

    console.log("");
    return;
  }

  // add <name> <schedule> <payload>
  if (subCmd === "add") {
    const name = extraArgs[0];
    const schedule = extraArgs[1];
    const payload = extraArgs.slice(2).join(" ");

    if (!name || !schedule || !payload) {
      console.log(colorize("Usage: lobs cron add <name> <schedule> <payload>", "yellow"));
      console.log(colorize("Example: lobs cron add 'Daily Report' '0 9 * * *' 'Generate daily report'", "dim"));
      return;
    }

    const result = await postApi("/scheduler", { name, schedule, payload });
    console.log(colorize("✓", "green") + ` Created cron job: ${result.name}`);
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
  console.log("  list                         List all cron jobs");
  console.log("  add <name> <sched> <payload>  Add an agent job");
  console.log("  remove <id>                  Remove an agent job");
  console.log("  toggle <id>                  Toggle enabled/disabled");
  console.log("  run <id>                     Trigger immediate run");
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
      await cmdRestart(args.includes("--no-build"), { useLaunchd: args.includes("--launchd") });
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
      } else if (subcommand === "show") {
        await cmdConfigShow();
      } else {
        console.log("Usage: lobs config [check|show]");
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
      } else {
        await cmdModelsDiagnostic();
      }
      break;

    case "cron":
      await cmdCron(subcommand, args.slice(2));
      break;
    
    case "init":
      cmdInit();
      break;

    case "--help":
    case "-h":
    case "help":
    default:
      console.log(colorize("\nlobs", "bright") + " — CLI for managing lobs-core\n");
      console.log(colorize("Process:", "cyan"));
      console.log("  lobs start [--launchd]   Start lobs-core (manual by default)");
      console.log("  lobs stop                Stop lobs-core and unload launchd");
      console.log("  lobs restart             Build + restart (use --no-build to skip)");
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
      console.log("  lobs cron [list]         List all cron jobs");
      console.log("  lobs cron add <n> <s> <p>  Add an agent cron job");
      console.log("  lobs cron remove <id>    Remove an agent cron job");
      console.log("  lobs cron toggle <id>    Toggle enabled/disabled");
      console.log("  lobs cron run <id>       Trigger immediate run");
      console.log("");
      console.log(colorize("Models:", "cyan"));
      console.log("  lobs models              Diagnose LM Studio model availability");
      console.log("  lobs models available    List selectable models + loaded LM Studio models");
      console.log("");
      console.log(colorize("Config:", "cyan"));
      console.log("  lobs config check        Validate all config files");
      console.log("  lobs config show         Show config file status");
      console.log("  lobs init                Initialize config directory");
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
