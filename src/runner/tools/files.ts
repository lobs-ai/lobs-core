/**
 * File tools — read, write, edit.
 * 
 * Read: supports offset/limit for large files, binary detection, image support.
 * Write: creates parent directories automatically.
 * Edit: exact string find-and-replace (matches OpenClaw's approach).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import type { ToolDefinition } from "../types.js";

// ── Tool Definitions ────────────────────────────────────────────────────────

export const readToolDefinition: ToolDefinition = {
  name: "read",
  description:
    "Read the contents of a file. For text files, output is truncated to 2000 lines or 50KB " +
    "(whichever is hit first). Use offset/limit for large files.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (relative or absolute)",
      },
      file_path: {
        type: "string",
        description: "Alias for path",
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
    required: [],
  },
};

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
      file_path: {
        type: "string",
        description: "Alias for path",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["content"],
  },
};

export const editToolDefinition: ToolDefinition = {
  name: "edit",
  description:
    "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). " +
    "Use this for precise, surgical edits.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit (relative or absolute)",
      },
      file_path: {
        type: "string",
        description: "Alias for path",
      },
      oldText: {
        type: "string",
        description: "Exact text to find and replace (must match exactly)",
      },
      old_string: {
        type: "string",
        description: "Alias for oldText",
      },
      newText: {
        type: "string",
        description: "New text to replace the old text with",
      },
      new_string: {
        type: "string",
        description: "Alias for newText",
      },
    },
    required: [],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024; // 50KB
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
    // Null bytes = binary
    if (byte === 0) return true;
  }
  return false;
}

// ── Tool Implementations ─────────────────────────────────────────────────────

export async function readTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = (params.path ?? params.file_path) as string;
  if (!filePath) throw new Error("path or file_path is required");

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

  const offset = typeof params.offset === "number" ? Math.max(1, params.offset) : 1;
  const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : MAX_LINES;

  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, lines.length);
  const sliced = lines.slice(startIdx, endIdx);

  let result = sliced.join("\n");

  // Truncate by bytes if needed
  if (Buffer.byteLength(result) > MAX_BYTES) {
    result = result.slice(0, MAX_BYTES);
    result += `\n\n(truncated at ${MAX_BYTES / 1024}KB)`;
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

export async function writeTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = (params.path ?? params.file_path) as string;
  if (!filePath) throw new Error("path or file_path is required");

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

export async function editTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = (params.path ?? params.file_path) as string;
  if (!filePath) throw new Error("path or file_path is required");

  const oldText = (params.oldText ?? params.old_string) as string;
  const newText = (params.newText ?? params.new_string) as string;

  if (oldText === undefined || oldText === null) {
    throw new Error("oldText or old_string is required");
  }
  if (newText === undefined || newText === null) {
    throw new Error("newText or new_string is required");
  }

  const resolved = resolvePath(filePath, cwd);

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(resolved, "utf-8");

  // Check if oldText exists in file
  const index = content.indexOf(oldText);
  if (index === -1) {
    // Check if newText already exists (idempotent edit)
    if (content.includes(newText)) {
      return `The new text already exists in ${filePath} (edit may have already been applied).`;
    }
    throw new Error(
      `Could not find the specified text in ${filePath}. ` +
      `The oldText must match exactly, including whitespace and indentation.`
    );
  }

  // Check for multiple matches
  const secondIndex = content.indexOf(oldText, index + 1);
  if (secondIndex !== -1) {
    const lineNum1 = content.slice(0, index).split("\n").length;
    const lineNum2 = content.slice(0, secondIndex).split("\n").length;
    throw new Error(
      `Found multiple matches for oldText in ${filePath} (lines ${lineNum1} and ${lineNum2}). ` +
      `Include more surrounding context to make the match unique.`
    );
  }

  // Apply the edit
  const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
  writeFileSync(resolved, updated, "utf-8");

  // Calculate what changed
  const lineNum = content.slice(0, index).split("\n").length;
  const oldLines = oldText.split("\n").length;
  const newLines = newText.split("\n").length;

  return `Successfully edited ${filePath} (line ${lineNum}, ${oldLines} lines → ${newLines} lines)`;
}
