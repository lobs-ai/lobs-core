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
const CI_SCHEDULE = "*/15 * * * *";
const CI_JOB_ID = "ci-runner-discord";

/** Prompt the LLM receives when the cron fires — it has the Discord tool to post results */
const CI_PROMPT = `Run CI checks in ${process.cwd()} and post results to channel <#1481131824867573770>.

Steps:
1. Run \`npm run typecheck && npm run lint\`
2. If errors: post failure summary with error count and first 20 lines of output
3. If no errors: post \`✅ All CI checks passed\`

Be concise.`;

/**
 * Register the CI runner cron job as an agent payload.
 * The LLM fires, runs CI checks, and posts results to Discord via the Discord tool.
 * Silent when all checks pass.
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
    payload: CI_PROMPT,
    enabled: true,
    channelId: CI_CHANNEL_ID,
    payloadKind: "agent",
  });

  log().info("[ci-runner] Registered CI runner cron (agent payload)");
}