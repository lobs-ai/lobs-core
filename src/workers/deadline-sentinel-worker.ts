/**
 * Deadline Sentinel Worker — daily calendar scan for upcoming deadlines.
 *
 * Runs at 9am daily. Sends Discord alerts for events classified as deadlines
 * at 7, 3, and 1 day warning windows. Silently succeeds if no alerts fire.
 *
 * Channel: 1466921249421660415 (alerts)
 * Schedule: 0 9 * * * (9am daily)
 */

import { discordService } from "../services/discord.js";
import { scanDeadlines } from "../services/deadline-sentinel.js";
import { log } from "../util/logger.js";
import {
  BaseWorker,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
} from "./base-worker.js";

const ALERTS_CHANNEL = "1466921249421660415";

export class DeadlineSentinelWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "deadline-sentinel",
    name: "Deadline Sentinel",
    description: "Scans calendar for upcoming deadlines and sends advance warnings",
    schedule: "0 9 * * *",
    enabled: true,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const startMs = Date.now();
    const result = await scanDeadlines();

    log().info(
      `[worker:deadline-sentinel] Scanned ${result.eventsScanned} events, fired ${result.alertsFired} alerts`,
    );

    for (const alert of result.alerts) {
      try {
        await discordService.send(ALERTS_CHANNEL, alert.message);
        log().info(`[worker:deadline-sentinel] Sent alert for "${alert.title}" (${alert.warningLevel})`);
      } catch (err) {
        log().error(`[worker:deadline-sentinel] Failed to send alert for "${alert.title}": ${err}`);
      }
    }

    return {
      success: true,
      durationMs: Date.now() - startMs,
      artifacts: result.alerts.map((a) => ({
        type: "draft" as const,
        content: a.message,
        metadata: {
          eventId: a.eventId,
          warningLevel: a.warningLevel,
          daysUntil: a.daysUntil,
          category: a.category,
        },
      })),
      alerts: [],
      tokensUsed: 0,
      summary: result.alertsFired > 0
        ? `Sent ${result.alertsFired} deadline alert${result.alertsFired === 1 ? "" : "s"} (${result.eventsScanned} events scanned)`
        : `No deadline alerts — ${result.eventsScanned} events scanned, none in warning windows`,
    };
  }
}
