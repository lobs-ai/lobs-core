/**
 * Knowledge API — aggregates knowledge from multiple sources:
 * - ~/lobs-shared-memory/ (learnings, ADRs, research)
 * - ~/.lobs/agents/main/context/ (agent docs, PROJECT files)
 * - ~/lobs/lobs-core/docs/ (project documentation)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";
import { json, parseQuery } from "./index.js";
import { getAgentContextDir } from "../config/lobs.js";

const HOME = process.env.HOME || "/Users/lobs";

interface KnowledgeSource {
  root: string;
  category: string;
}

const SOURCES: KnowledgeSource[] = [
  { root: join(HOME, "lobs-shared-memory"), category: "learnings" },
  { root: getAgentContextDir("main"), category: "agent-docs" },
  { root: join(HOME, "lobs/lobs-core/docs"), category: "docs" },
];

interface KnowledgeEntry {
  path: string;
  name: string;
  category: string;
  source: string;
  size: number;
  modified: string;
  preview?: string;
}

function categorize(filePath: string, defaultCat: string): string {
  const lower = filePath.toLowerCase();
  if (lower.includes("adr") || lower.includes("decision")) return "decisions";
  if (lower.includes("project-")) return "architecture";
  if (lower.includes("learning")) return "learnings";
  if (lower.includes("research")) return "research";
  if (lower.includes("memory/")) return "memory";
  return defaultCat;
}

async function scanDir(root: string, category: string): Promise<KnowledgeEntry[]> {
  const entries: KnowledgeEntry[] = [];
  try {
    await scanRecursive(root, root, category, entries, 3);
  } catch {
    // Source directory might not exist
  }
  return entries;
}

async function scanRecursive(
  base: string,
  dir: string,
  category: string,
  entries: KnowledgeEntry[],
  maxDepth: number,
): Promise<void> {
  if (maxDepth <= 0) return;
  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return;
  }
  for (const name of items) {
    if (name.startsWith(".") || name === "node_modules" || name === "compliant") continue;
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        await scanRecursive(base, full, category, entries, maxDepth - 1);
      } else if (s.isFile() && /\.(md|txt|json)$/i.test(name)) {
        const rel = relative(base, full);
        let preview = "";
        try {
          const content = await readFile(full, "utf-8");
          // First non-empty, non-heading line as preview
          const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
          preview = (lines[0] || "").slice(0, 200);
        } catch { /* skip preview */ }
        entries.push({
          path: rel,
          name: basename(name, extname(name)),
          category: categorize(rel, category),
          source: relative(HOME, base),
          size: s.size,
          modified: s.mtime.toISOString(),
          preview,
        });
      }
    } catch {
      continue;
    }
  }
}

export async function handleKnowledgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string | undefined,
  parts: string[],
): Promise<void> {
  const q = parseQuery(req.url ?? "");

  // GET /api/knowledge/feed — recent knowledge across all sources
  if (sub === "feed") {
    const all: KnowledgeEntry[] = [];
    for (const src of SOURCES) {
      all.push(...await scanDir(src.root, src.category));
    }
    all.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    const limit = parseInt(q.limit ?? "50", 10);
    return json(res, { entries: all.slice(0, limit), total: all.length });
  }

  // GET /api/knowledge/content?path=...&source=...
  if (sub === "content") {
    const path = q.path ?? "";
    const source = q.source ?? "";
    if (!path) return json(res, { path: "", content: "" });
    // Find the source root
    const sourceRoot = SOURCES.find(s => relative(HOME, s.root) === source)?.root;
    if (!sourceRoot) return json(res, { path, content: "Source not found" });
    try {
      const full = join(sourceRoot, path);
      // Security: ensure we stay within the source root
      if (!full.startsWith(sourceRoot)) return json(res, { path, content: "Access denied" });
      const content = await readFile(full, "utf-8");
      return json(res, { path, content });
    } catch {
      return json(res, { path, content: "File not found" });
    }
  }

  // POST /api/knowledge/sync — no-op for now
  if (sub === "sync" && req.method === "POST") {
    return json(res, { synced: 0 });
  }

  // GET /api/knowledge — browse all knowledge
  const search = (q.search ?? "").toLowerCase();
  const all: KnowledgeEntry[] = [];
  for (const src of SOURCES) {
    all.push(...await scanDir(src.root, src.category));
  }
  
  const filtered = search
    ? all.filter(e => e.name.toLowerCase().includes(search) || e.path.toLowerCase().includes(search) || (e.preview?.toLowerCase().includes(search)))
    : all;
  
  filtered.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return json(res, { entries: filtered, path: q.path || null, total: filtered.length });
}
