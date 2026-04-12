/**
 * Memory consolidation — merges near-duplicate active memories.
 *
 * Should be run on a less frequent schedule than reflection (daily or manual),
 * NOT in the hot path of reflection.
 *
 * Algorithm:
 *  1. Load all active memories with their stored embeddings.
 *  2. Pair-wise cosine similarity; group memories with similarity > 0.8.
 *  3. For each group of 2+ similar memories, ask Haiku to produce a single
 *     merged memory that captures the essential information.
 *  4. Insert the merged memory with the highest confidence/authority from the group.
 *  5. Mark originals as `superseded`.
 *  6. Return stats: { groupsFound, memoriesMerged, memoriesCreated }.
 */

import { getMemoryDb } from "./db.js";
import { parseModelString, createClient } from "../runner/providers.js";
import { log } from "../util/logger.js";
import { getModelForTier } from "../config/models.js";
import type { Memory } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const CONSOLIDATION_MODEL = getModelForTier("small");
const SIMILARITY_THRESHOLD = 0.75;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConsolidationStats {
  groupsFound: number;
  memoriesMerged: number;
  memoriesCreated: number;
}

interface MemoryWithEmbedding {
  memory: Memory;
  embedding: Float32Array | null;
}

// ── Embedding helpers ─────────────────────────────────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

function bufferToFloat32Array(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab as ArrayBuffer);
}

// ── LLM merge ────────────────────────────────────────────────────────────────

async function mergeMemories(contents: string[]): Promise<string | null> {
  const systemPrompt =
    `You are a memory consolidation assistant. Given several similar memory statements, ` +
    `produce a single concise merged statement (1-3 sentences) that captures all essential ` +
    `information without repetition. Output ONLY the merged text — no prose, no labels.`;

  const userPrompt =
    `Merge these memories into one:\n` +
    contents.map((c, i) => `${i + 1}. ${c.slice(0, 400)}`).join("\n");

  try {
    const config = parseModelString(CONSOLIDATION_MODEL);
    const client = await createClient(config);

    const response = await client.createMessage({
      model: config.modelId,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [],
      maxTokens: 256,
    });

    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();

    return text.length > 0 ? text : null;
  } catch (err) {
    log().warn(`[consolidation] mergeMemories failed: ${String(err)}`);
    return null;
  }
}

// ── Group detection ───────────────────────────────────────────────────────────

/**
 * Union-find to group memories into connected components where any two
 * members in the group have similarity > SIMILARITY_THRESHOLD.
 */
function findSimilarGroups(items: MemoryWithEmbedding[]): number[][] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }

  function union(x: number, y: number): void {
    parent[find(x)] = find(y);
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const eA = items[i].embedding;
      const eB = items[j].embedding;
      if (!eA || !eB) continue;
      const sim = cosineSimilarity(eA, eB);
      if (sim >= SIMILARITY_THRESHOLD) {
        union(i, j);
      }
    }
  }

  // Collect groups (only those with 2+ members)
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  return Array.from(groups.values()).filter((g) => g.length >= 2);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Consolidate near-duplicate active memories.
 *
 * Safe to run concurrently — reads all memories up-front, then writes in a
 * transaction per group. A failure in one group is logged and skipped.
 */
export async function consolidateMemories(): Promise<ConsolidationStats> {
  const db = getMemoryDb();
  const stats: ConsolidationStats = { groupsFound: 0, memoriesMerged: 0, memoriesCreated: 0 };

  // ── 1. Load all active memories with stored embeddings ──────────────────────
  const rows = db
    .prepare(
      `SELECT m.*, me.embedding
       FROM memories m
       LEFT JOIN memory_embeddings me ON me.memory_id = m.id
       WHERE m.status = 'active'`,
    )
    .all() as Array<Memory & { embedding: Buffer | null }>;

  if (rows.length < 2) {
    log().info("[consolidation] Not enough active memories to consolidate.");
    return stats;
  }

  const items: MemoryWithEmbedding[] = rows.map((r) => ({
    memory: r as Memory,
    embedding: r.embedding ? bufferToFloat32Array(r.embedding) : null,
  }));

  log().info(`[consolidation] Loaded ${items.length} active memories, scanning for duplicates…`);

  // ── 2. Find similarity groups ──────────────────────────────────────────────
  const groups = findSimilarGroups(items);
  stats.groupsFound = groups.length;

  if (groups.length === 0) {
    log().info("[consolidation] No near-duplicate groups found.");
    return stats;
  }

  log().info(`[consolidation] Found ${groups.length} group(s) to consolidate.`);

  // ── 3-5. For each group: merge via LLM, insert merged, supersede originals ─
  for (const group of groups) {
    const groupMemories = group.map((idx) => items[idx].memory);
    const contents = groupMemories.map((m) => m.content);

    const merged = await mergeMemories(contents);
    if (!merged) {
      log().warn(
        `[consolidation] Skipping group [${groupMemories.map((m) => m.id).join(", ")}] — LLM merge failed.`,
      );
      continue;
    }

    // Pick the best title, confidence, authority from the group
    const bestConfidence = Math.max(...groupMemories.map((m) => m.confidence));
    const bestAuthority = Math.max(...groupMemories.map((m) => m.source_authority));
    const bestTitle =
      groupMemories.find((m) => m.title)?.title ??
      `Consolidated: ${merged.slice(0, 40)}…`;

    // Pick the most common memory_type from the group
    const typeCounts = new Map<string, number>();
    for (const m of groupMemories) {
      typeCounts.set(m.memory_type, (typeCounts.get(m.memory_type) ?? 0) + 1);
    }
    const bestType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const now = new Date().toISOString();

    try {
      db.transaction(() => {
        // Insert merged memory
        const insert = db.prepare(
          `INSERT INTO memories
             (memory_type, title, content, confidence, scope, source_authority,
              status, derived_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        );

        const info = insert.run(
          bestType,
          bestTitle,
          merged,
          bestConfidence,
          groupMemories[0].scope,
          bestAuthority,
          now,
          now,
          now,
        );

        const newId = info.lastInsertRowid as number;

        // Mark originals as superseded
        const supersede = db.prepare(
          `UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`,
        );
        for (const m of groupMemories) {
          supersede.run(newId, now, m.id);
        }
      })();

      stats.memoriesMerged += groupMemories.length;
      stats.memoriesCreated += 1;

      log().info(
        `[consolidation] Merged group [${groupMemories.map((m) => m.id).join(", ")}] → new memory`,
      );
    } catch (err) {
      log().warn(
        `[consolidation] Transaction failed for group [${groupMemories.map((m) => m.id).join(", ")}]: ${String(err)}`,
      );
    }
  }

  return stats;
}
