/**
 * Memory GC — lifecycle state machine for the memories table.
 *
 * Transitions: active → stale → archived
 *
 * Safety rules ensure high-authority, well-evidenced, preference, and
 * high-confidence decision memories are never auto-archived.
 *
 * All transitions happen inside a single DB transaction.
 * Embeddings are deleted when a memory is archived (row stays for audit trail).
 */

import { getMemoryDb } from "./db.js";
import { log } from "../util/logger.js";
import type { Memory } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const EMBED_URL = "http://localhost:1234/v1/embeddings";
const EMBED_MODEL = "text-embedding-qwen3-embedding-4b";
const EMBED_TIMEOUT_MS = 15_000;

// ── Public types ──────────────────────────────────────────────────────────────

export interface GCResult {
  transitionsToStale: number;
  transitionsToArchived: number;
  confidenceReductions: number;
  protectedMemories: number;
  totalEvaluated: number;
}

// ── Row type used internally (extends Memory with evidence_count) ─────────────

interface MemoryWithEvidence extends Memory {
  evidence_count: number;
}

// ── Safety check ──────────────────────────────────────────────────────────────

/**
 * Returns true if this memory must NEVER be auto-archived.
 */
function isProtected(m: MemoryWithEvidence): boolean {
  if (m.source_authority >= 2) return true;
  if (m.evidence_count >= 5) return true;
  if (m.memory_type === "preference") return true;
  if (m.memory_type === "decision" && m.confidence > 0.7) return true;
  return false;
}

// ── GC audit helper ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStatement = { run: (...args: any[]) => unknown };

function writeGCLog(
  stmt: AnyStatement,
  memoryId: number,
  fromStatus: string,
  toStatus: string,
  reason: string,
): void {
  stmt.run(memoryId, fromStatus, toStatus, reason);
}

// ── Main GC runner ────────────────────────────────────────────────────────────

/**
 * Run a full memory GC pass.
 *
 * Evaluates all active/stale memories and applies state transitions:
 *   - active  → stale    (never-used after 90d, or abandoned after 180d)
 *   - stale   → archived (stale for 30d with no retrieval, or 60d if used)
 *   - active  → confidence decay (reinforced but never retrieved)
 *
 * All changes are committed in a single transaction.
 * Archiving deletes the embedding row but preserves the memory row.
 */
export async function runMemoryGC(): Promise<GCResult> {
  const result: GCResult = {
    transitionsToStale: 0,
    transitionsToArchived: 0,
    confidenceReductions: 0,
    protectedMemories: 0,
    totalEvaluated: 0,
  };

  try {
    const db = getMemoryDb();

    // Load all active and stale memories with their evidence counts in one query
    const candidates = db
      .prepare(
        `SELECT m.*, COALESCE(e.cnt, 0) AS evidence_count
         FROM memories m
         LEFT JOIN (
           SELECT memory_id, COUNT(*) AS cnt FROM evidence GROUP BY memory_id
         ) e ON m.id = e.memory_id
         WHERE m.status IN ('active', 'stale')`,
      )
      .all() as MemoryWithEvidence[];

    result.totalEvaluated = candidates.length;

    if (candidates.length === 0) {
      log().info("[gc] No active/stale memories to evaluate");
      return result;
    }

    const now = Date.now();

    // Prepare statements
    const updateStatus = db.prepare(
      `UPDATE memories SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    const updateConfidence = db.prepare(
      `UPDATE memories SET confidence = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    const deleteEmbedding = db.prepare(
      `DELETE FROM memory_embeddings WHERE memory_id = ?`,
    );
    const insertGCLog = db.prepare(
      `INSERT INTO gc_log (memory_id, from_status, to_status, reason)
       VALUES (?, ?, ?, ?)`,
    );

    // Helpers
    const daysSince = (ts: string | null | undefined): number => {
      if (!ts) return Infinity;
      return (now - new Date(ts).getTime()) / (1000 * 60 * 60 * 24);
    };

    // Bucket into actions
    const toStale: Array<{ m: MemoryWithEvidence; reason: string }> = [];
    const toArchived: Array<{ m: MemoryWithEvidence; reason: string }> = [];
    const toDecay: Array<{ m: MemoryWithEvidence; reason: string }> = [];
    const protected_: MemoryWithEvidence[] = [];

    for (const m of candidates) {
      const ageDays = daysSince(m.derived_at);
      const lastAccessedDays = daysSince(m.last_accessed);
      // For stale memories, updated_at represents the "stale since" date
      const staleSinceDays = m.status === "stale" ? daysSince(m.updated_at) : 0;

      if (m.status === "stale") {
        // ── Case: stale → archived ──────────────────────────────────────
        const wasNeverUsed = (m.access_count ?? 0) === 0;
        const staleThreshold = wasNeverUsed ? 30 : 60;

        if (staleSinceDays >= staleThreshold) {
          if (isProtected(m)) {
            protected_.push(m);
          } else {
            const reason = wasNeverUsed
              ? `stale for ${Math.round(staleSinceDays)}d with no retrieval (never-used path)`
              : `stale for ${Math.round(staleSinceDays)}d with no retrieval (abandoned path)`;
            toArchived.push({ m, reason });
          }
        }
      } else {
        // m.status === 'active'

        // ── Case 1: Never used ───────────────────────────────────────────
        if ((m.access_count ?? 0) === 0 && ageDays > 90) {
          toStale.push({
            m,
            reason: `unused for ${Math.round(ageDays)}d (never accessed)`,
          });
          continue;
        }

        // ── Case 2: Used but abandoned ───────────────────────────────────
        if (lastAccessedDays > 180) {
          toStale.push({
            m,
            reason: `last accessed ${Math.round(lastAccessedDays)}d ago (abandoned)`,
          });
          continue;
        }

        // ── Case 3: Reinforced but never retrieved ────────────────────────
        // evidence_count growing but access_count < 3 over 90+ days
        if (
          m.evidence_count > 0 &&
          (m.access_count ?? 0) < 3 &&
          ageDays >= 90
        ) {
          toDecay.push({
            m,
            reason: `${m.evidence_count} evidence but only ${m.access_count} retrievals over ${Math.round(ageDays)}d`,
          });
        }
      }
    }

    // ── Apply all transitions in a single transaction ─────────────────────
    const tx = db.transaction(() => {
      for (const { m, reason } of toStale) {
        updateStatus.run("stale", m.id);
        writeGCLog(insertGCLog, m.id, m.status, "stale", reason);
        log().info(
          `[gc] Memory #${m.id} (${m.memory_type}) transitioned: ${m.status} → stale (reason: ${reason})`,
        );
        result.transitionsToStale++;
      }

      for (const { m, reason } of toArchived) {
        updateStatus.run("archived", m.id);
        deleteEmbedding.run(m.id);
        writeGCLog(insertGCLog, m.id, m.status, "archived", reason);
        log().info(
          `[gc] Memory #${m.id} (${m.memory_type}) transitioned: ${m.status} → archived (reason: ${reason})`,
        );
        result.transitionsToArchived++;
      }

      for (const { m, reason } of toDecay) {
        // 0.95 per 30-day cycle; number of 30-day cycles since derived_at
        const ageDays =
          (now - new Date(m.derived_at).getTime()) / (1000 * 60 * 60 * 24);
        const cycles = Math.floor(ageDays / 30);
        const newConfidence = Math.max(0.05, m.confidence * Math.pow(0.95, cycles));
        if (newConfidence < m.confidence - 0.001) {
          updateConfidence.run(newConfidence, m.id);
          writeGCLog(
            insertGCLog,
            m.id,
            m.status,
            m.status, // status unchanged
            `confidence decay: ${m.confidence.toFixed(3)} → ${newConfidence.toFixed(3)} (${reason})`,
          );
          log().info(
            `[gc] Memory #${m.id} (${m.memory_type}) confidence decayed: ${m.confidence.toFixed(3)} → ${newConfidence.toFixed(3)} (reason: ${reason})`,
          );
          result.confidenceReductions++;
        }
      }
    });

    tx();

    result.protectedMemories = protected_.length;

    log().info(
      `[gc] Run complete — evaluated: ${result.totalEvaluated}, ` +
        `→stale: ${result.transitionsToStale}, ` +
        `→archived: ${result.transitionsToArchived}, ` +
        `decayed: ${result.confidenceReductions}, ` +
        `protected: ${result.protectedMemories}`,
    );
  } catch (err) {
    log().error(`[gc] runMemoryGC failed: ${String(err)}`);
  }

  return result;
}

// ── Memory resurrection ───────────────────────────────────────────────────────

/**
 * Resurrect an archived memory back to active status.
 *
 * Re-generates the embedding (best-effort; resurrection succeeds even if
 * embedding generation fails). Logs the resurrection in gc_log.
 *
 * @returns true if the memory was found and resurrected, false otherwise.
 */
export async function resurrectMemory(memoryId: number): Promise<boolean> {
  try {
    const db = getMemoryDb();

    const memory = db
      .prepare(`SELECT * FROM memories WHERE id = ?`)
      .get(memoryId) as Memory | undefined;

    if (!memory) {
      log().warn(`[gc] resurrectMemory: memory #${memoryId} not found`);
      return false;
    }

    if (memory.status !== "archived") {
      log().warn(
        `[gc] resurrectMemory: memory #${memoryId} is not archived (status: ${memory.status})`,
      );
      return false;
    }

    // Restore status and update last_accessed
    const updateStmt = db.prepare(
      `UPDATE memories
       SET status = 'active', last_accessed = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    );
    const insertGCLog = db.prepare(
      `INSERT INTO gc_log (memory_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)`,
    );

    const resurrectTx = db.transaction(() => {
      updateStmt.run(memoryId);
      insertGCLog.run(memoryId, "archived", "active", "resurrected");
    });

    resurrectTx();
    log().info(
      `[gc] Memory #${memoryId} (${memory.memory_type}) resurrected: archived → active`,
    );

    // Re-generate embedding (best-effort — don't fail resurrection if this fails)
    try {
      const embedding = await fetchEmbeddingForResurrect(memory.content);
      if (embedding) {
        const upsertEmb = db.prepare(
          `INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)`,
        );
        const embBuffer = Buffer.from(embedding.buffer);
        upsertEmb.run(memoryId, embBuffer);
        log().info(
          `[gc] Memory #${memoryId} embedding regenerated (${embedding.length} dims)`,
        );
      } else {
        log().warn(
          `[gc] Memory #${memoryId} resurrected without embedding (LM Studio unavailable)`,
        );
      }
    } catch (embErr) {
      log().warn(
        `[gc] Memory #${memoryId} embedding regeneration failed (non-fatal): ${String(embErr)}`,
      );
    }

    return true;
  } catch (err) {
    log().error(`[gc] resurrectMemory #${memoryId} failed: ${String(err)}`);
    return false;
  }
}

async function fetchEmbeddingForResurrect(
  text: string,
): Promise<Float32Array | null> {
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

// ── Importance score ──────────────────────────────────────────────────────────

/**
 * Compute an importance score for ranking purposes.
 *
 * Decays exponentially from the base confidence using a 120-day half-life
 * since last access. A floor based on access_count prevents well-used
 * memories from sinking below a useful threshold.
 *
 * Returns a value in [0, 1].
 */
export function importanceScore(memory: Memory): number {
  const ACCESS_HALF_LIFE = 120; // days
  const lastAccessed = memory.last_accessed ?? memory.derived_at;
  const daysSince =
    (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);

  const baseImportance = memory.confidence;
  const decayed = baseImportance * Math.pow(0.5, daysSince / ACCESS_HALF_LIFE);

  // Floor based on access count — log2(count+1) * 0.1, capped at ~0.3
  const floor = 0.1 * Math.log2((memory.access_count ?? 0) + 1);

  return Math.max(decayed, floor);
}
