/**
 * Glob tool — find files by glob pattern.
 *
 * Uses fd if available, falls back to the find command.
 */

import { spawn } from "node:child_process";
import { resolve, isAbsolute } from "node:path";
import type { ToolDefinition } from "../types.js";
import { capOutput } from "./output-cap.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const globToolDefinition: ToolDefinition = {
  name: "glob",
  description:
    "Find files by glob pattern. Returns matching file paths, one per line.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match (e.g. 'src/**/*.ts')",
      },
      path: {
        type: "string",
        description: "Base directory for search (default: current directory)",
      },
    },
    required: ["pattern"],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CAPTURE = 200_000;
const TIMEOUT_MS = 30_000;

// ── Tool Implementation ──────────────────────────────────────────────────────

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn("which", [cmd], { stdio: "ignore" });
    child.on("close", (code) => res(code === 0));
    child.on("error", () => res(false));
  });
}

export async function globTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const pattern = params.pattern as string;
  if (!pattern) throw new Error("pattern is required");

  const basePath = (params.path as string) || ".";
  const expanded = basePath.replace(/^~/, process.env.HOME ?? "");
  const resolved = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);

  const hasFd = await commandExists("fd");

  let cmd: string;
  let args: string[];

  if (hasFd) {
    // fd uses regex, but we can use --glob flag for glob patterns
    cmd = "fd";
    args = ["--glob", "--color=never", pattern, resolved];
  } else {
    // Fallback to find with -name or -path
    cmd = "find";
    // If the pattern contains /, use -path, otherwise -name
    if (pattern.includes("/")) {
      args = [resolved, "-path", `*${pattern}`, "-print"];
    } else {
      args = [resolved, "-name", pattern, "-print"];
    }
  }

  return new Promise<string>((resolvePromise) => {
    let output = "";
    let stderr = "";

    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (output.length < MAX_CAPTURE) {
        output += chunk.slice(0, MAX_CAPTURE - output.length);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (stderr.length < MAX_CAPTURE) {
        stderr += chunk.slice(0, MAX_CAPTURE - stderr.length);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise(`Error running ${cmd}: ${err.message}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (stderr && !output) {
        resolvePromise(`Error: ${stderr.trim()}`);
        return;
      }

      const result = output.trim();
      if (!result) {
        resolvePromise("No files matched the pattern.");
        return;
      }

      // Count matches
      const matchCount = result.split("\n").length;
      const header = `Found ${matchCount} file${matchCount === 1 ? "" : "s"}:\n`;

      resolvePromise(header + capOutput(result));
    });
  });
}
