/**
 * RepoHealthCron — ADR-008 Phase 4: Repo health cron
 *
 * Runs Monday at 10 AM ET. Checks for:
 * - Repos with uncommitted changes
 * - Repos with stale branches (>30 days since last commit)
 * - Repos with broken package.json
 * - Repos with no commits in 60+ days
 *
 * Reports to Discord #agent-work.
 * Uses the agent's `agent` payload_kind.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";

const RH_CHANNEL_ID = "1481131824867573770";
const RH_SCHEDULE = "0 10 * * 1"; // Monday 10 AM ET

const RH_PROMPT = `You are checking repo health across ~/lobs/ and ~/paw/.

For each repo:
1. Check for uncommitted changes: \`git status --porcelain\`
2. Check for stale branches: list branches with last commit >30 days ago
3. Check for broken package.json: try \`node -e "JSON.parse(require('fs').readFileSync('package.json'))"\`
4. Check for inactive repos: no commits in 60+ days (check \`git log --format="%ci" -1\`)

Report to Discord channel <#${RH_CHANNEL_ID}>:
- Repos with uncommitted changes
- Repos with stale branches
- Repos with broken package.json
- Repos with no commits in 60+ days

If everything looks healthy, stay silent.`;

export function registerRepoHealthCron(): void {
  const svc = getCronService();
  if (!svc) {
    log().warn("[repo-health] CronService not initialized, skipping registration");
    return;
  }
  svc.addAgentJob({
    name: "Repo Health",
    schedule: { kind: "cron", expr: RH_SCHEDULE, tz: "America/New_York" },
    payload: RH_PROMPT,
    enabled: true,
    channelId: RH_CHANNEL_ID,
    payloadKind: "agent",
  });
  log().info("[repo-health] Registered repo health cron");
}