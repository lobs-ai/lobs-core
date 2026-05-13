/**
 * MemoryCompactionCron — ADR-008 Phase 4: Memory compaction cron
 *
 * Runs every 6 hours. Triggers memory cleanup/compaction for the lobs-core
 * knowledge base (lobs-memory).
 *
 * Checks HEARTBEAT.md to see if compaction is needed, or runs a lightweight
 * cleanup pass. Since we don't have a formal compaction API, this is a no-op
 * stub that logs the intent.
 *
 * Reports to Discord #agent-work only if issues are detected.
 * Uses the agent's `agent` payload_kind so the LLM handles cleanup decisions.
 */

import { getCronService } from "../../services/cron.js";
import { log } from "../../util/logger.js";

const MC_CHANNEL_ID = "1481131824867573770";
const MC_SCHEDULE = "0 */6 * * *"; // Every 6 hours

const MC_PROMPT = `You are performing memory maintenance for lobs-core.

1. Read ~/lobs/lobs-core/HEARTBEAT.md to check if memory compaction is needed.
2. Check the lobs-memory collection status by calling the librarian_audit tool with fix=false.
3. If any issues are found (stale entries, missing docs, gaps in documentation), address them.
4. If everything looks healthy, stay silent.

Report any issues or fixes made to Discord channel <#${MC_CHANNEL_ID}>.`;

export function registerMemoryCompactionCron(): void {
  const svc = getCronService();
  if (!svc) {
    log().warn("[memory-compaction] CronService not initialized, skipping registration");
    return;
  }
  svc.addAgentJob({
    name: "Memory Compaction",
    schedule: { kind: "cron", expr: MC_SCHEDULE, tz: "America/New_York" },
    payload: MC_PROMPT,
    enabled: true,
    channelId: MC_CHANNEL_ID,
    payloadKind: "agent",
  });
  log().info("[memory-compaction] Registered memory compaction cron");
}