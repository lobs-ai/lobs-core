/**
 * Memory reconciler — deduplicates extracted candidates against the DB.
 *
 * Similarity check uses the LM Studio embedding endpoint (same model used by
 * lobs-memory). Falls back to normalized Levenshtein distance if unavailable.
 *
 * All DB writes use transactions. Never crashes.
 */

import { getMemoryDb } from "./db.js";
import { log } from "../util/logger.js";
import { parseModelString, createClient } from "../runner/providers.js";
import { getModelForTier } from "../config/models.js";
import type { MemoryCandidate } from "./extractor.js";
import type { Memory, Conflict } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const CLASSIFICATION_MODEL = getModelForTier("small");
const CLASSIFICATION_MAX_TOKENS = 16;

const EMBED_URL = "http://localhost:1234/v1/embeddings";
const EMBED_MODEL = "text-embedding-qwen3-embedding-4b";
const EMBED_TIMEOUT_MS = 15_000;

/** Similarity above this → reinforce existing memory */
const REINFORCE_THRESHOLD = 0.9;
/** Similarity above this → potential conflict zone (LLM classifies relationship) */
const CONFLICT_THRESHOLD = 0.55;
/** Confidence bump on reinforce */
const REINFORCE_BUMP = 0.05;

// ── Embedding ────────────────────────────────────────────────────────────────

async function fetchEmbedding(text: string): Promise<Float32Array | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

  try {
    const response = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const raw = data.data?.[0]?.embedding;
    if (!raw || !Array.isArray(raw)) return null;

    return new Float32Array(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Cosine similarity between two float arrays. Returns -1 to 1. */
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

// ── Text similarity fallback ─────────────────────────────────────────────────

/** Normalized Levenshtein distance → similarity (0–1). */
function levenshteinSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();

  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  // Quick substring check
  if (s1.includes(s2) || s2.includes(s1)) {
    return Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
  }

  const m = s1.length;
  const n = s2.length;

  // For long strings, use word-overlap similarity to avoid O(m*n) blow-up
  if (m > 300 || n > 300) {
    const words1 = new Set(s1.split(/\s+/));
    const words2 = new Set(s2.split(/\s+/));
    let overlap = 0;
    for (const w of words1) if (words2.has(w)) overlap++;
    return (2 * overlap) / (words1.size + words2.size);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return 1 - dp[m][n] / Math.max(m, n);
}

// ── Relationship classification ───────────────────────────────────────────────

export type RelationshipClass = "duplicate" | "update" | "contradiction" | "complementary";

/**
 * Use Claude Haiku to classify the relationship between two memories.
 *
 * - duplicate: same information, different words → reinforce existing
 * - update: newer info supersedes older → create new, supersede old
 * - contradiction: genuinely conflicting claims → create conflict
 * - complementary: related but distinct info → both are fine, create new
 *
 * Falls back to "complementary" on any error so we never crash or drop data.
 */
export async function classifyRelationship(
  existing: string,
  candidate: string,
): Promise<RelationshipClass> {
  const systemPrompt =
    `Classify the relationship between two memory statements. ` +
    `Reply with exactly one word: duplicate, update, contradiction, or complementary.\n` +
    `duplicate = same info, different words. ` +
    `update = candidate supersedes existing. ` +
    `contradiction = genuinely conflicting. ` +
    `complementary = related but distinct.`;

  const userPrompt =
    `Existing: "${existing.slice(0, 300)}"\nCandidate: "${candidate.slice(0, 300)}"`;

  try {
    const config = parseModelString(CLASSIFICATION_MODEL);
    const client = await createClient(config);

    const response = await client.createMessage({
      model: config.modelId,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [],
      maxTokens: CLASSIFICATION_MAX_TOKENS,
    });

    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .toLowerCase()
      .trim();

    if (text.startsWith("duplicate")) return "duplicate";
    if (text.startsWith("update")) return "update";
    if (text.startsWith("contradiction")) return "contradiction";
    if (text.startsWith("complementary")) return "complementary";

    log().warn(`[reconciler] Unexpected classification response: "${text}" — defaulting to complementary`);
    return "complementary";
  } catch (err) {
    log().warn(`[reconciler] classifyRelationship failed: ${String(err)} — defaulting to complementary`);
    return "complementary";
  }
}

// ── DB helpers ───────────────────────────────────────────────────────────────

interface ExistingMemoryWithEmbedding {
  memory: Memory;
  embedding: Float32Array | null;
  content: string;
}

function loadExistingMemories(): ExistingMemoryWithEmbedding[] {
  const db = getMemoryDb();

  const rows = db
    .prepare(
      `SELECT m.*, me.embedding FROM memories m
       LEFT JOIN memory_embeddings me ON me.memory_id = m.id
       WHERE m.status = 'active'`,
    )
    .all() as Array<Memory & { embedding: Buffer | null }>;

  return rows.map((row) => {
    let embedding: Float32Array | null = null;
    if (row.embedding) {
      // better-sqlite3 returns BLOBs as Buffer
      embedding = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
    }
    return { memory: row, embedding, content: row.content };
  });
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface ReconciliationResult {
  newMemories: Memory[];
  reinforcedMemories: Memory[];
  conflicts: Conflict[];
}

// ── Main reconciliation ──────────────────────────────────────────────────────

export async function reconcile(
  candidates: MemoryCandidate[],
  reflectionRunId: string,
): Promise<ReconciliationResult> {
  if (candidates.length === 0) {
    return { newMemories: [], reinforcedMemories: [], conflicts: [] };
  }

  const db = getMemoryDb();
  const result: ReconciliationResult = {
    newMemories: [],
    reinforcedMemories: [],
    conflicts: [],
  };

  let newMemoryCount = 0;
  const MAX_NEW_PER_CLUSTER = 5;

  // Load existing memories once
  const existing = loadExistingMemories();

  for (const candidate of candidates) {
    if (newMemoryCount >= MAX_NEW_PER_CLUSTER) break;

    // Get embedding for candidate
    const candidateEmbedding = await fetchEmbedding(candidate.content);
    const useEmbeddings = candidateEmbedding !== null;

    // Find best-matching existing memory
    let bestSimilarity = 0;
    let bestMatch: ExistingMemoryWithEmbedding | null = null;

    for (const mem of existing) {
      let similarity: number;

      if (useEmbeddings && mem.embedding !== null) {
        similarity = cosineSimilarity(candidateEmbedding, mem.embedding);
      } else {
        similarity = levenshteinSimilarity(candidate.content, mem.content);
      }

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = mem;
      }
    }

    if (bestSimilarity > REINFORCE_THRESHOLD && bestMatch) {
      // ── Reinforce existing memory ──
      const newConfidence = Math.min(1.0, bestMatch.memory.confidence + REINFORCE_BUMP);

      db.transaction(() => {
        db.prepare(`UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?`).run(
          newConfidence,
          new Date().toISOString(),
          bestMatch!.memory.id,
        );

        // Add evidence links for supporting events (check for existing first)
        const existingEvidence = db
          .prepare(`SELECT event_id FROM evidence WHERE memory_id = ?`)
          .all(bestMatch!.memory.id) as Array<{ event_id: number }>;
        const linkedEventIds = new Set(existingEvidence.map((r) => r.event_id));
        const insertEvidence = db.prepare(
          `INSERT INTO evidence (memory_id, event_id, relationship, strength)
           VALUES (?, ?, 'supports', 1.0)`,
        );
        for (const eventId of candidate.evidenceEventIds) {
          if (!linkedEventIds.has(eventId)) {
            insertEvidence.run(bestMatch!.memory.id, eventId);
          }
        }
      })();

      result.reinforcedMemories.push({
        ...bestMatch.memory,
        confidence: newConfidence,
      });

      // Update in-memory cache
      bestMatch.memory.confidence = newConfidence;
    } else if (bestSimilarity > CONFLICT_THRESHOLD && bestMatch) {
      // ── Potential conflict zone — ask LLM to classify ──
      const relationship = await classifyRelationship(bestMatch.content, candidate.content);
      log().debug?.(
        `[reconciler] Similarity ${bestSimilarity.toFixed(2)} → LLM says: ${relationship}`,
      );

      if (relationship === "duplicate") {
        // Same info, different words → reinforce existing
        const newConfidence = Math.min(1.0, bestMatch.memory.confidence + REINFORCE_BUMP);

        db.transaction(() => {
          db.prepare(`UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?`).run(
            newConfidence,
            new Date().toISOString(),
            bestMatch!.memory.id,
          );
          const existingEv = db
            .prepare(`SELECT event_id FROM evidence WHERE memory_id = ?`)
            .all(bestMatch!.memory.id) as Array<{ event_id: number }>;
          const alreadyLinked = new Set(existingEv.map((r) => r.event_id));
          const insertEvidence = db.prepare(
            `INSERT INTO evidence (memory_id, event_id, relationship, strength)
             VALUES (?, ?, 'supports', 1.0)`,
          );
          for (const eventId of candidate.evidenceEventIds) {
            if (!alreadyLinked.has(eventId)) {
              insertEvidence.run(bestMatch!.memory.id, eventId);
            }
          }
        })();

        result.reinforcedMemories.push({ ...bestMatch.memory, confidence: newConfidence });
        bestMatch.memory.confidence = newConfidence;
      } else if (relationship === "update") {
        // Candidate supersedes existing → create new, mark old as superseded
        const newMemory = await createMemory(candidate, reflectionRunId);
        if (newMemory) {
          result.newMemories.push(newMemory);
          newMemoryCount++;

          // Supersede the old memory
          db.prepare(
            `UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`,
          ).run(newMemory.id, new Date().toISOString(), bestMatch.memory.id);
          bestMatch.memory.status = "superseded";

          existing.push({
            memory: newMemory,
            embedding: candidateEmbedding,
            content: newMemory.content,
          });
        }
      } else if (relationship === "contradiction") {
        // Genuinely conflicting → create new memory and record conflict
        const newMemory = await createMemory(candidate, reflectionRunId);
        if (newMemory) {
          result.newMemories.push(newMemory);
          newMemoryCount++;

          const conflictDescription = `Possible contradiction: "${bestMatch.content.slice(0, 80)}" vs "${candidate.content.slice(0, 80)}"`;
          const now = new Date().toISOString();

          db.prepare(
            `INSERT INTO conflicts (memory_a, memory_b, description, created_at)
             VALUES (?, ?, ?, ?)`,
          ).run(bestMatch.memory.id, newMemory.id, conflictDescription, now);

          const conflictRow = db
            .prepare(`SELECT * FROM conflicts WHERE memory_a = ? AND memory_b = ?`)
            .get(bestMatch.memory.id, newMemory.id) as Conflict | undefined;

          if (conflictRow) {
            result.conflicts.push(conflictRow);
          }

          existing.push({
            memory: newMemory,
            embedding: candidateEmbedding,
            content: newMemory.content,
          });
        }
      } else {
        // complementary — related but distinct → create new without conflict
        const newMemory = await createMemory(candidate, reflectionRunId);
        if (newMemory) {
          result.newMemories.push(newMemory);
          newMemoryCount++;

          existing.push({
            memory: newMemory,
            embedding: candidateEmbedding,
            content: newMemory.content,
          });
        }
      }
    } else {
      // ── Novel memory — create new ──
      const newMemory = await createMemory(candidate, reflectionRunId);
      if (newMemory) {
        result.newMemories.push(newMemory);
        newMemoryCount++;

        existing.push({
          memory: newMemory,
          embedding: candidateEmbedding,
          content: newMemory.content,
        });
      }
    }
  }

  return result;
}

// ── Memory creation helper ───────────────────────────────────────────────────

async function createMemory(
  candidate: MemoryCandidate,
  reflectionRunId: string,
): Promise<Memory | null> {
  const db = getMemoryDb();
  const now = new Date().toISOString();

  try {
    let newMemoryId: number | null = null;

    db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO memories
             (memory_type, title, content, confidence, scope, source_authority, reflection_run_id, derived_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
          candidate.memoryType,
          candidate.title || null,
          candidate.content,
          candidate.confidence,
          candidate.scope,
          candidate.sourceAuthority,
          reflectionRunId,
          now,
        );

      newMemoryId = result.lastInsertRowid as number;

      // Link evidence events
      const insertEvidence = db.prepare(
        `INSERT INTO evidence (memory_id, event_id, relationship, strength)
         VALUES (?, ?, 'supports', 1.0)`,
      );
      for (const eventId of candidate.evidenceEventIds) {
        insertEvidence.run(newMemoryId, eventId);
      }
    })();

    if (newMemoryId === null) return null;

    // Generate and store embedding (best-effort — outside the transaction)
    const embedding = await fetchEmbedding(candidate.content);
    if (embedding) {
      try {
        db.prepare(
          `INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)`,
        ).run(newMemoryId, Buffer.from(embedding.buffer));
      } catch (err) {
        log().warn(
          `[reconciler] Failed to store embedding for memory ${newMemoryId}: ${String(err)}`,
        );
      }
    }

    return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(newMemoryId) as Memory | null;
  } catch (err) {
    log().warn(`[reconciler] Failed to create memory: ${String(err)}`);
    return null;
  }
}
