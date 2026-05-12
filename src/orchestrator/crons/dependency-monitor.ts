/**
 * DependencyMonitorCron — ADR-008 Phase 4: Dependency monitor cron
 *
 * Runs daily. Runs `npm audit --audit-level=high` in lobs-core.
 * If vulnerabilities found, creates a task with details and posts summary to Discord.
 *
 * Uses the agent's `agent` payload_kind so the LLM creates the task.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";

const DM_CHANNEL_ID = "1481131824867573770";
const DM_SCHEDULE = "0 9 * * *"; // 9 AM daily
const REPO = "lobs-ai/lobs-core";

const DM_PROMPT = `You are monitoring dependencies for ${REPO}.

Run: \`cd ~/lobs/lobs-core && npm audit --audit-level=high\`

If vulnerabilities are found:
1. Create a task titled "Dependency vulnerabilities found" with notes listing each vulnerability (package, severity, fix available yes/no)
2. Post a summary to Discord channel <#${DM_CHANNEL_ID}>: count of vulnerabilities, severity breakdown, and whether fixes are available

If no vulnerabilities found, stay silent.

Working directory for npm audit: /Users/lobs/lobs/lobs-core`;

export function registerDependencyMonitorCron(): void {
  const svc = getCronService();
  if (!svc) {
    log().warn("[dependency-monitor] CronService not initialized, skipping registration");
    return;
  }
  svc.addAgentJob({
    name: "Dependency Monitor",
    schedule: { kind: "cron", expr: DM_SCHEDULE, tz: "America/New_York" },
    payload: DM_PROMPT,
    enabled: true,
    channelId: DM_CHANNEL_ID,
    payloadKind: "agent",
  });
  log().info("[dependency-monitor] Registered dependency monitor cron");
}