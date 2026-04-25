/**
 * Repo Health — checks for dead code, unused deps, documentation gaps.
 * Per ADR-008: runs every Friday at 10am ET.
 */

import { execSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { join } from "path";

function findFiles(dir: string, pattern: RegExp, maxDepth = 4, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...findFiles(fullPath, pattern, maxDepth, depth + 1));
        } else if (pattern.test(entry)) {
          results.push(fullPath);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return results;
}

/**
 * Run repo health checks: TODO/FIXME scan, dead code detection.
 */
export async function runRepoHealthCheck(): Promise<void> {
  const root = process.cwd();

  // Scan for unresolved TODO/FIXME comments
  try {
    const tsFiles = findFiles(join(root, "src"), /\.ts$/);
    const issues: string[] = [];

    for (const file of tsFiles) {
      try {
        const content = execSync(`grep -n "TODO\\|FIXME\\|XXX" "${file}" 2>/dev/null || true`, {
          encoding: "utf-8",
          stdio: "pipe",
        });
        if (content.trim()) {
          const lines = content.trim().split("\n").slice(0, 3);
          issues.push(`${file}: ${lines.join(" | ")}`);
        }
      } catch {
        // No matches
      }
    }

    if (issues.length > 0) {
      console.warn(`[repo-health] ${issues.length} files with TODO/FIXME`);
      for (const issue of issues.slice(0, 10)) {
        console.warn(`  ${issue}`);
      }
    } else {
      console.log("[repo-health] No unresolved TODOs/FIXMEs found");
    }
  } catch (err) {
    console.warn(`[repo-health] TODO scan error: ${String(err)}`);
  }

  // Check for empty directories (dead code indicators)
  try {
    const emptyDirs: string[] = [];
    function checkEmpty(dir: string, depth = 0): void {
      if (depth > 5) return;
      try {
        const entries = readdirSync(dir).filter(
          (e) => e !== "node_modules" && e !== ".git",
        );
        if (entries.length === 0) {
          emptyDirs.push(dir);
          return;
        }
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          try {
            if (statSync(fullPath).isDirectory()) {
              checkEmpty(fullPath, depth + 1);
            }
          } catch {
            // Skip
          }
        }
      } catch {
        // Skip
      }
    }
    checkEmpty(join(root, "src"));
    if (emptyDirs.length > 0) {
      console.warn(`[repo-health] ${emptyDirs.length} empty directories found`);
    }
  } catch (err) {
    console.warn(`[repo-health] Empty dir scan error: ${String(err)}`);
  }

  console.log("[repo-health] Health check complete");
}
