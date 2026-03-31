/**
 * Read tool — read file contents.
 *
 * Supports offset/limit for large files, binary detection.
 * Output is truncated to ~500 lines / 50KB by default.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import type { ToolDefinition } from "../types.js";
import { resolveToCwd } from "./path-utils.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const readToolDefinition: ToolDefinition = {
  name: "read",
  description:
    "Reads a file from the local filesystem. Assume any user-provided path is worth checking. " +
    "Use an absolute path via file_path when possible. By default it reads from the start of the file and returns line-numbered text. " +
    "When you already know the area you need, use offset and limit for a targeted read instead of re-reading the whole file. " +
    "This tool reads files only, not directories.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to read",
      },
      path: {
        type: "string",
        description: "Backward-compatible path field; file_path is preferred",
      },
      offset: {
        type: "number",
        description: "Optional 1-based line offset to start reading from",
      },
      limit: {
        type: "number",
        description: "Optional maximum number of lines to read",
      },
      full: {
        type: "boolean",
        description: "Return the entire text file without preview truncation",
      },
    },
    required: [],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_LINES = 2000;
const DEFAULT_LINES = 500;
const MAX_BYTES = 50 * 1024; // 50KB
const DEFAULT_BYTES = 50000;
const BINARY_CHECK_BYTES = 8192;
const MAX_FULL_FILE_BYTES = 200 * 1024; // 200KB
export const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";

const recentReadCache = new Map<string, { mtimeMs: number; size: number }>();
const recentlyReadFiles = new Set<string>();

export function hasRecentlyReadFile(filePath: string): boolean {
  return recentlyReadFiles.has(filePath);
}

export function clearRecentReadTracking(): void {
  recentReadCache.clear();
  recentlyReadFiles.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  const filePath = (params.path as string) ?? (params.file_path as string);
  if (!filePath) throw new Error("path is required");

  const resolved = resolveToCwd(filePath, cwd);

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
  const full = params.full === true;
  const hasExplicitRange = typeof params.offset === "number" || typeof params.limit === "number";
  const offset = typeof params.offset === "number" ? Math.max(1, params.offset) : 1;
  const limit = typeof params.limit === "number"
    ? Math.max(1, params.limit)
    : (hasExplicitRange ? MAX_LINES : DEFAULT_LINES);
  const cacheKey = `${resolved}:${full ? "full" : `${offset}:${limit}`}`;

  const cached = recentReadCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return FILE_UNCHANGED_STUB;
  }

  if (full) {
    if (stat.size > MAX_FULL_FILE_BYTES) {
      throw new Error(
        `File too large for full read (${stat.size} bytes). Use offset/limit for large files.`,
      );
    }
    recentlyReadFiles.add(resolved);
    recentReadCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size });
    return content;
  }

  const byteBudget = hasExplicitRange ? MAX_BYTES : DEFAULT_BYTES;

  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, lines.length);
  const sliced = lines.slice(startIdx, endIdx);
  let result = sliced
    .map((line, index) => `${String(startIdx + index + 1).padStart(6, " ")}\t${line}`)
    .join("\n");

  // Truncate by bytes if needed
  if (Buffer.byteLength(result) > byteBudget) {
    const truncated = result.slice(0, byteBudget);
    const lastNl = truncated.lastIndexOf("\n");
    result = lastNl > byteBudget * 0.7 ? truncated.slice(0, lastNl) : truncated;
    const shownLines = result.split("\n").length;
    const from = offset + shownLines;
    result += `\n\n[Truncated. ${lines.length - (startIdx + shownLines)} more lines. Use offset=${from} to continue.]`;
    recentlyReadFiles.add(resolved);
    recentReadCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size });
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

  const finalResult = meta.length > 0 ? `${result}\n\n[${meta.join(". ")}]` : result;
  recentlyReadFiles.add(resolved);
  recentReadCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size });
  return finalResult;
}
