/**
 * Daily Scan — autonomous daily work-generation pipeline
 *
 * Runs every morning at 8 AM to ensure the system is never idle:
 * 1. GitHub issue/PR scan → create tasks for new items
 * 2. Code TODO/FIXME scan → create technical-debt tasks
 * 3. Reflection output capture → store strategic reflections
 * 4. Morning brief → parse and create actionable inbox tasks
 */

import { CronService } from "../services/cron.js";
import { getDb } from "../db.js";
import { task_create } from "./task.js";
import { logger } from "../utils/logger.js";
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const LOG = logger("daily-scan");

// Rate limit: max 10 GitHub API calls per batch
const GITHUB_BATCH_SIZE = 10;

// Repos to scan
const GITHUB_ORGS = ["lobs-ai", "paw-engineering"];

export async function runDailyScan(): Promise<void> {
  LOG.info("Starting daily scan...");

  try {
    // Step 1: GitHub issue/PR scan
    await scanGitHubIssues();

    // Step 2: Code TODO/FIXME scan
    await scanCodeTodos();

    // Step 3: Capture strategic reflections
    await captureReflections();

    // Step 4: Morning brief → actionable tasks
    await processMorningBrief();

    LOG.info("Daily scan complete.");
  } catch (err) {
    LOG.error("Daily scan failed", err);
  }
}

// ---------------------------------------------------------------------------
// Step 1: GitHub Issue/PR Scan
// ---------------------------------------------------------------------------

async function scanGitHubIssues(): Promise<void> {
  LOG.info("Scanning GitHub issues and PRs...");

  for (const org of GITHUB_ORGS) {
    try {
      const issues = await fetchGitHubIssues(org);
      for (const issue of issues) {
        await processGitHubIssue(org, issue);
      }
    } catch (err) {
      LOG.error(`GitHub scan failed for ${org}`, err);
      // Continue to next org — graceful degradation
    }
  }
}

interface GhIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  html_url: string;
  pull_request?: object;
}

async function fetchGitHubIssues(org: string): Promise<GhIssue[]> {
  // Use gh CLI for rate-limited API calls
  const output = execSync(
    `gh issue list --repo ${org} --state open --limit 50 --json number,title,state,labels,pullRequest,url`,
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
  );
  const items = JSON.parse(output) as GhIssue[];

  // Filter to batch size
  return items.slice(0, GITHUB_BATCH_SIZE);
}

async function processGitHubIssue(org: string, issue: GhIssue): Promise<void> {
  const db = getDb();

  // Check for existing task by title similarity
  const existing = db
    .prepare(
      `SELECT id FROM tasks WHERE title LIKE ? AND status IN ('inbox','active') LIMIT 1`
    )
    .get(`%${issue.title.slice(0, 80)}%`);

  if (existing) {
    LOG.debug(`Skipping duplicate issue #${issue.number}: ${issue.title}`);
    return;
  }

  // Determine priority from labels
  const hasHighLabel = issue.labels.some(
    (l) => typeof l === "string" && l.toLowerCase().includes("high")
  );
  const priority = hasHighLabel ? "high" : "medium";

  // Determine if it's a PR or issue
  const isPR = !!issue.pull_request;
  const type = isPR ? "code-review" : "feature-request";

  const title = `[${org}] ${isPR ? "PR" : "Issue"} #${issue.number}: ${issue.title}`;
  const notes = `Source: ${issue.html_url}\nLabels: ${issue.labels.join(", ") || "none"}`;

  await task_create({
    title,
    notes,
    priority,
    type,
    agent: "programmer",
    status: "inbox",
  });

  LOG.info(`Created task for ${org} ${isPR ? "PR" : "issue"} #${issue.number}`);
}

// ---------------------------------------------------------------------------
// Step 2: Code TODO/FIXME Scan
// ---------------------------------------------------------------------------

async function scanCodeTodos(): Promise<void> {
  LOG.info("Scanning code for TODOs and FIXMEs...");

  const searchPaths = [
    process.env.HOME + "/lobs/lobs-core/src",
    process.env.HOME + "/paw/paw-hub/src",
  ];

  for (const searchPath of searchPaths) {
    if (!existsSync(searchPath)) {
      LOG.warn(`Skipping non-existent path: ${searchPath}`);
      continue;
    }

    try {
      const output = execSync(
        `grep -rn "TODO\\|FIXME\\|HACK" "${searchPath}" 2>/dev/null | head -50`,
        { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
      );

      const lines = output.split("\n").filter(Boolean);
      for (const line of lines) {
        await processTodoLine(line, searchPath);
      }
    } catch {
      // grep returns non-zero when no matches — not an error
      LOG.debug(`No TODOs found in ${searchPath}`);
    }
  }
}

async function processTodoLine(line: string, basePath: string): Promise<void> {
  // Format: filepath:linenum:content
  const match = line.match(/^(.+?):(\d+):(.+)$/);
  if (!match) return;

  const [, filePath, lineNum, content] = match;
  const relativePath = filePath.replace(basePath + "/", "");

  // Check if a task already exists for this TODO
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM tasks WHERE title LIKE ? AND status IN ('inbox','active') LIMIT 1`
    )
    .get(`%${relativePath}:${lineNum}%`);

  if (existing) {
    LOG.debug(`Skipping duplicate TODO: ${relativePath}:${lineNum}`);
    return;
  }

  // Extract the TODO type
  const todoType = content.includes("FIXME")
    ? "bug"
    : content.includes("HACK")
    ? "technical-debt"
    : "technical-debt";

  const title = `[${todoType.toUpperCase()}] ${relativePath}:${lineNum} — ${content.trim()}`;
  const notes = `File: ${filePath}\nLine: ${lineNum}\nContent: ${content.trim()}`;

  await task_create({
    title,
    notes,
    priority: "medium",
    type: "technical-debt",
    agent: "programmer",
    status: "inbox",
  });

  LOG.info(`Created technical-debt task for ${relativePath}:${lineNum}`);
}

// ---------------------------------------------------------------------------
// Step 3: Reflection Output Capture
// ---------------------------------------------------------------------------

async function captureReflections(): Promise<void> {
  LOG.info("Capturing strategic reflections...");

  const reflectionsDir = process.env.HOME + "/lobs/lobs-memory/reflections";
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const outputPath = join(reflectionsDir, `${today}.md`);

  // Ensure directory exists
  if (!existsSync(reflectionsDir)) {
    mkdirSync(reflectionsDir, { recursive: true });
  }

  // Check if already captured today
  if (existsSync(outputPath)) {
    LOG.debug(`Reflection already captured for ${today}`);
    return;
  }

  // The reflection output is in the event log — we read it from the session
  // context or event stream. For now, capture the last 24 hours of reflection
  // events from the database.
  const db = getDb();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  interface ReflectionRow {
    id: number;
    content: string;
    created_at: string;
  }

  const reflections = db
    .prepare(
      `SELECT id, content, created_at FROM reflections WHERE created_at > ? ORDER BY created_at DESC LIMIT 20`
    )
    .all(yesterday) as ReflectionRow[];

  if (reflections.length === 0) {
    LOG.debug("No reflections found in the last 24 hours");
    return;
  }

  // Build reflection document
  let md = `# Strategic Reflections — ${today}\n\n`;
  md += `Captured ${reflections.length} reflection(s) from the last 24 hours.\n\n`;

  for (const r of reflections) {
    md += `## Reflection ${r.id} — ${r.created_at}\n\n`;
    md += r.content + "\n\n";
  }

  writeFileSync(outputPath, md, "utf-8");
  LOG.info(`Reflection saved to ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Step 4: Morning Brief → Actionable Tasks
// ---------------------------------------------------------------------------

interface MorningBriefTask {
  id: string;
  title: string;
  priority?: string;
  status: string;
  projectTitle?: string;
}

async function processMorningBrief(): Promise<void> {
  LOG.info("Processing morning brief for actionable tasks...");

  const db = getDb();

  // Get overdue and high-priority tasks from the morning brief context
  // The morning brief already runs and formats this data — we re-query to
  // extract actionable items
  interface TaskRow {
    id: string;
    title: string;
    priority: string;
    status: string;
    due_date: string | null;
    project_id: string | null;
  }

  const criticalTasks = db
    .prepare(
      `SELECT id, title, priority, status, due_date, project_id
       FROM tasks
       WHERE status IN ('inbox', 'active')
         AND (priority = 'high' OR due_date < date('now', '+3 days'))
       ORDER BY
         CASE WHEN priority = 'high' THEN 0 ELSE 1 END,
         due_date ASC
       LIMIT 10`
    )
    .all() as TaskRow[];

  for (const task of criticalTasks) {
    // Create a focused inbox item for each critical task
    const existing = db
      .prepare(
        `SELECT id FROM inboxItems WHERE title LIKE ? LIMIT 1`
      )
      .get(`%${task.title.slice(0, 50)}%`);

    if (existing) {
      LOG.debug(`Skipping duplicate morning brief item: ${task.title}`);
      continue;
    }

    // Inbox item for Rafe to review
    const { inbox_create } = await import("./inbox.js");
    await inbox_create({
      title: `[Morning Brief] ${task.title}`,
      content: `Priority: ${task.priority}\nStatus: ${task.status}\nDue: ${task.due_date || "none"}\n\nAction required: review and prioritize this task.`,
      category: "task-review",
    });

    LOG.info(`Created morning brief inbox item: ${task.title}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDailyScan(cronService: CronService): void {
  cronService.registerSystemJob({
    id: "daily-scan",
    name: "Daily Scan",
    schedule: "0 8 * * *", // 8 AM daily
    enabled: true,
    // Handler is dispatched via agent event — the cron triggers the "daily-scan" event
    // which the programmer agent handles by calling runDailyScan()
    handler: async () => {
      LOG.info("Daily scan cron triggered");
      // This will be picked up by the agent loop
    },
  });

  LOG.info("Registered daily-scan cron job (8 AM daily)");
}
