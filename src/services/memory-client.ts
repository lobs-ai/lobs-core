/**
 * Unified memory search client — single interface for all memory consumers.
 *
 * Primary: in-process calls to src/services/memory/ (no HTTP, no network overhead).
 * Fallback: grep search when memory service isn't initialized yet (early startup).
 *
 * Replaces the old HTTP-based client that talked to localhost:7420.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Types (re-exported from in-process module) ───────────────────────────────

import type {
  SearchRequest as _SearchRequest,
  SearchResponse as _SearchResponse,
  SearchResult,
  BatchSearchItem,
  HealthResponse as _HealthResponse,
} from "./memory/index.js";

export type { _SearchRequest as SearchRequest, _SearchResponse as SearchResponse, _HealthResponse as HealthResponse };
export type { SearchResult, BatchSearchItem };

// Re-export HealthStatus for backward compatibility with existing consumers
export interface HealthStatus {
  status: "ok" | "degraded" | "error" | "down";
  uptime?: number;
  documents?: number;
  chunks?: number;
}

// ── Configuration ────────────────────────────────────────────────────────────

// Grep fallback dirs
const HOME = process.env.HOME ?? "";
const SEARCH_DIRS = [
  resolve(HOME, ".lobs/agents"),
  resolve(HOME, "lobs/lobs-shared-memory"),
  resolve(HOME, "lobs/lobs-core"),
  resolve(HOME, "paw/bot-shared"),
  resolve(HOME, "paw/paw-hub"),
  resolve(HOME, "paw/paw-designs"),
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Search memory. Uses in-process engine when available, falls back to grep.
 */
export async function memorySearch(
  query: string,
  options: {
    maxResults?: number;
    minScore?: number;
    collections?: string[];
    conversationContext?: string;
    entityFilter?: { type: string; value: string };
  } = {},
): Promise<{ results: SearchResult[]; source: "server" | "grep"; timeMs: number }> {
  const start = Date.now();

  // Try in-process search
  try {
    const { isMemoryReady, searchMemory } = await import("./memory/index.js");
    if (isMemoryReady()) {
      const response = await searchMemory({
        query,
        maxResults: options.maxResults ?? 8,
        ...options,
      });
      return {
        results: response.results || [],
        source: "server",
        timeMs: Date.now() - start,
      };
    }
  } catch (err) {
    console.warn(`[memory-client] In-process search failed, falling back to grep: ${err}`);
  }

  // Fallback: grep
  const results = grepSearch(query, options.maxResults ?? 8);
  return { results, source: "grep", timeMs: Date.now() - start };
}

/**
 * Batch search — multiple queries. Uses in-process batch when available.
 */
export async function memorySearchBatch(
  searches: BatchSearchItem[],
): Promise<{
  results: Record<string, SearchResult[]>;
  source: "server" | "grep";
  timeMs: number;
}> {
  const start = Date.now();

  // Try in-process batch search
  try {
    const { isMemoryReady, searchMemoryBatch } = await import("./memory/index.js");
    if (isMemoryReady()) {
      const response = await searchMemoryBatch(searches);
      const flat: Record<string, SearchResult[]> = {};
      for (const [id, sr] of Object.entries(response.results)) {
        flat[id] = sr.results || [];
      }
      return { results: flat, source: "server", timeMs: Date.now() - start };
    }
  } catch (err) {
    console.warn(`[memory-client] In-process batch search failed, falling back to grep: ${err}`);
  }

  // Fallback: sequential grep
  const results: Record<string, SearchResult[]> = {};
  for (const item of searches) {
    results[item.id] = grepSearch(item.query, item.maxResults ?? 8);
  }
  return { results, source: "grep", timeMs: Date.now() - start };
}

/**
 * Check memory health. Uses in-process health when available.
 */
export async function getHealth(): Promise<HealthStatus> {
  try {
    const { isMemoryReady, getMemoryHealth } = await import("./memory/index.js");
    if (isMemoryReady()) {
      const health = await getMemoryHealth();
      return {
        status: health.status,
        uptime: health.uptime,
        documents: health.index.documents,
        chunks: health.index.chunks,
      };
    }
  } catch {
    // Fall through
  }
  return { status: "down" };
}

/**
 * Check if the memory service is available.
 */
export async function isServerUp(): Promise<boolean> {
  try {
    const { isMemoryReady } = await import("./memory/index.js");
    return isMemoryReady();
  } catch {
    return false;
  }
}

/**
 * Trigger a re-index.
 */
export async function triggerReindex(): Promise<boolean> {
  try {
    const { isMemoryReady, forceReindex } = await import("./memory/index.js");
    if (isMemoryReady()) {
      await forceReindex();
      return true;
    }
  } catch {
    // Fall through
  }
  return false;
}

/**
 * Reset client state. No-op for in-process mode (kept for API compatibility).
 */
export function resetClient(): void {
  // Nothing to reset — no HTTP connection state
}

// ── Grep Fallback ────────────────────────────────────────────────────────────

function grepSearch(query: string, maxResults: number): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return [];

  const results: Array<SearchResult & { matchCount: number }> = [];

  for (const dir of SEARCH_DIRS) {
    try {
      walkDir(dir, (filePath) => {
        if (!filePath.endsWith(".md")) return;
        try {
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n");

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
                source: "grep",
                citation: `${filePath}#${i + 1}`,
                matchCount,
              });
            }
          }
        } catch { /* skip unreadable */ }
      });
    } catch { /* skip inaccessible */ }
  }

  results.sort((a, b) => b.matchCount - a.matchCount);
  return results.slice(0, maxResults);
}

function walkDir(dir: string, callback: (path: string) => void, depth = 0): void {
  if (depth > 4) return;
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
