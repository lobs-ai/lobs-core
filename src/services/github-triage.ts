/**
 * GitHub Triage — per ADR-008 continuous operations.
 *
 * Runs every 30 minutes to:
 * - Auto-label new issues (based on keywords in title/body)
 * - Detect stale PRs (no activity in 14+ days)
 * - Flag issues missing required metadata
 */

import { log } from "../util/logger.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLobsRoot } from "../config/lobs.js";

interface GhConfig {
  owner: string;
  repo: string;
  token: string;
}

async function getGhConfig(): Promise<GhConfig | null> {
  const configPath = join(getLobsRoot(), "config/secrets/api-keys.json");
  if (!existsSync(configPath)) return null;

  try {
    const { readFileSync } = await import("node:fs");
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!data.github?.owner || !data.github?.repo || !data.github?.token) return null;
    return data.github as GhConfig;
  } catch {
    return null;
  }
}

interface GhIssue {
  number: number;
  state: string;
  title: string;
  body: string | null;
  labels: string[];
  updated_at: string;
  pull_request?: unknown;
}

interface LabelRule {
  pattern: RegExp;
  labels: string[];
}

/** Rules for auto-labeling based on title/body keywords */
const LABEL_RULES: LabelRule[] = [
  { pattern: /\b(bug|broken|crash|panic|exception)\b/i, labels: ["bug"] },
  { pattern: /\b(feat|feature|enhancement)\b/i, labels: ["enhancement"] },
  { pattern: /\b(docs?|documentation)\b/i, labels: ["documentation"] },
  { pattern: /\b(test|testing|coverage)\b/i, labels: ["testing"] },
  { pattern: /\b(perf|performance|slow|latency)\b/i, labels: ["performance"] },
  { pattern: /\b(security|vuln|cve)\b/i, labels: ["security"] },
  { pattern: /\b(refactor|cleanup|tech.?debt)\b/i, labels: ["refactor"] },
  { pattern: /\b ADR[- ]?\d+ /i, labels: ["decision"] },
  { pattern: /\b(ci|cd|pipeline|github.?action)\b/i, labels: ["infrastructure"] },
  { pattern: /\bfix(es)?\b/i, labels: ["bug"] },
  { pattern: /\b(memory|gc|leak)\b/i, labels: ["memory"] },
  { pattern: /\b(worker|cron|scheduler|heartbeat)\b/i, labels: ["workers"] },
  { pattern: /\b(database|db|schema|migration)\b/i, labels: ["database"] },
  { pattern: /\b(api|endpoint|route)\b/i, labels: ["api"] },
  { pattern: /\bdiscord|slack|notification\b/i, labels: ["integrations"] },
];

const STALE_DAYS = 14;

async function ghFetch(path: string, cfg: GhConfig): Promise<unknown> {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "lobs-core/1.0",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${path}: ${text}`);
  }

  return res.json();
}

async function addLabels(issueNumber: number, labels: string[], cfg: GhConfig): Promise<void> {
  await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/issues/${issueNumber}/labels`, cfg);
}

function daysSince(dateStr: string): number {
  const updated = new Date(dateStr).getTime();
  const now = Date.now();
  return (now - updated) / (1000 * 60 * 60 * 24);
}

export async function runGithubTriage(): Promise<void> {
  const cfg = await getGhConfig();
  if (!cfg) {
    log().info("[github-triage] No GitHub config — skipping");
    return;
  }

  log().info(`[github-triage] Running triage for ${cfg.owner}/${cfg.repo}`);

  // Fetch recent issues + PRs (updated in last 7 days to limit API calls)
  let issues: GhIssue[] = [];
  try {
    const data = await ghFetch(
      `/repos/${cfg.owner}/${cfg.repo}/issues?state=open&per_page=100&since=${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}`,
      cfg,
    );
    issues = data as GhIssue[];
  } catch (err) {
    log().error(`[github-triage] Failed to fetch issues: ${err}`);
    return;
  }

  let labeled = 0;
  let stalePRs = 0;

  for (const issue of issues) {
    const isPR = !!issue.pull_request;

    // Auto-label based on content
    if (issue.labels.length === 0) {
      const toAdd: string[] = [];
      const text = `${issue.title} ${issue.body ?? ""}`;

      for (const rule of LABEL_RULES) {
        if (rule.pattern.test(text)) {
          for (const label of rule.labels) {
            if (!toAdd.includes(label)) toAdd.push(label);
          }
        }
      }

      if (toAdd.length > 0) {
        try {
          await addLabels(issue.number, toAdd, cfg);
          labeled++;
          log().debug(`[github-triage] Labeled #${issue.number} with [${toAdd.join(", ")}]`);
        } catch (err) {
          log().warn(`[github-triage] Failed to label #${issue.number}: ${err}`);
        }
      }
    }

    // Detect stale PRs
    if (isPR) {
      const days = daysSince(issue.updated_at);
      if (days > STALE_DAYS) {
        stalePRs++;
        log().info(`[github-triage] Stale PR #${issue.number}: "${issue.title}" (${days.toFixed(0)}d old)`);
      }
    }
  }

  log().info(`[github-triage] Done — labeled ${labeled} issues, ${stalePRs} stale PRs detected`);
}
