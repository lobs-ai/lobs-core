/**
 * Daily memory GC — runs alongside daily reflection.
 * Designed to be called from a cron job.
 */
import { runMemoryGC } from "./gc.js";
import { log } from "../util/logger.js";

export async function runDailyGC(): Promise<void> {
  try {
    const result = await runMemoryGC();
    log().info(
      `[daily-gc] Complete: ${result.transitionsToStale} → stale, ` +
        `${result.transitionsToArchived} → archived, ` +
        `${result.confidenceReductions} confidence reductions, ` +
        `${result.protectedMemories} protected`,
    );
  } catch (err) {
    log().error(`[daily-gc] Failed: ${err}`);
  }
}
