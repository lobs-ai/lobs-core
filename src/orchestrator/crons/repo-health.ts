/**
 * RepoHealthCron — ADR-008 Phase 4: Repo health cron
 *
 * Runs daily. Checks for:
 * - Dead code files (no imports/exports)
 * - Unused dependencies in package.json
 * - Missing docs (files with no corresponding .md)
 *
 * Reports to Discord #agent-work.
 * Uses the agent's `agent` payload_kind.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";

const RH_CHANNEL_ID = "1481131824867573770";
const RH_SCHEDULE = "0 10 * * *"; // 10 AM daily

const RH_PROMPT = `You are checking repo health for lobs-core at /Users/lobs/lobs/lobs-core.

Check and report to Discord channel <#${RH_CHANNEL_ID}> with the following findings:

1. **Dead code files**: Find .ts/.js files in src/ that have no imports from other files and no exports. These are orphaned modules that may be unused. List the file paths.

2. **Unused dependencies**: Run \`cd /Users/lobs/lobs/lobs-core && npm ls --depth=0 2>/dev/null | grep -v "^@" | awk '{print $2}' | while read pkg; do grep -r "import.*$pkg" src/ --include="*.ts" > /dev/null || echo "$pkg"; done\` to find packages in package.json not imported anywhere. Alternatively check manually.

3. **Missing docs**: For each .ts file in src/ that has significant logic (not just re-exports), check if a corresponding .md docs file exists in docs/ or has documentation in the file header. Report files that lack docs.

Format your Discord report as:
- 🗃️ Dead code: [list or "None found"]
- 📦 Unused deps: [list or "None found"]
- 📝 Missing docs: [list or "None found"]

If everything looks healthy, post "✅ Repo health check passed — no issues found."`;

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