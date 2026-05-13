/**
 * DependencyMonitorCron — ADR-008 Phase 4: Dependency monitor cron
 *
 * Runs Monday at 8 AM ET. For each repo in ~/lobs/ and ~/paw/ with a package.json,
 * runs `npm audit --audit-level=moderate` and reports vulnerabilities by severity.
 *
 * Reports to Discord #agent-work.
 * Uses the agent's `agent` payload_kind so the LLM creates the task.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";

const DM_CHANNEL_ID = "1481131824867573770";
const DM_SCHEDULE = "0 8 * * 1"; // Monday 8 AM ET

const DM_PROMPT = `You are monitoring dependencies across all repos in ~/lobs/ and ~/paw/ that have a package.json.

For each repo with a package.json:
1. Run: \`npm audit --audit-level=moderate\`
2. Report vulnerabilities grouped by severity (critical, high, moderate)

Post a summary to Discord channel <#${DM_CHANNEL_ID}>: repo name, count by severity, and whether fixes are available. If no vulnerabilities found, stay silent.`;

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