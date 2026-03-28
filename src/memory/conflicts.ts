/**
 * Conflict auto-resolution and manual resolution for the memory system.
 *
 * Conflicts are created by reconciler.ts when two memories contradict each
 * other. This module applies rule-based auto-resolution and exposes helpers
 * for manual intervention via the CLI.
 *
 * DB schema (conflicts table):
 *   id, memory_a, memory_b, description, resolution, resolved_at, created_at
 *
 * Note: The spec references memory_id_a/memory_id_b/conflict_type/resolved_by
 * but the actual schema uses memory_a/memory_b/description. We adapt accordingly.
 */

import { getMemoryDb } from "./db.js";
import { log } from "../util/logger.js";
import type { Conflict, Memory } from "./types.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface ConflictResolutionResult {
  resolved: number;
  escalated: number;
  dismissed: number;
}

export interface ConflictWithMemories {
  conflict: Conflict;
  memoryA: Memory;
  memoryB: Memory;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadMemory(id: number): Memory | null {
  const db = getMemoryDb();
  return (db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory) ?? null;
}

function supersede(
  db: ReturnType<typeof getMemoryDb>,
  loserId: number,
  conflictId: number,
  resolution: string,
): void {
  db.prepare(
    "UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id = ?",
  ).run(loserId);
  db.prepare(
    "UPDATE conflicts SET resolved_at = datetime('now'), resolution = ? WHERE id = ?",
  ).run(resolution, conflictId);
}

function markDisputed(
  db: ReturnType<typeof getMemoryDb>,
  idA: number,
  idB: number,
  conflictId: number,
): void {
  db.prepare(
    "UPDATE memories SET status = 'contested', updated_at = datetime('now') WHERE id IN (?, ?)",
  ).run(idA, idB);
  db.prepare(
    "UPDATE conflicts SET resolved_at = datetime('now'), resolution = ? WHERE id = ?",
  ).run("auto: both disputed", conflictId);
}

// ── Auto-resolution ───────────────────────────────────────────────────────────

/**
 * Apply rule-based auto-resolution to all unresolved conflicts.
 *
 * Rules (applied in order):
 * 1. User preference (authority=3) always supersedes lower authority
 * 2. Higher authority contradicts lower → supersede the lower authority one
 * 3. Same scope + newer + same or higher authority → supersede old
 * 4. Same authority + both low confidence (<0.5) → mark both disputed
 * 5. Same authority + both high confidence (>0.7) → escalate (leave unresolved)
 */
export async function autoResolveConflicts(): Promise<ConflictResolutionResult> {
  const db = getMemoryDb();
  const result: ConflictResolutionResult = { resolved: 0, escalated: 0, dismissed: 0 };

  // Fetch all unresolved conflicts
  const unresolved = db
    .prepare("SELECT * FROM conflicts WHERE resolved_at IS NULL")
    .all() as Conflict[];

  for (const conflict of unresolved) {
    const memA = loadMemory(conflict.memory_a);
    const memB = loadMemory(conflict.memory_b);

    if (!memA || !memB) {
      // One of the memories was deleted — dismiss the conflict
      db.prepare(
        "UPDATE conflicts SET resolved_at = datetime('now'), resolution = ? WHERE id = ?",
      ).run("auto: memory not found, dismissed", conflict.id);
      result.dismissed++;
      continue;
    }

    const authA = memA.source_authority;
    const authB = memB.source_authority;
    const confA = memA.confidence;
    const confB = memB.confidence;

    try {
      // Rule 1: User preference (authority=3) always supersedes
      if (authA === 3 && authB < 3) {
        db.transaction(() => {
          supersede(db, memB.id, conflict.id, "auto: user preference supersedes");
        })();
        result.resolved++;
        log().info(`[conflicts] Auto-resolved conflict #${conflict.id}: user preference A supersedes`);
        continue;
      }

      if (authB === 3 && authA < 3) {
        db.transaction(() => {
          supersede(db, memA.id, conflict.id, "auto: user preference supersedes");
        })();
        result.resolved++;
        log().info(`[conflicts] Auto-resolved conflict #${conflict.id}: user preference B supersedes`);
        continue;
      }

      // Rule 2: Higher authority contradicts lower → supersede the lower
      if (authA > authB) {
        db.transaction(() => {
          supersede(db, memB.id, conflict.id, "auto: higher authority supersedes");
        })();
        result.resolved++;
        log().info(`[conflicts] Auto-resolved conflict #${conflict.id}: A (authority ${authA}) supersedes B (authority ${authB})`);
        continue;
      }

      if (authB > authA) {
        db.transaction(() => {
          supersede(db, memA.id, conflict.id, "auto: higher authority supersedes");
        })();
        result.resolved++;
        log().info(`[conflicts] Auto-resolved conflict #${conflict.id}: B (authority ${authB}) supersedes A (authority ${authA})`);
        continue;
      }

      // From here: same authority level

      // Rule 3: Same scope + newer wins (same or higher authority already handled)
      if (memA.scope === memB.scope) {
        const timeA = new Date(memA.derived_at).getTime();
        const timeB = new Date(memB.derived_at).getTime();

        if (timeA > timeB) {
          db.transaction(() => {
            supersede(db, memB.id, conflict.id, "auto: newer supersedes (same/higher authority)");
          })();
          result.resolved++;
          log().info(`[conflicts] Auto-resolved conflict #${conflict.id}: A is newer, supersedes B`);
          continue;
        }

        if (timeB > timeA) {
          db.transaction(() => {
            supersede(db, memA.id, conflict.id, "auto: newer supersedes (same/higher authority)");
          })();
          result.resolved++;
          log().info(`[conflicts] Auto-resolved conflict #${conflict.id}: B is newer, supersedes A`);
          continue;
        }
      }

      // Rule 4: Same authority + both low confidence → mark both disputed
      if (confA < 0.5 && confB < 0.5) {
        db.transaction(() => {
          markDisputed(db, memA.id, memB.id, conflict.id);
        })();
        result.dismissed++;
        log().info(`[conflicts] Marked conflict #${conflict.id} as disputed (both low confidence)`);
        continue;
      }

      // Rule 5: Same authority + high confidence (>0.7) on either → escalate
      if (confA > 0.7 || confB > 0.7) {
        // Leave unresolved — these surface in agent context
        result.escalated++;
        log().info(`[conflicts] Escalated conflict #${conflict.id} (high confidence, needs manual review)`);
        continue;
      }

      // Fallback: escalate anything else
      result.escalated++;
    } catch (err) {
      log().warn(`[conflicts] Error resolving conflict #${conflict.id}: ${String(err)}`);
    }
  }

  return result;
}

// ── Manual resolution ─────────────────────────────────────────────────────────

/**
 * Manually resolve a conflict.
 *
 * @param conflictId - ID of the conflict to resolve
 * @param resolution - Resolution strategy
 * @param mergedContent - Required when resolution === 'merge'
 */
export async function resolveConflict(
  conflictId: number,
  resolution: "choose_a" | "choose_b" | "merge" | "dismiss",
  mergedContent?: string,
): Promise<void> {
  const db = getMemoryDb();

  const conflict = db
    .prepare("SELECT * FROM conflicts WHERE id = ?")
    .get(conflictId) as Conflict | undefined;

  if (!conflict) {
    throw new Error(`Conflict #${conflictId} not found`);
  }

  const memA = loadMemory(conflict.memory_a);
  const memB = loadMemory(conflict.memory_b);

  if (!memA || !memB) {
    throw new Error(`One or both memories for conflict #${conflictId} not found`);
  }

  db.transaction(() => {
    switch (resolution) {
      case "choose_a": {
        // Supersede B, keep A active
        db.prepare(
          "UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id = ?",
        ).run(memB.id);
        db.prepare(
          "UPDATE conflicts SET resolved_at = datetime('now'), resolution = ? WHERE id = ?",
        ).run("manual: chose A", conflictId);
        break;
      }

      case "choose_b": {
        // Supersede A, keep B active
        db.prepare(
          "UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id = ?",
        ).run(memA.id);
        db.prepare(
          "UPDATE conflicts SET resolved_at = datetime('now'), resolution = ? WHERE id = ?",
        ).run("manual: chose B", conflictId);
        break;
      }

      case "merge": {
        if (!mergedContent) {
          throw new Error("mergedContent is required for 'merge' resolution");
        }
        // Supersede both, create a new merged memory
        db.prepare(
          "UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id IN (?, ?)",
        ).run(memA.id, memB.id);

        // Create merged memory inheriting the higher authority
        const newAuthority = Math.max(memA.source_authority, memB.source_authority);
        const newConfidence = Math.max(memA.confidence, memB.confidence);
        const now = new Date().toISOString();

        const insertResult = db
          .prepare(
            `INSERT INTO memories
               (memory_type, title, content, confidence, scope, source_authority, derived_at, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
          )
          .run(
            memA.memory_type,
            memA.title || memB.title || null,
            mergedContent,
            newConfidence,
            memA.scope,
            newAuthority,
            now,
          );

        const newMemId = insertResult.lastInsertRowid as number;

        // Copy evidence links from both
        const copyEvidence = db.prepare(
          `INSERT OR IGNORE INTO evidence (memory_id, event_id, relationship, strength)
           SELECT ?, event_id, relationship, strength FROM evidence WHERE memory_id = ?`,
        );
        copyEvidence.run(newMemId, memA.id);
        copyEvidence.run(newMemId, memB.id);

        db.prepare(
          "UPDATE conflicts SET resolved_at = datetime('now'), resolution = ? WHERE id = ?",
        ).run(`manual: merged into memory #${newMemId}`, conflictId);
        break;
      }

      case "dismiss": {
        // Supersede both (neither is useful)
        db.prepare(
          "UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id IN (?, ?)",
        ).run(memA.id, memB.id);
        db.prepare(
          "UPDATE conflicts SET resolved_at = datetime('now'), resolution = ? WHERE id = ?",
        ).run("manual: dismissed both", conflictId);
        break;
      }
    }
  })();

  log().info(`[conflicts] Manually resolved conflict #${conflictId} via '${resolution}'`);
}

// ── Conflict surfacing ────────────────────────────────────────────────────────

/**
 * Return unresolved conflicts with their associated memories.
 * Used by the context engine to surface contradictions to the agent.
 */
export function getUnresolvedConflicts(limit?: number): ConflictWithMemories[] {
  const db = getMemoryDb();

  const maxRows = limit ?? 10;

  // Re-query conflict and memory rows separately to avoid column name collisions
  // that would occur when using a JOIN (id, created_at etc. would be overwritten).
  const rawConflicts = db
    .prepare("SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT ?")
    .all(maxRows) as Conflict[];

  return rawConflicts
    .map((conflict) => {
      const memA = loadMemory(conflict.memory_a);
      const memB = loadMemory(conflict.memory_b);
      if (!memA || !memB) return null;
      return { conflict, memoryA: memA, memoryB: memB };
    })
    .filter((item): item is ConflictWithMemories => item !== null);
}

// ── Memory promotion ──────────────────────────────────────────────────────────

/**
 * Promote a memory to a higher source authority level.
 *
 * Authority levels:
 *   0 — low (auto-extracted, uncertain)
 *   1 — normal (reflection-extracted)
 *   2 — explicit agent statement / memory_write with permanent=true
 *   3 — user preference (highest)
 */
export function promoteMemory(memoryId: number, newAuthority: 0 | 1 | 2 | 3): void {
  const db = getMemoryDb();
  db.prepare(
    "UPDATE memories SET source_authority = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(newAuthority, memoryId);
  log().info(`[conflicts] Promoted memory #${memoryId} to authority ${newAuthority}`);
}
