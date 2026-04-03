/**
 * Edit tool — precise find-and-replace in files.
 *
 * Supports single edits (old_string/new_string) or batched edits via an
 * `edits` array for multiple changes in one call. All edits target the same file.
 * The old_string must match exactly (including whitespace).
 * Shows a unified diff of each change after a successful edit.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import type { ToolDefinition } from "../types.js";
import { resolveToCwd } from "./path-utils.js";
import { hasRecentlyReadFile, getReadCacheMtime } from "./read.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const editToolDefinition: ToolDefinition = {
  name: "edit",
  description:
    "Performs exact string replacements in files. You must use Read on the file before editing it. " +
    "Preserve exact indentation and whitespace exactly as it appears in the file, excluding any line-number prefix from Read output. " +
    "Use the smallest clearly unique old_string you can, usually only a few adjacent lines. " +
    "The edit fails if old_string is ambiguous; provide more context or use replace_all when you intentionally want every instance updated.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to edit",
      },
      path: {
        type: "string",
        description: "Backward-compatible path field; file_path is preferred",
      },
      old_string: {
        type: "string",
        description: "Exact text to find and replace (must match exactly)",
      },
      new_string: {
        type: "string",
        description: "New text to replace the old text with",
      },
      edits: {
        type: "array",
        description:
          "Multiple edits to apply in sequence. Each entry has old_string and new_string. " +
          "Use this instead of old_string/new_string to batch several changes to the same file in one call.",
        items: {
          type: "object",
          properties: {
            old_string: {
              type: "string",
              description: "Exact text to find and replace",
            },
            new_string: {
              type: "string",
              description: "New text to replace the old text with",
            },
          },
          required: ["old_string", "new_string"],
        },
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences of old_string in the file",
      },
    },
    required: [],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

/** Number of context lines to show around the diff */
const DIFF_CONTEXT_LINES = 3;

// ── Types ────────────────────────────────────────────────────────────────────

interface EditPair {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function validateEdits(edits: EditPair[]): void {
  const seen = new Set<string>();

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const label = edits.length > 1 ? `Edit ${i + 1}` : "Edit";

    if (edit.old_string.length === 0) {
      throw new Error(`${label} old_string must not be empty`);
    }

    const key = `${edit.old_string}\u0000${edit.new_string}\u0000${edit.replace_all === true}`;
    if (seen.has(key)) {
      throw new Error(`${label} duplicates an earlier edit in the same batch`);
    }
    seen.add(key);

    for (let j = 0; j < i; j++) {
      const prior = edits[j];
      if (edit.old_string.includes(prior.new_string) || prior.new_string.includes(edit.old_string)) {
        throw new Error(
          `${label} overlaps with an earlier edit in a way that is likely brittle. ` +
          "Split the edits into separate calls or use more specific old_string values.",
        );
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Normalize whitespace for fuzzy comparison:
 * collapse runs of spaces/tabs to single space, trim each line.
 */
function normalizeWhitespace(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n");
}

/**
 * Fuzzy-match old_string against the file content by normalizing whitespace.
 * Returns the actual text from the file that matches, or null.
 */
function fuzzyFindSimilar(content: string, oldStr: string): string | null {
  const normalizedOld = normalizeWhitespace(oldStr);
  const oldLines = normalizedOld.split("\n");
  const contentLines = content.split("\n");
  const windowSize = oldLines.length;

  if (windowSize === 0 || windowSize > contentLines.length) return null;

  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    const window = contentLines.slice(i, i + windowSize);
    const normalizedWindow = window
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .join("\n");
    if (normalizedWindow === normalizedOld) {
      return window.join("\n");
    }
  }

  return null;
}

/**
 * Normalize curly/typographic quotes to straight ASCII quotes.
 * Used as a fallback when exact match fails — models sometimes produce
 * curly quotes even when the source file uses straight quotes.
 */
function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"');
}

/**
 * Apply a single edit to content. Returns { updated, diff, summary } or throws.
 */
function applySingleEdit(
  filePath: string,
  content: string,
  oldText: string,
  newText: string,
): { updated: string; diff: string; summary: string } {
  const index = content.indexOf(oldText);
  if (index === -1) {
    // Check if new_string already exists (idempotent edit)
    if (content.includes(newText)) {
      return {
        updated: content,
        diff: "",
        summary: `Idempotent edit: the requested new text already exists in ${filePath}`,
      };
    }
    // Try quote normalization — model may have sent curly quotes, file has straight
    const normalizedOld = normalizeQuotes(oldText);
    if (normalizedOld !== oldText) {
      const normalizedIdx = content.indexOf(normalizedOld);
      if (normalizedIdx !== -1) {
        // Found with normalized quotes — recurse with the corrected old_string
        return applySingleEdit(filePath, content, normalizedOld, newText);
      }
    }

    // Try fuzzy matching to provide a helpful suggestion
    const similar = fuzzyFindSimilar(content, oldText);
    if (similar) {
      throw new Error(
        `old_string not found in file. Did you mean:\n\`\`\`\n${similar}\n\`\`\``,
      );
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

  const diff = generateDiff(filePath, content, oldText, newText, index);
  const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);

  const lineNum = content.slice(0, index).split("\n").length;
  const oldLines = oldText.split("\n").length;
  const newLines = newText.split("\n").length;
  const summary = `line ${lineNum}, ${oldLines} lines → ${newLines} lines`;

  return { updated, diff, summary };
}

function applyReplaceAllEdit(
  filePath: string,
  content: string,
  oldText: string,
  newText: string,
): { updated: string; diff: string; summary: string } {
  if (!content.includes(oldText)) {
    throw new Error(
      `Could not find the specified text in ${filePath}. ` +
      `The old_string must match exactly, including whitespace and indentation.`,
    );
  }

  const firstIndex = content.indexOf(oldText);
  const occurrences = content.split(oldText).length - 1;
  const updated = content.split(oldText).join(newText);
  const diff = generateDiff(filePath, content, oldText, newText, firstIndex);
  const summary = `Replace-all edit: replaced ${occurrences} occurrence${occurrences === 1 ? "" : "s"} in ${filePath}`;
  return { updated, diff, summary };
}

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function editTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = (params.path as string) ?? (params.file_path as string);
  if (!filePath) throw new Error("path is required");

  const resolved = resolveToCwd(filePath, cwd);

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Build the list of edits — either from edits[] or single old_string/new_string
  const edits: EditPair[] = [];

  if (Array.isArray(params.edits) && params.edits.length > 0) {
    for (const e of params.edits as EditPair[]) {
      if (e.old_string === undefined || e.old_string === null) {
        throw new Error("Each edit must have old_string");
      }
      if (e.new_string === undefined || e.new_string === null) {
        throw new Error("Each edit must have new_string");
      }
      edits.push({ old_string: e.old_string, new_string: e.new_string });
    }
  } else {
    // Single edit mode
    const oldText = params.old_string as string;
    const newText = params.new_string as string;
    const replaceAll = params.replace_all === true;
    if (oldText === undefined || oldText === null) {
      throw new Error("old_string is required (or use edits[] for multiple edits)");
    }
    if (newText === undefined || newText === null) {
      throw new Error("new_string is required");
    }
    edits.push({ old_string: oldText, new_string: newText, replace_all: replaceAll });
  }

  validateEdits(edits);

  if (!hasRecentlyReadFile(resolved)) {
    throw new Error(
      "You must use Read on this file before editing it. Read the file first so your old_string matches the exact current contents.",
    );
  }

  const cachedMtime = getReadCacheMtime(resolved);
  if (cachedMtime !== null) {
    const currentMtime = statSync(resolved).mtimeMs;
    if (currentMtime > cachedMtime) {
      throw new Error(
        `File '${filePath}' has been modified since last read (possibly by a linter, formatter, or another process). Read it again before editing.`,
      );
    }
  }

  let content = readFileSync(resolved, "utf-8");
  const results: string[] = [];
  let appliedCount = 0;

  const isBatch = edits.length > 1;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const label = isBatch ? `Edit ${i + 1}/${edits.length}: ` : "";

    try {
      const { updated, diff, summary } = edit.replace_all
        ? applyReplaceAllEdit(filePath, content, edit.old_string, edit.new_string)
        : applySingleEdit(filePath, content, edit.old_string, edit.new_string);
      content = updated;

      if (diff) {
        appliedCount++;
        results.push(`${label}${summary}\n\n${diff}`);
      } else {
        results.push(`${label}${summary}`);
      }
    } catch (err) {
      if (!isBatch) {
        // Single edit — throw so the agent sees is_error: true
        throw err;
      }
      // Multi-edit: write what we have so far and report
      if (appliedCount > 0) {
        writeFileSync(resolved, content, "utf-8");
      }
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`${label}FAILED — ${msg}`);
      results.push(`\n${appliedCount}/${edits.length} edits applied before failure. File has been partially updated.`);
      return `Edit applied: ${filePath}\n\n${results.join("\n\n")}`;
    }
  }

  // Write final content
  if (appliedCount > 0) {
    writeFileSync(resolved, content, "utf-8");
  }

  if (edits.length === 1) {
    return `Edit applied: ${filePath}\n\n${results[0]}`;
  }

  return `Edit applied: ${filePath}\nSummary: ${appliedCount}/${edits.length} edits applied\n\n${results.join("\n\n")}`;
}
