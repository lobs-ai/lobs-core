/**
 * Code Review Service
 *
 * Extracted from prototypes/code-review/code-review-agent.ts
 * Provides a reusable PR review engine that can be triggered by webhook events.
 *
 * Cost: ~$0.003/PR at claude-haiku-4-5 pricing for typical diffs.
 */

import Anthropic from "@anthropic-ai/sdk";

// ── Config ─────────────────────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const DEFAULT_MODEL = "claude-haiku-4-5";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PrMetadata {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  body: string | null;
  author: string;
  baseBranch: string;
  headBranch: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  url: string;
}

export interface FileDiff {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch: string | null;
  previousFilename?: string;
}

export interface FileReview {
  filename: string;
  summary: string;
  issues: ReviewIssue[];
  positives: string[];
  complexity: "low" | "medium" | "high";
}

export interface ReviewIssue {
  severity: "critical" | "major" | "minor" | "suggestion";
  type: "bug" | "security" | "performance" | "style" | "logic" | "test" | "docs";
  description: string;
  line?: number;
  suggestion?: string;
}

export interface PrReview {
  pr: PrMetadata;
  intent: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  riskFactors: string[];
  mergeReadiness: "ready" | "needs-changes" | "blocked";
  summary: string;
  fileReviews: FileReview[];
  overallIssues: ReviewIssue[];
  breakingChanges: string[];
  testCoverage: "adequate" | "minimal" | "missing";
  recommendations: string[];
  estimatedReviewTime: string;
}

export interface CodeReviewOptions {
  postReview?: boolean;   // Post back to GitHub as a PR comment
  model?: string;         // Override default model
  maxFiles?: number;      // Max files to review (default: 10)
}

// ── GitHub API ────────────────────────────────────────────────────────────────

function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "lobs-code-review/1.0",
  };
  const tok = token ?? process.env.GITHUB_TOKEN;
  if (tok) headers["Authorization"] = `token ${tok}`;
  return headers;
}

async function githubFetch(url: string, token?: string): Promise<unknown> {
  const resp = await fetch(url, { headers: githubHeaders(token) });
  if (resp.status === 403) {
    const remaining = resp.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = resp.headers.get("x-ratelimit-reset");
      const resetDate = reset ? new Date(parseInt(reset) * 1000).toISOString() : "unknown";
      throw new Error(`GitHub rate limit exceeded. Resets at ${resetDate}.`);
    }
  }
  if (!resp.ok) {
    throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function fetchPrMetadata(owner: string, repo: string, prNumber: number, token?: string): Promise<PrMetadata> {
  const data = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    token,
  ) as {
    title: string;
    body: string | null;
    user: { login: string };
    base: { ref: string };
    head: { ref: string };
    additions: number;
    deletions: number;
    changed_files: number;
    created_at: string;
    html_url: string;
  };

  return {
    owner,
    repo,
    prNumber,
    title: data.title,
    body: data.body,
    author: data.user.login,
    baseBranch: data.base.ref,
    headBranch: data.head.ref,
    additions: data.additions,
    deletions: data.deletions,
    changedFiles: data.changed_files,
    createdAt: data.created_at,
    url: data.html_url,
  };
}

async function fetchPrFiles(owner: string, repo: string, prNumber: number, token?: string): Promise<FileDiff[]> {
  const data = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    token,
  ) as Array<{
    filename: string;
    status: "added" | "removed" | "modified" | "renamed";
    additions: number;
    deletions: number;
    patch?: string;
    previous_filename?: string;
  }>;

  return data.map(f => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
    previousFilename: f.previous_filename,
  }));
}

// ── LLM Calls ─────────────────────────────────────────────────────────────────

function makeLLM(apiKey?: string) {
  return new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
}

async function llm(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  model = DEFAULT_MODEL
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return (response.content[0] as { text: string }).text.trim();
}

async function understandIntent(client: Anthropic, pr: PrMetadata, files: FileDiff[], model: string): Promise<string> {
  const filesSummary = files.map(f =>
    `${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`
  ).join("\n");

  const system = `You are a senior software engineer reviewing a pull request.
Your job is to understand the *intent* of this PR — what problem it solves, what it changes, and why.
Be specific and direct. 1-3 sentences. Don't mention the author or reviewer.`;

  const user = `PR Title: ${pr.title}
PR Description: ${pr.body ?? "(no description)"}
Branch: ${pr.headBranch} → ${pr.baseBranch}
Files changed (${pr.changedFiles}):
${filesSummary}

What is the intent and purpose of this PR?`;

  return llm(client, system, user, model);
}

async function reviewFile(client: Anthropic, file: FileDiff, prContext: string, model: string): Promise<FileReview> {
  if (!file.patch) {
    return {
      filename: file.filename,
      summary: `File ${file.status} (no diff available)`,
      issues: [],
      positives: [],
      complexity: "low",
    };
  }

  const system = `You are a senior software engineer reviewing a code change.
Analyze the diff and identify issues. Be concrete and actionable.

Return JSON only (no markdown, no explanation outside the JSON):
{
  "summary": "1-2 sentence description of what changed",
  "complexity": "low|medium|high",
  "positives": ["what's done well"],
  "issues": [
    {
      "severity": "critical|major|minor|suggestion",
      "type": "bug|security|performance|style|logic|test|docs",
      "description": "clear description",
      "line": <line number in diff if applicable, or omit>,
      "suggestion": "how to fix it"
    }
  ]
}`;

  const user = `PR context: ${prContext}

File: ${file.filename} (${file.status})
Diff:
\`\`\`diff
${file.patch.slice(0, 4000)}${file.patch.length > 4000 ? "\n... (diff truncated)" : ""}
\`\`\``;

  const raw = await llm(client, system, user, model);

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]) as Omit<FileReview, "filename">;
    return { filename: file.filename, ...parsed };
  } catch {
    return {
      filename: file.filename,
      summary: raw.slice(0, 200),
      issues: [],
      positives: [],
      complexity: "low",
    };
  }
}

async function synthesizeReview(
  client: Anthropic,
  pr: PrMetadata,
  intent: string,
  fileReviews: FileReview[],
  model: string,
): Promise<Omit<PrReview, "pr" | "intent" | "fileReviews">> {
  const reviewsSummary = fileReviews.map(fr => {
    const issues = fr.issues.map(i => `  [${i.severity}/${i.type}] ${i.description}`).join("\n");
    return `File: ${fr.filename}\nComplexity: ${fr.complexity}\nSummary: ${fr.summary}\nIssues:\n${issues || "  None found"}`;
  }).join("\n\n");

  const system = `You are a senior engineering lead doing a final PR synthesis.
Produce a concise, actionable review for the PR author and code owners.
Return JSON only:
{
  "riskLevel": "low|medium|high|critical",
  "riskFactors": ["list of specific risks"],
  "mergeReadiness": "ready|needs-changes|blocked",
  "summary": "2-3 sentences explaining what this PR does and whether it's safe to merge",
  "overallIssues": [{ "severity": "critical|major|minor|suggestion", "type": "bug|security|performance|style|logic|test|docs", "description": "...", "suggestion": "..." }],
  "breakingChanges": ["any breaking changes detected"],
  "testCoverage": "adequate|minimal|missing",
  "recommendations": ["actionable recommendations for the author"],
  "estimatedReviewTime": "e.g. 15 minutes"
}`;

  const user = `PR: ${pr.title}
Intent: ${intent}
Stats: +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} files

Per-file reviews:
${reviewsSummary}`;

  const raw = await llm(client, system, user, model);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Synthesis returned no JSON");
  return JSON.parse(jsonMatch[0]) as Omit<PrReview, "pr" | "intent" | "fileReviews">;
}

// ── Formatting ─────────────────────────────────────────────────────────────────

function severityEmoji(s: ReviewIssue["severity"]): string {
  return { critical: "🔴", major: "🟠", minor: "🟡", suggestion: "🔵" }[s];
}

function riskEmoji(r: PrReview["riskLevel"]): string {
  return { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" }[r];
}

function mergeEmoji(m: PrReview["mergeReadiness"]): string {
  return { ready: "✅", "needs-changes": "⚠️", blocked: "🚫" }[m];
}

export function formatReviewAsComment(review: PrReview): string {
  const lines: string[] = [
    `## 🤖 Code Review Agent`,
    ``,
    `**${mergeEmoji(review.mergeReadiness)} ${review.mergeReadiness.toUpperCase()}** · Risk: ${riskEmoji(review.riskLevel)} ${review.riskLevel} · Test coverage: ${review.testCoverage}`,
    ``,
    `### Intent`,
    review.intent,
    ``,
    `### Summary`,
    review.summary,
    ``,
  ];

  if (review.breakingChanges.length > 0) {
    lines.push(`### ⚠️ Breaking Changes`);
    review.breakingChanges.forEach(b => lines.push(`- ${b}`));
    lines.push(``);
  }

  if (review.overallIssues.length > 0) {
    lines.push(`### Issues`);
    review.overallIssues.forEach(issue => {
      lines.push(`${severityEmoji(issue.severity)} **[${issue.type}]** ${issue.description}`);
      if (issue.suggestion) lines.push(`  > 💡 ${issue.suggestion}`);
    });
    lines.push(``);
  }

  if (review.riskFactors.length > 0) {
    lines.push(`### Risk Factors`);
    review.riskFactors.forEach(r => lines.push(`- ${r}`));
    lines.push(``);
  }

  lines.push(`### Per-File Review`);
  review.fileReviews.forEach(fr => {
    const hasIssues = fr.issues.length > 0;
    lines.push(`<details>`);
    lines.push(`<summary><b>${fr.filename}</b> (${fr.complexity} complexity)${hasIssues ? ` — ${fr.issues.length} issue(s)` : " ✅"}</summary>`);
    lines.push(``);
    lines.push(fr.summary);
    if (fr.positives.length > 0) {
      lines.push(`\n**✅ Done well:**`);
      fr.positives.forEach(p => lines.push(`- ${p}`));
    }
    if (fr.issues.length > 0) {
      lines.push(`\n**Issues:**`);
      fr.issues.forEach(i => {
        lines.push(`${severityEmoji(i.severity)} **[${i.severity}/${i.type}]** ${i.description}`);
        if (i.suggestion) lines.push(`  > 💡 ${i.suggestion}`);
      });
    }
    lines.push(``);
    lines.push(`</details>`);
  });

  lines.push(``);

  if (review.recommendations.length > 0) {
    lines.push(`### Recommendations`);
    review.recommendations.forEach(r => lines.push(`- ${r}`));
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*Estimated review time: ${review.estimatedReviewTime} · Generated by lobs-code-review v1.0*`);

  return lines.join("\n");
}

// ── GitHub Comment Posting ─────────────────────────────────────────────────────

export async function postReviewComment(pr: PrMetadata, review: PrReview, token?: string): Promise<string> {
  const tok = token ?? process.env.GITHUB_TOKEN;
  if (!tok) throw new Error("No GITHUB_TOKEN — cannot post to GitHub");

  const body = formatReviewAsComment(review);
  const resp = await fetch(
    `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/issues/${pr.prNumber}/comments`,
    {
      method: "POST",
      headers: { ...githubHeaders(tok), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to post review comment: ${resp.status} ${await resp.text()}`);
  }

  const result = await resp.json() as { html_url: string };
  return result.html_url;
}

// ── Main Review Runner ─────────────────────────────────────────────────────────

export async function runCodeReview(
  owner: string,
  repo: string,
  prNumber: number,
  opts: CodeReviewOptions = {},
): Promise<PrReview> {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxFiles = opts.maxFiles ?? 10;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const client = makeLLM(apiKey);

  console.log(`[code-review] Starting review of ${owner}/${repo}#${prNumber} (model=${model})`);

  // Step 1: Fetch PR metadata
  const pr = await fetchPrMetadata(owner, repo, prNumber);
  console.log(`[code-review] PR: "${pr.title}" +${pr.additions}/-${pr.deletions}`);

  // Step 2: Fetch file diffs
  const allFiles = await fetchPrFiles(owner, repo, prNumber);
  const reviewableFiles = allFiles
    .filter(f => f.patch && f.additions + f.deletions < 500)
    .slice(0, maxFiles);
  console.log(`[code-review] ${allFiles.length} files, ${reviewableFiles.length} reviewable`);

  // Step 3: Understand intent
  const intent = await understandIntent(client, pr, allFiles, model);
  console.log(`[code-review] Intent: ${intent.slice(0, 100)}...`);

  // Step 4: Review each file sequentially (avoid parallel LLM calls for cost control)
  const fileReviews: FileReview[] = [];
  for (const file of reviewableFiles) {
    console.log(`[code-review] Reviewing ${file.filename}...`);
    const fr = await reviewFile(client, file, intent, model);
    fileReviews.push(fr);
  }

  // Step 5: Synthesize
  const synthesis = await synthesizeReview(client, pr, intent, fileReviews, model);

  const review: PrReview = {
    pr,
    intent,
    fileReviews,
    ...synthesis,
  };

  // Step 6: Post to GitHub if requested
  if (opts.postReview) {
    const commentUrl = await postReviewComment(pr, review);
    console.log(`[code-review] Posted review comment: ${commentUrl}`);
  }

  return review;
}
