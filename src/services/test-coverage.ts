/**
 * Test Coverage Analyzer
 *
 * Analyzes PR diffs to identify untested functions and generate concrete
 * test stubs. Runs after the code review to augment coverage feedback.
 *
 * Cost: ~$0.001/PR at claude-haiku-4-5 pricing.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { FileDiff, PrReview } from "./code-review.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TestStub {
  testFile: string;       // suggested path, e.g. "src/services/__tests__/foo.test.ts"
  description: string;   // what to test
  stubCode: string;       // actual test stub code (TypeScript/Bun test)
}

export interface CoverageReport {
  coverage: "adequate" | "minimal" | "missing";
  untestedFunctions: string[];   // function names added without tests
  suggestions: TestStub[];       // 2-4 concrete test stubs
  summary: string;               // 1-2 sentence human-readable summary
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-haiku-4-5";

// Patterns to extract function/method names from added lines in diffs
const FUNCTION_PATTERNS: RegExp[] = [
  /^[+]\s*export\s+(?:async\s+)?function\s+(\w+)\s*[(<]/,
  /^[+]\s*(?:async\s+)?function\s+(\w+)\s*[(<]/,
  /^[+]\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/,
  /^[+]\s*(?:export\s+)?const\s+(\w+)\s*=\s*async\s+\(/,
  /^[+]\s*(?:public|private|protected|static)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/,
  /^[+]\s*(?:export\s+)?(?:async\s+)?(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[\w<>\]|[]+)?\s*=>/,
];

// File patterns that indicate test files
const TEST_FILE_PATTERNS = [/test/, /spec/, /__tests__/];

// ── Function Extraction ───────────────────────────────────────────────────────

/**
 * Extract function/method names from the added lines of a diff patch.
 * Only processes lines starting with '+' (not '++' for diff headers).
 */
function extractFunctionsFromPatch(patch: string): string[] {
  const found = new Set<string>();
  const lines = patch.split("\n");

  for (const line of lines) {
    // Only look at added lines (skip diff headers "+++")
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    for (const pattern of FUNCTION_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1]) {
        const name = match[1];
        // Skip common false positives
        if (!["if", "for", "while", "switch", "catch", "return", "const", "let", "var", "new", "true", "false"].includes(name)) {
          found.add(name);
        }
        break; // First matching pattern wins per line
      }
    }
  }

  return [...found];
}

/**
 * Check whether any file in the PR is a test file.
 */
function hasTestFiles(files: FileDiff[]): boolean {
  return files.some(f => TEST_FILE_PATTERNS.some(p => p.test(f.filename)));
}

/**
 * For a given source file, derive the expected test file path.
 * e.g. "src/services/foo.ts" → "src/services/__tests__/foo.test.ts"
 */
function _deriveTestFilePath(sourceFile: string): string {
  const lastSlash = sourceFile.lastIndexOf("/");
  const dir = lastSlash >= 0 ? sourceFile.slice(0, lastSlash) : ".";
  const base = lastSlash >= 0 ? sourceFile.slice(lastSlash + 1) : sourceFile;
  // Strip extension
  const name = base.replace(/\.(ts|tsx|js|jsx|mts|mjs)$/, "");
  return `${dir}/__tests__/${name}.test.ts`;
}

// ── LLM Stub Generation ───────────────────────────────────────────────────────

async function generateTestStubs(
  files: FileDiff[],
  untestedFunctions: string[],
  review: PrReview,
  model: string,
): Promise<TestStub[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const client = new Anthropic({ apiKey });

  // Build a compact diff summary for the LLM
  const diffContext = files
    .filter(f => f.patch && !TEST_FILE_PATTERNS.some(p => p.test(f.filename)))
    .slice(0, 5)
    .map(f => {
      const addedLines = (f.patch ?? "")
        .split("\n")
        .filter(l => l.startsWith("+") && !l.startsWith("+++"))
        .slice(0, 40)
        .join("\n");
      return `### ${f.filename}\n${addedLines}`;
    })
    .join("\n\n");

  const system = `You are a senior TypeScript engineer writing test stubs for Bun's built-in test runner.
Use \`import { describe, it, expect, mock } from "bun:test"\`.
Write concrete, runnable stub skeletons — not pseudocode. Use \`// TODO: implement\` as the body placeholder.
Return a JSON array only (no markdown, no explanation):
[
  {
    "testFile": "src/services/__tests__/foo.test.ts",
    "description": "one-line description of what this stub tests",
    "stubCode": "import { describe, it, expect } from \\"bun:test\\";\n// actual stub code..."
  }
]
Generate 2-4 stubs total, prioritising the most important untested paths.`;

  const user = `PR: ${review.pr.title}
PR intent: ${review.intent}
Untested functions: ${untestedFunctions.join(", ") || "unknown — infer from diff"}

Changed source files (added lines only):
${diffContext.slice(0, 3000)}

Generate Bun test stubs for the untested functions above.`;

  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: user }],
  });

  const raw = (response.content[0] as { text: string }).text.trim();

  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]) as TestStub[];
  } catch {
    console.warn("[test-coverage] Failed to parse stub JSON:", raw.slice(0, 200));
    return [];
  }
}

// ── Main Analyzer ─────────────────────────────────────────────────────────────

/**
 * Analyze test coverage for a set of PR files given an existing code review.
 *
 * @param files  - All files in the PR (with patches)
 * @param review - The completed code review from runCodeReview()
 * @returns      CoverageReport with stubs if coverage is lacking
 */
export async function analyzeCoverage(
  files: FileDiff[],
  review: PrReview,
): Promise<CoverageReport> {
  const model = DEFAULT_MODEL;

  // 1. Determine coverage level
  const testFilesPresent = hasTestFiles(files);
  const sourceFiles = files.filter(
    f => !TEST_FILE_PATTERNS.some(p => p.test(f.filename))
      && f.patch
      && (f.additions > 0),
  );

  // Use the review's own testCoverage assessment as a starting point,
  // then refine with structural analysis
  let coverage: CoverageReport["coverage"];
  if (review.testCoverage === "adequate" && testFilesPresent) {
    coverage = "adequate";
  } else if (testFilesPresent) {
    coverage = "minimal";
  } else {
    coverage = "missing";
  }

  // 2. Extract untested functions from source file diffs
  const untestedFunctions: string[] = [];
  for (const file of sourceFiles) {
    const fns = extractFunctionsFromPatch(file.patch ?? "");
    untestedFunctions.push(...fns);
  }

  // Deduplicate
  const uniqueUntested = [...new Set(untestedFunctions)];

  // 3. Generate stubs only when coverage is lacking and there are untested functions
  let suggestions: TestStub[] = [];
  if (coverage !== "adequate" && (uniqueUntested.length > 0 || sourceFiles.length > 0)) {
    try {
      suggestions = await generateTestStubs(files, uniqueUntested, review, model);
    } catch (err) {
      console.warn("[test-coverage] Stub generation failed:", err);
    }
  }

  // 4. Build human-readable summary
  let summary: string;
  if (coverage === "adequate") {
    summary = `Test coverage looks adequate — test files were modified alongside source changes.`;
  } else if (coverage === "minimal") {
    summary = `Test files exist but were not updated in this PR. ${uniqueUntested.length > 0 ? `${uniqueUntested.length} new function(s) appear untested: ${uniqueUntested.slice(0, 3).join(", ")}${uniqueUntested.length > 3 ? "…" : ""}.` : "Consider adding tests for the changed logic."}`;
  } else {
    summary = `No test files were touched in this PR. ${uniqueUntested.length > 0 ? `${uniqueUntested.length} new function(s) lack test coverage: ${uniqueUntested.slice(0, 3).join(", ")}${uniqueUntested.length > 3 ? "…" : ""}.` : "New code was added without accompanying tests."}`;
  }

  return {
    coverage,
    untestedFunctions: uniqueUntested,
    suggestions,
    summary,
  };
}

// ── Comment Formatter ─────────────────────────────────────────────────────────

/**
 * Format a CoverageReport as a GitHub PR comment body.
 */
export function formatCoverageComment(report: CoverageReport): string {
  const lines: string[] = [
    `## 🧪 Test Coverage Suggestions`,
    ``,
    report.summary,
    ``,
  ];

  if (report.untestedFunctions.length > 0) {
    lines.push(`**Untested functions:** ${report.untestedFunctions.map(f => `\`${f}\``).join(", ")}`);
    lines.push(``);
  }

  if (report.suggestions.length > 0) {
    lines.push(`### Suggested Test Stubs`);
    lines.push(``);

    for (const stub of report.suggestions) {
      lines.push(`**${stub.testFile}** — ${stub.description}`);
      lines.push(``);
      lines.push("```typescript");
      lines.push(stub.stubCode);
      lines.push("```");
      lines.push(``);
    }
  }

  lines.push(`---`);
  lines.push(`*Coverage: \`${report.coverage}\` · ${report.untestedFunctions.length} untested function(s) · Generated by lobs-test-coverage v1.0*`);

  return lines.join("\n");
}

// ── Fetch helpers (duplicated from code-review to keep services independent) ──

const GITHUB_API = "https://api.github.com";

function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "lobs-test-coverage/1.0",
  };
  const tok = token ?? process.env.GITHUB_TOKEN;
  if (tok) headers["Authorization"] = `token ${tok}`;
  return headers;
}

async function githubFetch(url: string, token?: string): Promise<unknown> {
  const resp = await fetch(url, { headers: githubHeaders(token) });
  if (!resp.ok) {
    throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

/**
 * Fetch PR files for use in the Discord /test-stubs command.
 */
export async function fetchPrFilesForCoverage(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<FileDiff[]> {
  const data = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
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

/**
 * Post a coverage comment to a GitHub PR.
 */
export async function postCoverageComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token?: string,
): Promise<string> {
  const tok = token ?? process.env.GITHUB_TOKEN;
  if (!tok) throw new Error("No GITHUB_TOKEN — cannot post to GitHub");

  const resp = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: { ...githubHeaders(tok), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to post coverage comment: ${resp.status} ${await resp.text()}`);
  }

  const result = await resp.json() as { html_url: string };
  return result.html_url;
}

/**
 * Minimal stub PrReview for use when running coverage analysis standalone
 * (e.g. from the /test-stubs Discord command without a full code review).
 */
export function makeStubReview(owner: string, repo: string, prNumber: number): PrReview {
  return {
    pr: {
      owner,
      repo,
      prNumber,
      title: `PR #${prNumber}`,
      body: null,
      author: "unknown",
      baseBranch: "main",
      headBranch: "unknown",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      createdAt: new Date().toISOString(),
      url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    },
    intent: "Unknown — running coverage analysis standalone",
    riskLevel: "low",
    riskFactors: [],
    mergeReadiness: "needs-changes",
    summary: "",
    fileReviews: [],
    overallIssues: [],
    breakingChanges: [],
    testCoverage: "missing",
    recommendations: [],
    estimatedReviewTime: "unknown",
  };
}
