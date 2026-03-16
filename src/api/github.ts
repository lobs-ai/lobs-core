import type { IncomingMessage, ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import { json, error, parseQuery } from "./index.js";

/**
 * GitHub feed endpoint — aggregate GitHub activity.
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

const REPOS = [
  "lobs-ai/lobs-core",
  "lobs-ai/lobs-nexus",
  "lobs-ai/lobs-memory",
  "paw-engineering/paw-hub",
  "paw-engineering/paw-portal",
  "paw-engineering/ship-api",
  "paw-engineering/paw-site",
  "paw-engineering/paw-plugin",
];

const CI_REPOS = [
  "paw-engineering/paw-hub",
  "paw-engineering/paw-portal",
  "lobs-ai/lobs-core",
];

// Simple in-memory cache with 60s TTL
let cachedFeed: GitHubFeedResponse | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

function ghExec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 8000 });
}

export async function handleGitHubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  _parts: string[] = [],
): Promise<void> {
  // GET /api/github/prs — aggregate PRs across repos
  if (sub === "prs" && req.method === "GET") {
    const query = parseQuery(req.url ?? "");
    const limit = parseInt(query.limit ?? "20", 10);

    try {
      const allPRs: any[] = [];
      for (const repo of REPOS) {
        try {
          const prs = ghExec(
            `gh pr list --repo ${repo} --json number,title,state,author,createdAt,url --limit ${limit}`
          );
          const parsed = JSON.parse(prs);
          allPRs.push(...parsed.map((pr: any) => ({ ...pr, repo })));
        } catch {
          // skip
        }
      }

      allPRs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return json(res, { prs: allPRs.slice(0, limit * 2) });
    } catch (err) {
      return error(res, `Failed to fetch PRs: ${String(err)}`, 500);
    }
  }

  // GET /api/github/ci — aggregate CI runs across repos
  if (sub === "ci" && req.method === "GET") {
    const query = parseQuery(req.url ?? "");
    const limit = parseInt(query.limit ?? "20", 10);

    try {
      const allRuns: any[] = [];
      for (const repo of CI_REPOS) {
        try {
          const runs = ghExec(
            `gh run list --repo ${repo} --json name,status,conclusion,createdAt,url --limit ${limit}`
          );
          const parsed = JSON.parse(runs);
          allRuns.push(...parsed.map((run: any) => ({ ...run, repo })));
        } catch {
          // skip
        }
      }

      allRuns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return json(res, { runs: allRuns.slice(0, limit * 2) });
    } catch (err) {
      return error(res, `Failed to fetch CI runs: ${String(err)}`, 500);
    }
  }

  if (sub === "feed" && req.method === "GET") {
    // Check cache
    const now = Date.now();
    if (cachedFeed && (now - cacheTimestamp) < CACHE_TTL_MS) {
      return json(res, cachedFeed);
    }

    const query = parseQuery(req.url ?? "");
    const limit = parseInt(query.limit ?? "30", 10);

    try {
      const events: GitHubEvent[] = [];
      let recentCommits = 0;
      let totalPRs = 0;
      let failedCI = 0;
      const seenUrls = new Set<string>();

      // 1. Fetch recent commits per repo (gives us actual commit data)
      for (const repo of REPOS) {
        try {
          const commits = ghExec(
            `gh api /repos/${repo}/commits?per_page=5 --jq '[.[] | {sha: .sha, message: .commit.message, author: .author.login, date: .commit.author.date, url: .html_url}]'`
          );
          const parsed = JSON.parse(commits);
          for (const c of parsed) {
            const url = c.url ?? `https://github.com/${repo}`;
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            recentCommits++;
            // First line of commit message
            const msg = (c.message ?? "").split("\n")[0].slice(0, 120);
            events.push({
              type: "push",
              title: msg || "Push",
              repo,
              author: c.author ?? "unknown",
              timestamp: c.date,
              url,
            });
          }
        } catch {
          // skip
        }
      }

      // 2. Fetch recent PRs across repos
      for (const repo of REPOS) {
        try {
          const prs = ghExec(
            `gh pr list --repo ${repo} --state all --json title,author,createdAt,url --limit 5`
          );
          const parsed = JSON.parse(prs);
          for (const pr of parsed) {
            const url = pr.url ?? "";
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            totalPRs++;
            events.push({
              type: "pr",
              title: pr.title ?? "PR",
              repo,
              author: pr.author?.login ?? "unknown",
              timestamp: pr.createdAt,
              url,
            });
          }
        } catch {
          // skip
        }
      }

      // 3. Check for failed CI runs
      for (const repo of CI_REPOS) {
        try {
          const failedRuns = ghExec(
            `gh run list --repo ${repo} --status failure --json name,conclusion,createdAt,url --limit 3`
          );
          const parsed = JSON.parse(failedRuns);
          failedCI += parsed.length;

          for (const run of parsed) {
            const url = run.url ?? "";
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            events.push({
              type: "ci",
              title: `CI failed: ${run.name}`,
              repo: repo.split("/")[1],
              author: "github-actions",
              timestamp: run.createdAt,
              url,
            });
          }
        } catch {
          // skip
        }
      }

      // Sort by timestamp descending
      events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const feed: GitHubFeedResponse = {
        events: events.slice(0, limit),
        summary: { recentCommits, totalPRs, failedCI },
      };

      // Update cache
      cachedFeed = feed;
      cacheTimestamp = now;

      return json(res, feed);
    } catch (err) {
      return error(res, `Failed to build GitHub feed: ${String(err)}`, 500);
    }
  }

  return error(res, "Not found", 404);
}
