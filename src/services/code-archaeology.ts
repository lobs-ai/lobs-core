/**
 * Code Archaeology
 *
 * Answers "why does this code exist?" by mining git history.
 * Given a query (file path, function name, or concept), scans git log,
 * finds relevant commits, and uses an LLM to synthesize a narrative
 * explaining the history and intent.
 */

import { execSync } from "child_process";
import { callApiModelJSON } from "../workers/base-worker.js";

export interface ArchaeologyCommit {
  shortHash: string;
  fullHash: string;
  message: string;
  date: string;
  author: string;
  filesChanged: string[];
  significance: string;
}

export interface ArchaeologyResult {
  query: string;
  narrative: string;
  confidence: "high" | "medium" | "low";
  keyCommits: ArchaeologyCommit[];
  repoPath: string;
}

interface CommitRaw {
  shortHash: string;
  fullHash: string;
  message: string;
  date: string;
  author: string;
  filesChanged: string[];
  diff: string;
}

interface LLMAnalysis {
  narrative: string;
  confidence: "high" | "medium" | "low";
  keyCommitHashes: string[];
  significanceMap: Record<string, string>;
}

/**
 * Find the git repo root from a given directory, or use lobs-core as default.
 */
function findRepoRoot(query: string): string {
  // Try to detect if the query mentions a specific repo
  const knownRepos: Record<string, string> = {
    "lobs-nexus": `${process.env.HOME}/lobs/lobs-nexus`,
    "nexus": `${process.env.HOME}/lobs/lobs-nexus`,
    "paw-hub": `${process.env.HOME}/paw/paw-hub`,
    "paw": `${process.env.HOME}/paw/paw-hub`,
    "lobs-core": `${process.env.HOME}/lobs/lobs-core`,
  };

  const lowerQuery = query.toLowerCase();
  for (const [key, path] of Object.entries(knownRepos)) {
    if (lowerQuery.includes(key)) {
      return path;
    }
  }

  // Default: lobs-core
  return `${process.env.HOME}/lobs/lobs-core`;
}

/**
 * Get git log for commits matching the query (file path or grep in message/diff).
 */
function getRelevantCommits(repoPath: string, query: string, maxCommits = 40): CommitRaw[] {
  const commits: CommitRaw[] = [];
  const separator = "|||COMMIT|||";

  // Strategy 1: grep commit messages and diffs for the query terms
  const queryTerms = query
    .replace(/[^a-zA-Z0-9/_.-\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2)
    .slice(0, 3);

  let logOutput = "";

  // Try to find commits by searching diffs and messages
  for (const term of queryTerms) {
    try {
      // Search in commit messages
      const msgResult = execSync(
        `git -C "${repoPath}" log --oneline --max-count=20 --grep="${term}" --format="%H|%h|%s|%ai|%an"`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();
      if (msgResult) logOutput += msgResult + "\n";

      // Search in diffs (pickaxe)
      const diffResult = execSync(
        `git -C "${repoPath}" log --oneline --max-count=20 -S "${term}" --format="%H|%h|%s|%ai|%an"`,
        { encoding: "utf8", timeout: 15000 }
      ).trim();
      if (diffResult) logOutput += diffResult + "\n";
    } catch {
      // Term might not exist in history — skip
    }
  }

  // Strategy 2: if query looks like a file path, use git log -- <path>
  const filePathMatch = query.match(/([a-zA-Z0-9_/-]+\.[a-zA-Z]{1,6})/);
  if (filePathMatch) {
    try {
      const fileResult = execSync(
        `git -C "${repoPath}" log --oneline --max-count=20 --format="%H|%h|%s|%ai|%an" -- "${filePathMatch[1]}"`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();
      if (fileResult) logOutput += fileResult + "\n";
    } catch {
      // File might not exist
    }
  }

  // Deduplicate by hash and parse
  const seen = new Set<string>();
  const rawLines = logOutput.split("\n").filter(l => l.trim());

  for (const line of rawLines) {
    const parts = line.split("|");
    if (parts.length < 5) continue;

    const [fullHash, shortHash, ...rest] = parts;
    const author = rest.pop() ?? "";
    const date = rest.pop() ?? "";
    const message = rest.join("|");

    if (!fullHash || seen.has(fullHash)) continue;
    seen.add(fullHash);

    // Get changed files for this commit
    let filesChanged: string[] = [];
    try {
      const files = execSync(
        `git -C "${repoPath}" diff-tree --no-commit-id -r --name-only "${fullHash}"`,
        { encoding: "utf8", timeout: 5000 }
      ).trim();
      filesChanged = files.split("\n").filter(f => f.trim()).slice(0, 10);
    } catch {
      // Skip
    }

    // Get a short diff snippet (first 1500 chars)
    let diff = "";
    try {
      diff = execSync(
        `git -C "${repoPath}" show --stat --format="" "${fullHash}"`,
        { encoding: "utf8", timeout: 5000 }
      ).slice(0, 1500);
    } catch {
      // Skip
    }

    commits.push({
      shortHash: shortHash.trim(),
      fullHash: fullHash.trim(),
      message: message.trim(),
      date: date.trim().split("T")[0] ?? date.trim(),
      author: author.trim(),
      filesChanged,
      diff,
    });

    if (commits.length >= maxCommits) break;
  }

  return commits.slice(0, maxCommits);
}

/**
 * Analyze commits with LLM to produce narrative + identify key commits.
 */
async function analyzeWithLLM(
  query: string,
  commits: CommitRaw[],
  repoPath: string
): Promise<LLMAnalysis> {
  if (commits.length === 0) {
    return {
      narrative: `No git history found matching "${query}". This code may be new, or the query didn't match any commits in the history.`,
      confidence: "low",
      keyCommitHashes: [],
      significanceMap: {},
    };
  }

  const commitSummaries = commits
    .slice(0, 25)
    .map(c => `${c.shortHash} (${c.date}): ${c.message}\n  Files: ${c.filesChanged.slice(0, 5).join(", ")}`)
    .join("\n");

  const prompt = `You are analyzing git history to explain why code exists and how it evolved.

Query: "${query}"
Repository: ${repoPath.split("/").slice(-1)[0]}

Relevant commits (${commits.length} found):
${commitSummaries}

Based on this git history, provide:
1. A narrative (2-4 paragraphs) explaining WHY this code exists, HOW it evolved, and what problems it was solving. Be specific — reference actual commit messages and dates.
2. Confidence level: "high" if many relevant commits found, "medium" if some, "low" if sparse
3. The 3-5 most significant commit hashes (short hashes from the list above)
4. For each key commit, a 1-sentence explanation of its significance

Respond as JSON matching exactly:
{
  "narrative": "string (2-4 paragraphs)",
  "confidence": "high" | "medium" | "low",
  "keyCommitHashes": ["abc1234", ...],
  "significanceMap": {
    "abc1234": "One sentence explaining why this commit matters",
    ...
  }
}`;

  const { data } = await callApiModelJSON<LLMAnalysis>(prompt, {
    tier: "small",
    temperature: 0.3,
  });

  return data;
}

/**
 * Main entry point: run code archaeology for a query.
 */
export async function runArchaeology(query: string): Promise<ArchaeologyResult> {
  const repoPath = findRepoRoot(query);

  // Get relevant commits from git history
  const rawCommits = getRelevantCommits(repoPath, query);

  // Analyze with LLM
  const analysis = await analyzeWithLLM(query, rawCommits, repoPath);

  // Build key commits with significance annotations
  const keyCommitSet = new Set(analysis.keyCommitHashes ?? []);
  const keyCommits: ArchaeologyCommit[] = rawCommits
    .filter(c => keyCommitSet.has(c.shortHash) || keyCommitSet.has(c.fullHash.slice(0, 7)))
    .map(c => ({
      shortHash: c.shortHash,
      fullHash: c.fullHash,
      message: c.message,
      date: c.date,
      author: c.author,
      filesChanged: c.filesChanged,
      significance: analysis.significanceMap?.[c.shortHash]
        ?? analysis.significanceMap?.[c.fullHash.slice(0, 7)]
        ?? "Key commit",
    }));

  // If no key commits matched (LLM returned hashes not in our list), fall back to top 3
  if (keyCommits.length === 0 && rawCommits.length > 0) {
    rawCommits.slice(0, 3).forEach(c => {
      keyCommits.push({
        shortHash: c.shortHash,
        fullHash: c.fullHash,
        message: c.message,
        date: c.date,
        author: c.author,
        filesChanged: c.filesChanged,
        significance: "Most recent relevant change",
      });
    });
  }

  return {
    query,
    narrative: analysis.narrative ?? `Analysis of "${query}" in ${repoPath.split("/").slice(-1)[0]}.`,
    confidence: analysis.confidence ?? "low",
    keyCommits,
    repoPath,
  };
}
