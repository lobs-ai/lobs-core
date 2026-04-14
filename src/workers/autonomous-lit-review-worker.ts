/**
 * Autonomous Literature Review Worker.
 *
 * Proactively runs literature reviews on top radar items and posts Discord digests.
 * Runs daily at 10am. Picks up to 2 stale items per run, runs lit review,
 * fires gap finder async, saves review to file, and posts digest to Discord.
 *
 * Channel: 1466921249421660415 (alerts)
 * Schedule: 0 10 * * * (10am daily)
 */

import { log } from "../util/logger.js";
import {
  BaseWorker,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
} from "./base-worker.js";
import { runAutonomousLitReview } from "../services/autonomous-lit-review.js";

export class AutonomousLitReviewWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "autonomous-lit-review",
    name: "Autonomous Literature Review",
    description: "Proactively runs literature reviews on top radar items and posts Discord digests",
    schedule: "0 10 * * *",
    enabled: true,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const startMs = Date.now();
    const result = await runAutonomousLitReview();

    log().info(
      `[worker:autonomous-lit-review] Reviewed ${result.itemsReviewed} items, skipped ${result.itemsSkipped}, Discord posted: ${result.discordPosted}`,
    );

    return {
      success: true,
      durationMs: Date.now() - startMs,
      artifacts: result.summaries.map((s) => ({
        type: "file" as const,
        content: `Reviewed ${s.title}: ${s.papersFound} papers, ${s.topGaps.length} gaps`,
        metadata: { itemId: s.itemId, papersFound: s.papersFound, topGaps: s.topGaps },
      })),
      alerts: [],
      tokensUsed: 0,
      summary: result.itemsReviewed > 0
        ? `Reviewed ${result.itemsReviewed} radar item${result.itemsReviewed === 1 ? "" : "s"}, posted Discord digest`
        : `No items needed review (${result.itemsSkipped} stale items skipped — may already be running)`,
    };
  }
}
