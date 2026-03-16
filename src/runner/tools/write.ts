/**
 * Write tool — write content to a file.
 *
 * Creates the file if it doesn't exist, overwrites if it does.
 * Automatically creates parent directories.
 */

import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import type { ToolDefinition } from "../types.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const writeToolDefinition: ToolDefinition = {
  name: "write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
    "Automatically creates parent directories.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write (relative or absolute)",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd: string): string {
  if (!filePath) throw new Error("path is required");
  const expanded = filePath.replace(/^~/, process.env.HOME ?? "");
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function writeTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = params.path as string;
  if (!filePath) throw new Error("path is required");

  const content = params.content as string;
  if (content === undefined || content === null) {
    throw new Error("content is required");
  }

  const resolved = resolvePath(filePath, cwd);
  const dir = dirname(resolved);

  // Create parent directories
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(resolved, content, "utf-8");

  const bytes = Buffer.byteLength(content);
  return `Successfully wrote ${bytes} bytes to ${filePath}`;
}
