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
 *
 * Tasks & workers:
 *   lobs tasks [list|view]    Manage tasks
 *   lobs workers              Show active/recent worker runs
 *
 * Config:
 *   lobs config check         Validate all config files
 *   lobs config show          Dump current config file status
 *   lobs init                 Initialize config directory structure
 *
 * Logs:
 *   lobs logs [--tail N]      Show recent log output
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync, spawn } from "node:child_process";
import { validateAllConfigs, printValidationResults } from "../config/validator.js";
import { getModelConfig } from "../config/models.js";

const HOME = process.env.HOME ?? "";
const LOBS_PORT = parseInt(process.env.LOBS_PORT ?? "9420", 10);
const API_BASE = `http://localhost:${LOBS_PORT}/api`;
const CONFIG_DIR = resolve(HOME, ".lobs/config");
const SECRETS_DIR = resolve(CONFIG_DIR, "secrets");
const PID_FILE = resolve(HOME, ".lobs/lobs.pid");
const LOG_FILE = resolve(HOME, ".lobs/lobs.log");
const LOBS_CORE_DIR = resolve(HOME, "lobs/lobs-core");

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

async function cmdStart() {
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

  // Re-load launchd service if plist exists (ensures auto-restart on crash)
  const plistPathStart = resolve(HOME, "Library/LaunchAgents/com.lobs.core.plist");
  if (existsSync(plistPathStart)) {
    try {
      execSync(`launchctl load "${plistPathStart}" 2>/dev/null`, { encoding: "utf-8" });
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
  }

  // Spawn detached process with output going to log file
  const logFd = require("node:fs").openSync(LOG_FILE, "a");
  const child = spawn("node", [mainJs], {
    cwd: LOBS_CORE_DIR,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, LOBS_PORT: String(LOBS_PORT) },
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
  // First, unload launchd service so it doesn't auto-restart
  const plistPath = resolve(HOME, "Library/LaunchAgents/com.lobs.core.plist");
  if (existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { encoding: "utf-8" });
      console.log(colorize("Unloaded launchd service (won't auto-restart)", "dim"));
    } catch {
      // May already be unloaded
    }
  }

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

  // Wait up to 5 seconds for process to exit
  let stopped = false;
  for (let i = 0; i < 10; i++) {
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

async function cmdRestart(skipBuild = false) {
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
    await new Promise(r => setTimeout(r, 1000));
  }
  await cmdStart();
}

async function cmdLogs(tail: number = 50) {
  if (!existsSync(LOG_FILE)) {
    console.log(colorize("No log file found.", "yellow"));
    console.log(colorize(`  Expected at: ${LOG_FILE}`, "dim"));
    return;
  }

  try {
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
  console.log(`Status:       ${status}`);
  console.log(`Uptime:       ${formatUptime(data.uptime)}`);
  console.log(`PID:          ${data.pid || "unknown"}`);
  console.log(`DB:           ${data.db === "ok" ? colorize("✓", "green") : colorize("✗", "red")}`);
  console.log(`Memory Server: ${data.memory_server === "ok" ? colorize("✓", "green") : colorize("✗ down", "yellow")}`);
  console.log(`LM Studio:    ${data.lm_studio === "ok" ? colorize("✓", "green") : colorize("✗ down", "yellow")}`);
  console.log("");
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

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

(async () => {
  switch (command) {
    case "start":
      await cmdStart();
      break;

    case "stop":
      await cmdStop();
      break;

    case "restart":
      await cmdRestart(args.includes("--no-build"));
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
      await cmdLogs(tail);
      break;
    }
    
    case "health":
      await cmdHealth();
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
      console.log("  lobs start               Start lobs-core (re-enables auto-restart)");
      console.log("  lobs stop                Stop and STAY stopped (disables auto-restart)");
      console.log("  lobs restart             Build + restart (use --no-build to skip)");
      console.log("  lobs build               Build without restarting");
      console.log("  lobs status              System overview");
      console.log("  lobs health              Detailed health check");
      console.log("");
      console.log(colorize("Tasks & Workers:", "cyan"));
      console.log("  lobs tasks [list|view]   Manage tasks");
      console.log("  lobs workers             Show active/recent worker runs");
      console.log("");
      console.log(colorize("Config:", "cyan"));
      console.log("  lobs config check        Validate all config files");
      console.log("  lobs config show         Show config file status");
      console.log("  lobs init                Initialize config directory");
      console.log("");
      console.log(colorize("Logs:", "cyan"));
      console.log("  lobs logs [--tail N]     Show recent log output");
      console.log("");
      console.log(colorize("Config dir:", "dim") + ` ${CONFIG_DIR}`);
      console.log(colorize("Logs:", "dim") + `       ${LOG_FILE}`);
      console.log(colorize("PID file:", "dim") + `   ${PID_FILE}`);
      console.log("");
  }
})();
