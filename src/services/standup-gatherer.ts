/**
 * standup-gatherer.ts — Pre-gathers data for standup cron jobs
 * 
 * Runs before the LLM fires so the agent spends tokens on thinking,
 * not gathering. Collects:
 * - Recent git activity across PAW repos
 * - Open PRs
 * - Open issues
 * - Task DB state
 * - Recent memory entries
 * 
 * Returns a formatted string that gets injected as a tool result
 * into the agent's conversation.
 */

import { execSync } from "child_process";

const PAW_REPOS = [
  "paw-hub",
  "paw-site",
  "paw-portal",
  "lobs-sets-sail",
  "trident",
  "ship-api",
  "paw-tts",
  "version-claw",
  "service-sdk",
  "paw-plugin",
];

const PAW_DIR = `${process.env.HOME}/paw`;
const GH_ORG = "paw-engineering";

function run(cmd: string, timeout = 15_000): string {
  try {
    return execSync(cmd, {
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      shell: "/bin/bash",
      env: { ...process.env, HOME: process.env.HOME },
    }).trim();
  } catch {
    return "";
  }
}

function getRecentGitActivity(hours = 6): string {
  const since = `${hours} hours ago`;
  const sections: string[] = [];

  for (const repo of PAW_REPOS) {
    const repoPath = `${PAW_DIR}/${repo}`;
    const log = run(
      `cd "${repoPath}" 2>/dev/null && git log --all --oneline --since="${since}" --format="%h %s (%an, %ar)" 2>/dev/null | head -10`,
    );
    if (log) {
      sections.push(`### ${repo}\n${log}`);
    }
  }

  return sections.length > 0
    ? sections.join("\n\n")
    : "No git activity in the last " + hours + " hours.";
}

function getOpenPRs(): string {
  const prs = run(
    `gh pr list --org ${GH_ORG} --state open --json repository,title,number,author,createdAt,url --limit 20 2>/dev/null`,
  );
  if (!prs) return "Could not fetch PRs (gh CLI error or no PRs).";

  try {
    const parsed = JSON.parse(prs) as Array<{
      repository: { name: string };
      title: string;
      number: number;
      author: { login: string };
      url: string;
    }>;
    if (parsed.length === 0) return "No open PRs.";
    return parsed
      .map(
        (pr) =>
          `- **${pr.repository?.name ?? "?"}#${pr.number}** ${pr.title} (by ${pr.author?.login ?? "?"}) — ${pr.url}`,
      )
      .join("\n");
  } catch {
    return "Could not parse PR data.";
  }
}

function getOpenIssues(): string {
  // Get issues across key repos
  const issues: string[] = [];
  for (const repo of ["paw-hub", "lobs-sets-sail", "trident", "paw-portal"]) {
    const result = run(
      `gh issue list --repo ${GH_ORG}/${repo} --state open --json title,number,labels,assignees --limit 10 2>/dev/null`,
    );
    if (!result) continue;
    try {
      const parsed = JSON.parse(result) as Array<{
        title: string;
        number: number;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
      }>;
      if (parsed.length === 0) continue;
      const lines = parsed.map(
        (i) =>
          `- **${repo}#${i.number}** ${i.title}${i.labels?.length ? ` [${i.labels.map((l) => l.name).join(", ")}]` : ""}`,
      );
      issues.push(`### ${repo}\n${lines.join("\n")}`);
    } catch {
      continue;
    }
  }
  return issues.length > 0 ? issues.join("\n\n") : "No open issues found.";
}

function getRecentMemory(): string {
  // Read today's and yesterday's memory files
  const today = new Date()
    .toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const yesterday = new Date(Date.now() - 86400000)
    .toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const sections: string[] = [];
  for (const date of [today, yesterday]) {
    const content = run(
      `cat "${process.env.HOME}/.lobs/agents/main/context/memory/${date}.md" 2>/dev/null | tail -50`,
    );
    if (content) {
      sections.push(`### Memory ${date}\n${content}`);
    }
  }
  return sections.length > 0
    ? sections.join("\n\n")
    : "No recent memory entries.";
}

function getTaskState(): string {
  const dbPath = `${process.env.HOME}/.lobs/lobs.db`;
  const tasks = run(
    `sqlite3 "${dbPath}" "SELECT id, title, status, priority FROM tasks WHERE status NOT IN ('done', 'cancelled') ORDER BY priority DESC LIMIT 15;" 2>/dev/null`,
  );
  if (!tasks) return "No active tasks or DB unavailable.";
  const lines = tasks.split("\n").map((line) => {
    const [id, title, status, priority] = line.split("|");
    return `- [${status}] ${title} (priority: ${priority ?? "?"})`;
  });
  return lines.join("\n");
}

/**
 * Gather all standup data and return a formatted string.
 * This runs synchronously (via execSync) to keep it simple —
 * total runtime should be <30s even if some commands timeout.
 */
export function gatherStandupData(): string {
  const startMs = Date.now();

  const gitActivity = getRecentGitActivity(8);
  const openPRs = getOpenPRs();
  const openIssues = getOpenIssues();
  const taskState = getTaskState();
  const recentMemory = getRecentMemory();

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  return [
    `# Standup Data (gathered in ${elapsed}s)`,
    "",
    "## Recent Git Activity (last 8 hours)",
    gitActivity,
    "",
    "## Open Pull Requests",
    openPRs,
    "",
    "## Open Issues",
    openIssues,
    "",
    "## Active Tasks",
    taskState,
    "",
    "## Recent Memory",
    recentMemory,
  ].join("\n");
}
