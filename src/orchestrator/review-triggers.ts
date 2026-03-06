/**
 * review-triggers.ts — Selective review trigger detection for the PAW orchestrator.
 *
 * Implements the criteria from agent-code-review-workflow.md:
 *   1. LARGE_REFACTOR    — >500 lines changed (added + removed)
 *   2. NEW_API_ENDPOINT  — new route handler detected in diff content
 *   3. DB_SCHEMA_CHANGE  — migration, model, or schema file modified
 *   4. SECURITY          — auth/token/crypto/permission-related changes
 *   5. TEST_SUITE        — >20 new test functions added
 *
 * Usage (from post-completion hook in engine.ts):
 *
 *   import { shouldTriggerReview, ReviewTriggerResult } from "../orchestrator/review-triggers.js";
 *
 *   const result = shouldTriggerReview({ repoPath, taskId, taskTitle });
 *   if (result.shouldReview) {
 *     queueReviewerFollowup(taskId);
 *   }
 */

import { spawnSync } from "node:child_process";
import { log } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Trigger thresholds — adjust here
// ---------------------------------------------------------------------------

const LINES_CHANGED_THRESHOLD = 500;   // LARGE_REFACTOR
const NEW_TESTS_THRESHOLD = 20;         // TEST_SUITE

// ---------------------------------------------------------------------------
// Pattern matchers
// ---------------------------------------------------------------------------

const API_ROUTE_PATTERN = /(@\s*(?:router|app)\s*\.\s*(?:get|post|put|patch|delete|head|options)\s*\(|@app\.route\s*\()/i;

const DB_SCHEMA_PATTERNS = [
  /models?\.py$/i,
  /migration/i,
  /alembic/i,
  /schema\.py$/i,
  /schema\.ts$/i,
  /db\.py$/i,
  /database\.py$/i,
  /\.sql$/i,
  /migrate\.ts$/i,
  /migrate\.py$/i,
  /drizzle\.config/i,
];

const SECURITY_PATTERNS = [
  /\b(auth|token|permission|secret|crypto|encrypt|decrypt|password|oauth|jwt|bearer|api.?key)\b/i,
];

const TEST_FUNCTION_PATTERN = /^\s*(def\s+test_\w+|it\s*\(|test\s*\(|describe\s*\()/m;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewTriggerName =
  | "large_refactor"
  | "new_api_endpoint"
  | "db_schema_change"
  | "security"
  | "test_suite";

export interface ReviewTriggerResult {
  shouldReview: boolean;
  triggers: ReviewTriggerName[];
  /** Human-readable explanation for logging */
  reason: string;
  /** Stats used for the decision */
  stats: {
    linesAdded: number;
    linesRemoved: number;
    linesChanged: number;
    fileCount: number;
    newTests: number;
  };
}

interface FileStat {
  path: string;
  added: number;
  removed: number;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function gitExec(repoPath: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout ?? "";
}

/**
 * Get the list of files changed since the last commit (HEAD~1..HEAD).
 * Falls back to staged changes if HEAD~1 doesn't exist (first commit).
 */
function getChangedFiles(repoPath: string): FileStat[] {
  // Try HEAD~1..HEAD first (post-commit scenario)
  let raw = gitExec(repoPath, "diff", "--numstat", "HEAD~1..HEAD");

  // If empty, try staged diff (pre-commit scenario) or working tree
  if (!raw.trim()) {
    raw = gitExec(repoPath, "diff", "--numstat", "HEAD");
  }
  if (!raw.trim()) {
    raw = gitExec(repoPath, "diff", "--numstat", "--cached");
  }

  const files: FileStat[] = [];
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\t/);
    if (parts.length < 3) continue;
    const added = parseInt(parts[0]!, 10) || 0;
    const removed = parseInt(parts[1]!, 10) || 0;
    const path = parts[2]!.trim();
    if (path) files.push({ path, added, removed });
  }
  return files;
}

/**
 * Get the full diff content for a specific file (for pattern matching).
 * Limits to 200KB to avoid memory issues.
 */
function getFileDiff(repoPath: string, filePath: string): string {
  let diff = gitExec(repoPath, "diff", "HEAD~1..HEAD", "--", filePath);
  if (!diff) {
    diff = gitExec(repoPath, "diff", "HEAD", "--", filePath);
  }
  if (!diff) {
    diff = gitExec(repoPath, "diff", "--cached", "--", filePath);
  }
  return diff.slice(0, 200_000);
}

/**
 * Count new test function definitions in diff content (only added lines).
 */
function countNewTests(diffContent: string): number {
  const addedLines = diffContent
    .split("\n")
    .filter(l => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");

  const matches = addedLines.match(/^\s*\+?\s*(def\s+test_\w+|it\s*\(|test\s*\()/gm);
  return matches?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReviewTriggerInput {
  /** Absolute path to the git repository. Required for diff analysis. */
  repoPath: string | null | undefined;
  taskId: string;
  taskTitle: string;
}

/**
 * Analyze the latest git changes in a repository and determine whether
 * a code review should be triggered.
 *
 * Returns a ReviewTriggerResult with:
 *   - shouldReview: true if any trigger was matched
 *   - triggers: list of matched trigger names
 *   - reason: human-readable explanation (for logging)
 *   - stats: raw numbers used for the decision
 */
export function shouldTriggerReview(input: ReviewTriggerInput): ReviewTriggerResult {
  const { repoPath, taskId, taskTitle } = input;

  const noReview = (reason: string): ReviewTriggerResult => ({
    shouldReview: false,
    triggers: [],
    reason,
    stats: { linesAdded: 0, linesRemoved: 0, linesChanged: 0, fileCount: 0, newTests: 0 },
  });

  if (!repoPath) {
    return noReview("no_repo_path: cannot analyze diff without a repository path");
  }

  // Check if it's actually a git repo
  const isRepo = gitExec(repoPath, "rev-parse", "--git-dir");
  if (!isRepo.trim()) {
    return noReview(`not_a_git_repo: ${repoPath} is not a git repository`);
  }

  const files = getChangedFiles(repoPath);

  if (files.length === 0) {
    return noReview("no_changes: no files changed in the last commit");
  }

  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);
  const totalChanged = totalAdded + totalRemoved;

  const stats = {
    linesAdded: totalAdded,
    linesRemoved: totalRemoved,
    linesChanged: totalChanged,
    fileCount: files.length,
    newTests: 0,
  };

  const matched: ReviewTriggerName[] = [];
  const reasons: string[] = [];

  // ── Trigger 1: Large refactor ──────────────────────────────────────────────
  if (totalChanged > LINES_CHANGED_THRESHOLD) {
    matched.push("large_refactor");
    reasons.push(`large_refactor: ${totalChanged} lines changed (threshold: ${LINES_CHANGED_THRESHOLD})`);
  }

  // ── Triggers 2-5: Require per-file analysis ────────────────────────────────
  let apiEndpointFound = false;
  let schemaChangeFound = false;
  let securityChangeFound = false;
  let totalNewTests = 0;

  for (const file of files) {
    const { path } = file;

    // Trigger 3: DB schema change (path-based — no content needed)
    if (!schemaChangeFound && DB_SCHEMA_PATTERNS.some(p => p.test(path))) {
      schemaChangeFound = true;
      matched.push("db_schema_change");
      reasons.push(`db_schema_change: file ${path} matches schema/migration pattern`);
    }

    // Need content for API, security, and test detection
    if (!apiEndpointFound || !securityChangeFound || totalNewTests <= NEW_TESTS_THRESHOLD) {
      const diff = getFileDiff(repoPath, path);
      if (!diff) continue;

      // Trigger 2: New API endpoint (look for route decorators in added lines)
      if (!apiEndpointFound) {
        const addedLines = diff
          .split("\n")
          .filter(l => l.startsWith("+") && !l.startsWith("+++"))
          .join("\n");
        if (API_ROUTE_PATTERN.test(addedLines)) {
          apiEndpointFound = true;
          matched.push("new_api_endpoint");
          reasons.push(`new_api_endpoint: new route decorator found in ${path}`);
        }
      }

      // Trigger 4: Security-sensitive changes
      if (!securityChangeFound) {
        const pathSensitive = SECURITY_PATTERNS.some(p => p.test(path));
        const contentSensitive = SECURITY_PATTERNS.some(p => p.test(diff));
        if (pathSensitive || contentSensitive) {
          securityChangeFound = true;
          matched.push("security");
          reasons.push(
            `security: ${pathSensitive ? `file path ${path} matches security pattern` : `diff content in ${path} matches security pattern`}`
          );
        }
      }

      // Trigger 5: Test suite additions
      if (totalNewTests <= NEW_TESTS_THRESHOLD) {
        const newTests = countNewTests(diff);
        totalNewTests += newTests;
      }
    }
  }

  // Trigger 5: Test suite (evaluated after all files)
  if (totalNewTests > NEW_TESTS_THRESHOLD) {
    matched.push("test_suite");
    reasons.push(`test_suite: ${totalNewTests} new test functions added (threshold: ${NEW_TESTS_THRESHOLD})`);
  }
  stats.newTests = totalNewTests;

  if (matched.length === 0) {
    const skipReason = [
      `no_trigger: task ${taskId.slice(0, 8)} "${taskTitle.slice(0, 50)}" does not meet review criteria`,
      `  lines_changed=${totalChanged} (threshold=${LINES_CHANGED_THRESHOLD}), files=${files.length}, new_tests=${totalNewTests}`,
    ].join("\n");
    return { shouldReview: false, triggers: [], reason: skipReason, stats };
  }

  const triggerReason = [
    `triggers_matched for task ${taskId.slice(0, 8)} "${taskTitle.slice(0, 50)}":`,
    ...reasons.map(r => `  - ${r}`),
  ].join("\n");

  return { shouldReview: true, triggers: matched, reason: triggerReason, stats };
}
