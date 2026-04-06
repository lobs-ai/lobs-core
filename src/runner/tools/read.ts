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
type ReadSnapshot = {
  mtimeMs: number;
  size: number;
  contentHash: string;
};

export const recentReadCache = new Map<string, ReadSnapshot>();
export const recentlyReadFiles = new Set<string>();

function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}

export function hasRecentlyReadFile(filePath: string): boolean {
  return recentlyReadFiles.has(filePath);
}

export function getReadSnapshot(resolvedPath: string): ReadSnapshot | null {
  // The cache key for a full read is `${resolved}:full`, and for default reads
  // it's `${resolved}:1:500` (or other offset:limit combos). We want the snapshot
  // regardless of which variant was cached, so scan for any entry whose key
  // starts with the resolved path.
  for (const [key, value] of recentReadCache) {
    if (key.startsWith(`${resolvedPath}:`)) {
      return value;
    }
  }
  return null;
}

export function createReadSnapshot(content: string, mtimeMs: number, size: number): ReadSnapshot {
  return {
    mtimeMs,
    size,
    contentHash: hashContent(content),
  };
}

export function clearRecentReadTracking(): void {
  recentReadCache.clear();
  recentlyReadFiles.clear();
}

/**
 * Update the read snapshot for a file after it has been modified by the Edit tool.
 * This prevents the staleness check from rejecting subsequent edits to the same file
 * without requiring a re-read.
 */
export function updateReadSnapshot(resolvedPath: string, content: string, mtimeMs: number, size: number): void {
  const snapshot = createReadSnapshot(content, mtimeMs, size);
  // Update all cached variants for this path (full, offset:limit, etc.)
  for (const key of recentReadCache.keys()) {
    if (key.startsWith(`${resolvedPath}:`)) {
      recentReadCache.set(key, snapshot);
    }
  }
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

  // Block device files that would hang or produce infinite output
  const BLOCKED_DEVICE_PATHS = new Set([
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/full",
    "/dev/stdin",
    "/dev/tty",
    "/dev/console",
  ]);
  if (BLOCKED_DEVICE_PATHS.has(resolved)) {
    throw new Error(
      "Cannot read device file — would block or produce infinite output.",
    );
  }

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

  const currentSnapshot = createReadSnapshot(content, stat.mtimeMs, stat.size);

  if (full) {
    if (stat.size > MAX_FULL_FILE_BYTES) {
      throw new Error(
        `File too large for full read (${stat.size} bytes). Use offset/limit for large files.`,
      );
    }
    recentlyReadFiles.add(resolved);
    recentReadCache.set(cacheKey, currentSnapshot);
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
    recentReadCache.set(cacheKey, currentSnapshot);
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
  recentReadCache.set(cacheKey, currentSnapshot);
  return finalResult;
}
