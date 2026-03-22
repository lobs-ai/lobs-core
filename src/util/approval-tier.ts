/**
 * Shared approval tier classification.
 * Used by tool-gate (hook) and meeting-analysis (service) to consistently
 * determine what level of approval a task needs.
 *
 * Tier A (auto): Bug fixes, docs, research, tests, internal housekeeping → active immediately
 * Tier B (lobs): Refactors, utilities, task management, consolidation → active, logged for audit
 * Tier C (rafe): UI, features, architecture, design → proposed + inbox item
 */

export function classifyApprovalTier(agent: string, notes: string): "A" | "B" | "C" {
  const lower = (agent + " " + notes).toLowerCase();

  // Tier A: bug fixes, docs, research, tests, metadata cleanup
  if (/bug.?fix|test|doc|research|investigation|metadata|truncat|description|typo|cleanup|clean.?up/i.test(lower)) return "A";

  // Tier B: refactors, task management, consolidation, internal tooling, dependency tracking
  if (/refactor|consolidat|merg|link|unif|reconcil|dedup|audit|diagnos|verify|formalize|clarif|dependency|task.?closure|update.?task/i.test(lower)) return "B";

  // Tier C: UI, features, architecture, design, new systems
  if (/feature|ui|architecture|design|new\s+endpoint|new\s+system|new\s+service/i.test(lower)) return "C";

  // Default: Tier B (Lobs can handle) — only truly novel/risky things should reach Rafe
  return "B";
}
