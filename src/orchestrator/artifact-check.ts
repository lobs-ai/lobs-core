/**
 * Pre-flight artifact existence check for the orchestrator.
 *
 * Called synchronously in `processSpawnRequest` before model selection.
 * If all expected artifacts are present and complete, the task is auto-closed.
 * If some are present but others are missing, the task is flagged for review.
 * If none are present, spawning proceeds normally.
 *
 * @see docs/decisions/designs/preflight-artifact-check.md
 */

import { existsSync, statSync } from "node:fs";

const DEFAULT_MIN_BYTES = 512;
const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 3600; // 7 days

export type ArtifactSpec = {
  path: string;
  minBytes?: number;
  maxAgeSeconds?: number;
  required?: boolean;
};

export type ArtifactCheckResult =
  | { status: "skip_all_present" }                  // all required artifacts present and complete
  | { status: "skip_partial"; missing: string[] }   // some present, some missing — mark needs_review
  | { status: "proceed" };                          // none present — normal spawn

/**
 * Check whether expected artifacts exist and meet the size + age heuristics.
 *
 * Returns:
 *   - `skip_all_present`  — every required artifact passes all checks
 *   - `skip_partial`      — at least one required artifact passes, but others fail
 *   - `proceed`           — no required artifacts pass (or rawSpecs is null/empty)
 *
 * Artifacts with `required: false` are warn-only and do not affect the outcome.
 * null/empty rawSpecs → no-op (`proceed`).
 */
export function checkArtifacts(rawSpecs: unknown): ArtifactCheckResult {
  if (!rawSpecs || !Array.isArray(rawSpecs) || rawSpecs.length === 0) {
    return { status: "proceed" };
  }

  const specs = rawSpecs as ArtifactSpec[];
  const requiredSpecs = specs.filter(s => s.required !== false);

  if (requiredSpecs.length === 0) {
    return { status: "proceed" };
  }

  const now = Date.now();
  const presentPaths: string[] = [];
  const missingPaths: string[] = [];

  for (const spec of requiredSpecs) {
    const resolved = spec.path.replace(/^~/, process.env["HOME"] ?? "");
    const minBytes = spec.minBytes ?? DEFAULT_MIN_BYTES;
    const maxAgeMs = (spec.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS) * 1000;

    if (!existsSync(resolved)) {
      missingPaths.push(`${spec.path} (not found)`);
      continue;
    }

    const stat = statSync(resolved);
    const ageMs = now - stat.mtimeMs;

    if (stat.size < minBytes) {
      missingPaths.push(`${spec.path} (too small: ${stat.size}B < ${minBytes}B)`);
      continue;
    }

    if (ageMs > maxAgeMs) {
      missingPaths.push(`${spec.path} (too old: ${Math.round(ageMs / 86400000)}d)`);
      continue;
    }

    presentPaths.push(spec.path);
  }

  if (presentPaths.length === 0) {
    return { status: "proceed" };
  }

  if (missingPaths.length === 0) {
    return { status: "skip_all_present" };
  }

  return { status: "skip_partial", missing: missingPaths };
}
