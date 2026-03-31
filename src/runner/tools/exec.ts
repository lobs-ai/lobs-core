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
import { extractCdTarget } from "../../claude-runtime/bash-parser.js";
import { processTool } from "./process.js";

export const execToolDefinition: ToolDefinition = {
  name: "exec",
  description:
    "Execute a shell command in the current working directory or an optional workdir. " +
    "Returns structured stdout, stderr, and exit status. Prefer dedicated tools like Read, Edit, Glob, and Grep when they fit the task instead of routing everything through Bash. " +
    "Prefer targeted commands over huge output. Use timeout to limit execution time. " +
    "Use run_in_background when you do not need the result immediately and are okay checking later.",
  input_schema: {
    type: "object",
    properties: {
      cmd: {
        type: "string",
        description: "Shell command to execute",
      },
      command: {
        type: "string",
        description: "Backward-compatible command field; cmd is preferred",
      },
      workdir: {
        type: "string",
        description: "Working directory (defaults to agent cwd)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default 30, max 300)",
      },
      run_in_background: {
        type: "boolean",
        description: "Run the command in the background and return a session ID instead of waiting for completion",
      },
      env: {
        type: "object",
        description: "Additional environment variables",
        additionalProperties: { type: "string" },
      },
    },
    required: [],
  },
};

const MAX_CAPTURE_CHARS = 1_000_000; // Max to capture from the process (raw)
const MAX_OUTPUT_CHARS = 25_000;     // Max to return to the model
const MAX_OUTPUT_LINES = 500;        // Max lines to return to the model
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
  return extractCdTarget(command);
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
  const command = (params.command as string) ?? (params.cmd as string);
  if (!command || typeof command !== "string") {
    throw new Error("command is required and must be a string");
  }

  const workdir = (params.workdir as string) || defaultCwd;
  const timeoutRaw = typeof params.timeout === "number" ? params.timeout : DEFAULT_TIMEOUT;
  const timeout = Math.min(Math.max(timeoutRaw, 1), MAX_TIMEOUT);
  const runInBackground = params.run_in_background === true;
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

  if (runInBackground) {
    if (params.env && typeof params.env === "object" && Object.keys(params.env as Record<string, string>).length > 0) {
      throw new Error("run_in_background does not support env overrides yet");
    }

    const started = await processTool({
      action: "start",
      command,
      cwd: workdir,
      timeout,
    }, defaultCwd);

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(started) as Record<string, unknown>;
    } catch {
      return started;
    }

    return [
      "background_started: true",
      `command: ${command}`,
      `cwd: ${workdir}`,
      `session_id: ${String(parsed.sessionId ?? "")}`,
      `pid: ${String(parsed.pid ?? "")}`,
      "Use the process tool with action=poll or action=log to check progress later.",
    ].join("\n\n");
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

      const stdoutText = cleanedStdout.length > 0 ? capOutput(
        cleanedStdout,
        MAX_OUTPUT_CHARS,
        MAX_OUTPUT_LINES,
        "Re-run with a more specific command (for example head, tail, or grep) to inspect less output.",
      ) : "(empty)";
      const stderrText = stderr.length > 0 ? capOutput(
        stderr,
        MAX_OUTPUT_CHARS,
        MAX_OUTPUT_LINES,
        "Re-run with a more specific command to inspect less stderr output.",
      ) : "(empty)";

      const exitStatus = killed
        ? "timeout"
        : code !== null
          ? String(code)
          : `signal ${signal}`;

      const sections = [
        `command: ${command}`,
        `cwd: ${workdir}`,
        `stdout:\n${stdoutText}`,
        `stderr:\n${stderrText}`,
        `exit_code: ${exitStatus}`,
      ];

      if (killed) {
        sections.push(`timeout_seconds: ${timeout}`);
      }

      resolvePromise({ output: sections.join("\n\n"), detectedCwd: cwd });
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
