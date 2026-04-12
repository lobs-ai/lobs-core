import type { IncomingMessage, ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { json, error, parseQuery, readRawBody } from "./index.js";
import { runCodeReview } from "../services/code-review.js";
import { analyzeCoverage, formatCoverageComment, postCoverageComment, fetchPrFilesForCoverage } from "../services/test-coverage.js";
import { discordService } from "../services/discord.js";

/**
 * GitHub feed endpoint — aggregate GitHub activity.
 * Dynamically discovers repos from orgs, filters out archived ones.
 *
 * GET /api/github/feed?limit=30 → recent GitHub events + summary
 * GET /api/github/prs?limit=20 → aggregate PRs
 * GET /api/github/ci?limit=20 → aggregate CI runs
 */

interface GitHubEvent {
  type: "push" | "pr" | "issue" | "ci";
  title: string;
  repo: string;
  author: string;
  timestamp: string;
  url: string;
}

interface GitHubFeedResponse {
  events: GitHubEvent[];
  summary: {
    recentCommits: number;
    totalPRs: number;
    failedCI: number;
  };
}

const ORGS = ["lobs-ai", "paw-engineering"];

// Repos that have CI workflows worth tracking
const CI_REPO_NAMES = new Set([
  "paw-hub", "paw-portal", "lobs-core", "trident", "ship-api",
]);

// In-memory cache with TTLs
interface CacheEntry<T> { data: T; ts: number; }
const cache: Record<string, CacheEntry<any>> = {};
const CACHE_TTL_MS = 120_000; // 2 minutes
const REPO_CACHE_TTL_MS = 600_000; // 10 minutes for repo discovery

function cached<T>(key: string, ttl = CACHE_TTL_MS): T | null {
  const entry = cache[key];
  if (entry && (Date.now() - entry.ts) < ttl) return entry.data;
  return null;
}

function setCache<T>(key: string, data: T): T {
  cache[key] = { data, ts: Date.now() };
  return data;
}

// Async gh CLI exec — doesn't block the event loop
function ghExec(cmd: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Discover active (non-archived) repos from our orgs. Cached for 10 min. */
async function getActiveRepos(): Promise<string[]> {
  const hit = cached<string[]>("_repos", REPO_CACHE_TTL_MS);
  if (hit) return hit;

  const results = await Promise.allSettled(
    ORGS.map(async (org) => {
      const raw = await ghExec(
        `gh repo list ${org} --json nameWithOwner,isArchived,pushedAt --limit 30`,
        15_000,
      );
      const repos: Array<{ nameWithOwner: string; isArchived: boolean; pushedAt: string }> = JSON.parse(raw);
      // Only include non-archived repos pushed to in the last 30 days
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      return repos
        .filter((r) => !r.isArchived && r.pushedAt > cutoff)
        .map((r) => r.nameWithOwner);
    }),
  );

  const repos: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") repos.push(...r.value);
    else console.error("[github] repo discovery failed:", (r as PromiseRejectedResult).reason?.message ?? r);
  }

  return setCache("_repos", repos);
}

/** Get the subset of active repos that have CI. */
async function getCIRepos(): Promise<string[]> {
  const all = await getActiveRepos();
  return all.filter((r) => {
    const name = r.split("/")[1];
    return CI_REPO_NAMES.has(name);
  });
}

// Run gh commands in parallel for multiple repos
async function ghParallel<T>(
  repos: string[],
  cmdFn: (repo: string) => string,
  mapFn: (raw: any[], repo: string) => T[],
): Promise<T[]> {
  const results = await Promise.allSettled(
    repos.map(async (repo) => {
      const raw = await ghExec(cmdFn(repo));
      const parsed = JSON.parse(raw);
      return mapFn(Array.isArray(parsed) ? parsed : [], repo);
    }),
  );
  const items: T[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") items.push(...r.value);
    else console.error("[github] ghParallel rejected:", (r as PromiseRejectedResult).reason?.message ?? r);
  }
  return items;
}

export async function handleGitHubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  _parts: string[] = [],
): Promise<void> {
  // GET /api/github/prs — aggregate PRs across repos
  if (sub === "prs" && req.method === "GET") {
    const hit = cached<any>("prs");
    if (hit) return json(res, hit);

    const query = parseQuery(req.url ?? "");
    const limit = parseInt(query.limit ?? "20", 10);
    const repos = await getActiveRepos();

    try {
      const allPRs = await ghParallel(
        repos,
        (repo) => `gh pr list --repo ${repo} --json number,title,state,author,createdAt,url --limit ${limit}`,
        (parsed, repo) => parsed.map((pr: any) => ({ ...pr, repo })),
      );

      allPRs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return json(res, setCache("prs", { prs: allPRs.slice(0, limit * 2) }));
    } catch (err) {
      return error(res, `Failed to fetch PRs: ${String(err)}`, 500);
    }
  }

  // GET /api/github/ci — aggregate CI runs across repos
  if (sub === "ci" && req.method === "GET") {
    const hit = cached<any>("ci");
    if (hit) return json(res, hit);

    const query = parseQuery(req.url ?? "");
    const limit = parseInt(query.limit ?? "20", 10);
    const ciRepos = await getCIRepos();

    try {
      const allRuns = await ghParallel(
        ciRepos,
        (repo) => `gh run list --repo ${repo} --json name,status,conclusion,createdAt,url --limit ${limit}`,
        (parsed, repo) => parsed.map((run: any) => ({ ...run, repo })),
      );

      allRuns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return json(res, setCache("ci", { runs: allRuns.slice(0, limit * 2) }));
    } catch (err) {
      return error(res, `Failed to fetch CI runs: ${String(err)}`, 500);
    }
  }

  if (sub === "feed" && req.method === "GET") {
    const hit = cached<GitHubFeedResponse>("feed");
    if (hit) return json(res, hit);

    const query = parseQuery(req.url ?? "");
    const limit = parseInt(query.limit ?? "30", 10);
    const repos = await getActiveRepos();
    const ciRepos = await getCIRepos();

    try {
      const events: GitHubEvent[] = [];
      let recentCommits = 0;
      let totalPRs = 0;
      let failedCI = 0;
      const seenUrls = new Set<string>();

      // Run all three data fetches in parallel
      const [commitResults, prResults, ciResults] = await Promise.all([
        // 1. Commits — parallel across repos
        ghParallel(
          repos,
          (repo) =>
            `gh api /repos/${repo}/commits?per_page=5 --jq '[.[] | {sha: .sha, message: .commit.message, author: .author.login, date: .commit.author.date, url: .html_url}]'`,
          (parsed, repo) => parsed.map((c: any) => ({ ...c, repo })),
        ),
        // 2. PRs — parallel across repos
        ghParallel(
          repos,
          (repo) => `gh pr list --repo ${repo} --state all --json title,author,createdAt,url --limit 5`,
          (parsed, repo) => parsed.map((pr: any) => ({ ...pr, repo })),
        ),
        // 3. Failed CI — parallel across repos
        ghParallel(
          ciRepos,
          (repo) =>
            `gh run list --repo ${repo} --status failure --json name,conclusion,createdAt,url --limit 3`,
          (parsed, repo) => parsed.map((run: any) => ({ ...run, repo })),
        ),
      ]);

      // Process commits
      for (const c of commitResults) {
        const url = c.url ?? `https://github.com/${c.repo}`;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        recentCommits++;
        const msg = (c.message ?? "").split("\n")[0].slice(0, 120);
        events.push({
          type: "push",
          title: msg || "Push",
          repo: c.repo,
          author: c.author ?? "unknown",
          timestamp: c.date,
          url,
        });
      }

      // Process PRs
      for (const pr of prResults) {
        const url = pr.url ?? "";
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        totalPRs++;
        events.push({
          type: "pr",
          title: pr.title ?? "PR",
          repo: pr.repo,
          author: pr.author?.login ?? "unknown",
          timestamp: pr.createdAt,
          url,
        });
      }

      // Process failed CI
      failedCI = ciResults.length;
      for (const run of ciResults) {
        const url = run.url ?? "";
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        events.push({
          type: "ci",
          title: `CI failed: ${run.name}`,
          repo: run.repo?.split("/")[1] ?? run.repo,
          author: "github-actions",
          timestamp: run.createdAt,
          url,
        });
      }

      // Sort by timestamp descending
      events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const feed: GitHubFeedResponse = {
        events: events.slice(0, limit),
        summary: { recentCommits, totalPRs, failedCI },
      };

      return json(res, setCache("feed", feed));
    } catch (err) {
      return error(res, `Failed to build GitHub feed: ${String(err)}`, 500);
    }
  }

  // ── POST /api/github/webhook ──────────────────────────────────────────────
  if (req.method === "POST" && sub === "webhook") {
    return handleGitHubWebhook(req, res);
  }

  return error(res, "Not found", 404);
}

// ── GitHub Webhook ─────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
// Discord channel to notify on new PR reviews (Lobs Lab #alerts or similar)
const DISCORD_ALERTS_CHANNEL = process.env.DISCORD_ALERTS_CHANNEL ?? "1466921249421660415";

function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) {
    // If no secret configured, skip verification (dev mode)
    console.warn("[github-webhook] No GITHUB_WEBHOOK_SECRET configured — skipping signature verification");
    return true;
  }
  if (!signature) return false;

  const expected = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

type PrAction = "opened" | "synchronize" | "reopened" | "closed" | "edited" | string;

interface GitHubPrPayload {
  action: PrAction;
  number: number;
  pull_request: {
    title: string;
    html_url: string;
    draft: boolean;
    user: { login: string };
    head: { sha: string };
    state: string;
  };
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
  };
  sender: { login: string };
}

async function handleGitHubWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawBody = await readRawBody(req);
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const event = req.headers["x-github-event"] as string | undefined;

  // Verify signature
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn("[github-webhook] Signature verification failed");
    return error(res, "Invalid webhook signature", 401);
  }

  // Parse body
  let payload: GitHubPrPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf-8")) as GitHubPrPayload;
  } catch {
    return error(res, "Invalid JSON payload", 400);
  }

  // Only handle pull_request events for opened/synchronize actions
  if (event !== "pull_request") {
    return json(res, { ok: true, message: `Ignored event: ${event}` });
  }

  const { action, number: prNumber, pull_request: pr, repository: repo } = payload;

  if (!["opened", "synchronize", "reopened"].includes(action)) {
    return json(res, { ok: true, message: `Ignored PR action: ${action}` });
  }

  // Skip draft PRs
  if (pr.draft) {
    return json(res, { ok: true, message: "Skipped draft PR" });
  }

  const owner = repo.owner.login;
  const repoName = repo.name;

  console.log(`[github-webhook] PR #${prNumber} ${action} in ${owner}/${repoName}: "${pr.title}"`);

  // Acknowledge immediately — review runs async
  json(res, { ok: true, message: `Review queued for PR #${prNumber}` });

  // Run review async
  void runWebhookReview(owner, repoName, prNumber, pr.title, pr.html_url);
}

async function runWebhookReview(
  owner: string,
  repo: string,
  prNumber: number,
  prTitle: string,
  prUrl: string,
): Promise<void> {
  const startedAt = Date.now();
  try {
    console.log(`[github-webhook] Starting review for ${owner}/${repo}#${prNumber}`);

    const review = await runCodeReview(owner, repo, prNumber, { postReview: true });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const riskEmoji = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" }[review.riskLevel];
    const mergeEmoji = { ready: "✅", "needs-changes": "⚠️", blocked: "🚫" }[review.mergeReadiness];
    const issueCount = review.overallIssues.length + review.fileReviews.reduce((n, fr) => n + fr.issues.length, 0);

    // ── Coverage Analysis ────────────────────────────────────────────────────
    let coverageLine = "";
    if (review.testCoverage !== "adequate") {
      try {
        const prFiles = await fetchPrFilesForCoverage(owner, repo, prNumber);
        const coverageReport = await analyzeCoverage(prFiles, review);

        // Post a second PR comment with test stubs if coverage is lacking
        if (
          (coverageReport.coverage === "missing" || coverageReport.coverage === "minimal") &&
          coverageReport.suggestions.length > 0
        ) {
          const commentBody = formatCoverageComment(coverageReport);
          await postCoverageComment(owner, repo, prNumber, commentBody);
          console.log(`[github-webhook] Coverage stubs posted for ${owner}/${repo}#${prNumber}`);
        }

        const stubCount = coverageReport.suggestions.length;
        coverageLine = `\n🧪 Coverage: ${coverageReport.coverage} — ${stubCount} suggested stub${stubCount !== 1 ? "s" : ""}`;
      } catch (coverageErr) {
        console.warn(`[github-webhook] Coverage analysis failed:`, coverageErr);
        // Non-fatal — code review already posted successfully
      }
    }

    const discordMsg = [
      `## 🤖 Code Review: \`${owner}/${repo}#${prNumber}\``,
      `**${prTitle}**`,
      `${prUrl}`,
      ``,
      `${mergeEmoji} **${review.mergeReadiness.toUpperCase()}** · ${riskEmoji} Risk: ${review.riskLevel} · ${issueCount} issue(s) · ${elapsed}s${coverageLine}`,
      ``,
      review.summary,
    ].join("\n");

    await discordService.send(DISCORD_ALERTS_CHANNEL, discordMsg);
    console.log(`[github-webhook] Review posted for ${owner}/${repo}#${prNumber} in ${elapsed}s`);
  } catch (err) {
    console.error(`[github-webhook] Review failed for ${owner}/${repo}#${prNumber}:`, err);

    // Notify Discord on failure too
    try {
      await discordService.send(
        DISCORD_ALERTS_CHANNEL,
        `⚠️ Code review failed for **${owner}/${repo}#${prNumber}** (${prTitle})\nError: ${String(err)}\n${prUrl}`,
      );
    } catch {
      // ignore discord error
    }
  }
}

