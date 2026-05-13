/**
 * GitHubTriageCron — ADR-008 Phase 4: GitHub triage cron
 *
 * Runs weekdays at 9 AM ET. Uses `gh` CLI to:
 * - Identify issues with no labels
 * - Detect issues older than 7 days with no activity
 * - Flag issues assigned to @RafeSymonds or @marcus-darden
 *
 * Monitors: lobs-ai, paw-engineering orgs
 *
 * Uses the agent's `agent` payload_kind so the LLM handles triage.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";

const GH_CHANNEL_ID = "1481131824867573770";
const GH_SCHEDULE = "0 9 * * 1-5"; // 9 AM ET weekdays only
const ORGS = ["lobs-ai", "paw-engineering"];

const GH_PROMPT = `You are a diligent open-source maintainer doing GitHub triage.

For each org in ${ORGS.join(", ")}, run: \`gh issue list --state open --limit 50\`

Identify and report to Discord channel <#${GH_CHANNEL_ID}>:
1. Issues with no labels
2. Issues older than 7 days with no activity
3. Issues assigned to @RafeSymonds or @marcus-darden

Post a summary with counts and links. If nothing notable, stay silent.`;

export function registerGitHubTriageCron(): void {
  const svc = getCronService();
  if (!svc) {
    log().warn("[github-triage] CronService not initialized, skipping registration");
    return;
  }
  svc.addAgentJob({
    name: "GitHub Triage",
    schedule: { kind: "cron", expr: GH_SCHEDULE, tz: "America/New_York" },
    payload: GH_PROMPT,
    enabled: true,
    channelId: GH_CHANNEL_ID,
    payloadKind: "agent",
  });
  log().info("[github-triage] Registered GitHub triage cron");
}