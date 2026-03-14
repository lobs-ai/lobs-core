#!/usr/bin/env node
/**
 * lobs — CLI for managing lobs-core
 *
 * Usage:
 *   lobs status              System overview
 *   lobs tasks [list|create|view]  Manage tasks
 *   lobs workers             Show active/recent worker runs
 *   lobs config check        Validate all config files
 *   lobs config show         Dump current config
 *   lobs logs [--tail N]     Show recent logs
 *   lobs health              Detailed health check
 *   lobs init                Initialize config directory structure
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateAllConfigs, printValidationResults } from "../config/validator.js";

const HOME = process.env.HOME ?? "";
const API_BASE = "http://localhost:9420/api";
const CONFIG_DIR = resolve(HOME, ".lobs/config");
const SECRETS_DIR = resolve(CONFIG_DIR, "secrets");

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

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const data = await fetchApi("/status/overview");
  
  console.log(colorize("\n=== Lobs Core Status ===\n", "bright"));
  
  console.log(colorize("Server", "cyan"));
  console.log(`  Status:  ${data.server.status === "healthy" ? colorize("✓ healthy", "green") : colorize("✗ unhealthy", "red")}`);
  console.log(`  Uptime:  ${Math.floor(data.server.uptime_seconds / 60)}m`);
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

async function cmdLogs(tail: number = 50) {
  console.log(colorize(`\n=== Recent Logs (last ${tail}) ===\n`, "bright"));
  console.log(colorize("(Log streaming not yet implemented)", "dim"));
  console.log("");
}

async function cmdHealth() {
  const data = await fetchApi("/health");
  
  console.log(colorize("\n=== Health Check ===\n", "bright"));
  
  const status = data.status === "healthy" ? colorize("✓ HEALTHY", "green") : colorize("✗ UNHEALTHY", "red");
  console.log(`Status:       ${status}`);
  console.log(`Uptime:       ${Math.floor(data.uptime / 60)}m`);
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
    const modelsTemplate = {
      tiers: {
        micro: "lmstudio/qwen3-4b",
        small: "anthropic/claude-sonnet-4-6",
        medium: "anthropic/claude-sonnet-4-6",
        standard: "anthropic/claude-sonnet-4-6",
        strong: "anthropic/claude-opus-4-6",
      },
      agents: {
        programmer: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["anthropic/claude-haiku-4-5"] },
        researcher: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["anthropic/claude-opus-4-6"] },
        writer: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["anthropic/claude-opus-4-6"] },
        reviewer: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["anthropic/claude-opus-4-6"] },
        architect: { primary: "anthropic/claude-opus-4-6", fallbacks: ["anthropic/claude-sonnet-4-6"] },
      },
      local: {
        baseUrl: "http://localhost:1234/v1",
        chatModel: "qwen3-4b",
        embeddingModel: "text-embedding-qwen3-embedding-4b",
      },
    };
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
    
    case "logs":
      const tail = args.find(a => a.startsWith("--tail"))
        ? parseInt(args[args.indexOf("--tail") + 1] || "50", 10)
        : 50;
      await cmdLogs(tail);
      break;
    
    case "health":
      await cmdHealth();
      break;
    
    case "init":
      cmdInit();
      break;
    
    default:
      console.log(colorize("\nlobs — CLI for managing lobs-core\n", "bright"));
      console.log("Usage:");
      console.log("  lobs status              System overview");
      console.log("  lobs tasks [list|view]   Manage tasks");
      console.log("  lobs workers             Show active/recent worker runs");
      console.log("  lobs config check        Validate all config files");
      console.log("  lobs config show         Dump current config");
      console.log("  lobs logs [--tail N]     Show recent logs");
      console.log("  lobs health              Detailed health check");
      console.log("  lobs init                Initialize config directory structure");
      console.log("");
  }
})();
