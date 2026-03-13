/**
 * Self-reflection system — periodic analysis of recent work.
 *
 * Runs on a cron schedule (every 6 hours) to analyze recent worker runs.
 * Uses LOCAL model (NOT expensive API calls) to find patterns and issues.
 *
 * Outputs findings to ~/lobs-shared-memory/reflections/YYYY-MM-DD.md
 * Creates inbox items for critical findings.
 */

import { getRawDb } from "../db/connection.js";
import { log } from "../util/logger.js";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Import callLocal from local-classifier
// This gives us free local model access for analysis
async function callLocal(
  prompt: string,
  options?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  }
): Promise<string> {
  const LM_STUDIO_BASE = process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1";
  const DEFAULT_MODEL = process.env.LOCAL_MODEL ?? "qwen3-4b";
  const DEFAULT_TIMEOUT_MS = 15_000;
  const MAX_INPUT_CHARS = 8000;

  const model = options?.model ?? DEFAULT_MODEL;
  const maxTokens = options?.maxTokens ?? 512;
  const temperature = options?.temperature ?? 0.3;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const truncatedPrompt = prompt.length > MAX_INPUT_CHARS
    ? prompt.slice(0, MAX_INPUT_CHARS) + "\n... [truncated]"
    : prompt;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${LM_STUDIO_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: truncatedPrompt }],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LM Studio returned ${response.status}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Local model timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

interface WorkerRun {
  workerId: string;
  agentType: string;
  taskId: string;
  taskTitle: string;
  succeeded: boolean;
  model: string;
  durationSeconds: number;
  errorMessage?: string;
  startedAt: string;
}

interface ReflectionResult {
  timestamp: Date;
  periodHours: number;
  totalRuns: number;
  successRate: number;
  findings: string;
  criticalIssues: string[];
}

/**
 * Query recent worker runs from the database.
 */
async function getRecentWorkerRuns(hours: number): Promise<WorkerRun[]> {
  const db = getRawDb();
  
  const rows = db.prepare(`
    SELECT 
      wr.worker_id as workerId,
      wr.agent_type as agentType,
      wr.task_id as taskId,
      t.title as taskTitle,
      wr.succeeded,
      wr.model,
      wr.duration_seconds as durationSeconds,
      wr.error_message as errorMessage,
      wr.started_at as startedAt
    FROM worker_runs wr
    LEFT JOIN tasks t ON wr.task_id = t.id
    WHERE wr.started_at >= datetime('now', '-${hours} hours')
    ORDER BY wr.started_at DESC
  `).all() as any[];
  
  return rows.map((row) => ({
    workerId: row.workerId,
    agentType: row.agentType,
    taskId: row.taskId,
    taskTitle: row.taskTitle ?? "Unknown",
    succeeded: row.succeeded === 1,
    model: row.model,
    durationSeconds: row.durationSeconds,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
  }));
}

/**
 * Build a summary of recent work for the local model.
 */
function buildWorkSummary(runs: WorkerRun[]): string {
  const successes = runs.filter((r) => r.succeeded);
  const failures = runs.filter((r) => !r.succeeded);
  
  let summary = `# Recent Work Summary (Last 6 Hours)\n\n`;
  summary += `Total runs: ${runs.length}\n`;
  summary += `Successes: ${successes.length}\n`;
  summary += `Failures: ${failures.length}\n`;
  summary += `Success rate: ${runs.length > 0 ? ((successes.length / runs.length) * 100).toFixed(1) : 0}%\n\n`;
  
  // Group by agent type
  const byAgent: Record<string, WorkerRun[]> = {};
  for (const run of runs) {
    if (!byAgent[run.agentType]) byAgent[run.agentType] = [];
    byAgent[run.agentType].push(run);
  }
  
  summary += `## By Agent Type:\n`;
  for (const [agentType, agentRuns] of Object.entries(byAgent)) {
    const agentSuccesses = agentRuns.filter((r) => r.succeeded).length;
    summary += `- ${agentType}: ${agentRuns.length} runs (${agentSuccesses} succeeded)\n`;
  }
  
  // Recent failures
  if (failures.length > 0) {
    summary += `\n## Recent Failures:\n`;
    for (const failure of failures.slice(0, 5)) {
      summary += `- [${failure.agentType}] ${failure.taskTitle}\n`;
      if (failure.errorMessage) {
        summary += `  Error: ${failure.errorMessage.slice(0, 200)}\n`;
      }
    }
  }
  
  return summary;
}

/**
 * Run the reflection analysis.
 */
export async function runReflection(): Promise<ReflectionResult> {
  log().info("[reflection] Starting self-reflection analysis");
  
  const periodHours = 6;
  const runs = await getRecentWorkerRuns(periodHours);
  
  if (runs.length === 0) {
    log().info("[reflection] No recent worker runs to analyze");
    return {
      timestamp: new Date(),
      periodHours,
      totalRuns: 0,
      successRate: 0,
      findings: "No activity in the last 6 hours.",
      criticalIssues: [],
    };
  }
  
  const summary = buildWorkSummary(runs);
  const successes = runs.filter((r) => r.succeeded);
  const successRate = successes.length / runs.length;
  
  // Build prompt for local model
  const prompt = `You are analyzing recent work by an AI agent system. Review the summary below and provide insights.

${summary}

Answer these questions concisely:
1. What patterns do you notice?
2. What worked well?
3. What failed and why?
4. Are there recurring issues?
5. What should we do differently?

Focus on actionable insights. Be brief and specific.`;
  
  let findings = "";
  const criticalIssues: string[] = [];
  
  try {
    findings = await callLocal(prompt, { maxTokens: 800, temperature: 0.3 });
    
    // Extract critical issues (simple pattern matching)
    if (successRate < 0.5) {
      criticalIssues.push(`Low success rate: ${(successRate * 100).toFixed(1)}%`);
    }
    
    if (findings.toLowerCase().includes("critical") || findings.toLowerCase().includes("urgent")) {
      criticalIssues.push("Analysis flagged critical issues");
    }
  } catch (error) {
    log().info(`[reflection] Local model analysis failed: ${error}`);
    findings = "Local model unavailable — skipped analysis.";
  }
  
  // Write findings to file
  const home = process.env.HOME ?? "";
  const reflectionsDir = resolve(home, "lobs-shared-memory/reflections");
  
  if (!existsSync(reflectionsDir)) {
    await mkdir(reflectionsDir, { recursive: true });
  }
  
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const filePath = resolve(reflectionsDir, `${date}.md`);
  
  const content = `# Self-Reflection — ${date}

**Period:** Last ${periodHours} hours  
**Total Runs:** ${runs.length}  
**Success Rate:** ${(successRate * 100).toFixed(1)}%

## Summary

${summary}

## Analysis

${findings}

${criticalIssues.length > 0 ? `\n## ⚠️ Critical Issues\n\n${criticalIssues.map((i) => `- ${i}`).join("\n")}\n` : ""}

---
*Generated at ${new Date().toISOString()}*
`;
  
  await writeFile(filePath, content, "utf-8");
  log().info(`[reflection] Wrote findings to ${filePath}`);
  
  // Create inbox item for critical issues
  if (criticalIssues.length > 0) {
    const db = getRawDb();
    db.prepare(`
      INSERT INTO inbox_items (id, title, message, priority, read, created_at, updated_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(
      "Reflection: Critical Issues Detected",
      `Self-reflection found ${criticalIssues.length} critical issue(s). See ~/lobs-shared-memory/reflections/${date}.md`,
      "high"
    );
    log().info("[reflection] Created inbox item for critical issues");
  }
  
  return {
    timestamp: new Date(),
    periodHours,
    totalRuns: runs.length,
    successRate,
    findings,
    criticalIssues,
  };
}
