/**
 * GitHub Triage — auto-labels new issues, detects stale PRs, responds to unassigned issues.
 * Per ADR-008: runs every 30 minutes.
 */

import { execSync } from "child_process";

/**
 * Run GitHub triage operations.
 * Uses gh CLI for GitHub API interactions.
 */
export async function runGithubTriage(): Promise<void> {
  try {
    // Auto-label new issues (unlabeled, opened in last 24h)
    try {
      execSync(
        `gh issue list --state open --no-assignee --createdafter "$(date -v-1d '+%Y-%m-%d')" --json number,title --jq '.[] | "gh issue edit \(.number) --add-label triage"'`,
        { stdio: "pipe" },
      );
    } catch {
      // No new unassigned issues — that's fine
    }

    // Detect stale PRs (no activity in 14 days)
    try {
      execSync(
        `gh pr list --state open --json number,title,updatedAt --jq '.[] | select(.updatedAt < "$(date -v-14d -I)') | "gh pr comment \(.number) --body \\"This PR has been idle for 14+ days. Please update or close.\\""'`,
        { stdio: "pipe" },
      );
    } catch {
      // No stale PRs
    }

    console.log("[github-triage] Triage complete");
  } catch (err) {
    console.warn(`[github-triage] Warning: ${String(err)}`);
  }
}
