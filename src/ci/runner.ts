/**
 * CI Runner — runs build + lint + typecheck on lobs-core.
 * Per ADR-008: runs every 15 min, reports failures.
 */

import { execSync } from "child_process";
import { resolve } from "path";

const NPM = "/opt/homebrew/bin/npm";

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
    execSync(`${NPM} run typecheck`, { cwd: root, stdio: "pipe", env: { ...process.env, PATH: "/opt/homebrew/bin:" + (process.env.PATH || "") } });
    return "OK";
  }));

  // Lint
  checks.push(runCheck("lint", () => {
    execSync(`${NPM} run lint`, { cwd: root, stdio: "pipe", env: { ...process.env, PATH: "/opt/homebrew/bin:" + (process.env.PATH || "") } });
    return "OK";
  }));

  // Build
  checks.push(runCheck("build", () => {
    execSync(`${NPM} run build`, { cwd: root, stdio: "pipe", env: { ...process.env, PATH: "/opt/homebrew/bin:" + (process.env.PATH || "") } });
    return "OK";
  }));

  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;

  return { total: checks.length, passed, failed, checks };
}
