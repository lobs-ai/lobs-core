/**
 * Structured memory search — queries the memories table in memory.db.
 *
 * This is separate from src/services/memory/search.ts (which searches documents).
 * This module searches structured memories extracted by the reconciler.
 *
 * Two search modes:
 *  - Fast:  FTS5 full-text search + recency scoring     (< 50ms)
 *  - Full:  FTS5 + vector similarity (cosine) via LM Studio (< 2s)
 */

import { getMemoryDb } from "./db.js";
import { log } from "../util/logger.js";
import { importanceScore } from "./gc.js";
import type { Memory } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const EMBED_URL = "http://localhost:1234/v1/embeddings";
const EMBED_MODEL = "text-embedding-qwen3-embedding-4b";
const EMBED_TIMEOUT_MS = 10_000;

// ── Public types ─────────────────────────────────────────────────────────────

export interface StructuredMemoryResult {
  memory: Memory;
  /** Combined relevance score (0–1) */
  score: number;
  matchType: "fts" | "vector" | "hybrid";
  evidenceCount: number;
}

// ── Confidence decay ─────────────────────────────────────────────────────────

const HALF_LIFE_DAYS: Record<string, number> = {
  decision: 365,
  learning: 180,
  pattern: 90,
  preference: 365,
};

/**
 * Apply exponential decay to a memory's confidence based on time since last
 * validation. Facts never decay.
 */
export function decayedConfidence(memory: Memory): number {
  if (memory.memory_type === "fact") return memory.confidence;

  const halfLife = HALF_LIFE_DAYS[memory.memory_type] ?? 180;
  const lastValidated = memory.last_validated ?? memory.derived_at;
  const daysSince =
    (Date.now() - new Date(lastValidated).getTime()) / (1000 * 60 * 60 * 24);

  return memory.confidence * Math.pow(0.5, daysSince / halfLife);
}

// ── Embedding helper ─────────────────────────────────────────────────────────

async function fetchQueryEmbedding(query: string): Promise<Float32Array | null> {
  try {
    const resp = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: query }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const raw = data.data?.[0]?.embedding;
    if (!raw || !Array.isArray(raw)) return null;

    return new Float32Array(raw);
  } catch {
    return null;
  }
}

/** Cosine similarity between two float arrays. Returns –1 to 1. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Access tracking (fire-and-forget) ────────────────────────────────────────

function trackAccess(
  memoryIds: number[],
  query: string,
  scores: Map<number, number>,
): void {
  setImmediate(() => {
    try {
      const db = getMemoryDb();
      const now = new Date().toISOString();

      const updateStmt = db.prepare(
        `UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?`,
      );
      const logStmt = db.prepare(
        `INSERT INTO retrieval_log (memory_id, query, score, timestamp) VALUES (?, ?, ?, ?)`,
      );

      const tx = db.transaction((ids: number[]) => {
        for (const id of ids) {
          updateStmt.run(now, id);
          logStmt.run(id, query, scores.get(id) ?? null, now);
        }
      });

      tx(memoryIds);
    } catch (err) {
      log().warn(`[memory-search] Access tracking failed: ${String(err)}`);
    }
  });
}

// ── Evidence count helper ────────────────────────────────────────────────────

function getEvidenceCounts(ids: number[]): Map<number, number> {
  if (ids.length === 0) return new Map();
  try {
    const db = getMemoryDb();
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT memory_id, COUNT(*) as cnt FROM evidence WHERE memory_id IN (${placeholders}) GROUP BY memory_id`,
      )
      .all(...ids) as Array<{ memory_id: number; cnt: number }>;
    return new Map(rows.map((r) => [r.memory_id, r.cnt]));
  } catch {
    return new Map();
  }
}

// ── Type weights ─────────────────────────────────────────────────────────────

/**
 * Score multipliers applied after FTS + vector scoring.
 * Episodic memories (distilled insights) score higher than raw document chunks.
 */
export const MEMORY_TYPE_WEIGHTS: Record<string, number> = {
  preference: 1.3,
  decision: 1.2,
  learning: 1.15,
  pattern: 1.1,
  fact: 1.0,
  document: 0.8,
};

// ── Shared filter builder ────────────────────────────────────────────────────

interface SearchOpts {
  maxResults?: number;
  memoryTypes?: string[];
  scope?: string;
  projectId?: string;
  minConfidence?: number;
  includeSuperseded?: boolean;
  includeDocuments?: boolean;
}

function buildWhereClause(
  opts: SearchOpts,
  ftsAlias: string,
): { where: string; bindings: unknown[] } {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  // Status filter
  if (!opts.includeSuperseded) {
    conditions.push(`${ftsAlias}.status = 'active'`);
  }

  // Confidence filter
  const minConf = opts.minConfidence ?? 0.3;
  conditions.push(`${ftsAlias}.confidence >= ?`);
  bindings.push(minConf);

  if (opts.memoryTypes && opts.memoryTypes.length > 0) {
    const ph = opts.memoryTypes.map(() => "?").join(",");
    conditions.push(`${ftsAlias}.memory_type IN (${ph})`);
    bindings.push(...opts.memoryTypes);
  }

  if (opts.scope) {
    conditions.push(`${ftsAlias}.scope = ?`);
    bindings.push(opts.scope);
  }

  if (opts.projectId) {
    conditions.push(`${ftsAlias}.project_id = ?`);
    bindings.push(opts.projectId);
  }

  if (opts.includeDocuments === false) {
    conditions.push(`${ftsAlias}.memory_type != 'document'`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    bindings,
  };
}

// ── Fast path: FTS5 + recency ─────────────────────────────────────────────────

/**
 * Fast structured memory search using FTS5 full-text index and recency scoring.
 *
 * Score = FTS5_rank_normalized * 0.6 + confidence * 0.2 + recency * 0.2
 * Target: < 50ms
 */
export async function searchMemoriesFast(
  query: string,
  opts: SearchOpts = {},
): Promise<StructuredMemoryResult[]> {
  const maxResults = opts.maxResults ?? 10;

  try {
    const db = getMemoryDb();
    const { where, bindings } = buildWhereClause(opts, "m");

    // FTS5 rank is negative (lower = better match); we negate to get positive score
    const rows = db
      .prepare(
        `SELECT m.*, (-fts.rank) AS fts_rank
         FROM memories m
         JOIN memories_fts fts ON fts.rowid = m.id
         WHERE memories_fts MATCH ?
           ${where ? "AND " + where.replace("WHERE ", "") : ""}
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(query, ...bindings, maxResults * 3) as Array<
      Memory & { fts_rank: number }
    >;

    if (rows.length === 0) return [];

    // Normalize FTS rank to 0-1
    const maxRank = Math.max(...rows.map((r) => r.fts_rank));

    const scored = rows.map((row) => {
      const ftsNorm = maxRank > 0 ? row.fts_rank / maxRank : 0;
      const decayed = decayedConfidence(row);
      const importance = importanceScore(row);
      // importance (decayed confidence + access floor) replaces the raw
      // confidence + recency signals, giving 40% weight to lifecycle-aware ranking
      const typeWeight = MEMORY_TYPE_WEIGHTS[row.memory_type] ?? 1.0;
      const score = (ftsNorm * 0.6 + importance * 0.4) * typeWeight;
      return { row, score, decayed };
    });

    // Sort and take top maxResults
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, maxResults);

    const ids = top.map((t) => t.row.id);
    const evidenceCounts = getEvidenceCounts(ids);
    const scoreMap = new Map(top.map((t) => [t.row.id, t.score]));

    // Fire-and-forget access tracking
    trackAccess(ids, query, scoreMap);

    return top.map(({ row, score }) => ({
      memory: row,
      score: Math.max(0, Math.min(1, score)),
      matchType: "fts" as const,
      evidenceCount: evidenceCounts.get(row.id) ?? 0,
    }));
  } catch (err) {
    log().warn(`[memory-search] Fast search failed: ${String(err)}`);
    return [];
  }
}

// ── Slow path: FTS5 + vector ──────────────────────────────────────────────────

/**
 * Full structured memory search combining FTS5 and vector (cosine) similarity.
 *
 * Target: < 2s
 */
export async function searchMemoriesFull(
  query: string,
  opts: SearchOpts = {},
): Promise<StructuredMemoryResult[]> {
  const maxResults = opts.maxResults ?? 10;

  try {
    const db = getMemoryDb();
    const { where, bindings } = buildWhereClause(opts, "m");

    // ── FTS5 results ──────────────────────────────────────────────────────
    let ftsRows: Array<Memory & { fts_rank: number }> = [];
    try {
      ftsRows = db
        .prepare(
          `SELECT m.*, (-fts.rank) AS fts_rank
           FROM memories m
           JOIN memories_fts fts ON fts.rowid = m.id
           WHERE memories_fts MATCH ?
             ${where ? "AND " + where.replace("WHERE ", "") : ""}
           ORDER BY fts.rank
           LIMIT ?`,
        )
        .all(query, ...bindings, maxResults * 5) as Array<
        Memory & { fts_rank: number }
      >;
    } catch {
      // FTS5 might fail if the query contains special characters
    }

    // ── Vector results ────────────────────────────────────────────────────
    const queryEmbedding = await fetchQueryEmbedding(query);

    const vectorScores = new Map<number, number>();

    if (queryEmbedding) {
      // Load all embeddings (at most a few hundred memories)
      const embRows = db
        .prepare(
          `SELECT me.memory_id, me.embedding
           FROM memory_embeddings me
           JOIN memories m ON m.id = me.memory_id
           ${where}`,
        )
        .all(...bindings) as Array<{ memory_id: number; embedding: Buffer }>;

      for (const { memory_id, embedding } of embRows) {
        const vec = new Float32Array(
          embedding.buffer,
          embedding.byteOffset,
          embedding.byteLength / 4,
        );
        const sim = cosineSimilarity(queryEmbedding, vec);
        vectorScores.set(memory_id, (sim + 1) / 2); // normalize –1..1 → 0..1
      }
    }

    // ── Merge + deduplicate ───────────────────────────────────────────────
    // Collect unique memory IDs
    const memoryIds = new Set<number>([
      ...ftsRows.map((r) => r.id),
      ...vectorScores.keys(),
    ]);

    if (memoryIds.size === 0) return [];

    // Load all candidate memories
    const idList = [...memoryIds];
    const placeholders = idList.map(() => "?").join(",");
    const allMemories = db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...idList) as Memory[];

    // Build FTS rank map
    const maxFtsRank = ftsRows.length
      ? Math.max(...ftsRows.map((r) => r.fts_rank))
      : 1;
    const ftsScores = new Map(
      ftsRows.map((r) => [r.id, maxFtsRank > 0 ? r.fts_rank / maxFtsRank : 0]),
    );

    // Score each memory
    const scored = allMemories.map((m) => {
      const ftsNorm = ftsScores.get(m.id) ?? 0;
      const vecNorm = vectorScores.get(m.id) ?? 0;
      const isVector = vecNorm > 0;
      const isFts = ftsNorm > 0;

      // Base score: weight FTS and vector
      let score = ftsNorm * 0.5 + vecNorm * 0.5;
      if (isFts && !isVector) score = ftsNorm * 0.8;
      if (!isFts && isVector) score = vecNorm * 0.8;

      // Lifecycle-aware importance replaces raw confidence + recency bonuses,
      // giving 40% weight to memories that are well-accessed and recently relevant
      const importance = importanceScore(m);
      score += importance * 0.4;

      // Apply per-type multiplier before normalization
      const typeWeight = MEMORY_TYPE_WEIGHTS[m.memory_type] ?? 1.0;
      score = score * typeWeight;

      const matchType: StructuredMemoryResult["matchType"] =
        isFts && isVector ? "hybrid" : isFts ? "fts" : "vector";

      return { memory: m, score: Math.min(score, 1), matchType };
    });

    // Sort descending
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, maxResults);

    const topIds = top.map((t) => t.memory.id);
    const evidenceCounts = getEvidenceCounts(topIds);
    const scoreMap = new Map(top.map((t) => [t.memory.id, t.score]));

    trackAccess(topIds, query, scoreMap);

    return top.map(({ memory, score, matchType }) => ({
      memory,
      score,
      matchType,
      evidenceCount: evidenceCounts.get(memory.id) ?? 0,
    }));
  } catch (err) {
    log().warn(`[memory-search] Full search failed: ${String(err)}`);
    return [];
  }
}
