/**
 * Memories API — reads from agent workspaces (~/.openclaw/workspace-{agent}/memory/).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { json } from "./index.js";

const WORKSPACE_BASE = join(process.env.HOME || "/Users/lobs", ".openclaw");
const AGENTS = ["programmer", "writer", "researcher", "reviewer", "architect"];

interface MemoryEntry {
  agent: string;
  file: string;
  content: string;
  modified: string;
  size: number;
}

async function readAgentMemories(agent: string): Promise<MemoryEntry[]> {
  const memDir = join(WORKSPACE_BASE, `workspace-${agent}`, "memory");
  const results: MemoryEntry[] = [];
  try {
    const files = await readdir(memDir);
    for (const f of files) {
      if (!f.endsWith(".md") && !f.endsWith(".txt")) continue;
      const full = join(memDir, f);
      try {
        const [content, s] = await Promise.all([readFile(full, "utf-8"), stat(full)]);
        results.push({ agent, file: f, content, modified: s.mtime.toISOString(), size: s.size });
      } catch {}
    }
  } catch {}
  return results;
}

export async function handleMemoriesFsRequest(req: IncomingMessage, res: ServerResponse, sub?: string): Promise<void> {
  if (sub && AGENTS.includes(sub)) {
    const memories = await readAgentMemories(sub);
    return json(res, { agent: sub, memories });
  }
  // All agents
  const all: MemoryEntry[] = [];
  for (const agent of AGENTS) {
    all.push(...(await readAgentMemories(agent)));
  }
  all.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return json(res, { memories: all });
}
