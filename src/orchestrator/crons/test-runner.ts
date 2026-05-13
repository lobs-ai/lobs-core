/**
 * TestRunnerCron — ADR-008 Phase 4: Test runner cron
 *
 * Runs every 4 hours. In ~/lobs/lobs-core/, runs `npm test` and captures the result.
 * If tests fail, alerts to #agent-work with failure summary.
 * If tests pass, stays silent (no noise).
 *
 * Uses the agent's `agent` payload_kind so the LLM interprets results.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";

const TR_CHANNEL_ID = "1481131824867573770";
const TR_SCHEDULE = "0 */4 * * *"; // Every 4 hours

const TR_PROMPT = `You are running tests in ~/lobs/lobs-core/.

1. Run: \`cd ~/lobs/lobs-core && npm test\`
2. Capture the full output

If tests FAIL:
- Post a failure summary to Discord channel <#${TR_CHANNEL_ID}>: which tests failed, error type, and first few lines of stack trace
- Do NOT post anything if tests pass (stay silent)

Working directory: /Users/lobs/lobs/lobs-core`;

export function registerTestRunnerCron(): void {
  const svc = getCronService();
  if (!svc) {
    log().warn("[test-runner] CronService not initialized, skipping registration");
    return;
  }
  svc.addAgentJob({
    name: "Test Runner",
    schedule: { kind: "cron", expr: TR_SCHEDULE, tz: "America/New_York" },
    payload: TR_PROMPT,
    enabled: true,
    channelId: TR_CHANNEL_ID,
    payloadKind: "agent",
  });
  log().info("[test-runner] Registered test runner cron");
}