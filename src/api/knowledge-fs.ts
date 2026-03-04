/**
 * Knowledge API — reads from ~/lobs-shared-memory (cross-project docs, ADRs, research).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { json } from "./index.js";

const SHARED_MEMORY = join(process.env.HOME || "/Users/lobs", "lobs-shared-memory");

async function walkDir(dir: string, base: string): Promise<Array<{ path: string; name: string; size: number; modified: string }>> {
  const results: Array<{ path: string; name: string; size: number; modified: string }> = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await walkDir(full, base)));
      } else if ([".md", ".txt", ".json"].includes(extname(entry.name))) {
        const s = await stat(full);
        results.push({ path: relative(base, full), name: entry.name, size: s.size, modified: s.mtime.toISOString() });
      }
    }
  } catch {}
  return results;
}

export async function handleKnowledgeFsRequest(req: IncomingMessage, res: ServerResponse, sub?: string, parts: string[] = []): Promise<void> {
  if (sub === "list" || !sub) {
    const files = await walkDir(SHARED_MEMORY, SHARED_MEMORY);
    return json(res, { root: SHARED_MEMORY, entries: files });
  }
  if (sub === "read") {
    const filePath = parts.slice(2).join("/");
    if (!filePath || filePath.includes("..")) return json(res, { error: "invalid path" }, 400);
    try {
      const content = await readFile(join(SHARED_MEMORY, filePath), "utf-8");
      return json(res, { path: filePath, content });
    } catch {
      return json(res, { error: "not found" }, 404);
    }
  }
  return json(res, { error: "unknown" }, 404);
}
