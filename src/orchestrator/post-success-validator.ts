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
 * @see docs/decisions/designs/post-success-artifact-validation.md
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

/** How far back to look for output artifacts (5 minutes). */
const ARTIFACT_WINDOW_MINUTES = 5;

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
 * Validate that a succeeded task actually produced output.
 *
 * @param agentType   agent role ("programmer" | "writer" | etc.)
 * @param repoPath    project repo path (from projects.repo_path), may be null
 * @param durationMs  how long the last run took (ended_at - started_at in ms), null if unknown
 */
export function validatePostSuccessArtifacts(
  agentType: string | null,
  repoPath: string | null,
  durationMs: number | null,
): PostSuccessValidationResult {
  const agent = agentType ?? "unknown";

  // Skip validation for agent types we don't have heuristics for.
  // Better to miss a phantom than to falsely block a valid completion.
  if (!VALIDATED_AGENTS.has(agent)) {
    return { status: "valid" };
  }

  let hasArtifacts = false;
  let artifactDetail = "";

  if (agent === "programmer" || agent === "reviewer" || agent === "architect") {
    const result = checkRepoArtifacts(repoPath);
    hasArtifacts = result.found;
    artifactDetail = result.detail;
  } else if (agent === "writer") {
    const result = checkWriterArtifacts();
    hasArtifacts = result.found;
    artifactDetail = result.detail;
  }

  if (!hasArtifacts) {
    return {
      status: "no_artifacts",
      reason:
        `No output artifacts detected in last ${ARTIFACT_WINDOW_MINUTES}min for ` +
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

/** Check a git repo for recent commits or file modifications. */
function checkRepoArtifacts(repoPath: string | null): { found: boolean; detail: string } {
  if (!repoPath) {
    // No repo path: can't check git. Fall through to broader check.
    return checkAnyRecentFiles(null);
  }

  const resolved = repoPath.replace(/^~/, process.env["HOME"] ?? "");
  if (!existsSync(resolved)) {
    return { found: false, detail: `repo not found: ${repoPath}` };
  }

  // 1. Recent git commits (most reliable signal)
  try {
    const commits = execSync(
      `git log --oneline --since="${ARTIFACT_WINDOW_MINUTES} minutes ago" 2>/dev/null`,
      { cwd: resolved, timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (commits.length > 0) {
      const count = commits.split("\n").length;
      return { found: true, detail: `${count} commit(s) in last ${ARTIFACT_WINDOW_MINUTES}min` };
    }
  } catch { /* git not available or not a git repo */ }

  // 2. Uncommitted tracked changes (git add but not committed, or dirty working tree)
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

  // 3. File mtime check: any file touched in the last N minutes
  try {
    const recent = execSync(
      `find . -mmin -${ARTIFACT_WINDOW_MINUTES} -type f -not -path './.git/*' 2>/dev/null | head -5`,
      { cwd: resolved, timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (recent.length > 0) {
      const count = recent.split("\n").length;
      return { found: true, detail: `${count} file(s) modified in last ${ARTIFACT_WINDOW_MINUTES}min` };
    }
  } catch { /* ignore */ }

  return { found: false, detail: "no recent git activity or file changes" };
}

/** Check for recently written .md files for writer agents. */
function checkWriterArtifacts(): { found: boolean; detail: string } {
  const home = process.env["HOME"] ?? "";
  const searchPaths = [
    `${home}/lobs-shared-memory/docs`,
    `${home}/lobs-shared-memory`,
    `${home}/apps`,
  ].filter(p => existsSync(p));

  for (const searchPath of searchPaths) {
    try {
      const recent = execSync(
        `find "${searchPath}" -name "*.md" -mmin -${ARTIFACT_WINDOW_MINUTES} -type f 2>/dev/null | head -5`,
        { timeout: 5000, encoding: "utf-8" },
      ).trim();
      if (recent.length > 0) {
        const count = recent.split("\n").length;
        return { found: true, detail: `${count} .md file(s) written in ${searchPath}` };
      }
    } catch { /* ignore */ }
  }

  return { found: false, detail: `no .md files written in last ${ARTIFACT_WINDOW_MINUTES}min` };
}

/** Fallback: check for any recently modified files (no specific repo). */
function checkAnyRecentFiles(baseDir: string | null): { found: boolean; detail: string } {
  const home = process.env["HOME"] ?? "";
  const searchDir = baseDir ?? `${home}/apps`;
  if (!existsSync(searchDir)) return { found: false, detail: `search dir not found: ${searchDir}` };

  try {
    const recent = execSync(
      `find "${searchDir}" -mmin -${ARTIFACT_WINDOW_MINUTES} -type f -not -path '*/.git/*' 2>/dev/null | head -5`,
      { timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (recent.length > 0) {
      const count = recent.split("\n").length;
      return { found: true, detail: `${count} file(s) modified in last ${ARTIFACT_WINDOW_MINUTES}min` };
    }
  } catch { /* ignore */ }

  return { found: false, detail: "no recent file activity found" };
}
