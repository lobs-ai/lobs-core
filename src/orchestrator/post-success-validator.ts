/**
 * Post-success artifact validation for the orchestrator.
 *
 * Called from `autoCloseSucceededTasks` before a task is marked completed.
 * Detects phantom completions: tasks that report succeeded=true but produced
 * no output (no commits, no files written). These are flagged for review
 * instead of being silently closed.
 *
 * Also flags fast completions (< FAST_THRESHOLD_MS) as suspicious even
 * when artifacts are present.
 *
 * Supported agent types:
 *   - programmer / reviewer / architect: check git commits + file mtimes in repo
 *   - writer: check .md file mtimes in known doc locations
 *   - others: skip validation (return "valid" to avoid false positives)
 *
 * Time window: uses the task's startedAt timestamp so that artifacts are
 * detected even if the auto-close check runs well after the task finished.
 * Falls back to FALLBACK_WINDOW_MINUTES if startedAt is unavailable.
 *
 * @see docs/decisions/designs/post-success-artifact-validation.md
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Fallback: how far back to look if we don't have startedAt (10 minutes). */
const FALLBACK_WINDOW_MINUTES = 10;

/** Flag completions faster than this as suspicious (60 seconds). */
const FAST_THRESHOLD_MS = 60 * 1000;

/**
 * Agent types that require artifact validation.
 * Others skip validation to avoid false positives on unknown task shapes.
 */
const VALIDATED_AGENTS = new Set(["programmer", "reviewer", "architect", "writer"]);

export type PostSuccessValidationResult =
  | { status: "valid" }                             // artifacts found, duration OK — safe to close
  | { status: "suspicious"; reason: string }        // fast but artifacts found — close with warning
  | { status: "no_artifacts"; reason: string };     // no artifacts — phantom completion

/**
 * Build the `--since` argument for git log and the `-newermt` argument for find
 * based on the task's startedAt time. Falls back to a relative window if unavailable.
 */
function buildTimeCutoff(startedAt: string | null): { gitSince: string; findNewer: string; label: string } {
  if (startedAt) {
    // Parse and subtract 1 minute buffer for clock skew
    const ts = new Date(new Date(startedAt).getTime() - 60_000);
    const isoStr = ts.toISOString();
    return {
      gitSince: isoStr,
      findNewer: isoStr,
      label: `since task start (${startedAt})`,
    };
  }
  // Fallback: relative window from now
  return {
    gitSince: `${FALLBACK_WINDOW_MINUTES} minutes ago`,
    findNewer: new Date(Date.now() - FALLBACK_WINDOW_MINUTES * 60_000).toISOString(),
    label: `last ${FALLBACK_WINDOW_MINUTES}min (fallback)`,
  };
}

/**
 * Validate that a succeeded task actually produced output.
 *
 * @param agentType         agent role ("programmer" | "writer" | etc.)
 * @param repoPath          project repo path (from projects.repo_path), may be null
 * @param durationMs        how long the last run took (ended_at - started_at in ms), null if unknown
 * @param expectedArtifacts parsed expected_artifacts from the task (ArtifactSpec[]), null to use heuristics
 * @param startedAt         ISO timestamp of when the task's last run started, null if unknown
 */
export function validatePostSuccessArtifacts(
  agentType: string | null,
  repoPath: string | null,
  durationMs: number | null,
  expectedArtifacts: unknown = null,
  startedAt: string | null = null,
): PostSuccessValidationResult {
  const agent = agentType ?? "unknown";

  // Skip validation for agent types we don't have heuristics for.
  // Better to miss a phantom than to falsely block a valid completion.
  if (!VALIDATED_AGENTS.has(agent)) {
    return { status: "valid" };
  }

  const cutoff = buildTimeCutoff(startedAt);
  let hasArtifacts = false;
  let artifactDetail = "";

  if (agent === "programmer" || agent === "reviewer" || agent === "architect") {
    const result = checkRepoArtifacts(repoPath, cutoff);
    hasArtifacts = result.found;
    artifactDetail = result.detail;
  } else if (agent === "writer") {
    // If the task declared expected_artifacts, verify those specific paths exist.
    // This catches false-success reports where git push failed (file may not be on remote,
    // but more importantly it didn't end up in the expected location at all).
    const specPaths = extractExpectedPaths(expectedArtifacts);
    if (specPaths.length > 0) {
      const result = checkExpectedArtifactPaths(specPaths);
      hasArtifacts = result.found;
      artifactDetail = result.detail;
    } else {
      const result = checkWriterArtifacts(cutoff);
      hasArtifacts = result.found;
      artifactDetail = result.detail;
    }
  }

  if (!hasArtifacts) {
    return {
      status: "no_artifacts",
      reason:
        `No output artifacts detected ${cutoff.label} for ` +
        `${agent} task (duration=${durationMs != null ? Math.round(durationMs / 1000) + "s" : "unknown"}, ` +
        `repo=${repoPath ?? "none"})`,
    };
  }

  // Artifacts found — check if completion was suspiciously fast
  if (durationMs != null && durationMs < FAST_THRESHOLD_MS) {
    return {
      status: "suspicious",
      reason:
        `Fast completion: ${Math.round(durationMs / 1000)}s < ${FAST_THRESHOLD_MS / 1000}s threshold. ` +
        `Artifacts found (${artifactDetail}) but duration is suspicious.`,
    };
  }

  return { status: "valid" };
}

interface TimeCutoff {
  gitSince: string;
  findNewer: string;
  label: string;
}

/** Check a git repo for recent commits or file modifications. */
function checkRepoArtifacts(repoPath: string | null, cutoff: TimeCutoff): { found: boolean; detail: string } {
  if (!repoPath) {
    // No repo path: can't check git. Fall through to broader check.
    return checkAnyRecentFiles(null, cutoff);
  }

  const resolved = repoPath.replace(/^~/, process.env["HOME"] ?? "");
  if (!existsSync(resolved)) {
    return { found: false, detail: `repo not found: ${repoPath}` };
  }

  // 1. Recent git commits (most reliable signal)
  try {
    const commits = execSync(
      `git log --oneline --since="${cutoff.gitSince}" 2>/dev/null`,
      { cwd: resolved, timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (commits.length > 0) {
      const count = commits.split("\n").length;
      return { found: true, detail: `${count} commit(s) ${cutoff.label}` };
    }
  } catch { /* git not available or not a git repo */ }

  // 2. Uncommitted tracked changes (git add but not committed, or dirty working tree)
  //    This check is time-independent — any uncommitted changes count as artifacts
  try {
    const dirty = execSync(
      `git status --porcelain 2>/dev/null`,
      { cwd: resolved, timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (dirty.length > 0) {
      const lineCount = dirty.split("\n").length;
      return { found: true, detail: `${lineCount} uncommitted change(s) in repo` };
    }
  } catch { /* ignore */ }

  // 3. File mtime check: any file touched since the task started
  try {
    const recent = execSync(
      `find . -newermt "${cutoff.findNewer}" -type f -not -path './.git/*' 2>/dev/null | head -5`,
      { cwd: resolved, timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (recent.length > 0) {
      const count = recent.split("\n").length;
      return { found: true, detail: `${count} file(s) modified ${cutoff.label}` };
    }
  } catch { /* ignore */ }

  return { found: false, detail: "no recent git activity or file changes" };
}

/** Check for recently written .md files for writer agents. */
function checkWriterArtifacts(cutoff: TimeCutoff): { found: boolean; detail: string } {
  const home = process.env["HOME"] ?? "";
  const searchPaths = [
    `${home}/lobs-shared-memory/docs`,
    `${home}/lobs-shared-memory`,
    `${home}/apps`,
  ].filter(p => existsSync(p));

  for (const searchPath of searchPaths) {
    try {
      const recent = execSync(
        `find "${searchPath}" -name "*.md" -newermt "${cutoff.findNewer}" -type f 2>/dev/null | head -5`,
        { timeout: 5000, encoding: "utf-8" },
      ).trim();
      if (recent.length > 0) {
        const count = recent.split("\n").length;
        return { found: true, detail: `${count} .md file(s) written in ${searchPath}` };
      }
    } catch { /* ignore */ }
  }

  return { found: false, detail: `no .md files written ${cutoff.label}` };
}

/** Fallback: check for any recently modified files (no specific repo). */
function checkAnyRecentFiles(baseDir: string | null, cutoff: TimeCutoff): { found: boolean; detail: string } {
  const home = process.env["HOME"] ?? "";
  const searchDir = baseDir ?? `${home}/apps`;
  if (!existsSync(searchDir)) return { found: false, detail: `search dir not found: ${searchDir}` };

  try {
    const recent = execSync(
      `find "${searchDir}" -newermt "${cutoff.findNewer}" -type f -not -path '*/.git/*' 2>/dev/null | head -5`,
      { timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (recent.length > 0) {
      const count = recent.split("\n").length;
      return { found: true, detail: `${count} file(s) modified ${cutoff.label}` };
    }
  } catch { /* ignore */ }

  return { found: false, detail: "no recent file activity found" };
}

/**
 * Extract path strings from an expected_artifacts spec (ArtifactSpec[]).
 * Returns empty array if the input is not a valid spec array.
 */
function extractExpectedPaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const paths: string[] = [];
  for (const spec of raw) {
    if (spec && typeof spec === "object" && typeof (spec as Record<string, unknown>)["path"] === "string") {
      paths.push((spec as Record<string, unknown>)["path"] as string);
    }
  }
  return paths;
}

/**
 * Check that specific expected artifact paths exist on disk.
 * Used for writer tasks that declare expected_artifacts in the task spec.
 */
function checkExpectedArtifactPaths(paths: string[]): { found: boolean; detail: string } {
  const home = process.env["HOME"] ?? "";
  const present: string[] = [];
  const missing: string[] = [];

  for (const p of paths) {
    const resolved = p.replace(/^~/, home);
    if (existsSync(resolved)) {
      present.push(p);
    } else {
      missing.push(p);
    }
  }

  if (missing.length > 0 && present.length === 0) {
    return { found: false, detail: `expected artifacts missing: ${missing.join(", ")}` };
  }
  if (missing.length > 0) {
    // Some present, some missing — treat as found but note partial
    return { found: true, detail: `${present.length}/${paths.length} expected artifacts present; missing: ${missing.join(", ")}` };
  }
  return { found: true, detail: `all ${paths.length} expected artifact(s) present: ${present.join(", ")}` };
}
