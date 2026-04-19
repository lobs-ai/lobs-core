/**
 * Repo Health — per ADR-008 continuous operations.
 *
 * Runs every Friday at 10am ET to:
 * - Report test coverage trends
 * - Scan for unresolved TODO/FIXME comments
 * - Check for commonly misplaced debug code (console.log in src/)
 */

import { log } from "../util/logger.js";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LOBS_ROOT = process.cwd();

interface TodoMatch {
  file: string;
  line: number;
  content: string;
  age?: string; // git blame age if available
}

function runCoverageCheck(): { coverage: number; totalTests: number } {
  try {
    // Try to read coverage summary
    const coveragePath = join(LOBS_ROOT, "coverage/coverage-summary.json");
    if (existsSync(coveragePath)) {
      const { readFileSync } = require("node:fs");
      const data = JSON.parse(readFileSync(coveragePath, "utf-8"));
      const total = data.total;
      if (total?.lines?.pct !== undefined) {
        return { coverage: total.lines.pct, totalTests: 0 };
      }
    }
  } catch {
    // fall through
  }

  // Fallback: try jest --coverage
  try {
    const output = execSync("npm test -- --coverage --coverageReporters=json-summary 2>/dev/null || echo '{}'", {
      encoding: "utf-8",
      timeout: 120_000,
      cwd: LOBS_ROOT,
    });
    const data = JSON.parse(output);
    const pct = data?.total?.lines?.pct ?? 0;
    return { coverage: pct, totalTests: 0 };
  } catch {
    return { coverage: 0, totalTests: 0 };
  }
}

function scanForTodos(dir: string, extensions: string[]): TodoMatch[] {
  const matches: TodoMatch[] = [];

  function walk(dir: string) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "coverage") continue;

      const fullPath = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const ext = entry.split(".").pop() ?? "";
        if (!extensions.includes(ext)) continue;

        try {
          const { readFileSync } = require("node:fs");
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");

          lines.forEach((line: string, idx: number) => {
            if (/\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b|\bBUG\b/.test(line)) {
              matches.push({
                file: fullPath.replace(LOBS_ROOT + "/", ""),
                line: idx + 1,
                content: line.trim().slice(0, 120),
              });
            }
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(dir);
  return matches;
}

function scanForDebugCode(dir: string): TodoMatch[] {
  const matches: TodoMatch[] = [];
  const debugPattern = /^\s*(?:console\.(log|debug|info)|debugger|process\.exit)/;

  function walk(dir: string) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "coverage") continue;

      const fullPath = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && entry.endsWith(".ts")) {
        try {
          const { readFileSync } = require("node:fs");
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");

          lines.forEach((line: string, idx: number) => {
            if (debugPattern.test(line) && !line.includes("// deno")) {
              matches.push({
                file: fullPath.replace(LOBS_ROOT + "/", ""),
                line: idx + 1,
                content: line.trim().slice(0, 120),
              });
            }
          });
        } catch {
          // skip
        }
      }
    }
  }

  walk(dir);
  return matches;
}

export async function runRepoHealthCheck(): Promise<void> {
  log().info("[repo-health] Starting repo health check");

  // 1. Test coverage
  const { coverage } = runCoverageCheck();
  if (coverage > 0) {
    const status = coverage >= 70 ? "✅" : coverage >= 50 ? "⚠️" : "❌";
    log().info(`${status} Test coverage: ${coverage.toFixed(1)}%`);
  } else {
    log().info("⚠️  Could not determine test coverage");
  }

  // 2. TODO/FIXME scan in src/
  const srcTodos = scanForTodos(join(LOBS_ROOT, "src"), ["ts", "js", "tsx"]);
  if (srcTodos.length > 0) {
    log().warn(`[repo-health] ${srcTodos.length} unresolved TODO/FIXME comments in src/:`);
    for (const m of srcTodos.slice(0, 20)) {
      log().warn(`  ${m.file}:${m.line} — ${m.content}`);
    }
  } else {
    log().info("✅ No unresolved TODO/FIXME comments in src/");
  }

  // 3. Debug code scan in src/
  const debugCode = scanForDebugCode(join(LOBS_ROOT, "src"));
  if (debugCode.length > 0) {
    log().warn(`[repo-health] ${debugCode.length} potential debug statements in src/:`);
    for (const m of debugCode.slice(0, 10)) {
      log().warn(`  ${m.file}:${m.line} — ${m.content}`);
    }
  } else {
    log().info("✅ No debug statements (console.log/debugger) found in src/");
  }

  log().info("[repo-health] Done");
}
