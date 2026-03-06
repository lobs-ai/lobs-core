/**
 * Shared approval tier classification.
 * Used by tool-gate (hook) and meeting-analysis (service) to consistently
 * determine what level of approval a task needs.
 *
 * Tier A (auto): Bug fixes, docs, research, tests → active immediately
 * Tier B (lobs): Refactors, utilities → active, logged for audit
 * Tier C (rafe): UI, features, architecture, design → proposed + inbox item
 */

export function classifyApprovalTier(agent: string, notes: string): "A" | "B" | "C" {
  const lower = (agent + " " + notes).toLowerCase();

  // Tier A: bug fixes, docs, research, tests
  if (/bug.?fix|test|doc|research|investigation/i.test(lower)) return "A";

  // Tier C: UI, features, architecture, design
  if (/feature|ui|architecture|design|new\s+endpoint/i.test(lower)) return "C";

  // Tier B: everything else (refactors, utilities)
  return "B";
}
