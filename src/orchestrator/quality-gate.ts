import { getModelForTier } from "../config/models.js";
/**
 * Quality gate auto-review system.
 *
 * When a programmer task completes:
 * 1. Auto-spawn reviewer with task description + output
 * 2. Reviewer evaluates: pass / needs-changes / fail
 * 3. If needs-changes: send feedback to programmer for revision
 * 4. If pass: mark task done
 * 5. If fail or max revisions exceeded: mark for human review
 */

import { log } from "../util/logger.js";
import { runAgent } from "../runner/index.js";
import type { AgentResult } from "../runner/types.js";
import { getRawDb } from "../db/connection.js";

export interface QualityGate {
  enabled: boolean;
  /** Model to use for review (defaults to same tier as original task) */
  reviewModel?: string;
  /** Auto-approve if reviewer finds no issues */
  autoApprove?: boolean;
  /** Max number of revision attempts before escalating to human */
  maxRevisions?: number;
}

export interface ReviewResult {
  verdict: "pass" | "needs-changes" | "fail";
  feedback: string;
  issues: string[];
  /** Whether the task should be marked done */
  shouldComplete: boolean;
  /** Whether human review is needed */
  needsHumanReview: boolean;
}

/**
 * Check a completed task through the quality gate.
 *
 * @param taskId - Task that just completed
 * @param agentOutput - Output from the agent that completed the task
 * @param config - Quality gate configuration
 * @param repoPath - Working directory for reviewer
 * @returns Review result with verdict and next action
 */
export async function checkQualityGate(
  taskId: string,
  agentOutput: string,
  config: QualityGate,
  repoPath: string,
): Promise<ReviewResult> {
  if (!config.enabled) {
    log().debug?.(`[QUALITY_GATE] Disabled for task ${taskId.slice(0, 8)} — auto-approving`);
    return {
      verdict: "pass",
      feedback: "Quality gate disabled",
      issues: [],
      shouldComplete: true,
      needsHumanReview: false,
    };
  }

  // Fetch task details
  const db = getRawDb();
  const task = db
    .prepare(`SELECT title, notes, agent FROM tasks WHERE id = ?`)
    .get(taskId) as { title: string; notes: string | null; agent: string | null } | undefined;

  if (!task) {
    log().error(`[QUALITY_GATE] Task ${taskId.slice(0, 8)} not found`);
    return {
      verdict: "fail",
      feedback: "Task not found in database",
      issues: ["Task metadata missing"],
      shouldComplete: false,
      needsHumanReview: true,
    };
  }

  log().info(`[QUALITY_GATE] Reviewing task ${taskId.slice(0, 8)} (${task.agent ?? "unknown"})`);

  // Build review prompt
  const reviewPrompt = `
# Code Review Task

You are reviewing the output of a ${task.agent ?? "programmer"} agent.

## Original Task
${task.title}

${task.notes ?? ""}

## Agent Output
${agentOutput.slice(0, 20000)}

---

**Your job:** Review the output and determine:

1. **Does it complete the task?** Check if all requirements are met.
2. **Is the code correct?** Look for bugs, logic errors, edge cases.
3. **Is it well-structured?** Check readability, maintainability, patterns.
4. **Are there security issues?** Check for vulnerabilities, unsafe practices.
5. **Is it tested?** Verify tests exist and cover key paths (if applicable).

**Respond with ONE of these verdicts:**

- **PASS** — Output is good, task is complete
- **NEEDS_CHANGES** — Output has issues that should be fixed (provide specific feedback)
- **FAIL** — Output is fundamentally wrong or incomplete

**Format your response as:**

\`\`\`
VERDICT: [PASS|NEEDS_CHANGES|FAIL]

ISSUES:
- [List specific issues here, one per line]

FEEDBACK:
[Detailed explanation and suggestions for fixes]
\`\`\`
`.trim();

  try {
    // Run reviewer
    const result = await runAgent({
      task: reviewPrompt,
      agent: "reviewer",
      model: config.reviewModel ?? getModelForTier("small"),
      cwd: repoPath,
      tools: ["read", "exec"], // Reviewer can read files and run checks
      timeout: 600, // 10 minutes for review
      maxTurns: 50,
    });

    if (!result.succeeded) {
      log().warn(`[QUALITY_GATE] Review failed for task ${taskId.slice(0, 8)}: ${result.error}`);
      return {
        verdict: "fail",
        feedback: `Review execution failed: ${result.error ?? "unknown error"}`,
        issues: ["Review agent failed to complete"],
        shouldComplete: false,
        needsHumanReview: true,
      };
    }

    // Parse review output
    const parsed = parseReviewOutput(result.output);

    // Check revision count
    const revisionCount = getRevisionCount(taskId);
    const maxRevisions = config.maxRevisions ?? 2;

    if (parsed.verdict === "pass") {
      log().info(`[QUALITY_GATE] ✓ Task ${taskId.slice(0, 8)} passed review`);
      return {
        verdict: "pass",
        feedback: parsed.feedback,
        issues: parsed.issues,
        shouldComplete: config.autoApprove ?? true,
        needsHumanReview: false,
      };
    } else if (parsed.verdict === "needs-changes") {
      if (revisionCount >= maxRevisions) {
        log().warn(
          `[QUALITY_GATE] Task ${taskId.slice(0, 8)} exceeded max revisions ` +
          `(${revisionCount}/${maxRevisions}) — escalating to human`,
        );
        return {
          verdict: "fail",
          feedback: parsed.feedback,
          issues: parsed.issues,
          shouldComplete: false,
          needsHumanReview: true,
        };
      }

      log().info(
        `[QUALITY_GATE] Task ${taskId.slice(0, 8)} needs changes ` +
        `(revision ${revisionCount + 1}/${maxRevisions})`,
      );
      incrementRevisionCount(taskId);

      return {
        verdict: "needs-changes",
        feedback: parsed.feedback,
        issues: parsed.issues,
        shouldComplete: false,
        needsHumanReview: false,
      };
    } else {
      // verdict === "fail"
      log().warn(`[QUALITY_GATE] ✗ Task ${taskId.slice(0, 8)} failed review`);
      return {
        verdict: "fail",
        feedback: parsed.feedback,
        issues: parsed.issues,
        shouldComplete: false,
        needsHumanReview: true,
      };
    }
  } catch (error) {
    log().error(`[QUALITY_GATE] Review threw error for task ${taskId.slice(0, 8)}: ${error}`);
    return {
      verdict: "fail",
      feedback: `Review error: ${error instanceof Error ? error.message : String(error)}`,
      issues: ["Review system error"],
      shouldComplete: false,
      needsHumanReview: true,
    };
  }
}

/**
 * Parse reviewer output to extract verdict, issues, and feedback.
 */
function parseReviewOutput(output: string): {
  verdict: "pass" | "needs-changes" | "fail";
  feedback: string;
  issues: string[];
} {
  // Look for VERDICT line
  const verdictMatch = output.match(/VERDICT:\s*(PASS|NEEDS_CHANGES|FAIL)/i);
  let verdict: "pass" | "needs-changes" | "fail" = "fail"; // default to fail if can't parse

  if (verdictMatch) {
    const v = verdictMatch[1].toUpperCase();
    if (v === "PASS") verdict = "pass";
    else if (v === "NEEDS_CHANGES" || v === "NEEDS-CHANGES") verdict = "needs-changes";
    else verdict = "fail";
  }

  // Extract ISSUES section
  const issues: string[] = [];
  const issuesMatch = output.match(/ISSUES:(.*?)(?:FEEDBACK:|$)/is);
  if (issuesMatch) {
    const issuesText = issuesMatch[1].trim();
    const lines = issuesText.split("\n");
    for (const line of lines) {
      const cleaned = line.replace(/^[-*•]\s*/, "").trim();
      if (cleaned) issues.push(cleaned);
    }
  }

  // Extract FEEDBACK section
  let feedback = "";
  const feedbackMatch = output.match(/FEEDBACK:(.*)/is);
  if (feedbackMatch) {
    feedback = feedbackMatch[1].trim();
  } else {
    // Fallback: use entire output if no structured format
    feedback = output.slice(0, 2000);
  }

  return { verdict, feedback, issues };
}

/**
 * Get the current revision count for a task.
 */
function getRevisionCount(taskId: string): number {
  const db = getRawDb();
  const result = db
    .prepare(`SELECT retry_count FROM tasks WHERE id = ?`)
    .get(taskId) as { retry_count: number | null } | undefined;

  return result?.retry_count ?? 0;
}

/**
 * Increment the revision count for a task.
 */
function incrementRevisionCount(taskId: string): void {
  const db = getRawDb();
  db.prepare(
    `UPDATE tasks SET retry_count = COALESCE(retry_count, 0) + 1, updated_at = datetime('now') WHERE id = ?`,
  ).run(taskId);
}

/**
 * Get quality gate configuration from orchestrator settings.
 */
export function getQualityGateConfig(): QualityGate {
  const db = getRawDb();
  const row = db
    .prepare(`SELECT value FROM orchestrator_settings WHERE key = 'quality_gate'`)
    .get() as { value: string } | undefined;

  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Partial<QualityGate>;
      return {
        enabled: parsed.enabled ?? true,
        reviewModel: parsed.reviewModel,
        autoApprove: parsed.autoApprove ?? true,
        maxRevisions: parsed.maxRevisions ?? 2,
      };
    } catch {
      // Invalid JSON — use defaults
    }
  }

  // Defaults
  return {
    enabled: true,
    autoApprove: true,
    maxRevisions: 2,
  };
}
