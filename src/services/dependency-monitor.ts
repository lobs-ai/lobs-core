/**
 * Dependency Monitor — checks for security vulnerabilities and outdated packages.
 * Per ADR-008: runs daily (Monday at 9am ET).
 */

import { execSync } from "child_process";

/**
 * Run dependency check: npm audit + outdated packages.
 */
export async function runDependencyCheck(): Promise<void> {
  try {
    // Security audit
    try {
      const auditOutput = execSync("npm audit --json", {
        cwd: process.cwd(),
        stdio: "pipe",
        encoding: "utf-8",
      });
      const audit = JSON.parse(auditOutput);
      const vulnerabilities = audit?.metadata?.vulnerabilities ?? {};
      const total = Object.values(vulnerabilities).reduce(
        (sum: number, n: unknown) => sum + (Number(n) || 0),
        0,
      );
      if (total > 0) {
        console.warn(`[dependency-monitor] ${total} vulnerabilities found`);
      } else {
        console.log("[dependency-monitor] No vulnerabilities found");
      }
    } catch (err: unknown) {
      // npm audit returns non-zero when vulnerabilities found
      const output = err instanceof Error && "stdout" in err
        ? String((err as { stdout: unknown }).stdout)
        : String(err);
      if (output.includes("vulnerabilit")) {
        console.warn(`[dependency-monitor] Security vulnerabilities detected`);
      }
    }

    // Check for outdated packages
    try {
      const outdatedOutput = execSync("npm outdated --json", {
        cwd: process.cwd(),
        stdio: "pipe",
        encoding: "utf-8",
      });
      const outdated = JSON.parse(outdatedOutput);
      const count = Object.keys(outdated).length;
      if (count > 0) {
        console.warn(`[dependency-monitor] ${count} outdated packages`);
      } else {
        console.log("[dependency-monitor] All packages up to date");
      }
    } catch {
      // npm outdated returns non-zero when outdated packages exist
      // (exit code 1 means there ARE outdated packages — not an error)
    }
  } catch (err) {
    console.error(`[dependency-monitor] Error: ${String(err)}`);
  }
}
