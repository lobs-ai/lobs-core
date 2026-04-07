/**
 * Write tool — write content to a file.
 *
 * Creates the file if it doesn't exist, overwrites if it does.
 * Automatically creates parent directories.
 */

import { existsSync, statSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "../types.js";
import { resolveToCwd } from "./path-utils.js";
import { hasRecentlyReadFile, updateReadSnapshot } from "./read.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const writeToolDefinition: ToolDefinition = {
  name: "write",
  description:
    "Writes a file to the local filesystem. This overwrites the target file if it already exists. " +
    "Prefer Edit for modifying existing files; use Write for new files, generated files, or full rewrites where replacing the whole file is intentional.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to write",
      },
      path: {
        type: "string",
        description: "Backward-compatible path field; file_path is preferred",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["content"],
  },
};

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function writeTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = (params.path as string) ?? (params.file_path as string);
  if (!filePath) throw new Error("path is required");

  const content = params.content as string;
  if (content === undefined || content === null) {
    throw new Error("content is required");
  }

  const resolved = resolveToCwd(filePath, cwd);
  const dir = dirname(resolved);

  // Create parent directories
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(resolved, content, "utf-8");

  // Register the file so edit won't require a re-read
  if (!hasRecentlyReadFile(filePath, cwd)) {
    const stat = statSync(resolved);
    updateReadSnapshot(resolved, content, stat.mtimeMs, stat.size);
  }

  const bytes = Buffer.byteLength(content);
  return `Write applied: ${filePath}\nBytes written: ${bytes}`;
}
