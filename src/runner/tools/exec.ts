/**
 * Exec tool — run shell commands.
 *
 * Supports command, workdir, timeout, and env.
 * Tracks cwd changes: if the command is a `cd` or uses `workdir`,
 * the new cwd is returned as a side effect so the agent loop can
 * update its tracked working directory.
 *
 * Uses a cwd marker to detect directory changes from compound commands
 * like `cd /foo && npm install` — the marker is parsed and stripped
 * from output so subsequent calls use the correct cwd.
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

const MAX_CAPTURE_CHARS = 1_000_000; // Max to capture from the process (raw)
const MAX_OUTPUT_CHARS = 8_000;      // Max to return to the model (~200 lines)
const MAX_OUTPUT_LINES = 200;        // Max lines to return to the model
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 300;

/** Sentinel used to detect the final cwd after a command runs */
const CWD_MARKER = "__LOBS_CWD__";

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

/**
 * Wrap a command so that after it runs, it prints a cwd marker to stdout.
 * The marker format is: \n__LOBS_CWD__:/path/to/cwd
 * The original exit code is preserved.
 */
function wrapWithCwdMarker(command: string): string {
  // Use a subshell to capture the exit code, then print marker, then exit with original code
  return `{ ${command}\n}; __lobs_ec=$?; printf '\\n${CWD_MARKER}:%s' "$(pwd)"; exit $__lobs_ec`;
}

/**
 * Parse and strip the cwd marker from stdout.
 * Returns the cleaned stdout and the detected cwd (if any).
 */
function extractCwdMarker(stdout: string): { cleaned: string; detectedCwd: string | null } {
  const markerPattern = new RegExp(`\\n?${CWD_MARKER}:(.+)$`);
  const match = stdout.match(markerPattern);
  if (!match) return { cleaned: stdout, detectedCwd: null };

  const detectedCwd = match[1]!;
  const cleaned = stdout.slice(0, match.index ?? stdout.length);
  return { cleaned, detectedCwd };
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

  // Wrap the command with a cwd marker so we can detect directory changes
  const wrappedCommand = wrapWithCwdMarker(command);

  const { output, detectedCwd } = await new Promise<{ output: string; detectedCwd: string | null }>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn("bash", ["-c", wrappedCommand], {
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
      resolvePromise({ output: `Error spawning process: ${err.message}`, detectedCwd: null });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      // Extract and strip the cwd marker from stdout
      const { cleaned: cleanedStdout, detectedCwd: cwd } = extractCwdMarker(stdout);

      const parts: string[] = [];

      if (killed) {
        parts.push(`Command timed out after ${timeout} seconds.`);
      }

      if (cleanedStdout.length > 0) parts.push(cleanedStdout);
      if (stderr.length > 0) parts.push(`STDERR:\n${stderr}`);

      const exitInfo = killed
        ? `Exit: killed (timeout)`
        : `Exit code: ${code ?? `signal ${signal}`}`;

      const raw = parts.join("\n") || "(no output)";
      const capped = capOutput(raw, MAX_OUTPUT_CHARS, MAX_OUTPUT_LINES,
        "Re-run with more specific command (e.g. head/tail/grep) to see more.");
      resolvePromise({ output: `${capped}\n\n${exitInfo}`, detectedCwd: cwd });
    });
  });

  // Determine if cwd changed — from the marker or from explicit workdir
  const newCwd = detectedCwd && detectedCwd !== workdir
    ? detectedCwd
    : params.workdir && typeof params.workdir === "string"
      ? resolve(params.workdir.startsWith("~")
          ? params.workdir.replace(/^~/, process.env.HOME ?? "/")
          : params.workdir)
      : undefined;

  if (newCwd) {
    return {
      output,
      sideEffects: { newCwd },
    };
  }

  return output;
}
