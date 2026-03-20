/**
 * Code search tool — smart code search using ripgrep with context.
 *
 * Wraps ripgrep with useful defaults for code navigation: surrounding context
 * lines, language filtering, smart case, word matching, and result capping.
 * Returns results with clear file separators for readability.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";
import { capOutput } from "./output-cap.js";
import { resolveToCwd } from "./path-utils.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const codeSearchToolDefinition: ToolDefinition = {
  name: "code_search",
  description:
    "Search code with context. Returns matches with surrounding lines for better understanding. " +
    "Useful for finding function definitions, usages, imports, and code patterns.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description:
          "File or directory to search (default: current directory)",
      },
      language: {
        type: "string",
        description:
          "Filter by language/file type (e.g. 'ts', 'python', 'rust', 'go'). Maps to ripgrep's --type flag.",
      },
      context_lines: {
        type: "number",
        description: "Number of context lines around each match (default: 3)",
      },
      max_results: {
        type: "number",
        description: "Maximum number of matches to return (default: 50)",
      },
      word_match: {
        type: "boolean",
        description: "Match whole words only (default: false)",
      },
      case_sensitive: {
        type: "boolean",
        description:
          "Case sensitive search (default: smart case — case sensitive if pattern has uppercase)",
      },
    },
    required: ["pattern"],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CAPTURE = 200_000;
const TIMEOUT_MS = 30_000;
const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_RESULTS = 50;

// ── Tool Implementation ──────────────────────────────────────────────────────

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn("which", [cmd], { stdio: "ignore" });
    child.on("close", (code) => res(code === 0));
    child.on("error", () => res(false));
  });
}

export async function codeSearchTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const pattern = params.pattern as string;
  if (!pattern) throw new Error("pattern is required");

  const searchPath = (params.path as string) || ".";
  const resolved = resolveToCwd(searchPath, cwd);
  const language = params.language as string | undefined;
  const contextLines =
    (params.context_lines as number | undefined) ?? DEFAULT_CONTEXT;
  const maxResults =
    (params.max_results as number | undefined) ?? DEFAULT_MAX_RESULTS;
  const wordMatch = params.word_match as boolean | undefined;
  const caseSensitive = params.case_sensitive as boolean | undefined;

  const hasRg = await commandExists("rg");

  let cmd: string;
  let args: string[];

  if (hasRg) {
    cmd = "rg";
    args = [
      "--color=never",
      "--line-number",
      "--heading",          // group matches by file
      "-C", String(contextLines),
      "-m", String(maxResults),
    ];

    // Case sensitivity: explicit true → -s, explicit false → -i, undefined → -S (smart)
    if (caseSensitive === true) {
      args.push("-s");
    } else if (caseSensitive === false) {
      args.push("-i");
    } else {
      args.push("-S"); // smart case
    }

    if (wordMatch) {
      args.push("-w");
    }
    if (language) {
      args.push("--type", language);
    }

    args.push(pattern, resolved);
  } else {
    // Fallback: grep -rn with context (no language filtering)
    cmd = "grep";
    args = ["-rn", "--color=never", `-C${contextLines}`];

    if (caseSensitive === false) {
      args.push("-i");
    }
    if (wordMatch) {
      args.push("-w");
    }
    if (maxResults) {
      args.push("-m", String(maxResults));
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
        // rg/grep exit code 1 = no matches
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

      resolvePromise(capOutput(result));
    });
  });
}
