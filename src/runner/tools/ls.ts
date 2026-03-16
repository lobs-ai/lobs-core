/**
 * Ls tool — list directory contents.
 *
 * Shows type indicator (f=file, d=directory, l=symlink), size, and name.
 * Directories end with /.
 */

import { readdirSync, statSync, lstatSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import type { ToolDefinition } from "../types.js";
import { capOutput } from "./output-cap.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const lsToolDefinition: ToolDefinition = {
  name: "ls",
  description:
    "List files and directories. Defaults to current directory. " +
    "Output format: type (f=file, d=directory, l=symlink) size name. " +
    "Directories end with /.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list (default: current directory)",
      },
      limit: {
        type: "number",
        description: "Max entries to return",
      },
    },
    required: [],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function lsTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const dirPath = (params.path as string) || ".";
  const expanded = dirPath.replace(/^~/, process.env.HOME ?? "");
  const resolved = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : undefined;

  let entries;
  try {
    entries = readdirSync(resolved, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot list directory: ${msg}`);
  }

  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  if (limit) {
    entries = entries.slice(0, limit);
  }

  const lines: string[] = [];
  for (const entry of entries) {
    const fullPath = join(resolved, entry.name);
    let typeChar: string;
    let size = "";

    try {
      const lstat = lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        typeChar = "l";
        size = formatSize(lstat.size);
      } else if (lstat.isDirectory()) {
        typeChar = "d";
        size = "-";
      } else {
        typeChar = "f";
        size = formatSize(lstat.size);
      }
    } catch {
      typeChar = "?";
      size = "?";
    }

    const displayName = entry.isDirectory() ? `${entry.name}/` : entry.name;
    lines.push(`${typeChar} ${size.padStart(8)} ${displayName}`);
  }

  if (lines.length === 0) {
    return "(empty directory)";
  }

  const output = lines.join("\n");
  return capOutput(output);
}
