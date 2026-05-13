/**
 * GitHub Triage Worker — ADR-008 Phase 4: proactive GitHub housekeeping.
 *
 * Every 4 hours, scans all repos in lobs-ai and paw-engineering orgs for:
 *   1. Issues with no labels that are >7 days old
 *   2. PRs with no review requests that are >3 days old
 *   3. Issues/PRs labeled "priority" or "urgent" with no activity in 48h
 *
 * Creates inbox items (type="action") for each finding so nothing slips through.
 */

import { getDb } from "../db/connection.js";
import { inboxItems } from "../db/schema.js";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  BaseWorker,
  type WorkerArtifact,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
} from "./base-worker.js";

// ── Org / Repo Config ─────────────────────────────────────────────────────────

const LOBE_AI_ORGS = [
  "lobs-ai",
] as const;

const PAW_ENGINEERING_ORGS = [
  "paw-engineering",
] as const;

type Org = (typeof LOBE_AI_ORGS)[number] | (typeof PAW_ENGINEERING_ORGS)[number];

// Repos confirmed to exist — if a repo is added/removed update this list
const LOBE_AI_REPOS = [
  "lobs-core",
  "lobs-memory",
  "lobs-nexus",
  "lobs-ai",
  "ideas",
  "ship-api",
  "paw-hub",
  "paw-portal",
  "bot-shared",
] as const;

const PAW_ENGINEERING_REPOS = ["paw-engineering"] as const; // placeholder — populated dynamically

const ALL_REPOS: Array<{ org: Org; repo: string }> = [
  ...LOBE_AI_ORGS.flatMap(org => LOBE_AI_REPOS.map(repo => ({ org, repo }))),
  ...PAW_ENGINEERING_ORGS.flatMap(org =>
    PAW_ENGINEERING_REPOS.map(repo => ({ org, repo })),
  ),
];

// ── gh CLI helpers ────────────────────────────────────────────────────────────

/** Run a gh command and return stdout, throwing on non-zero exit. */
function gh(args: string | string[]): string {
  const cmd = Array.isArray(args) ? args.join(" ") : args;
  return execSync(`gh ${cmd}`, {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** List repos in an org (authenticated as thelobsbot). */
function listOrgRepos(org: string): string[] {
  try {
    const out = gh(`api repos --org ${org} --jq '.[].name'`);
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ── Finding Types ─────────────────────────────────────────────────────────────

interface TriageFinding {
  org: string;
  repo: string;
  kind: "issue" | "pr";
  number: number;
  title: string;
  url: string;
  ageDays: number;
  lastActivity: string;
  reason: string;
}

// ── Age / staleness helpers ────────────────────────────────────────────────────

function daysAgo(dateStr: string): number {
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  return (now - then) / (1_000 * 60 * 60 * 24);
}

function isStale(dateStr: string, thresholdDays: number): boolean {
  return daysAgo(dateStr) > thresholdDays;
}

// ── Scanning logic ─────────────────────────────────────────────────────────────

/** Scan a single repo for triage findings. */
function scanRepo(org: string, repo: string): TriageFinding[] {
  const findings: TriageFinding[] = [];

  // ── 1. Issues with no labels >7 days old ─────────────────────────────
  try {
    const issues = gh(
      `api repos/${org}/${repo}/issues ` +
        `--jq '.[] | select(.pull_request == null and (.labels | length) == 0) | ' +
        '{number, title, url, created_at, updated_at}'`,
    );
    for (const raw of issues ? JSON.parse(issues) : []) {
      if (isStale(raw.created_at, 7)) {
        findings.push({
          org,
          repo,
          kind: "issue",
          number: raw.number,
          title: raw.title,
          url: raw.url,
          ageDays: Math.floor(daysAgo(raw.created_at)),
          lastActivity: raw.updated_at,
          reason: `Unlabeled issue, ${Math.floor(daysAgo(raw.created_at))} days old (>7 days threshold)`,
        });
      }
    }
  } catch {
    // Repo may be empty or private — skip
  }

  // ── 2. PRs with no review requests >3 days old ───────────────────────
  try {
    const prs = gh(
      `api repos/${org}/${repo}/pulls ` +
        `--jq '.[] | select(.requested_reviewers == null or (.requested_reviewers | length) == 0) | ' +
        '{number, title, url, created_at, updated_at}'`,
    );
    for (const raw of prs ? JSON.parse(prs) : []) {
      if (isStale(raw.created_at, 3)) {
        findings.push({
          org,
          repo,
          kind: "pr",
          number: raw.number,
          title: raw.title,
          url: raw.url,
          ageDays: Math.floor(daysAgo(raw.created_at)),
          lastActivity: raw.updated_at,
          reason: `PR with no review requests, ${Math.floor(daysAgo(raw.created_at))} days old (>3 days threshold)`,
        });
      }
    }
  } catch {
    // Repo may be empty or private — skip
  }

  // ── 3. Priority/urgent items with no activity in 48h ────────────────
  for (const label of ["priority", "urgent"]) {
    try {
      const items = gh(
        `api repos/${org}/${repo}/issues ` +
          `--jq '.[] | select(has("pull_request") | not) | select(.labels | .[].name == "${label}") | ' +
          '{number, title, url, created_at, updated_at}'`,
      );
      for (const raw of items ? JSON.parse(items) : []) {
        if (isStale(raw.updated_at, 2)) {
          findings.push({
            org,
            repo,
            kind: "issue",
            number: raw.number,
            title: raw.title,
            url: raw.url,
            ageDays: Math.floor(daysAgo(raw.created_at)),
            lastActivity: raw.updated_at,
            reason: `Issue labeled "${label}" with no activity for >48h (last update: ${new Date(raw.updated_at).toLocaleDateString()})`,
          });
        }
      }
    } catch {
      // skip
    }

    // Also check PRs with priority/urgent labels
    try {
      const prs = gh(
        `api repos/${org}/${repo}/pulls ` +
          `--jq '.[] | select(.labels | .[].name == "${label}") | ' +
          '{number, title, url, created_at, updated_at}'`,
      );
      for (const raw of prs ? JSON.parse(prs) : []) {
        if (isStale(raw.updated_at, 2)) {
          findings.push({
            org,
            repo,
            kind: "pr",
            number: raw.number,
            title: raw.title,
            url: raw.url,
            ageDays: Math.floor(daysAgo(raw.created_at)),
            lastActivity: raw.updated_at,
            reason: `PR labeled "${label}" with no activity for >48h (last update: ${new Date(raw.updated_at).toLocaleDateString()})`,
          });
        }
      }
    } catch {
      // skip
    }
  }

  return findings;
}

// ── Inbox item creation ────────────────────────────────────────────────────────

function createInboxItem(finding: TriageFinding): string {
  const db = getDb();
  const id = `gh triage_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const icon = finding.kind === "issue" ? "🏷️" : "🔀";
  const ageStr = finding.ageDays === 1 ? "1 day" : `${finding.ageDays} days`;

  db.insert(inboxItems).values({
    id,
    title: `${icon} GitHub triage: ${finding.repo}#${finding.number} — ${finding.title.slice(0, 80)}`,
    content:
      `**Repo:** ${finding.org}/${finding.repo}\n` +
      `**Kind:** ${finding.kind.toUpperCase()} #${finding.number}\n` +
      `**Age:** ${ageStr}\n` +
      `**Reason:** ${finding.reason}\n` +
      `**Title:** ${finding.title}\n` +
      `**URL:** ${finding.url}\n` +
      `**Last activity:** ${new Date(finding.lastActivity).toLocaleString()}`,
    modifiedAt: now,
    isRead: false,
    type: "action",
    requiresAction: true,
    actionStatus: "pending",
  }).run();

  return id;
}

// ── Worker ────────────────────────────────────────────────────────────────────

export class GitHubTriageWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "github-triage",
    name: "GitHub Triage",
    description:
      "Scans lobs-ai and paw-engineering repos for stale/unlabeled issues, unreviewed PRs, and urgent items needing attention",
    schedule: "0 */4 * * *", // Every 4 hours
    enabled: true,
    maxTokens: 512,
    timeoutMs: 180_000, // Allow up to 3 min for all orgs
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const artifacts: WorkerArtifact[] = [];
    const alerts: WorkerResult["alerts"] = [];
    let totalFindings = 0;
    let totalCreated = 0;

    // Expand paw-engineering repos dynamically
    const pawRepos = listOrgRepos("paw-engineering");
    const repoList: Array<{ org: Org; repo: string }> = [
      ...ALL_REPOS,
      ...pawRepos.map(repo => ({ org: "paw-engineering" as const, repo })),
    ];

    for (const { org, repo } of repoList) {
      try {
        const findings = scanRepo(org, repo);
        totalFindings += findings.length;

        for (const finding of findings) {
          try {
            createInboxItem(finding);
            totalCreated++;
          } catch (err) {
            alerts.push({
              severity: "warning",
              title: `Failed to create inbox item for ${repo}#${finding.number}`,
              message: String(err),
              actionRequired: false,
            });
          }
        }
      } catch (err) {
        alerts.push({
          severity: "warning",
          title: `Failed to scan ${org}/${repo}`,
          message: String(err),
          actionRequired: false,
        });
      }
    }

    if (totalCreated > 0) {
      artifacts.push({
        type: "db_record",
        content: `Created ${totalCreated} inbox items from ${totalFindings} triage findings across ${repoList.length} repos`,
      });
    }

    return {
      success: true,
      artifacts,
      alerts,
      tokensUsed: 0,
      durationMs: 0,
      summary:
        totalCreated > 0
          ? `GitHub triage: ${totalCreated} inbox items created from ${totalFindings} findings`
          : "GitHub triage: no items requiring attention",
    };
  }
}
