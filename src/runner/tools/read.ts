/**
 * Read tool — read file contents.
 *
 * Supports offset/limit for large files, binary detection.
 * Output is truncated to ~500 lines / 50KB by default.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { ToolDefinition } from "../types.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const readToolDefinition: ToolDefinition = {
  name: "read",
  description:
    "Read the contents of a file. For text files, output is truncated to 500 lines or 50KB by default " +
    "(whichever is hit first). Use offset/limit for large files.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (relative or absolute)",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read",
      },
    },
    required: ["path"],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_LINES = 2000;
const DEFAULT_LINES = 500;
const MAX_BYTES = 50 * 1024; // 50KB
const DEFAULT_BYTES = 50000;
const BINARY_CHECK_BYTES = 8192;

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd: string): string {
  if (!filePath) throw new Error("path is required");
  const expanded = filePath.replace(/^~/, process.env.HOME ?? "");
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function isBinary(buffer: Buffer): boolean {
  const check = buffer.subarray(0, Math.min(BINARY_CHECK_BYTES, buffer.length));
  for (let i = 0; i < check.length; i++) {
    const byte = check[i];
    if (byte === 0) return true;
  }
  return false;
}

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function readTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = params.path as string;
  if (!filePath) throw new Error("path is required");

  const resolved = resolvePath(filePath, cwd);

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    throw new Error(`${filePath} is a directory, not a file`);
  }

  const buffer = readFileSync(resolved);

  // Binary detection
  if (isBinary(buffer)) {
    return `Binary file (${stat.size} bytes): ${filePath}`;
  }

  const content = buffer.toString("utf-8");
  const lines = content.split("\n");

  const hasExplicitRange = typeof params.offset === "number" || typeof params.limit === "number";
  const offset = typeof params.offset === "number" ? Math.max(1, params.offset) : 1;
  const limit = typeof params.limit === "number"
    ? Math.max(1, params.limit)
    : (hasExplicitRange ? MAX_LINES : DEFAULT_LINES);
  const byteBudget = hasExplicitRange ? MAX_BYTES : DEFAULT_BYTES;

  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, lines.length);
  const sliced = lines.slice(startIdx, endIdx);

  let result = sliced.join("\n");

  // Truncate by bytes if needed
  if (Buffer.byteLength(result) > byteBudget) {
    const truncated = result.slice(0, byteBudget);
    const lastNl = truncated.lastIndexOf("\n");
    result = lastNl > byteBudget * 0.7 ? truncated.slice(0, lastNl) : truncated;
    const shownLines = result.split("\n").length;
    const from = offset + shownLines;
    result += `\n\n[Truncated. ${lines.length - (startIdx + shownLines)} more lines. Use offset=${from} to continue.]`;
    return result;
  }

  // Add metadata
  const meta: string[] = [];
  if (startIdx > 0 || endIdx < lines.length) {
    meta.push(`Lines ${offset}-${endIdx} of ${lines.length}`);
  }
  if (endIdx < lines.length) {
    meta.push(`${lines.length - endIdx} more lines. Use offset=${endIdx + 1} to continue.`);
  }

  return meta.length > 0 ? `${result}\n\n[${meta.join(". ")}]` : result;
}
