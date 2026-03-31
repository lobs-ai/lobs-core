/**
 * Grep tool — search file contents using ripgrep.
 *
 * Uses ripgrep (rg) for fast searching that respects .gitignore.
 * Falls back to grep -rn if rg is not available.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";
import { capOutput } from "./output-cap.js";
import { resolveToCwd } from "./path-utils.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const grepToolDefinition: ToolDefinition = {
  name: "grep",
  description:
    "A ripgrep-powered search tool for file contents. Use this for search tasks instead of invoking grep or rg through Bash. " +
    "Supports regex patterns, optional glob filters, multiline mode, and output modes for content, files_with_matches, or count.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      glob: {
        type: "string",
        description: "Optional file glob filter such as '*.ts' or 'src/**/*.tsx'",
      },
      path: {
        type: "string",
        description: "File or directory to search (default: current directory)",
      },
      include: {
        type: "string",
        description: "Backward-compatible glob filter field",
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Return matching lines, only files with matches, or counts",
      },
      multiline: {
        type: "boolean",
        description: "Enable cross-line matching",
      },
    },
    required: ["pattern"],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CAPTURE = 200_000; // Max bytes to capture from the process
const TIMEOUT_MS = 30_000;

// ── Tool Implementation ──────────────────────────────────────────────────────

/**
 * Check if a command exists on the system.
 */
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn("which", [cmd], { stdio: "ignore" });
    child.on("close", (code) => res(code === 0));
    child.on("error", () => res(false));
  });
}

export async function grepTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const pattern = params.pattern as string;
  if (!pattern) throw new Error("pattern is required");

  const searchPath = (params.path as string) || ".";
  const resolved = resolveToCwd(searchPath, cwd);
  const include = (params.include as string | undefined) ?? (params.glob as string | undefined);
  const outputMode = typeof params.output_mode === "string" ? params.output_mode : "content";
  const multiline = params.multiline === true;

  const hasRg = await commandExists("rg");

  let args: string[];
  let cmd: string;

  if (hasRg) {
    cmd = "rg";
    args = ["-n", "--color=never", "--no-heading"];
    if (multiline) {
      args.push("--multiline");
    }
    if (outputMode === "files_with_matches") {
      args.push("--files-with-matches");
    } else if (outputMode === "count") {
      args.push("--count");
    }
    if (include) {
      args.push("--glob", include);
    }
    args.push(pattern, resolved);
  } else {
    cmd = "grep";
    args = ["-rn", "--color=never"];
    if (include) {
      args.push("--include", include);
    }
    args.push(pattern, resolved);
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

      if (code === 1 && !output && !stderr) {
        // grep/rg exit code 1 means no matches
        resolvePromise("No matches found.");
        return;
      }

      if (stderr && !output) {
        resolvePromise(`Error: ${stderr.trim()}`);
        return;
      }

      const result = output.trim();
      if (!result) {
        resolvePromise("No matches found.");
        return;
      }

      if (outputMode === "files_with_matches" || outputMode === "count") {
        resolvePromise(capOutput(result));
        return;
      }

      resolvePromise(capOutput(result));
    });
  });
}
