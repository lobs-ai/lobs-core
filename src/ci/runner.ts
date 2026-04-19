import { execSync } from "node:child_process";
import { join } from "node:path";

export interface CiCheck {
  name: string;
  passed: boolean;
  output?: string;
}

export interface CiResult {
  total: number;
  failed: number;
  checks: CiCheck[];
}

function runCheck(name: string, command: string, cwd: string): CiCheck {
  try {
    const output = execSync(command, {
      cwd,
      timeout: 120_000,
      encoding: "utf-8",
    });
    return { name, passed: true, output };
  } catch (err: unknown) {
    const exitCode = (err as { status?: number }).status ?? 1;
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
 * Run CI checks — lint + typecheck — per ADR-008.
 *
 * Scheduled weekly on Monday at 8am ET (just before cost audit).
 * Both checks must pass for a clean report.
 *
 * Returns summary of pass/fail counts.
 */
export function runCiChecks(): CiResult {
  const cwd = process.cwd();
  const checks: CiCheck[] = [
    runCheck("lint", "npm run lint", cwd),
    runCheck("typecheck", "npm run typecheck", cwd),
  ];

  const failed = checks.filter((c) => !c.passed).length;
  return { total: checks.length, failed, checks };
}