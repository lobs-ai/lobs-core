/**
 * Test Runner — runs vitest suite every 30 minutes.
 * Per ADR-008: run test suites, auto-fix simple test failures.
 */

import { execSync } from "child_process";

export interface TestResult {
  total: number;
  passed: number;
  failed: number;
  output: string;
}

/**
 * Run the vitest test suite.
 */
export async function runTests(): Promise<TestResult> {
  try {
    const output = execSync("npm run test -- --reporter=verbose", {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf-8",
    });

    // Parse vitest output for pass/fail counts
    // Vitest outputs summary like "Test Files  3 passed | 1 failed"
    const passedMatch = output.match(/(\d+) passed/);
    const failedMatch = output.match(/(\d+) failed/);
    const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;

    return { total: passed + failed, passed, failed, output };
  } catch (err: unknown) {
    const output = err instanceof Error && "stdout" in err
      ? String((err as { stdout: unknown }).stdout)
      : String(err);
    const failedMatch = output.match(/(\d+) failed/);
    const passedMatch = output.match(/(\d+) passed/);
    const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
    const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;

    return { total: passed + failed, passed, failed, output };
  }
}
