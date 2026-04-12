#!/usr/bin/env npx ts-node
/**
 * index-knowledge-base.ts
 *
 * Triggers a re-index of the lobs-memory vector database by walking knowledge
 * directories and POSTing to lobs-memory's /index endpoint.
 *
 * The lobs-memory server (localhost:7420) has a built-in indexing pipeline:
 *   - File watchers with 2s debounce
 *   - Hash-based change detection (only upserts changed chunks)
 *   - Chunking (~300 tokens, 40 token overlap)
 *   - BGE embedding via LM Studio
 *
 * This script tells lobs-memory to do a full sync now. It's idempotent —
 * unchanged files are detected via content hash and skipped.
 *
 * Usage:
 *   npx ts-node scripts/index-knowledge-base.ts [--watch] [--dry-run]
 *
 * Environment:
 *   LOBS_MEMORY_URL  Base URL of lobs-memory (default: http://localhost:7420)
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

const MEMORY_URL = process.env.LOBS_MEMORY_URL ?? "http://localhost:7420";

// ── Knowledge directories ─────────────────────────────────────────────────────

interface Volume {
  project: "lobs" | "paw" | "flock" | "lobs-core" | "lobs-nexus";
  category: "learnings" | "preferences" | "adrs" | "notes" | "projects" | "ideas" | "specs" | "guides" | "plans" | "handoffs" | "memory" | "context" | "scripts" | "proposals" | "designs" | "docs" | "general";
  subcategory?: string;
  path: string;
  patterns: string[];
}

const VOLUMES: Volume[] = [
  // lobs shared memory
  { project: "lobs", category: "learnings", path: "~/lobs-shared-memory/", patterns: ["*.md", "**/*.md"] },
  { project: "lobs", category: "preferences", path: "~/lobs-shared-memory/preferences/", patterns: ["**/*.md"] },
  { project: "lobs", category: "adrs", path: "~/lobs-shared-memory/adrs/", patterns: ["**/*.md"] },
  { project: "lobs", category: "notes", path: "~/lobs-shared-memory/notes/", patterns: ["**/*.md"] },

  // paw bot-shared — note: lobs-memory already has a bot-shared collection
  // covering all *.md, but we call /index to ensure it's fresh
  { project: "paw", category: "adrs", path: "~/paw/bot-shared/adrs/", patterns: ["**/*.md"] },
  { project: "paw", category: "ideas", path: "~/paw/bot-shared/ideas/", patterns: ["**/*.md"] },
  { project: "paw", category: "specs", path: "~/paw/bot-shared/specs/", patterns: ["**/*.md"] },
  { project: "paw", category: "guides", path: "~/paw/bot-shared/guides/", patterns: ["**/*.md"] },
  { project: "paw", category: "plans", path: "~/paw/bot-shared/plans/", patterns: ["**/*.md"] },
  { project: "paw", category: "handoffs", path: "~/paw/bot-shared/handoffs/", patterns: ["**/*.md"] },

  // lobs-core project docs
  { project: "lobs-core", category: "memory", path: "~/lobs/lobs-core/memory/", patterns: ["**/*.md"] },
  { project: "lobs-core", category: "context", path: "~/lobs/lobs-core/docs/", patterns: ["**/*.md"] },

  // lobs-nexus docs
  { project: "lobs-nexus", category: "docs", path: "~/lobs/lobs-nexus/", patterns: ["**/*.md"] },

  // agents context (if it exists)
  { project: "lobs", category: "context", path: "~/lobs/agents/main/context/", patterns: ["**/*.md"] },
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpPost(url: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function httpGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https") ? https : http;
    const req = transport.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
  });
}

// ── File utilities ────────────────────────────────────────────────────────────

function expandPath(p: string): string {
  return p.replace(/^~\//, `${process.env.HOME}/`);
}

function walkDir(dir: string, patterns: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, patterns));
    } else if (entry.isFile()) {
      if (patterns.some((pat) => matchPattern(pat, entry.name))) {
        results.push(full);
      }
    }
  }
  return results;
}

function matchPattern(pattern: string, filename: string): boolean {
  if (pattern.startsWith("**/")) {
    return filename.endsWith(pattern.slice(2));
  }
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
    return regex.test(filename);
  }
  return pattern === filename;
}

function computeHash(content: string): string {
  // Simple djb2-style hash — fast, sufficient for change detection
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash) ^ content.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ── Core indexing logic ───────────────────────────────────────────────────────

interface IndexStats {
  volumesScanned: number;
  filesFound: number;
  filesChanged: number;
  bytesTotal: number;
  errors: string[];
  durationMs: number;
}

async function triggerReindex(volumes: Volume[]): Promise<IndexStats> {
  const start = Date.now();
  const stats: IndexStats = {
    volumesScanned: 0,
    filesFound: 0,
    filesChanged: 0,
    bytesTotal: 0,
    errors: [],
    durationMs: 0,
  };

  // Build a snapshot of file hashes per volume
  const volumeSnapshots: Array<{ volume: Volume; files: Array<{ path: string; hash: string; size: number }> }> = [];

  for (const volume of volumes) {
    const expandedPath = expandPath(volume.path);
    if (!fs.existsSync(expandedPath)) {
      continue;
    }
    stats.volumesScanned++;
    const patterns = volume.patterns ?? ["**/*.md"];
    const files = walkDir(expandedPath, patterns);
    const snapshot: Array<{ path: string; hash: string; size: number }> = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const hash = computeHash(content);
        const size = fs.statSync(file).size;
        snapshot.push({ path: file, hash, size });
        stats.filesFound++;
        stats.bytesTotal += size;
      } catch (e: any) {
        stats.errors.push(`Error reading ${file}: ${e.message}`);
      }
    }
    volumeSnapshots.push({ volume, files: snapshot });
  }

  // Check current status from lobs-memory
  let previousDocCount = 0;
  try {
    const status = await httpGet(`${MEMORY_URL}/status`);
    if (status.body?.docCount !== undefined) {
      previousDocCount = status.body.docCount;
    }
  } catch (e: any) {
    stats.errors.push(`Could not fetch lobs-memory status: ${e.message}`);
  }

  // Touch each changed file (update mtime) so file watchers pick them up
  // The lobs-memory watcher debounces at 2s, so we batch all touches then trigger
  for (const { volume, files } of volumeSnapshots) {
    for (const file of files) {
      try {
        // Update mtime to trigger the watcher
        const now = Date.now();
        fs.utimesSync(file.path, now, now);
        stats.filesChanged++;
      } catch (e: any) {
        stats.errors.push(`Error touching ${file.path}: ${e.message}`);
      }
    }
  }

  // Trigger a full re-index via the API
  try {
    console.log(`\n→ Triggering lobs-memory re-index at ${MEMORY_URL}/index ...`);
    const result = await httpPost(`${MEMORY_URL}/index`, {
      volumes: volumeSnapshots.map((vs) => ({
        path: expandPath(vs.volume.path),
        project: vs.volume.project,
        category: vs.volume.category,
        subcategory: vs.volume.subcategory,
        fileCount: vs.files.length,
      })),
    });

    if (result.status >= 400) {
      stats.errors.push(`Re-index API returned ${result.status}: ${JSON.stringify(result.body)}`);
    } else {
      console.log(`   ${result.body?.message ?? "Re-indexing started"}`);
    }
  } catch (e: any) {
    stats.errors.push(`Failed to call lobs-memory /index: ${e.message}`);
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

// ── Watch mode (re-index on file changes) ────────────────────────────────────

function watchVolumes(volumes: Volume[]): void {
  const chokidar = require("chokidar");
  console.log("\n🔁 Watch mode enabled — press Ctrl+C to stop\n");

  const watchers: any[] = [];
  for (const volume of volumes) {
    const expandedPath = expandPath(volume.path);
    if (!fs.existsSync(expandedPath)) continue;

    const globPatterns = (volume.patterns ?? ["**/*.md"]).map((p) =>
      path.join(expandedPath, p),
    );
    const watcher = chokidar.watch(globPatterns, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    });

    watcher.on("change", async (filePath: string) => {
      const relative = path.relative(process.env.HOME!, filePath);
      console.log(`[watch] changed: ${relative}`);
      try {
        const result = await httpPost(`${MEMORY_URL}/index`, {
          volumes: [{ path: path.dirname(filePath), forceFile: filePath }],
        });
        console.log(`[watch] indexed: ${result.body?.message ?? "ok"}`);
      } catch (e: any) {
        console.error(`[watch] error: ${e.message}`);
      }
    });

    watcher.on("add", async (filePath: string) => {
      const relative = path.relative(process.env.HOME!, filePath);
      console.log(`[watch] added: ${relative}`);
      try {
        const result = await httpPost(`${MEMORY_URL}/index`, {
          volumes: [{ path: path.dirname(filePath), forceFile: filePath }],
        });
        console.log(`[watch] indexed: ${result.body?.message ?? "ok"}`);
      } catch (e: any) {
        console.error(`[watch] error: ${e.message}`);
      }
    });

    watcher.on("error", (err: Error) => {
      console.error(`[watch] watcher error: ${err.message}`);
    });

    watchers.push(watcher);
    console.log(`  watching ${globPatterns.join(", ")}`);
  }

  process.on("SIGINT", () => {
    console.log("\n\nStopping watchers...");
    for (const w of watchers) w.close();
    process.exit(0);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const watchMode = args.includes("--watch") || args.includes("-w");
  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const verbose = args.includes("--verbose") || args.includes("-v");

  console.log(color("lobs-memory index-knowledge-base", "bold", "cyan"));
  console.log(color(`  Target:  ${MEMORY_URL}`, "dim"));
  console.log(`  Volumes: ${VOLUMES.length}`);
  console.log(`  Mode:    ${watchMode ? "watch" : dryRun ? "dry-run" : "sync"}\n`);

  if (dryRun) {
    console.log(colorize("[dry-run] Would scan:", "yellow"));
    for (const vol of VOLUMES) {
      const expanded = expandPath(vol.path);
      if (!fs.existsSync(expanded)) {
        console.log(`  ${colorize("✗ missing", "red")}  ${vol.path} (${vol.project}/${vol.category})`);
        continue;
      }
      const files = walkDir(expanded, vol.patterns ?? ["**/*.md"]);
      console.log(`  ${colorize("✓", "green")}  ${vol.path} → ${files.length} files (${vol.project}/${vol.category})`);
      if (verbose) {
        for (const f of files.slice(0, 5)) {
          console.log(`        ${path.relative(process.env.HOME!, f)}`);
        }
        if (files.length > 5) console.log(`        ... and ${files.length - 5} more`);
      }
    }
    return;
  }

  const stats = await triggerReindex(VOLUMES);

  console.log(colorize("\n── Index Summary ─────────────────────────────", "dim"));
  console.log(`  Volumes scanned : ${stats.volumesScanned}`);
  console.log(`  Files found     : ${stats.filesFound}`);
  console.log(`  Files touched   : ${stats.filesChanged}`);
  console.log(`  Total size      : ${formatBytes(stats.bytesTotal)}`);
  console.log(`  Duration        : ${stats.durationMs}ms`);

  if (stats.errors.length > 0) {
    console.log(colorize(`\n  Errors (${stats.errors.length}):`, "yellow"));
    for (const err of stats.errors.slice(0, 10)) {
      console.log(`    • ${err}`);
    }
    if (stats.errors.length > 10) {
      console.log(`    ... and ${stats.errors.length - 10} more`);
    }
  } else {
    console.log(colorize("  ✅ No errors", "green"));
  }

  console.log(
    `\n  lobs-memory will process changed files via its ${colorize("5-min sync", "dim")} periodic scan,\n` +
    `  or trigger immediately from file watcher events (2s debounce).\n`,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function colorize(text: string, color: string): string {
  const colors: Record<string, string> = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  };
  const c = colors[color] ?? "";
  const r = colors.reset ?? "\x1b[0m";
  return `${c}${text}${r}`;
}

function color(text: string, ...codes: string[]): string {
  const colors: Record<string, string> = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  };
  let out = text;
  for (const c of codes) out = `${colors[c] ?? ""}${out}`;
  out += colors.reset ?? "\x1b[0m";
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

main().catch((e) => {
  console.error(colorize(`Fatal: ${e.message}`, "red"));
  process.exit(1);
});
