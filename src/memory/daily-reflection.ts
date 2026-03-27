/**
 * Daily reflection — runs once per day to extract memories from the day's events.
 *
 * Designed to be called from a cron job (e.g. at 03:00 local time).
 * Register in src/index.ts using the project's cron pattern.
 *
 * Example registration:
 *   import { runDailyReflection } from "./memory/daily-reflection.js";
 *   // schedule with node-cron or similar at "0 3 * * *"
 *   cron.schedule("0 3 * * *", () => void runDailyReflection());
 */

import { runReflection } from "./reflection.js";
import { log } from "../util/logger.js";

/**
 * Run a full daily reflection over all events recorded since midnight today.
 * Safe to call multiple times — the daily budget cap prevents duplicate memory creation.
 */
export async function runDailyReflection(): Promise<void> {
  const now = new Date();

  // Midnight (local) → today T00:00:00.000Z equivalent
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);

  log().info(`[daily-reflection] Starting — scanning events since ${since.toISOString()}`);

  try {
    const result = await runReflection({
      trigger: "daily",
      eventRange: {
        since: since.toISOString(),
        until: now.toISOString(),
      },
      maxMemories: 50,
    });

    if (result.skipped) {
      log().info(`[daily-reflection] Skipped: ${result.skipReason}`);
    } else {
      log().info(
        `[daily-reflection] Completed — ` +
          `${result.eventsProcessed} events, ` +
          `${result.clustersProcessed} clusters, ` +
          `${result.memoriesCreated} created, ` +
          `${result.memoriesReinforced} reinforced, ` +
          `${result.conflictsDetected} conflicts, ` +
          `${result.tokensUsed} tokens used (run ${result.runId})`,
      );
    }
  } catch (err) {
    // Should never reach here — runReflection catches internally.
    // Defensive catch so cron jobs never crash.
    log().error(`[daily-reflection] Unexpected error: ${String(err)}`);
  }
}
