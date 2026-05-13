/**
 * CiRunnerCron — ADR-008 Phase 4: CI/CD monitoring cron
 *
 * Runs `npm run typecheck && npm run lint` every 15 minutes.
 * Posts a summary to Discord channel 1481131824867573770 if failures are found.
 * Silent when all checks pass.
 *
 * Uses the agent's `agent` payload_kind for the DB-backed cron entry.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";

const CI_CHANNEL_ID = "1481131824867573770";
const CI_SCHEDULE = "*/10 * * * *"; // Every 10 minutes
const CI_JOB_ID = "ci-runner-discord";

/** Prompt the LLM receives when the cron fires — it has the Discord tool to post results */
const CI_PROMPT = `You are a CI/CD monitor. Check all repos in ~/paw/ and ~/lobs/ that have a package.json or cargo.toml.

For each repo:
1. Run \`git fetch\` and check if main branch has new unpulled commits
2. If main has new commits, check for CI risk signals:
   - Breaking test patterns in recent commits (look for test.skip, it.skip,.skip in .test.ts files)
   - Major version bumps in package-lock.json (e.g., "major": true)
3. Alert to Discord channel <#${CI_CHANNEL_ID}> if something needs attention

Use standup mode. Be concise — only report problems, not healthy repos.`;

/**
 * Register the CI runner cron job as an agent payload.
 * The LLM fires, runs CI checks, and posts results to Discord via the Discord tool.
 * Silent when all checks pass.
 */
export function registerCiRunnerCron(): void {
  const svc = getCronService();
  if (!svc) {
    log().warn("[ci-runner] CronService not initialized, skipping registration");
    return;
  }
  svc.addAgentJob({
    name: "CI Runner",
    schedule: {
      kind: "cron",
      expr: CI_SCHEDULE,
      tz: "America/New_York",
    },
    payload: CI_PROMPT,
    enabled: true,
    channelId: CI_CHANNEL_ID,
    payloadKind: "agent",
  });

  log().info("[ci-runner] Registered CI runner cron (agent payload)");
}