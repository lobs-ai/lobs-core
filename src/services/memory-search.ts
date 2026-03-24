/**
 * @deprecated Use memory-client.ts instead.
 * This module is kept for backward compatibility but all new consumers
 * should import from memory-client.ts which adds health tracking,
 * connection backoff, and a unified API.
 *
 * Memory search bridge — tries HTTP first, falls back to grep.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const MEMORY_SERVER = "http://localhost:7420";
const HOME = process.env.HOME ?? "";

// Collections to search (mirrors memory/config.json)
const SEARCH_DIRS = [
  resolve(HOME, ".lobs/agents"),
  resolve(HOME, "lobs/lobs-shared-memory"),
  resolve(HOME, "lobs/lobs-core"),
  resolve(HOME, "paw/bot-shared"),
  resolve(HOME, "paw/paw-hub"),
  resolve(HOME, "paw/paw-designs"),
];

export interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  citation: string;
}

/**
 * Try HTTP search first, fall back to file grep
 */
export async function memorySearch(
  query: string,
  maxResults: number = 8,
  collections?: string[],
  context?: string,
): Promise<{ results: SearchResult[]; source: "server" | "grep"; timeMs: number }> {
  const start = Date.now();
  
  // Try HTTP first
  try {
    const body: Record<string, unknown> = { query, maxResults };
    if (collections?.length) body.collections = collections;
    if (context) body.conversationContext = context;
    
    const response = await fetch(`${MEMORY_SERVER}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000), // 5s timeout
    });
    
    if (response.ok) {
      const data = await response.json() as { results: SearchResult[] };
      return { results: data.results || [], source: "server", timeMs: Date.now() - start };
    }
  } catch {
    // Server not available, fall through to grep
  }

  // Fallback: grep-based search
  const results = grepSearch(query, maxResults);
  return { results, source: "grep", timeMs: Date.now() - start };
}

/**
 * Batch search — multiple queries in one HTTP round-trip.
 * Falls back to sequential memorySearch calls if server is down.
 */
export interface BatchSearchItem {
  id: string;
  query: string;
  maxResults?: number;
  collections?: string[];
  conversationContext?: string;
}

export async function memorySearchBatch(
  searches: BatchSearchItem[],
): Promise<{
  results: Record<string, SearchResult[]>;
  source: "server" | "grep";
  timeMs: number;
}> {
  const start = Date.now();

  // Try batch HTTP endpoint
  try {
    const response = await fetch(`${MEMORY_SERVER}/search/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searches }),
      signal: AbortSignal.timeout(10_000), // 10s for batch
    });

    if (response.ok) {
      const data = await response.json() as {
        results: Record<string, { results: SearchResult[] }>;
      };
      // Flatten: extract .results from each SearchResponse
      const flat: Record<string, SearchResult[]> = {};
      for (const [id, sr] of Object.entries(data.results)) {
        flat[id] = sr.results || [];
      }
      return { results: flat, source: "server", timeMs: Date.now() - start };
    }
  } catch {
    // Server not available, fall through
  }

  // Fallback: sequential grep searches
  const results: Record<string, SearchResult[]> = {};
  for (const item of searches) {
    const { results: r } = await memorySearch(item.query, item.maxResults ?? 8, item.collections, item.conversationContext);
    results[item.id] = r;
  }
  return { results, source: "grep", timeMs: Date.now() - start };
}

/**
 * Simple but effective grep fallback
 */
function grepSearch(query: string, maxResults: number): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const results: Array<SearchResult & { matchCount: number }> = [];
  
  for (const dir of SEARCH_DIRS) {
    try {
      walkDir(dir, (filePath) => {
        if (!filePath.endsWith(".md")) return;
        try {
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          
          // Score each chunk of ~10 lines
          for (let i = 0; i < lines.length; i += 8) {
            const chunk = lines.slice(i, i + 12).join("\n").toLowerCase();
            const matchCount = terms.filter(t => chunk.includes(t)).length;
            if (matchCount >= Math.min(2, terms.length)) {
              results.push({
                path: filePath,
                startLine: i + 1,
                endLine: Math.min(i + 12, lines.length),
                score: matchCount / terms.length,
                snippet: lines.slice(i, i + 8).join("\n"),
                citation: `${filePath}#${i + 1}`,
                matchCount,
              });
            }
          }
        } catch { /* skip unreadable files */ }
      });
    } catch { /* skip inaccessible dirs */ }
  }
  
  // Sort by match score, return top N
  results.sort((a, b) => b.matchCount - a.matchCount);
  return results.slice(0, maxResults);
}

function walkDir(dir: string, callback: (path: string) => void, depth = 0): void {
  if (depth > 4) return; // Don't recurse too deep
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build") continue;
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walkDir(full, callback, depth + 1);
        else if (stat.isFile()) callback(full);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}
