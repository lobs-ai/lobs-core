/**
 * Edit tool — precise find-and-replace in files.
 *
 * The old_string must match exactly (including whitespace).
 * Shows a unified diff of the change after a successful edit.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { ToolDefinition } from "../types.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const editToolDefinition: ToolDefinition = {
  name: "edit",
  description:
    "Edit a file by replacing exact text. The old_string must match exactly (including whitespace). " +
    "Use this for precise, surgical edits.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit (relative or absolute)",
      },
      old_string: {
        type: "string",
        description: "Exact text to find and replace (must match exactly)",
      },
      new_string: {
        type: "string",
        description: "New text to replace the old text with",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

/** Number of context lines to show around the diff */
const DIFF_CONTEXT_LINES = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd: string): string {
  if (!filePath) throw new Error("path is required");
  const expanded = filePath.replace(/^~/, process.env.HOME ?? "");
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Generate a unified diff snippet showing the change with context lines.
 */
function generateDiff(
  filePath: string,
  originalContent: string,
  oldText: string,
  newText: string,
  matchIndex: number,
): string {
  const allLines = originalContent.split("\n");
  const beforeMatch = originalContent.slice(0, matchIndex);
  const matchStartLine = beforeMatch.split("\n").length; // 1-indexed

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Calculate context range
  const contextStart = Math.max(0, matchStartLine - 1 - DIFF_CONTEXT_LINES);
  const contextEnd = Math.min(allLines.length, matchStartLine - 1 + oldLines.length + DIFF_CONTEXT_LINES);

  const beforeContext = allLines.slice(contextStart, matchStartLine - 1);
  const afterContext = allLines.slice(matchStartLine - 1 + oldLines.length, contextEnd);

  // Build diff output
  const parts: string[] = [];
  parts.push(`--- a/${filePath}`);
  parts.push(`+++ b/${filePath}`);

  const oldRangeStart = contextStart + 1;
  const oldRangeLen = beforeContext.length + oldLines.length + afterContext.length;
  const newRangeLen = beforeContext.length + newLines.length + afterContext.length;
  parts.push(`@@ -${oldRangeStart},${oldRangeLen} +${oldRangeStart},${newRangeLen} @@`);

  for (const line of beforeContext) {
    parts.push(` ${line}`);
  }
  for (const line of oldLines) {
    parts.push(`-${line}`);
  }
  for (const line of newLines) {
    parts.push(`+${line}`);
  }
  for (const line of afterContext) {
    parts.push(` ${line}`);
  }

  return parts.join("\n");
}

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function editTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = params.path as string;
  if (!filePath) throw new Error("path is required");

  const oldText = params.old_string as string;
  const newText = params.new_string as string;

  if (oldText === undefined || oldText === null) {
    throw new Error("old_string is required");
  }
  if (newText === undefined || newText === null) {
    throw new Error("new_string is required");
  }

  const resolved = resolvePath(filePath, cwd);

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(resolved, "utf-8");

  // Check if old_string exists in file
  const index = content.indexOf(oldText);
  if (index === -1) {
    // Check if new_string already exists (idempotent edit)
    if (content.includes(newText)) {
      return `The new text already exists in ${filePath} (edit may have already been applied).`;
    }
    throw new Error(
      `Could not find the specified text in ${filePath}. ` +
      `The old_string must match exactly, including whitespace and indentation.`,
    );
  }

  // Check for multiple matches
  const secondIndex = content.indexOf(oldText, index + 1);
  if (secondIndex !== -1) {
    const lineNum1 = content.slice(0, index).split("\n").length;
    const lineNum2 = content.slice(0, secondIndex).split("\n").length;
    throw new Error(
      `Found multiple matches for old_string in ${filePath} (lines ${lineNum1} and ${lineNum2}). ` +
      `Include more surrounding context to make the match unique.`,
    );
  }

  // Generate diff before applying
  const diff = generateDiff(filePath, content, oldText, newText, index);

  // Apply the edit
  const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
  writeFileSync(resolved, updated, "utf-8");

  // Calculate what changed
  const lineNum = content.slice(0, index).split("\n").length;
  const oldLines = oldText.split("\n").length;
  const newLines = newText.split("\n").length;

  return `Edited ${filePath} (line ${lineNum}, ${oldLines} lines → ${newLines} lines)\n\n${diff}`;
}
