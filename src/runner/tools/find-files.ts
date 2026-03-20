/**
 * Find files tool — find files and directories using fd.
 *
 * More flexible than glob: supports regex/literal patterns, type filtering,
 * extension filtering, depth limiting, hidden files, and exclude patterns.
 * Falls back to `find` if fd is not available.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";
import { capOutput } from "./output-cap.js";
import { resolveToCwd } from "./path-utils.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const findFilesToolDefinition: ToolDefinition = {
  name: "find_files",
  description:
    "Find files and directories using fd. Fast, respects .gitignore by default. " +
    "More flexible than glob for complex searches.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Search pattern (regex by default, or literal filename). Leave empty to find all files.",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: current directory)",
      },
      extension: {
        type: "string",
        description:
          "Filter by file extension (e.g. 'ts', 'py', 'json'). No dot needed.",
      },
      type: {
        type: "string",
        description:
          "Filter by type: 'f' for files, 'd' for directories, 'l' for symlinks",
        enum: ["f", "d", "l"],
      },
      max_depth: {
        type: "number",
        description: "Maximum search depth",
      },
      hidden: {
        type: "boolean",
        description: "Include hidden files/directories (default: false)",
      },
      exclude: {
        type: "string",
        description: "Glob pattern to exclude (e.g. 'node_modules')",
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

export async function findFilesTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const pattern = params.pattern as string | undefined;
  const basePath = (params.path as string) || ".";
  const extension = params.extension as string | undefined;
  const fileType = params.type as string | undefined;
  const maxDepth = params.max_depth as number | undefined;
  const hidden = params.hidden as boolean | undefined;
  const exclude = params.exclude as string | undefined;

  const resolved = resolveToCwd(basePath, cwd);

  const hasFd = await commandExists("fd");

  let cmd: string;
  let args: string[];

  if (hasFd) {
    cmd = "fd";
    args = ["--color=never"];

    if (extension) {
      args.push("--extension", extension);
    }
    if (fileType) {
      args.push("--type", fileType);
    }
    if (maxDepth !== undefined) {
      args.push("--max-depth", String(maxDepth));
    }
    if (hidden) {
      args.push("--hidden");
    }
    if (exclude) {
      args.push("--exclude", exclude);
    }

    // pattern is positional — comes before the search path
    if (pattern) {
      args.push(pattern);
    }
    args.push(resolved);
  } else {
    // Fallback: build an equivalent `find` command
    cmd = "find";
    args = [resolved];

    if (maxDepth !== undefined) {
      args.push("-maxdepth", String(maxDepth));
    }
    if (fileType) {
      const typeMap: Record<string, string> = { f: "f", d: "d", l: "l" };
      args.push("-type", typeMap[fileType] ?? fileType);
    }
    if (!hidden) {
      // Exclude dot-files/dirs at any depth
      args.push("!", "-name", ".*");
    }
    if (exclude) {
      args.push("!", "-path", `*/${exclude}/*`);
    }
    if (extension) {
      args.push("-name", `*.${extension}`);
    } else if (pattern) {
      args.push("-name", `*${pattern}*`);
    }
    args.push("-print");
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

    child.on("close", () => {
      clearTimeout(timer);

      if (stderr && !output) {
        resolvePromise(`Error: ${stderr.trim()}`);
        return;
      }

      const result = output.trim();
      if (!result) {
        resolvePromise("No files found.");
        return;
      }

      const matchCount = result.split("\n").length;
      const header = `Found ${matchCount} result${matchCount === 1 ? "" : "s"}:\n`;

      resolvePromise(header + capOutput(result));
    });
  });
}
