/**
 * Librarian tools — search, audit, and manage the knowledge base.
 *
 * Tools:
 *  - librarianAskTool: 3-phase search (registry + vector + structured files)
 *  - librarianReindexTool: trigger re-index with before/after counts, polls completion
 *  - librarianAuditTool: full doc audit (untracked/missing/stale/dupe detection)
 *  - librarianStatusTool: KB health check
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import os from "node:os";
import type { ToolDefinition } from "../types.js";
import { log } from "../../util/logger.js";

// ── Constants ────────────────────────────────────────────────────────────────

const MEMORY_URL = "http://localhost:7420";
const HOME = os.homedir();
const REGISTRY_PATH = resolve(HOME, "lobs/lobs-shared-memory/docs-registry.md");

// ── Shared helpers ────────────────────────────────────────────────────────────

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

// ── Project → Collection Mapping ─────────────────────────────────────────────

const COLLECTIONS: Record<string, string[]> = {
  all: [
    "agent-context", "agent-memory", "knowledge", "lobs-brain", "lobs-core",
    "lobs-core-memory", "lobs-nexus", "lobs-sentinel", "lobs-voice", "lobs-imagine",
    "lobs-mobile", "lobslab-apps", "lobslab-infra", "bot-shared", "ideas",
    "paw-hub", "paw-portal", "paw-plugin", "paw-designs", "paw-docs", "paw-proposals",
    "trident", "version-claw", "ship-api", "ship-services", "lobs-sail", "lobs-sets-sail",
    "service-sdk", "service-sdk-python", "paper-context-budgeting", "paper-hybrid-memory",
    "projects",
  ],
  lobs: [
    "lobs-core", "lobs-core-memory", "lobs-nexus", "lobs-sentinel", "lobs-voice",
    "lobs-imagine", "lobs-mobile", "lobslab-apps", "lobslab-infra",
    "agent-memory", "agent-context", "knowledge", "lobs-brain",
  ],
  paw: [
    "paw-hub", "paw-portal", "paw-plugin", "paw-designs", "paw-docs", "paw-proposals",
    "bot-shared", "trident", "version-claw", "ship-api", "ship-services",
    "lobs-sail", "lobs-sets-sail", "service-sdk", "service-sdk-python",
  ],
  flock: ["knowledge"],
};

// Stopwords for pattern extraction
const STOPWORDS = new Set([
  "what", "are", "the", "is", "a", "an", "of", "for", "to", "in", "on", "and", "or",
  "how", "why", "when", "where", "do", "does", "my", "his", "her", "with", "this",
  "that", "it", "be", "have", "has", "was", "were", "been", "being", "can", "could",
  "would", "should", "will", "shall", "may", "might", "must", "about", "each", "which",
  "their", "them", "they", "its", "our", "all", "any", "some", "no", "not", "but", "so",
  "if", "than", "then", "just", "also", "very", "much", "more", "most",
]);

function extractKeywords(text: string, max = 5): string[] {
  return text
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, max);
}

// ── Tool Definitions ──────────────────────────────────────────────────────────

export const librarianAskToolDefinition: ToolDefinition = {
  name: "librarian_ask",
  description:
    "Ask the Librarian a question about Rafe's knowledge base — projects, decisions, " +
    "preferences, documentation, or anything stored in memory. " +
    "Searches the docs registry + lobs-memory vector store + structured memory files. " +
    "Use this when you need to recall something rather than search for it manually.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the Librarian. Be natural — describe what you're trying to find.",
      },
      project: {
        type: "string",
        description: "Limit search to a specific project: 'lobs', 'paw', 'flock', or omit for all. Known projects: lobs, paw, flock.",
      },
      limit: {
        type: "number",
        description: "Max results to return (default: 8)",
      },
    },
    required: ["question"],
  },
};

export const librarianReindexToolDefinition: ToolDefinition = {
  name: "librarian_reindex_knowledge_base",
  description:
    "Trigger a re-index of the lobs-memory vector database to refresh knowledge base " +
    "contents from disk. Use when search results are stale or new documents were added.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why re-indexing is needed. Brief description for logging.",
      },
    },
    required: [],
  },
};

export const librarianAuditToolDefinition: ToolDefinition = {
  name: "librarian_audit",
  description:
    "Audit documentation across all repos. Scans every known doc location, compares against " +
    "the registry, and reports: new untracked docs, stale/missing docs, duplicates, and " +
    "inconsistencies. Use fix=true to auto-update the registry with findings.",
  input_schema: {
    type: "object",
    properties: {
      fix: {
        type: "boolean",
        description: "Auto-update the registry with new findings (default: false, report only)",
      },
      scope: {
        type: "string",
        description: "Limit audit to a specific area: 'lobs', 'paw', 'shared', or omit for all",
      },
    },
    required: [],
  },
};

export const librarianAddDocumentToolDefinition: ToolDefinition = {
  name: "librarian_add_document",
  description:
    "Write a document to disk and register it in the docs registry so future agents can find it. " +
    "Use for research findings, design docs, runbooks, ADRs, and other significant documents. " +
    "Automatically triggers a re-index so the content is immediately searchable.",
  input_schema: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "Absolute path where the document should be written (e.g. ~/lobs/lobs-shared-memory/research/my-finding.md)",
      },
      content: {
        type: "string",
        description: "Full markdown content to write to the file.",
      },
      description: {
        type: "string",
        description: "Short one-line description for the registry (max 100 chars).",
      },
    },
    required: ["filepath", "content"],
  },
};

export const librarianStatusToolDefinition: ToolDefinition = {
  name: "librarian_status",
  description:
    "Check the status of the lobs-memory knowledge base — document count, chunk count, " +
    "isIndexing, list of collections.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// ── Phase helpers for librarianAskTool ───────────────────────────────────────

interface RegistryHit {
  path: string;
  displayPath: string;
  title: string;
  status: string;
  desc: string;
  preview: string;
}

function registrySearch(question: string): RegistryHit[] {
  const registry = readIfExists(REGISTRY_PATH);
  if (!registry) return [];

  const keywords = extractKeywords(question, 5);
  if (keywords.length === 0) return [];

  const pattern = new RegExp(keywords.join("|"), "i");
  const hits: RegistryHit[] = [];

  for (const line of registry.split("\n")) {
    if (!pattern.test(line)) continue;
    // Only table rows containing backtick paths
    const pathMatch = line.match(/`(~\/[^`]+)`/);
    if (!pathMatch) continue;

    const displayPath = pathMatch[1];
    const fullPath = displayPath.replace(/^~/, HOME);
    if (!existsSync(fullPath)) continue;

    // Parse table columns: | col1 | col2 | ... |
    const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
    const title = cols[2] ?? displayPath;
    const status = cols[3] ?? "";
    const desc = cols[cols.length - 1] ?? "";

    // Preview: first 5 non-blank, non-heading lines
    let preview = "";
    try {
      const content = readFileSync(fullPath, "utf8");
      const previewLines = content
        .split("\n")
        .filter((l) => l.trim() && !/^(#|>|---|^\|)/.test(l.trim()))
        .slice(0, 5)
        .map((l) => `  > ${l.trim()}`);
      preview = previewLines.join("\n");
    } catch { /* ignore */ }

    hits.push({ path: fullPath, displayPath, title, status, desc, preview });
    if (hits.length >= 10) break;
  }

  return hits;
}

interface VectorResult {
  snippet: string;
  score: number;
  source?: string;
}

async function vectorSearch(question: string, project: string | undefined, limit: number): Promise<VectorResult[]> {
  const cols = project ? (COLLECTIONS[project] ?? COLLECTIONS.all) : COLLECTIONS.all;

  const body = JSON.stringify({ query: question, maxResults: limit, collections: cols });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(`${MEMORY_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const data = await res.json() as {
      results?: Array<{ text?: string; snippet?: string; score?: number; source?: string }>;
    };
    return (data.results ?? []).slice(0, limit).map((r) => ({
      snippet: String(r.text ?? r.snippet ?? ""),
      score: r.score ?? 0,
      source: r.source,
    }));
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name !== "AbortError") {
      log().warn(`[librarian-ask] Vector search failed: ${err.message}`);
    }
    return [];
  }
}

function structuredFileSearch(question: string, project: string | undefined): string[] {
  const keywords = extractKeywords(question, 3);
  if (keywords.length === 0) return [];
  const pattern = new RegExp(keywords.join("|"), "i");

  const results: string[] = [];

  // Search learnings files
  const learningsFiles = [
    resolve(HOME, "lobs-shared-memory/learnings.md"),
    resolve(HOME, "lobs/lobs-shared-memory/learnings.md"),
    resolve(HOME, "lobs/lobs-brain/shared-memory/learnings.md"),
  ];
  for (const f of learningsFiles) {
    const content = readIfExists(f);
    if (!content) continue;
    const matches = content.split("\n").filter((l) => pattern.test(l)).slice(0, 10);
    if (matches.length > 0) {
      const basename = f.replace(HOME, "~");
      results.push(`**${basename}:**\n${matches.join("\n")}`);
      break; // Only first found learnings file
    }
  }

  // Search PROJECT-*.md files
  const projectNames = project ? [project] : ["lobs", "paw", "flock", "versionclaw"];
  for (const proj of projectNames) {
    const pfile = resolve(HOME, `.lobs/agents/main/context/PROJECT-${proj}.md`);
    const content = readIfExists(pfile);
    if (!content) continue;
    const matches = content.split("\n").filter((l) => pattern.test(l)).slice(0, 8);
    if (matches.length > 0) {
      results.push(`**PROJECT-${proj}.md:**\n${matches.join("\n")}`);
    }
  }

  return results;
}

// ── librarianAskTool ──────────────────────────────────────────────────────────

export async function librarianAskTool(
  params: Record<string, unknown>,
  _cwd: string,
): Promise<string> {
  const question = (params.question as string | undefined) ?? "";
  if (!question) return "Error: question is required";

  const project = params.project as string | undefined;
  const limit = (params.limit as number | undefined) ?? 8;

  log().info(`[librarian-ask] question="${question}" project=${project ?? "all"}`);

  const parts: string[] = [];
  parts.push(`## Librarian: "${question}"`);
  if (project) parts.push(`_Scoped to: ${project}_`);
  parts.push("");

  // Phase 1: Registry search
  const registryHits = registrySearch(question);
  if (registryHits.length > 0) {
    parts.push("### 📚 Relevant Documents (from registry)\n");
    for (const hit of registryHits) {
      parts.push(`**${hit.title}** ${hit.status}`);
      parts.push(`  Path: \`${hit.displayPath}\``);
      if (hit.desc) parts.push(`  ${hit.desc}`);
      if (hit.preview) parts.push(hit.preview);
      parts.push("");
    }
  }

  // Phase 2: Vector search
  const vectorResults = await vectorSearch(question, project, limit);
  if (vectorResults.length > 0) {
    parts.push(`### 🔍 Knowledge Base Results (${vectorResults.length} matches)\n`);
    vectorResults.forEach((r, i) => {
      const pct = r.score > 0 ? `${Math.floor(r.score * 100)}%` : "?";
      const src = r.source ? ` — _${r.source}_` : "";
      parts.push(`**[${i + 1}]** ${pct} match${src}`);
      parts.push(r.snippet.slice(0, 600));
      parts.push("");
    });
  } else {
    parts.push("### ⚠️ Vector search unavailable or no results\n");
  }

  // Phase 3: Structured files
  parts.push("---\n### 📂 Structured Files\n");
  const fileHits = structuredFileSearch(question, project);
  if (fileHits.length > 0) {
    parts.push(...fileHits.map((h) => h + "\n"));
  } else {
    parts.push("_No additional matches in structured files._");
  }

  log().info(`[librarian-ask] Done: ${registryHits.length} registry, ${vectorResults.length} vector, ${fileHits.length} file hits`);
  return parts.join("\n");
}

// ── librarianReindexTool ──────────────────────────────────────────────────────

export async function reindexKnowledgeBaseTool(
  params: Record<string, unknown>,
  _cwd: string,
): Promise<string> {
  const reason = (params.reason as string | undefined) ?? "manual trigger";
  log().info(`[librarian-reindex] reason="${reason}"`);

  // Get status before
  let docsBefore: number | string = "?";
  let chunksBefore: number | string = "?";
  try {
    const res = await fetch(`${MEMORY_URL}/status`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json() as { index?: { documents?: number; chunks?: number } };
      docsBefore = data.index?.documents ?? "?";
      chunksBefore = data.index?.chunks ?? "?";
    }
  } catch {
    return `Error: Could not reach lobs-memory at ${MEMORY_URL}`;
  }

  log().info(`[librarian-reindex] Before: ${docsBefore} docs / ${chunksBefore} chunks`);

  // Trigger
  let triggerMsg = "";
  try {
    const res = await fetch(`${MEMORY_URL}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggeredBy: "librarian-tool", reason }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as { ok?: boolean; message?: string; error?: string };
    if (!data.ok) {
      return `Re-index failed: ${data.error ?? "unknown error"}`;
    }
    triggerMsg = data.message ?? "Re-indexing started.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to trigger re-index: ${msg}`;
  }

  log().info(`[librarian-reindex] Triggered: ${triggerMsg}`);

  // Poll for completion (up to 60s, 15 × 4s intervals, 2 stable checks)
  let stable = 0;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch(`${MEMORY_URL}/status`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json() as {
        indexer?: { isIndexing?: boolean };
        index?: { documents?: number; chunks?: number; collections?: string[] };
      };
      if (data.indexer?.isIndexing) {
        stable = 0;
        log().info("[librarian-reindex] Still indexing...");
        continue;
      }
      stable++;
      if (stable >= 2) {
        const docs = data.index?.documents ?? "?";
        const chunks = data.index?.chunks ?? "?";
        const cols = (data.index?.collections ?? []).join(", ");
        log().info(`[librarian-reindex] Done: ${docs} docs / ${chunks} chunks`);
        return [
          "Re-index complete!",
          `  Documents: ${docs} (was ${docsBefore})`,
          `  Chunks: ${chunks} (was ${chunksBefore})`,
          `  Collections: ${cols}`,
        ].join("\n");
      }
    } catch { /* keep polling */ }
  }

  return `${triggerMsg}\n(Polling timed out after 60s — check librarian_status manually)`;
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

function getScanDirs(scope: string): string[] {
  const h = HOME;
  const lobs = [
    join(h, "lobs/lobs-core/docs"),
    join(h, "lobs/lobs-core"),
    join(h, "lobs/lobs-memory"),
    join(h, "lobs/lobs-nexus"),
    join(h, "lobs/lobs-brain/shared-memory"),
    join(h, "lobs/lobs-shared-memory"),
    join(h, ".lobs/agents/main/context"),
  ];
  const paw = [
    join(h, "paw/bot-shared"),
    join(h, "paw/paw-hub/docs"),
    join(h, "paw/paw-portal/docs"),
    join(h, "paw/ship-api/docs"),
  ];
  const shared = [
    join(h, "lobs/lobs-shared-memory"),
    join(h, "lobs/lobs-brain/shared-memory"),
    join(h, "paw/bot-shared"),
  ];

  switch (scope) {
    case "lobs": return lobs;
    case "paw": return paw;
    case "shared": return shared;
    default: return [...new Set([...lobs, ...paw, join(h, "paw/trident/docs")])];
  }
}

const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\/\.git\//,
  /\/dist\//,
  /\/memory\/2\d{3}/,
  /\/github-prs\//,
  /\/tests\/output\//,
  /\/tests\/fixtures\//,
];
const EXCLUDE_NAMES = new Set(["CHANGELOG.md", "package.md"]);

function findMdFiles(dir: string, depth = 0, results: string[] = []): string[] {
  if (depth > 4 || !existsSync(dir)) return results;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const shouldExclude = EXCLUDE_PATTERNS.some((p) => p.test(fullPath + "/"));
        if (!shouldExclude) findMdFiles(fullPath, depth + 1, results);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !EXCLUDE_NAMES.has(entry.name)) {
        const shouldExclude = EXCLUDE_PATTERNS.some((p) => p.test(fullPath));
        if (!shouldExclude) results.push(fullPath);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

function extractRegistryPaths(): Set<string> {
  const registry = readIfExists(REGISTRY_PATH);
  if (!registry) return new Set();
  const paths = new Set<string>();
  for (const match of registry.matchAll(/`(~\/[^`]+\.md)`/g)) {
    paths.add(match[1].replace(/^~/, HOME));
  }
  return paths;
}

function getSubmodulePaths(scanDirs: string[]): Set<string> {
  const submodules = new Set<string>();
  const repoRoots = new Set<string>();

  for (const dir of scanDirs) {
    try {
      const root = execSync(`git -C "${dir}" rev-parse --show-toplevel 2>/dev/null`, { encoding: "utf8" }).trim();
      if (root) repoRoots.add(root);
    } catch { /* not a git repo */ }
  }

  for (const root of repoRoots) {
    try {
      const out = execSync(`git -C "${root}" submodule status 2>/dev/null`, { encoding: "utf8" });
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1]) {
          submodules.add(join(root, parts[1]));
        }
      }
    } catch { /* ignore */ }
  }

  return submodules;
}

function classifyDoc(filepath: string): string {
  const lower = filepath.toLowerCase();
  if (/adr|decision/.test(lower)) return "ADR";
  if (/design|spec|architecture/.test(lower)) return "Design";
  if (/readme|guide|onboard/.test(lower)) return "Reference";
  if (/post.mortem|incident/.test(lower)) return "Post-Mortem";
  if (/roadmap|epic|plan/.test(lower)) return "Roadmap";
  if (/idea|proposal/.test(lower)) return "Idea";
  if (/runbook|operations|playbook/.test(lower)) return "Runbook";
  if (/research|investigation|analysis/.test(lower)) return "Research";
  if (/handoff|audit|pattern/.test(lower)) return "Pattern";
  if (/skill/.test(lower)) return "Skill";
  return "Unknown";
}

function getModDate(filepath: string): string {
  try {
    const stat = statSync(filepath);
    return stat.mtime.toISOString().slice(0, 10);
  } catch {
    return "?";
  }
}

function md5File(filepath: string): string | null {
  try {
    const content = readFileSync(filepath);
    return createHash("md5").update(content).digest("hex");
  } catch {
    return null;
  }
}

function lineCount(filepath: string): number {
  try {
    const content = readFileSync(filepath, "utf8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function getDocTitle(filepath: string): string {
  try {
    const content = readFileSync(filepath, "utf8");
    for (const line of content.split("\n").slice(0, 5)) {
      if (line.startsWith("#")) return line.replace(/^#+\s*/, "").slice(0, 60);
    }
  } catch { /* ignore */ }
  return "";
}

// ── librarianAuditTool ────────────────────────────────────────────────────────

export async function librarianAuditTool(
  params: Record<string, unknown>,
  _cwd: string,
): Promise<string> {
  const fix = (params.fix as boolean | undefined) ?? false;
  const scope = (params.scope as string | undefined) ?? "all";
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  log().info(`[librarian-audit] scope=${scope} fix=${fix}`);

  const parts: string[] = [];
  parts.push("# 📋 Documentation Audit");
  parts.push(`> ${now} | Scope: ${scope} | Fix: ${fix}\n`);

  const scanDirs = getScanDirs(scope);
  const submodulePaths = getSubmodulePaths(scanDirs);

  // Phase 1: Find all docs on disk
  const allDocSet = new Set<string>();
  for (const dir of scanDirs) {
    for (const f of findMdFiles(dir)) {
      allDocSet.add(f);
    }
  }
  const allDocs = Array.from(allDocSet).sort();
  const totalOnDisk = allDocs.length;

  // Phase 2: Extract registry paths
  const registryPaths = extractRegistryPaths();
  const totalRegistered = registryPaths.size;

  // Phase 3: Compare
  const untracked: string[] = [];
  const missing: string[] = [];
  const tracked: string[] = [];

  for (const f of allDocs) {
    if (registryPaths.has(f)) tracked.push(f);
    else untracked.push(f);
  }
  for (const f of registryPaths) {
    if (!allDocSet.has(f)) missing.push(f);
  }

  parts.push("## Summary\n");
  parts.push("| Metric | Count |");
  parts.push("|--------|-------|");
  parts.push(`| Docs on disk | ${totalOnDisk} |`);
  parts.push(`| In registry | ${totalRegistered} |`);
  parts.push(`| ✅ Tracked | ${tracked.length} |`);
  parts.push(`| 🆕 Untracked (new) | ${untracked.length} |`);
  parts.push(`| ❌ Missing (deleted?) | ${missing.length} |`);
  parts.push("");

  // Phase 4: Untracked docs
  if (untracked.length > 0) {
    parts.push("## 🆕 Untracked Documents");
    parts.push("These docs exist on disk but aren't in the registry:\n");
    for (const filepath of untracked) {
      const displayPath = filepath.replace(HOME, "~");
      const title = getDocTitle(filepath);
      const lines = lineCount(filepath);
      const type = classifyDoc(filepath);
      const modDate = getModDate(filepath);
      parts.push(`- \`${displayPath}\` (${lines} lines, ${type}, modified ${modDate})`);
      if (title) parts.push(`  Title: **${title}**`);
    }
    parts.push("");
  }

  // Phase 5: Missing docs
  if (missing.length > 0) {
    parts.push("## ❌ Missing Documents");
    parts.push("These are in the registry but don't exist on disk:\n");
    for (const filepath of missing) {
      const displayPath = filepath.replace(HOME, "~");
      parts.push(`- \`${displayPath}\` — **FILE NOT FOUND**`);
    }
    parts.push("");
  }

  // Phase 6: Duplicate detection
  parts.push("## 📋 Duplicate Detection");
  parts.push("Files with identical content in multiple locations (excluding submodule copies):\n");

  const hashMap = new Map<string, string[]>();
  for (const filepath of allDocs) {
    if (lineCount(filepath) <= 50) continue;
    // Skip submodule paths
    const isSubmodule = Array.from(submodulePaths).some((sp) => filepath.startsWith(sp));
    if (isSubmodule) continue;
    const hash = md5File(filepath);
    if (!hash) continue;
    const existing = hashMap.get(hash) ?? [];
    existing.push(filepath);
    hashMap.set(hash, existing);
  }

  let dupeCount = 0;
  for (const [hash, files] of hashMap) {
    if (files.length > 1) {
      parts.push(`**Content duplicate** (md5: ${hash.slice(0, 8)}...):`);
      for (const f of files) {
        const display = f.replace(HOME, "~");
        parts.push(`  - \`${display}\` (${lineCount(f)} lines)`);
      }
      parts.push("");
      dupeCount++;
    }
  }
  if (dupeCount === 0) {
    parts.push("_No content-level duplicates detected (submodule copies excluded)._\n");
  }

  // Phase 7: Staleness check
  parts.push("## ⏰ Staleness Check");
  parts.push("Tracked docs not modified in 30+ days:\n");

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let staleCount = 0;
  for (const filepath of tracked) {
    try {
      const stat = statSync(filepath);
      if (stat.mtimeMs < thirtyDaysAgo) {
        const displayPath = filepath.replace(HOME, "~");
        const modDate = getModDate(filepath);
        const title = getDocTitle(filepath);
        parts.push(`- \`${displayPath}\` — last modified ${modDate}`);
        if (title) parts.push(`  (${title})`);
        staleCount++;
      }
    } catch { /* ignore */ }
  }
  if (staleCount === 0) {
    parts.push("_No stale tracked documents found._");
  }
  parts.push("");

  // Phase 8: Submodule info
  if (submodulePaths.size > 0) {
    parts.push("## 📦 Submodules Detected");
    parts.push("These paths are git submodules — docs inside are copies of their upstream repos:\n");
    for (const sp of submodulePaths) {
      parts.push(`- \`${sp.replace(HOME, "~")}\``);
    }
    parts.push("");
  }

  // Phase 9: Auto-fix
  if (fix && untracked.length > 0) {
    parts.push("## 🔧 Auto-Fix: Updating Registry\n");
    const today = new Date().toISOString().slice(0, 10);
    const lines: string[] = [
      "",
      `## Recently Discovered (auto-added ${today})`,
      "",
      "| Path | Title | Status | Date | Description |",
      "|------|-------|--------|------|-------------|",
    ];
    for (const filepath of untracked) {
      const displayPath = filepath.replace(HOME, "~");
      const title = (getDocTitle(filepath) || "Untitled").slice(0, 60);
      const modDate = getModDate(filepath);
      let desc = "";
      try {
        const content = readFileSync(filepath, "utf8");
        const descLine = content.split("\n")
          .find((l) => l.trim() && !/^(#|>|---|^\|)/.test(l.trim()));
        desc = (descLine ?? "Needs review").trim().slice(0, 100);
      } catch { /* ignore */ }
      lines.push(`| \`${displayPath}\` | ${title} | 🆕 | ${modDate} | ${desc} |`);
    }
    try {
      const existing = readFileSync(REGISTRY_PATH, "utf8");
      writeFileSync(REGISTRY_PATH, existing + lines.join("\n") + "\n");
      parts.push(`Added ${untracked.length} new entries to registry.`);
      parts.push("⚠️ New entries are in a 'Recently Discovered' section — review and categorize them.\n");
    } catch (err) {
      parts.push(`Failed to update registry: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (fix && missing.length > 0) {
    parts.push(`### Removing ${missing.length} dead references from registry`);
    try {
      let content = readFileSync(REGISTRY_PATH, "utf8");
      for (const filepath of missing) {
        const displayPath = filepath.replace(HOME, "~").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        content = content.split("\n").filter((l) => !l.includes(filepath.replace(HOME, "~"))).join("\n");
      }
      writeFileSync(REGISTRY_PATH, content);
      for (const filepath of missing) {
        parts.push(`- Removed: \`${filepath.replace(HOME, "~")}\``);
      }
    } catch (err) {
      parts.push(`Failed to clean registry: ${err instanceof Error ? err.message : String(err)}`);
    }
    parts.push("");
  }

  parts.push("---");
  if (!fix) {
    parts.push("_Run with `fix=true` to auto-update the registry with these findings._");
  }

  log().info(`[librarian-audit] Done: ${untracked.length} untracked, ${missing.length} missing, ${staleCount} stale`);
  return parts.join("\n");
}

// ── librarianAddDocumentTool ──────────────────────────────────────────────────

export async function librarianAddDocumentTool(
  params: Record<string, unknown>,
  _cwd: string,
): Promise<string> {
  const rawPath = params["filepath"] as string;
  const content = params["content"] as string;
  const description = (params["description"] as string | undefined) ?? "";

  if (!rawPath || !content) {
    return "Error: filepath and content are required.";
  }

  // Expand ~ to home dir
  const filepath = rawPath.startsWith("~")
    ? join(os.homedir(), rawPath.slice(1))
    : resolve(rawPath);

  // Ensure parent directory exists
  const dir = join(filepath, "..");
  mkdirSync(dir, { recursive: true });

  // Write the document
  writeFileSync(filepath, content, "utf8");

  // Update docs registry
  const registryPath = join(os.homedir(), "lobs/lobs-shared-memory/docs-registry.md");
  if (existsSync(registryPath)) {
    const displayPath = filepath.replace(os.homedir(), "~");
    const filename = filepath.split("/").pop() ?? filepath;
    const date = new Date().toISOString().split("T")[0];
    const desc = description || filename;
    const registryEntry = `\n| \`${displayPath}\` | ${desc} | 🆕 | ${date} | Added via librarian_add_document |`;
    appendFileSync(registryPath, registryEntry, "utf8");
  }

  // Trigger re-index so the new doc is immediately searchable
  try {
    await fetch(`${MEMORY_URL}/reindex`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-fatal — doc was saved; reindex will happen on next scheduled run
  }

  const displayPath = filepath.replace(os.homedir(), "~");
  return `Document saved to ${displayPath} and registered in docs registry. Re-index triggered.`;
}

// ── librarianStatusTool ───────────────────────────────────────────────────────

export async function librarianStatusTool(
  _params: Record<string, unknown>,
  _cwd: string,
): Promise<string> {
  try {
    const res = await fetch(`${MEMORY_URL}/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return `Error: lobs-memory returned HTTP ${res.status}`;
    }
    const data = await res.json() as {
      index?: { documents?: number; chunks?: number; collections?: string[] };
      indexer?: { isIndexing?: boolean };
    };

    const docs = data.index?.documents ?? "?";
    const chunks = data.index?.chunks ?? "?";
    const isIndexing = data.indexer?.isIndexing ?? false;
    const collections = data.index?.collections ?? [];

    const lines = [
      "## Librarian Knowledge Base Status",
      "",
      `Documents: ${docs}`,
      `Chunks: ${chunks}`,
      `Is Indexing: ${isIndexing}`,
      "",
      "Collections:",
      ...collections.map((c) => `  - ${c}`),
    ];
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: Could not reach lobs-memory at ${MEMORY_URL}: ${msg}`;
  }
}
