import { execSync } from "node:child_process";

export interface TestCheck {
  name: string;
  passed: boolean;
  output?: string;
}

export interface TestResult {
  total: number;
  failed: number;
  checks: TestCheck[];
}

function runCheck(name: string, command: string, cwd: string): TestCheck {
  try {
    const output = execSync(command, {
      cwd,
      timeout: 300_000, // 5 min timeout
      encoding: "utf-8",
    });
    return { name, passed: true, output };
  } catch (err: unknown) {
    const output = err instanceof Error ? (err as { stdout?: string; stderr?: string }).stdout ?? "" : "";
    const stderr =
      err instanceof Error ? (err as { stderr?: string }).stderr ?? "" : "";
    return {
      name,
      passed: false,
      output: output + (stderr.length > 200 ? "\n[...truncated]\n" + stderr.slice(-200) : stderr),
    };
  }
}

/**
 * Run test suite — `npm test` — per ADR-008.
 *
 * Scheduled every 30 minutes alongside github-triage.
 * Runs vitest test suite in run mode (not watch).
 *
 * Returns summary of pass/fail counts.
 */
export function runTests(): TestResult {
  const cwd = process.cwd();
  const checks: TestCheck[] = [
    runCheck("test", "npm test -- --run", cwd),
  ];

  const failed = checks.filter((c) => !c.passed).length;
  return { total: checks.length, failed, checks };
}