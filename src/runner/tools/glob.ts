/**
 * Glob tool — find files by glob pattern.
 *
 * Uses fd if available, falls back to the find command.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";
import { capOutput } from "./output-cap.js";
import { resolveToCwd } from "./path-utils.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const globToolDefinition: ToolDefinition = {
  name: "glob",
  description:
    "Fast file pattern matching across the codebase. Use this when you need to find files by name or path patterns such as '**/*.ts' or 'src/**/*.tsx'.",
  input_schema: {
    type: "object",
    properties: {
      glob: {
        type: "string",
        description: "Glob pattern to match",
      },
      pattern: {
        type: "string",
        description: "Backward-compatible glob pattern field; glob is preferred",
      },
      path: {
        type: "string",
        description: "Base directory for search (default: current directory)",
      },
    },
    required: [],
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
  const pattern = (params.pattern as string) ?? (params.glob as string);
  if (!pattern) throw new Error("pattern is required");

  const basePath = (params.path as string) || ".";
  const resolved = resolveToCwd(basePath, cwd);

  const hasFd = await commandExists("fd");

  let cmd: string;
  let args: string[];

  if (hasFd) {
    // fd --glob doesn't support ** (deep recursion) — it recurses by default.
    // Strip leading path segments from pattern and adjust the search dir.
    // e.g. "src/**/*.ts" → search in <resolved>/src with pattern "*.ts"
    let searchDir = resolved;
    let fdPattern = pattern;

    // Extract leading literal path prefix (before any glob chars)
    const match = pattern.match(/^([^*?{[]+\/)/);
    if (match) {
      const prefix = match[1].replace(/\/$/, "");
      searchDir = resolveToCwd(prefix, resolved);
      fdPattern = pattern.slice(match[1].length);
    }

    // Strip any remaining **/ since fd recurses by default
    fdPattern = fdPattern.replace(/\*\*\//g, "");
    if (!fdPattern) fdPattern = "*";

    cmd = "fd";
    args = ["--glob", "--color=never", fdPattern, searchDir];
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
