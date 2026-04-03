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
    "A ripgrep-powered search tool for file contents. Use this instead of invoking grep or rg through Bash. " +
    "Supports regex patterns, optional glob filters, multiline mode, and output modes for matching lines, files_with_matches, or count. " +
    "Prefer this when you know the text pattern you need but not yet the exact file.",
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
      context_lines: {
        type: "number",
        description:
          "Number of context lines around each match (default: 0). Only applies in content output mode.",
      },
      case_sensitive: {
        type: "boolean",
        description:
          "Case sensitive search (default: smart case — case sensitive if pattern has uppercase)",
      },
      max_results: {
        type: "number",
        description: "Maximum number of matches to return (default: 200)",
      },
    },
    required: ["pattern"],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CAPTURE = 200_000; // Max bytes to capture from the process
const TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 200;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Strip the cwd prefix from file paths in grep/rg output to save tokens.
 */
function relativizePaths(output: string, cwd: string): string {
  if (!cwd.endsWith("/")) cwd += "/";
  return output.replaceAll(cwd, "");
}

/**
 * Truncate output to max_results lines, appending a notice if truncated.
 */
function applyMaxResults(output: string, maxResults: number): string {
  const lines = output.split("\n");
  if (lines.length <= maxResults) return output;
  const truncated = lines.slice(0, maxResults).join("\n");
  return (
    truncated +
    `\n(... results truncated to ${maxResults} matches. Use a more specific pattern or path to narrow results.)`
  );
}

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function grepTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const pattern = params.pattern as string;
  if (!pattern) throw new Error("pattern is required");

  const searchPath = (params.path as string) || ".";
  const resolved = resolveToCwd(searchPath, cwd);
  const include =
    (params.include as string | undefined) ?? (params.glob as string | undefined);
  const outputMode =
    typeof params.output_mode === "string" ? params.output_mode : "content";
  const multiline = params.multiline === true;
  const contextLines =
    typeof params.context_lines === "number" ? params.context_lines : 0;
  const caseSensitive = params.case_sensitive as boolean | undefined;
  const maxResults =
    typeof params.max_results === "number"
      ? params.max_results
      : DEFAULT_MAX_RESULTS;

  const hasRg = await commandExists("rg");

  let args: string[];
  let cmd: string;

  if (hasRg) {
    cmd = "rg";
    args = ["-n", "--color=never", "--no-heading", "--max-columns=500", "--max-columns-preview"];

    // Smart case by default; explicitly true → -s; explicitly false → -i
    if (caseSensitive === true) {
      args.push("-s");
    } else if (caseSensitive === false) {
      args.push("-i");
    } else {
      args.push("--smart-case");
    }

    if (multiline) {
      args.push("--multiline");
    }

    if (outputMode === "files_with_matches") {
      args.push("--files-with-matches");
    } else if (outputMode === "count") {
      args.push("--count");
    } else if (contextLines > 0) {
      // Context lines only apply in content mode
      args.push(`-C`, String(contextLines));
    }

    if (include) {
      args.push("--glob", include);
    }

    // Always exclude .git directory
    args.push("--glob=!.git");

    args.push(pattern, resolved);
  } else {
    cmd = "grep";
    args = ["-rn", "--color=never"];

    // Case sensitivity for grep fallback
    if (caseSensitive === false) {
      args.push("-i");
    }

    // Context lines for grep fallback (content mode only)
    if (outputMode === "content" && contextLines > 0) {
      args.push(`-C`, String(contextLines));
    }

    if (include) {
      args.push("--include", include);
    }

    // Exclude .git for grep fallback
    args.push("--exclude-dir=.git");

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

      // Relativize paths to save tokens
      const relativized = relativizePaths(result, cwd);

      // Apply max_results truncation
      const truncated = applyMaxResults(relativized, maxResults);

      resolvePromise(capOutput(truncated));
    });
  });
}
