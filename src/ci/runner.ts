/**
 * CI Runner — runs build + lint + typecheck on lobs-core.
 * Per ADR-008: runs every 15 min, reports failures.
 */

import { execSync } from "child_process";

export interface CiCheckResult {
  name: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface CiReport {
  total: number;
  passed: number;
  failed: number;
  checks: CiCheckResult[];
}

function runCheck(name: string, fn: () => string): CiCheckResult {
  const start = Date.now();
  try {
    const output = fn();
    return { name, passed: true, output, durationMs: Date.now() - start };
  } catch (err) {
    return { name, passed: false, output: String(err), durationMs: Date.now() - start };
  }
}

/**
 * Run all CI checks: build, lint, typecheck.
 */
export async function runCiChecks(): Promise<CiReport> {
  const checks: CiCheckResult[] = [];
  const root = process.cwd();

  // Typecheck
  checks.push(runCheck("typecheck", () => {
    execSync("npm run typecheck", { cwd: root, stdio: "pipe" });
    return "OK";
  }));

  // Lint
  checks.push(runCheck("lint", () => {
    execSync("npm run lint", { cwd: root, stdio: "pipe" });
    return "OK";
  }));

  // Build
  checks.push(runCheck("build", () => {
    execSync("npm run build", { cwd: root, stdio: "pipe" });
    return "OK";
  }));

  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;

  return { total: checks.length, passed, failed, checks };
}
