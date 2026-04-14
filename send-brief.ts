import { discordService } from "./dist/services/discord.js";
import { loadConfig } from "./dist/config/index.js";

async function main() {
  await loadConfig();
  await discordService.initialize();

  const userId = "644578016298795010";
  const channelId = "1466921249421660415";

  const brief = `**Good morning Rafe!** Here's your Tuesday brief.

**Overnight Agent Activity** (past 24h)
8 agent runs, all succeeded. Total cost: $13.33.

• **Autonomous Literature Review Agent** — fully shipped and running. The system picks 2 stale radar items daily, runs full multi-hop paper discovery (arXiv + Semantic Scholar), synthesizes reviews, auto-populates research gaps, posts Discord digest. Daily 10am cron. (6 runs overnight)
• **Lit Review CLI** — \`lit-review\` command registered in package.json bin. Takes topic, depth, paper count flags. Produces papers.json, contradictions.md, related-work.md, full-review.md. (1 run)
• **Paper Submission Readiness** — verified both papers (Hybrid Memory Retrieval + Adaptive Context Budgeting) are submission-ready: all sections present, figures exist, citations matched, TODOs cleared. (1 run)

**Active Goals**
• Autonomous Literature Review Agent — 2 tasks completed today, 15 total. Fully operational.

**Tasks**
Active: 0 | Completed today: 2 | Blocked: 1 | Overdue: 0

⚠️ **Blocked:** Need Semantic Scholar API key for production lit-review quality (task: a398e986)

**System**
✅ Healthy — all services operational.`;

  // Send as DM to Rafe's user ID
  await discordService.sendDM(userId, brief);
  console.log("Sent morning brief to Rafe via DM.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});