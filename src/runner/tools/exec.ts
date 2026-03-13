/**
 * Exec tool — run shell commands.
 * 
 * Modeled after OpenClaw's exec: supports command, workdir, timeout, env.
 * Simplified: no PTY, no background processes, no sandboxing.
 * Workers are one-shot — they don't need persistent sessions.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";

export const execToolDefinition: ToolDefinition = {
  name: "exec",
  description:
    "Execute a shell command. Returns stdout, stderr, and exit code. " +
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

const MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 300;

export async function execTool(
  params: Record<string, unknown>,
  defaultCwd: string,
): Promise<string> {
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

  return new Promise<string>((resolve) => {
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
      if (stdout.length < MAX_OUTPUT_CHARS) {
        stdout += chunk.slice(0, MAX_OUTPUT_CHARS - stdout.length);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (stderr.length < MAX_OUTPUT_CHARS) {
        stderr += chunk.slice(0, MAX_OUTPUT_CHARS - stderr.length);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Error spawning process: ${err.message}`);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const parts: string[] = [];

      if (killed) {
        parts.push(`Command timed out after ${timeout} seconds.`);
      }

      if (stdout.length > 0) parts.push(stdout);
      if (stderr.length > 0) parts.push(stderr);

      if (stdout.length >= MAX_OUTPUT_CHARS || stderr.length >= MAX_OUTPUT_CHARS) {
        parts.push(`(output truncated at ${MAX_OUTPUT_CHARS} characters)`);
      }

      const exitInfo = killed
        ? `Exit: killed (timeout)`
        : `Exit code: ${code ?? `signal ${signal}`}`;
      parts.push(exitInfo);

      resolve(parts.join("\n") || "(no output)");
    });
  });
}
