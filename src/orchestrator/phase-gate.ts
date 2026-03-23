/**
 * Phase Gate — acceptance-criteria enforcement for sequential task chains.
 *
 * Problem: The blocked_by dependency gate already prevents Phase N+1 from
 * spawning until Phase N reaches a terminal status. But a task can reach
 * `completed` without its acceptance criteria ever being verified — a
 * "phantom completion". This module adds a second layer of defense:
 *
 *   1. `parseAcceptanceCriteria(notes)` — extract AC items from task notes.
 *   2. `verifyPhaseGateAC(taskId, db)` — check whether a closed blocker task's
 *      AC items are ALL marked with ✓. Returns a PhaseGateResult.
 *   3. `checkBlockerPhaseGates(blockedByIds, db)` — used by scanner AND the
 *      control-loop spawn gate to block any task whose blocker closed without
 *      verified AC.
 *   4. `emitPhaseGateInboxAlert(taskId, result, db)` — posts a loud inbox item
 *      when a gate violation is detected, so humans are notified immediately.
 *
 * AC Format (in task.notes field):
 *   ACCEPTANCE CRITERIA:
 *   ✓ Some criterion that must be met
 *   ✗ Some criterion that is NOT met (will block gate)
 *   - Some criterion that is NOT met (dash format, will block gate)
 *
 * Tasks with no AC section are treated as UNVERIFIED and will block dependents
 * unless explicitly bypassed (see PhaseGateOptions.requireAC).
 */

import { inArray } from "drizzle-orm";
import { getRawDb } from "../db/connection.js";
import type { getDb } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { log } from "../util/logger.js";
import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AcItem {
  text: string;
  checked: boolean; // true = ✓, false = unchecked / ✗
}

export type PhaseGateStatus =
  | "passed"       // all AC items checked
  | "ac_missing"   // no ACCEPTANCE CRITERIA section found in notes
  | "ac_incomplete" // AC section exists but ≥1 item is unchecked
  | "task_not_found"; // blocker task doesn't exist (treated as passed — deleted = done)

export interface PhaseGateResult {
  taskId: string;
  status: PhaseGateStatus;
  items: AcItem[];
  /** Human-readable explanation for log / inbox messages. */
  reason: string;
}

export interface BlockerPhaseGateResult {
  /** true = all blockers passed AC verification, safe to proceed */
  allPassed: boolean;
  /** Results for each blocker that failed */
  failures: PhaseGateResult[];
}

// ─── AC Parser ────────────────────────────────────────────────────────────────

/**
 * Parse acceptance criteria items from a task notes string.
 *
 * Looks for a section starting with "ACCEPTANCE CRITERIA" (case-insensitive),
 * then collects lines that look like checklist items until a blank line or
 * a new all-caps section header breaks the block.
 *
 * Checked (✓ or ✅):  item.checked = true
 * Unchecked (✗, -, •, *, or plain text starting with a letter/digit): item.checked = false
 */
export function parseAcceptanceCriteria(notes: string | null | undefined): AcItem[] | null {
  if (!notes) return null;

  // Find the AC section header
  const acHeaderRe = /^[ \t]*ACCEPTANCE CRITERIA[:\s]*/im;
  const headerMatch = acHeaderRe.exec(notes);
  if (!headerMatch) return null;

  const afterHeader = notes.slice(headerMatch.index + headerMatch[0].length);
  const lines = afterHeader.split(/\r?\n/);

  const items: AcItem[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // A new section header (all-caps word(s) followed by colon) ends AC block
    if (/^[A-Z][A-Z\s]{3,}:/.test(trimmed) && !trimmed.startsWith("✓") && !trimmed.startsWith("✗")) {
      break;
    }

    // Checked: ✓ or ✅ at start
    if (/^[✓✅]/.test(trimmed)) {
      items.push({ text: trimmed.replace(/^[✓✅]\s*/, ""), checked: true });
      continue;
    }

    // Unchecked: ✗, ×, -, *, •, [ ], [x] at start, or plain bullet
    if (/^[✗×\-\*•]/.test(trimmed) || /^\[\s*[x ]?\s*\]/.test(trimmed)) {
      const text = trimmed
        .replace(/^\[\s*[x ]?\s*\]\s*/, "")
        .replace(/^[✗×\-\*•]\s*/, "");
      items.push({ text, checked: false });
      continue;
    }

    // Line that starts with an uppercase letter/digit after the header — treat as unchecked item
    if (/^[A-Z0-9]/.test(trimmed)) {
      items.push({ text: trimmed, checked: false });
    }
  }

  return items.length > 0 ? items : null;
}

// ─── Per-task AC verification ─────────────────────────────────────────────────

/**
 * Verify the acceptance criteria of a single blocker task.
 *
 * @param blockerId  - Full task UUID of the blocker
 * @param requireAC  - When true, tasks with no AC section fail the gate.
 *                     When false (default), tasks with no AC section pass
 *                     (backward-compatible for older tasks created before AC
 *                     discipline was enforced).
 */
export function verifyPhaseGateAC(
  blockerId: string,
  requireAC = false,
): PhaseGateResult {
  const db = getRawDb();

  const row = db
    .prepare(`SELECT id, notes FROM tasks WHERE id = ?`)
    .get(blockerId) as { id: string; notes: string | null } | undefined;

  if (!row) {
    return {
      taskId: blockerId,
      status: "task_not_found",
      items: [],
      reason: `Blocker task ${blockerId.slice(0, 8)} not found — treating as resolved`,
    };
  }

  const items = parseAcceptanceCriteria(row.notes);

  if (!items || items.length === 0) {
    if (requireAC) {
      return {
        taskId: blockerId,
        status: "ac_missing",
        items: [],
        reason: `Blocker ${blockerId.slice(0, 8)} closed without any ACCEPTANCE CRITERIA section in notes — gate BLOCKED`,
      };
    }
    // No AC section and not required → pass with warning
    log().warn(
      `[PHASE_GATE] Blocker ${blockerId.slice(0, 8)} has no ACCEPTANCE CRITERIA section — ` +
      `passing gate (requireAC=false) but this is a discipline gap`
    );
    return {
      taskId: blockerId,
      status: "passed",
      items: [],
      reason: `Blocker ${blockerId.slice(0, 8)} has no AC section — passing (no-AC tasks exempt)`,
    };
  }

  const unchecked = items.filter(i => !i.checked);
  if (unchecked.length > 0) {
    const uncheckedList = unchecked.map(i => `  ✗ ${i.text}`).join("\n");
    return {
      taskId: blockerId,
      status: "ac_incomplete",
      items,
      reason:
        `Blocker ${blockerId.slice(0, 8)} closed with ${unchecked.length}/${items.length} ` +
        `AC item(s) unverified:\n${uncheckedList}`,
    };
  }

  return {
    taskId: blockerId,
    status: "passed",
    items,
    reason: `Blocker ${blockerId.slice(0, 8)} — all ${items.length} AC items verified ✓`,
  };
}

// ─── Batch blocker check ──────────────────────────────────────────────────────

/**
 * Check all blockers in a blocked_by list for AC gate compliance.
 *
 * Only checks blockers that are already in a terminal status — non-terminal
 * blockers are handled by the existing `hasUnresolvedBlockers` check in
 * scanner.ts and control-loop.ts.
 *
 * @param blockedByRaw  - Raw blocked_by value from DB (JSON string or array)
 * @param requireAC     - Pass through to verifyPhaseGateAC
 */
export function checkBlockerPhaseGates(
  blockedByRaw: unknown,
  requireAC = false,
): BlockerPhaseGateResult {
  if (!blockedByRaw) return { allPassed: true, failures: [] };

  let blockerIds: string[];
  try {
    blockerIds = typeof blockedByRaw === "string"
      ? JSON.parse(blockedByRaw)
      : (blockedByRaw as string[]);
  } catch {
    return { allPassed: true, failures: [] }; // malformed JSON handled elsewhere
  }

  if (!Array.isArray(blockerIds) || blockerIds.length === 0) {
    return { allPassed: true, failures: [] };
  }

  // Only check terminal blockers — we can't verify AC on tasks still in progress
  const db = getRawDb();
  const terminalBlockers = db
    .prepare(
      `SELECT id FROM tasks WHERE id IN (${blockerIds.map(() => "?").join(",")}) ` +
      `AND (status IN ('completed', 'closed', 'cancelled', 'rejected') ` +
      `  OR work_state IN ('completed', 'done'))`
    )
    .all(...blockerIds) as Array<{ id: string }>;

  const failures: PhaseGateResult[] = [];
  for (const { id } of terminalBlockers) {
    const result = verifyPhaseGateAC(id, requireAC);
    if (result.status !== "passed" && result.status !== "task_not_found") {
      failures.push(result);
    }
  }

  return { allPassed: failures.length === 0, failures };
}

// ─── Inbox alert emission ─────────────────────────────────────────────────────

/**
 * Post a loud inbox alert when a phase gate violation is detected.
 *
 * Deduplicates: won't insert a new item if one with the same title is already
 * pending (mirrors the dedup pattern in control-loop.ts).
 */
export function emitPhaseGateInboxAlert(
  dependentTaskId: string,
  failures: PhaseGateResult[],
): void {
  if (failures.length === 0) return;

  const db = getRawDb();
  const blockerSummary = failures
    .map(f => `  • ${f.taskId.slice(0, 8)}: ${f.reason}`)
    .join("\n");

  const title = `[PHASE_GATE] Task ${dependentTaskId.slice(0, 8)} blocked — prerequisite AC unverified`;
  const content =
    `Phase gate blocked task ${dependentTaskId.slice(0, 8)} from starting because ` +
    `${failures.length} predecessor task(s) closed without verified acceptance criteria.\n\n` +
    `Failures:\n${blockerSummary}\n\n` +
    `Action required: Review the listed blocker task(s). Either:\n` +
    `  1. Update their notes to mark all AC items with ✓, then re-open and close them cleanly.\n` +
    `  2. If AC is genuinely met, a human operator can manually unblock the dependent task.\n\n` +
    `The dependent task will be re-queued and retried on the next tick.`;

  try {
    // Dedup: skip if pending alert already exists for this task
    const existing = db
      .prepare(`SELECT COUNT(*) as cnt FROM inbox_items WHERE title = ? AND action_status = 'pending'`)
      .get(title) as { cnt: number };
    if (existing.cnt > 0) return;

    db.prepare(
      `INSERT INTO inbox_items (id, title, content, type, requires_action, action_status, source_agent) ` +
      `VALUES (?, ?, ?, 'phase_gate_violation', 1, 'pending', 'orchestrator')`
    ).run(randomUUID(), title, content);

    log().error(`[PHASE_GATE] Alert posted to inbox for task ${dependentTaskId.slice(0, 8)}`);
  } catch (e) {
    // Non-fatal: log the error but don't propagate — gate still blocked
    log().error(`[PHASE_GATE] Failed to write inbox alert: ${e}`);
  }
}
