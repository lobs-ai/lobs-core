/**
 * Knowledge FS API — reads from multiple knowledge sources:
 * - ~/lobs-shared-memory (cross-project docs, learnings, ADRs)
 * - ~/.lobs/agents/main/context/ (agent context: PROJECT files, SOUL, USER, etc.)
 * - ~/lobs/lobs-core/docs/ (project documentation)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { json } from "./index.js";

const HOME = process.env.HOME || "/Users/lobs";

interface KnowledgeRoot {
  label: string;
  root: string;
}

const ROOTS: KnowledgeRoot[] = [
  { label: "shared-memory", root: join(HOME, "lobs-shared-memory") },
  { label: "agent-context", root: join(HOME, ".lobs/agents/main/context") },
  { label: "lobs-docs", root: join(HOME, "lobs/lobs-core/docs") },
];

async function walkDir(
  dir: string,
  base: string,
  maxDepth = 4,
): Promise<Array<{ path: string; name: string; size: number; modified: string }>> {
  if (maxDepth <= 0) return [];
  const results: Array<{ path: string; name: string; size: number; modified: string }> = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "compliant") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await walkDir(full, base, maxDepth - 1)));
      } else if ([".md", ".txt", ".json"].includes(extname(entry.name))) {
        const s = await stat(full);
        results.push({
          path: relative(base, full),
          name: entry.name,
          size: s.size,
          modified: s.mtime.toISOString(),
        });
      }
    }
  } catch {}
  return results;
}

// Also collect top-level .md files from agent dir (SOUL.md, USER.md, etc.)
async function walkAgentRootDocs(): Promise<Array<{ path: string; name: string; size: number; modified: string }>> {
  const agentDir = join(HOME, ".lobs/agents/main");
  const results: Array<{ path: string; name: string; size: number; modified: string }> = [];
  try {
    const entries = await readdir(agentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && extname(entry.name) === ".md") {
        const full = join(agentDir, entry.name);
        const s = await stat(full);
        results.push({
          path: `agent-root/${entry.name}`,
          name: entry.name,
          size: s.size,
          modified: s.mtime.toISOString(),
        });
      }
    }
  } catch {}
  return results;
}

export async function handleKnowledgeFsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  parts: string[] = [],
): Promise<void> {
  if (sub === "list" || !sub) {
    // Aggregate files from all roots
    const allFiles: Array<{ path: string; name: string; size: number; modified: string; source: string }> = [];

    for (const { label, root } of ROOTS) {
      const files = await walkDir(root, root);
      for (const f of files) {
        allFiles.push({ ...f, source: label });
      }
    }

    // Also add top-level agent docs
    const agentDocs = await walkAgentRootDocs();
    for (const f of agentDocs) {
      allFiles.push({ ...f, source: "agent-root" });
    }

    // Sort by modified desc
    allFiles.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    return json(res, { roots: ROOTS.map(r => r.label), entries: allFiles });
  }

  if (sub === "read") {
    const filePath = parts.slice(2).join("/");
    if (!filePath || filePath.includes("..")) return json(res, { error: "invalid path" }, 400);

    // Check agent-root special prefix
    if (filePath.startsWith("agent-root/")) {
      const name = filePath.replace("agent-root/", "");
      try {
        const content = await readFile(join(HOME, ".lobs/agents/main", name), "utf-8");
        return json(res, { path: filePath, content });
      } catch {
        return json(res, { error: "not found" }, 404);
      }
    }

    // Try each root
    for (const { root } of ROOTS) {
      const full = join(root, filePath);
      if (!full.startsWith(root)) continue; // security check
      try {
        const content = await readFile(full, "utf-8");
        return json(res, { path: filePath, content });
      } catch {
        continue;
      }
    }
    return json(res, { error: "not found" }, 404);
  }

  return json(res, { error: "unknown" }, 404);
}
