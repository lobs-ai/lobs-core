/**
 * GitHubTriageCron — ADR-008 Phase 4: GitHub triage cron
 *
 * Runs daily at 9 AM ET. Uses `gh` CLI to:
 * - Auto-label new unlabelled issues
 * - Detect stale PRs (no activity 7+ days)
 * - Flag unassigned issues older than 48h
 *
 * Monitors: lobs-ai/lobs-core, lobs-ai/lobs-memory, lobs-ai/lobs-nexus,
 *           paw-engineering/paw-hub, paw-engineering/ship-api
 *
 * Uses the agent's `agent` payload_kind so the LLM handles labeling.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";

const GH_CHANNEL_ID = "1481131824867573770";
const GH_SCHEDULE = "0 9 * * *"; // 9 AM ET daily
const REPOS = [
  "lobs-ai/lobs-core",
  "lobs-ai/lobs-memory",
  "lobs-ai/lobs-nexus",
  "paw-engineering/paw-hub",
  "paw-engineering/ship-api",
];

const GH_PROMPT = `You are a diligent open-source maintainer. Run GitHub triage every morning.

For each of these repos: ${REPOS.join(", ")}:

1. Scan overnight: new issues, PRs, comments
2. Label new issues: \`bug\`, \`enhancement\`, \`question\` based on content
3. Flag unassigned issues older than 48h
4. Label stale PRs (no activity in 7+ days) with \`stale\`

Shell commands to use:
- \`gh issue list --repo ${REPOS[0]} --state open --search "created:>$(date -v-1d +%Y-%m-%d)" --json number,title,author --limit 20\`
- \`gh pr list --repo ${REPOS[0]} --state open --search "updated:<$(date -v-7d +%Y-%m-%d)" --json number,title,updatedAt --limit 20\`
- \`gh issue edit --repo ${REPOS[0]} --add-label triage\`
- \`gh pr edit --repo ${REPOS[0]} --add-label stale\`

After completing all triage actions, post a brief summary to Discord channel <#${GH_CHANNEL_ID}> with counts of: new issues triaged, stale PRs labeled, unassigned issues flagged. If nothing needed doing, stay silent.`;

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
