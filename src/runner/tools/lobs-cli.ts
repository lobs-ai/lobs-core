/**
 * Lobs CLI built-in tools — native wrappers around the `lobs` CLI binary.
 *
 * Replaces the dynamic shell script shims in ~/.lobs/tools/. Each tool
 * calls the lobs CLI via execFile so there are no shell escaping issues
 * or exit-code ambiguities.
 *
 * Diagnostic commands (health, preflight, models) may exit non-zero when
 * they find issues, but their stdout is still valuable — we always return
 * it when present.
 */

import { execFile, spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";

const LOBS_BIN = "/Users/lobs/.lobs/bin/lobs";

// ── Shared helper ────────────────────────────────────────────────────────────

function runLobsCli(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(LOBS_BIN, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      // Diagnostic tools exit non-zero when they find issues but stdout is gold
      if (stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim() || "(no output)");
    });
  });
}

// ── lobs-status ──────────────────────────────────────────────────────────────

export const lobsStatusToolDefinition: ToolDefinition = {
  name: "lobs-status",
  description: "System overview: server status, uptime, task counts, recent workers, LM Studio status.",
  input_schema: { type: "object", properties: {}, required: [] },
};

export async function lobsStatusTool(_params: Record<string, unknown>): Promise<string> {
  return runLobsCli(["status"]);
}

// ── lobs-health ──────────────────────────────────────────────────────────────

export const lobsHealthToolDefinition: ToolDefinition = {
  name: "lobs-health",
  description: "Detailed health check: DB connectivity, memory availability, LM Studio connection, disk space.",
  input_schema: { type: "object", properties: {}, required: [] },
};

export async function lobsHealthTool(_params: Record<string, unknown>): Promise<string> {
  return runLobsCli(["health"], 60_000);
}

// ── lobs-build ───────────────────────────────────────────────────────────────

export const lobsBuildToolDefinition: ToolDefinition = {
  name: "lobs-build",
  description: "Build lobs-core without restarting. Use after code changes.",
  input_schema: { type: "object", properties: {}, required: [] },
};

export async function lobsBuildTool(_params: Record<string, unknown>): Promise<string> {
  return runLobsCli(["build"], 120_000);
}

// ── lobs-stop ────────────────────────────────────────────────────────────────

export const lobsStopToolDefinition: ToolDefinition = {
  name: "lobs-stop",
  description: "Stop the running lobs-core instance and unload launchd if registered.",
  input_schema: { type: "object", properties: {}, required: [] },
};

export async function lobsStopTool(_params: Record<string, unknown>): Promise<string> {
  return runLobsCli(["stop"]);
}

// ── lobs-workers ─────────────────────────────────────────────────────────────

export const lobsWorkersToolDefinition: ToolDefinition = {
  name: "lobs-workers",
  description: "Show active and recent worker runs.",
  input_schema: { type: "object", properties: {}, required: [] },
};

export async function lobsWorkersTool(_params: Record<string, unknown>): Promise<string> {
  return runLobsCli(["workers"]);
}

// ── lobs-preflight ───────────────────────────────────────────────────────────

export const lobsPreflightToolDefinition: ToolDefinition = {
  name: "lobs-preflight",
  description: "Session startup health check + LM Studio model availability diagnostic. Run before starting important work.",
  input_schema: { type: "object", properties: {}, required: [] },
};

export async function lobsPreflightTool(_params: Record<string, unknown>): Promise<string> {
  return runLobsCli(["preflight"], 60_000);
}

// ── lobs-config-check ────────────────────────────────────────────────────────

export const lobsConfigCheckToolDefinition: ToolDefinition = {
  name: "lobs-config-check",
  description: "Validate lobs config files. Shows any issues with the configuration.",
  input_schema: { type: "object", properties: {}, required: [] },
};

export async function lobsConfigCheckTool(_params: Record<string, unknown>): Promise<string> {
  return runLobsCli(["config", "check"]);
}

// ── lobs-start ───────────────────────────────────────────────────────────────

export const lobsStartToolDefinition: ToolDefinition = {
  name: "lobs-start",
  description: "Start lobs-core. Use launchd=true to register with macOS launchd for auto-start.",
  input_schema: {
    type: "object",
    properties: {
      launchd: {
        type: "boolean",
        description: "Register with macOS launchd for auto-start on boot",
      },
    },
    required: [],
  },
};

export async function lobsStartTool(params: Record<string, unknown>): Promise<string> {
  const args = ["start"];
  if (params.launchd === true) args.push("--launchd");
  return runLobsCli(args, 60_000);
}

// ── lobs-restart ─────────────────────────────────────────────────────────────

export const lobsRestartToolDefinition: ToolDefinition = {
  name: "lobs-restart",
  description: "Stop + pull submodules + build + restart lobs-core. Use no_build/no_pull to skip steps.",
  input_schema: {
    type: "object",
    properties: {
      no_build: {
        type: "boolean",
        description: "Skip the build step",
      },
      no_pull: {
        type: "boolean",
        description: "Skip pulling git submodules",
      },
    },
    required: [],
  },
};

export async function lobsRestartTool(params: Record<string, unknown>): Promise<string> {
  // Restart kills the current process — must run detached and return immediately.
  const args = ["restart"];
  if (params.no_build === true) args.push("--no-build");
  if (params.no_pull === true) args.push("--no-pull");

  const child = spawn(LOBS_BIN, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return "Restart initiated. lobs-core will stop, rebuild, and restart in the background. The current connection will drop briefly.";
}

// ── lobs-logs ────────────────────────────────────────────────────────────────

export const lobsLogsToolDefinition: ToolDefinition = {
  name: "lobs-logs",
  description: "Show lobs-core logs. Use tail to show last N lines, or follow=true to stream live output.",
  input_schema: {
    type: "object",
    properties: {
      tail: {
        type: "number",
        description: "Show last N lines (default: 50)",
      },
      follow: {
        type: "boolean",
        description: "Stream live log output",
      },
    },
    required: [],
  },
};

export async function lobsLogsTool(params: Record<string, unknown>): Promise<string> {
  const args = ["logs"];
  if (typeof params.tail === "number") {
    args.push("--tail", String(params.tail));
  }
  if (params.follow === true) {
    args.push("--follow");
  }
  // Cap at 30s — follow mode would block forever
  return runLobsCli(args, 30_000);
}

// ── lobs-cron ────────────────────────────────────────────────────────────────

export const lobsCronToolDefinition: ToolDefinition = {
  name: "lobs-cron",
  description: "Manage cron jobs. List all, add new (agent or script), remove, toggle, or trigger immediate run.",
  input_schema: {
    type: "object",
    properties: {
      subcommand: {
        type: "string",
        enum: ["list", "add", "remove", "toggle", "run"],
        description: "Cron subcommand to run",
      },
      name: {
        type: "string",
        description: "Name for the cron job",
      },
      schedule: {
        type: "string",
        description: "Cron schedule, e.g. '*/15 * * * *' for every 15 min",
      },
      prompt: {
        type: "string",
        description: "Prompt/system message (for add agent job)",
      },
      cron_id: {
        type: "string",
        description: "Cron job ID (for remove, toggle, run)",
      },
      command: {
        type: "string",
        description: "Shell command (for add --script)",
      },
      agent_script: {
        type: "boolean",
        description: "Use 'script' to add a shell script job instead of an LLM agent job",
      },
    },
    required: ["subcommand"],
  },
};

export async function lobsCronTool(params: Record<string, unknown>): Promise<string> {
  const subcommand = params.subcommand as string;
  const args = ["cron", subcommand];

  if (subcommand === "add") {
    if (params.agent_script === true) args.push("--script");
    if (typeof params.name === "string") args.push("--name", params.name);
    if (typeof params.schedule === "string") args.push("--schedule", params.schedule);
    if (typeof params.prompt === "string") args.push("--prompt", params.prompt);
    if (typeof params.command === "string") args.push("--command", params.command);
  } else if (["remove", "toggle", "run"].includes(subcommand)) {
    if (typeof params.cron_id === "string") args.push(params.cron_id);
  }

  return runLobsCli(args, 30_000);
}

// ── lobs-models ──────────────────────────────────────────────────────────────

export const lobsModelsToolDefinition: ToolDefinition = {
  name: "lobs-models",
  description: "Diagnose and manage AI model availability. List available models, check LM Studio status, enable/disable providers, set usage limits, view routing policy.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["available", "diagnostic", "disable", "enable", "providers", "route", "set-limit", "status", "usage", "policy"],
        description: "Subcommand",
      },
      category: {
        type: "string",
        description: "Task category for 'route' (e.g. coding, creative, reasoning)",
      },
      tier: {
        type: "string",
        description: "Model tier for route query (e.g. micro, small, medium)",
      },
      provider_id: {
        type: "string",
        description: "Provider ID for enable/disable",
      },
      limit_provider: {
        type: "string",
        description: "Provider for set-limit (e.g. openai, anthropic)",
      },
      limit_period: {
        type: "string",
        description: "Limit period: day, week, or month",
      },
      limit_amount: {
        type: "number",
        description: "Usage limit dollar amount",
      },
    },
    required: [],
  },
};

export async function lobsModelsTool(params: Record<string, unknown>): Promise<string> {
  const args = ["models"];

  if (typeof params.action === "string") {
    args.push(params.action);
  }

  if (params.action === "route") {
    if (typeof params.category === "string") args.push("--category", params.category);
    if (typeof params.tier === "string") args.push("--tier", params.tier);
  } else if (params.action === "enable" || params.action === "disable") {
    if (typeof params.provider_id === "string") args.push(params.provider_id);
  } else if (params.action === "set-limit") {
    if (typeof params.limit_provider === "string") args.push("--provider", params.limit_provider);
    if (typeof params.limit_period === "string") args.push("--period", params.limit_period);
    if (typeof params.limit_amount === "number") args.push("--amount", String(params.limit_amount));
  }

  return runLobsCli(args, 30_000);
}

// ── lobs-tasks ───────────────────────────────────────────────────────────────

export const lobsTasksToolDefinition: ToolDefinition = {
  name: "lobs-tasks",
  description: "List tasks or view a specific task. Use view_task_id to see task details.",
  input_schema: {
    type: "object",
    properties: {
      subcommand: {
        type: "string",
        enum: ["list", "view"],
        description: "list or view",
        default: "list",
      },
      task_id: {
        type: "string",
        description: "Task ID to view (required if subcommand is view)",
      },
    },
    required: [],
  },
};

export async function lobsTasksTool(params: Record<string, unknown>): Promise<string> {
  const subcommand = (params.subcommand as string) ?? "list";
  const args = ["tasks", subcommand];
  if (subcommand === "view" && typeof params.task_id === "string") {
    args.push(params.task_id);
  }
  return runLobsCli(args, 30_000);
}

// ── lobs-codex-auth ──────────────────────────────────────────────────────────

export const lobsCodexAuthToolDefinition: ToolDefinition = {
  name: "lobs-codex-auth",
  description: "Manage Codex auth for the openai-codex provider. Check status, refresh token, or initiate OAuth login.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["login", "refresh", "status"],
        description: "subcommand",
      },
    },
    required: [],
  },
};

export async function lobsCodexAuthTool(params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) ?? "status";
  return runLobsCli(["codex-auth", action], 60_000);
}
