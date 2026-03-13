import type { IncomingMessage, ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import { json, error, parseQuery } from "./index.js";

/**
 * GitHub feed endpoint — aggregate GitHub activity.
 * 
 * GET /api/github/feed?limit=30 → recent GitHub events + summary
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

// Simple in-memory cache with 60s TTL
let cachedFeed: GitHubFeedResponse | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

export async function handleGitHubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  _parts: string[] = [],
): Promise<void> {
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

      // Fetch recent events from thelobsbot
      try {
        const userEvents = execSync(
          `gh api /users/thelobsbot/received_events --jq '.[0:${Math.min(limit, 30)}]'`,
          { encoding: "utf-8", timeout: 5000 }
        );
        const parsed = JSON.parse(userEvents);
        
        for (const evt of parsed) {
          if (evt.type === "PushEvent") {
            recentCommits += evt.payload?.commits?.length ?? 0;
            events.push({
              type: "push",
              title: `Pushed ${evt.payload?.commits?.length ?? 0} commits`,
              repo: evt.repo?.name ?? "unknown",
              author: evt.actor?.login ?? "unknown",
              timestamp: evt.created_at,
              url: `https://github.com/${evt.repo?.name}`,
            });
          } else if (evt.type === "PullRequestEvent") {
            totalPRs++;
            events.push({
              type: "pr",
              title: evt.payload?.pull_request?.title ?? "PR",
              repo: evt.repo?.name ?? "unknown",
              author: evt.actor?.login ?? "unknown",
              timestamp: evt.created_at,
              url: evt.payload?.pull_request?.html_url ?? "",
            });
          } else if (evt.type === "IssuesEvent") {
            events.push({
              type: "issue",
              title: evt.payload?.issue?.title ?? "Issue",
              repo: evt.repo?.name ?? "unknown",
              author: evt.actor?.login ?? "unknown",
              timestamp: evt.created_at,
              url: evt.payload?.issue?.html_url ?? "",
            });
          }
        }
      } catch (err) {
        console.error("Failed to fetch user events:", err);
      }

      // Fetch org events (lobs-ai)
      try {
        const lobsOrgEvents = execSync(
          `gh api /orgs/lobs-ai/events --jq '.[0:10]'`,
          { encoding: "utf-8", timeout: 5000 }
        );
        const parsed = JSON.parse(lobsOrgEvents);
        
        for (const evt of parsed) {
          if (evt.type === "PushEvent") {
            recentCommits += evt.payload?.commits?.length ?? 0;
          }
          // Add to events if not duplicate
          if (!events.some(e => e.url === evt.payload?.pull_request?.html_url)) {
            if (evt.type === "PullRequestEvent") {
              totalPRs++;
              events.push({
                type: "pr",
                title: evt.payload?.pull_request?.title ?? "PR",
                repo: evt.repo?.name ?? "unknown",
                author: evt.actor?.login ?? "unknown",
                timestamp: evt.created_at,
                url: evt.payload?.pull_request?.html_url ?? "",
              });
            }
          }
        }
      } catch (err) {
        console.error("Failed to fetch lobs-ai org events:", err);
      }

      // Fetch org events (paw-engineering)
      try {
        const pawOrgEvents = execSync(
          `gh api /orgs/paw-engineering/events --jq '.[0:10]'`,
          { encoding: "utf-8", timeout: 5000 }
        );
        const parsed = JSON.parse(pawOrgEvents);
        
        for (const evt of parsed) {
          if (evt.type === "PushEvent") {
            recentCommits += evt.payload?.commits?.length ?? 0;
          }
          if (!events.some(e => e.url === evt.payload?.pull_request?.html_url)) {
            if (evt.type === "PullRequestEvent") {
              totalPRs++;
              events.push({
                type: "pr",
                title: evt.payload?.pull_request?.title ?? "PR",
                repo: evt.repo?.name ?? "unknown",
                author: evt.actor?.login ?? "unknown",
                timestamp: evt.created_at,
                url: evt.payload?.pull_request?.html_url ?? "",
              });
            }
          }
        }
      } catch (err) {
        console.error("Failed to fetch paw-engineering org events:", err);
      }

      // Check for failed CI runs
      const repos = ["paw-engineering/paw-hub", "lobs-ai/lobs-core"];
      for (const repo of repos) {
        try {
          const failedRuns = execSync(
            `gh run list --repo ${repo} --status failure --json name,conclusion,createdAt,url --limit 3`,
            { encoding: "utf-8", timeout: 5000 }
          );
          const parsed = JSON.parse(failedRuns);
          failedCI += parsed.length;
          
          for (const run of parsed) {
            events.push({
              type: "ci",
              title: `CI failed: ${run.name}`,
              repo: repo.split("/")[1],
              author: "github-actions",
              timestamp: run.createdAt,
              url: run.url ?? "",
            });
          }
        } catch (err) {
          // Repo might not exist or have CI, skip silently
        }
      }

      // Sort by timestamp descending
      events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Limit events
      const limitedEvents = events.slice(0, limit);

      const response: GitHubFeedResponse = {
        events: limitedEvents,
        summary: {
          recentCommits,
          totalPRs,
          failedCI,
        },
      };

      // Update cache
      cachedFeed = response;
      cacheTimestamp = now;

      return json(res, response);
    } catch (err) {
      return error(res, `Failed to fetch GitHub feed: ${String(err)}`, 500);
    }
  }

  return error(res, "Invalid GitHub endpoint", 404);
}
