/**
 * Exec tool — run shell commands.
 * 
 * Supports command, workdir, timeout, and env.
 * Tracks cwd changes: if the command is a `cd` or uses `workdir`,
 * the new cwd is returned as a side effect so the agent loop can
 * update its tracked working directory.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolDefinition, ToolExecutorResult } from "../types.js";
import { capOutput } from "./output-cap.js";

export const execToolDefinition: ToolDefinition = {
  name: "exec",
  description:
    "Execute a shell command. Returns stdout, stderr, and exit code. " +
    "Output is capped to ~200 lines/8KB by default — use head/tail/grep for large outputs. " +
    "Commands run in the agent's working directory by default. " +
    "Use workdir to change directory. Use timeout to limit execution time (default 30s, max 300s).",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      workdir: {
        type: "string",
        description: "Working directory (defaults to agent cwd)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default 30, max 300)",
      },
      env: {
        type: "object",
        description: "Additional environment variables",
        additionalProperties: { type: "string" },
      },
    },
    required: ["command"],
  },
};

const MAX_CAPTURE_CHARS = 100_000;  // Max to capture from the process (raw)
const MAX_OUTPUT_CHARS = 8_000;     // Max to return to the model (~200 lines)
const MAX_OUTPUT_LINES = 200;       // Max lines to return to the model
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 300;

/**
 * Detect if a command is a bare `cd` that should change the agent's cwd.
 * Matches: `cd /path`, `cd ~/foo`, `cd ..`, `cd` (alone = home).
 * Does NOT match: `cd /foo && ls` or `cd /foo; echo hi` — those are compound
 * commands where the cd is part of a pipeline.
 */
function parseCdCommand(command: string): string | null {
  const trimmed = command.trim();
  // Match bare `cd` or `cd <path>` — no pipes, semicolons, or &&
  const cdMatch = trimmed.match(/^cd(?:\s+(.+))?$/);
  if (!cdMatch) return null;
  
  // Check it's not a compound command
  const target = cdMatch[1]?.trim();
  if (target && /[;&|]/.test(target)) return null;
  
  return target ?? process.env.HOME ?? "/";
}

/**
 * Resolve a cd target relative to a base directory.
 * Handles ~, .., relative, and absolute paths.
 */
function resolveCdTarget(target: string, baseCwd: string): string | null {
  // Expand ~ to home directory
  let expanded = target;
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = expanded.replace(/^~/, process.env.HOME ?? "/");
  }
  
  const resolved = resolve(baseCwd, expanded);
  
  // Verify the directory exists
  if (!existsSync(resolved)) return null;
  return resolved;
}

export async function execTool(
  params: Record<string, unknown>,
  defaultCwd: string,
): Promise<ToolExecutorResult> {
  const command = params.command as string;
  if (!command || typeof command !== "string") {
    throw new Error("command is required and must be a string");
  }

  const workdir = (params.workdir as string) || defaultCwd;
  const timeoutRaw = typeof params.timeout === "number" ? params.timeout : DEFAULT_TIMEOUT;
  const timeout = Math.min(Math.max(timeoutRaw, 1), MAX_TIMEOUT);
  const env = {
    ...process.env,
    ...(params.env && typeof params.env === "object" ? params.env as Record<string, string> : {}),
  };

  // Check for bare `cd` command — handle it as a cwd change
  const cdTarget = parseCdCommand(command);
  if (cdTarget !== null) {
    const resolvedDir = resolveCdTarget(cdTarget, workdir);
    if (resolvedDir) {
      return {
        output: resolvedDir,
        sideEffects: { newCwd: resolvedDir },
      };
    } else {
      return `cd: no such directory: ${cdTarget}`;
    }
  }

  // If workdir was explicitly set, signal it as a cwd change too
  const cwdChanged = params.workdir && typeof params.workdir === "string"
    ? resolve(params.workdir.startsWith("~")
        ? params.workdir.replace(/^~/, process.env.HOME ?? "/")
        : params.workdir)
    : undefined;

  const output = await new Promise<string>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn("bash", ["-c", command], {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeout * 1000);

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (stdout.length < MAX_CAPTURE_CHARS) {
        stdout += chunk.slice(0, MAX_CAPTURE_CHARS - stdout.length);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (stderr.length < MAX_CAPTURE_CHARS) {
        stderr += chunk.slice(0, MAX_CAPTURE_CHARS - stderr.length);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise(`Error spawning process: ${err.message}`);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const parts: string[] = [];

      if (killed) {
        parts.push(`Command timed out after ${timeout} seconds.`);
      }

      if (stdout.length > 0) parts.push(stdout);
      if (stderr.length > 0) parts.push(`STDERR:\n${stderr}`);

      const exitInfo = killed
        ? `Exit: killed (timeout)`
        : `Exit code: ${code ?? `signal ${signal}`}`;

      const raw = parts.join("\n") || "(no output)";
      const capped = capOutput(raw, MAX_OUTPUT_CHARS, MAX_OUTPUT_LINES,
        "Re-run with more specific command (e.g. head/tail/grep) to see more.");
      resolvePromise(`${capped}\n\n${exitInfo}`);
    });
  });

  // Return with side effects if workdir was explicitly changed
  if (cwdChanged) {
    return {
      output,
      sideEffects: { newCwd: cwdChanged },
    };
  }

  return output;
}
