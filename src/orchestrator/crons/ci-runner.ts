/**
 * CiRunnerCron — ADR-008 Phase 4: CI/CD monitoring cron
 *
 * Runs `npm run typecheck && npm run lint` every 15 minutes.
 * Posts a summary to Discord channel 1481131824867573770 if failures are found.
 * Silent when all checks pass.
 *
 * Uses the agent's `script` payload_kind for the DB-backed cron entry.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";
import { exec as execCb, type ExecException } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);

const CI_CHANNEL_ID = "1481131824867573770";
const CI_SCRIPT = "npm run typecheck && npm run lint";
const CI_SCHEDULE = "*/15 * * * *";
const CI_JOB_ID = "ci-runner-discord";

/** Parse error/warning counts from npm typecheck + lint output */
function parseCiOutput(stdout: string, stderr: string): { errors: number; warnings: number } {
  const combined = stdout + "\n" + stderr;
  let errors = 0;
  let warnings = 0;

  // TypeScript errors: "✖ X errors"
  const tsErrorsMatch = combined.match(/✖\s+(\d+)\s+errors?/i);
  if (tsErrorsMatch) errors += parseInt(tsErrorsMatch[1], 10);

  // TypeScript warnings: "⚠ X warnings"
  const tsWarningsMatch = combined.match(/⚠\s+(\d+)\s+warnings?/i);
  if (tsWarningsMatch) warnings += parseInt(tsWarningsMatch[1], 10);

  // ESLint errors: "X errors"
  const eslintErrorsMatch = combined.match(/(\d+)\s+errors?/i);
  if (eslintErrorsMatch) {
    const parsed = parseInt(eslintErrorsMatch[1], 10);
    if (parsed > errors) errors = parsed;
  }

  // Count individual error/warning lines (fallback for raw output)
  if (errors === 0 && warnings === 0) {
    const errorLines = (combined.match(/\berror\b/gi) || []).length;
    const warnLines = (combined.match(/\bwarning\b/gi) || []).length;
    // Rough heuristic: cap at 20 to avoid false positives from common words
    errors = Math.min(errorLines, 20);
    warnings = Math.min(warnLines, 20);
  }

  return { errors, warnings };
}

/** Post a failure summary to the CI Discord channel using webhook */
async function postToDiscord(errors: number, warnings: number, snippet: string): Promise<void> {
  try {
    // Use WebhookClient with the agent-work channel webhook URL
    const { WebhookClient } = await import("discord.js");
    const webhookClient = new WebhookClient({ url: `https://discord.com/api/webhooks/1481131824867573770/${CI_CHANNEL_ID}` });

    const emoji = errors > 0 ? "❌" : "⚠️";
    const total = errors + warnings;
    const summary = `${emoji} **CI Failure** — ${errors} error${errors !== 1 ? "s" : ""}, ${warnings} warning${warnings !== 1 ? "s" : ""}`;

    const body = snippet.length > 800 ? snippet.slice(0, 800) + "..." : snippet;

    await webhookClient.send({
      content: summary,
      embeds: [
        {
          title: "CI/CD Check Failed",
          description: `\`\`\`\n${body}\n\`\`\``,
          color: errors > 0 ? 0xff0000 : 0xffaa00,
        },
      ],
    });

    log().info(`[ci-runner] Posted CI failure summary to Discord: ${errors} errors, ${warnings} warnings`);
  } catch (err) {
    log().warn(`[ci-runner] Failed to post to Discord: ${err}`);
  }
}

/**
 * Register the CI runner cron job using the agent's script payload_kind.
 * This creates a DB-backed cron entry that runs every 15 minutes.
 */
export function registerCiRunnerCron(): void {
  getCronService().addAgentJob({
    id: CI_JOB_ID,
    name: "CI Runner",
    schedule: {
      kind: "cron",
      expr: CI_SCHEDULE,
      tz: "America/New_York",
    },
    payload: CI_SCRIPT,
    enabled: true,
    channelId: CI_CHANNEL_ID,
    payloadKind: "script",
  });

  log().info(`[ci-runner] Registered CI runner cron with script payload: "${CI_SCRIPT}"`);
}

/**
 * Run CI checks and post results to Discord if failures found.
 * Called by the cron handler when the script job fires.
 */
export async function runCiRunnerCheck(): Promise<void> {
  log().info("[ci-runner] Running CI checks...");

  let stdout = "";
  let stderr = "";

  try {
    const result = await execAsync(CI_SCRIPT, {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME: process.env.HOME },
      shell: "/bin/bash",
    });
    stdout = result.stdout || "";
    stderr = result.stderr || "";
  } catch (err: unknown) {
    // Non-zero exit — capture output even on failure
    if (err && typeof err === "object" && "stdout" in err) {
      stdout = String((err as { stdout?: string }).stdout || "");
      stderr = String((err as { stderr?: string }).stderr || "");
    }
    log().warn(`[ci-runner] CI script exited with error: ${err}`);
  }

  const { errors, warnings } = parseCiOutput(stdout, stderr);

  if (errors > 0 || warnings > 0) {
    const snippet = (stdout + "\n" + stderr).trim().slice(-1000);
    log().warn(`[ci-runner] CI checks failed: ${errors} errors, ${warnings} warnings`);
    await postToDiscord(errors, warnings, snippet);
  } else {
    log().info("[ci-runner] All CI checks passed");
  }
}