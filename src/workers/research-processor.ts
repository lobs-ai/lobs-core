import type { ResearchQueueService } from "../services/research-queue.js";
import {
  BaseWorker,
  type WorkerArtifact,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
} from "./base-worker.js";

export class ResearchProcessorWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "research-processor",
    name: "Research Processor",
    description: "Consumes queued docs, changelogs, and web scraps with a local model",
    schedule: "*/10 * * * *",
    enabled: true,
    maxTokens: 1024,
    timeoutMs: 60_000,
  };

  constructor(private readonly researchQueue: ResearchQueueService) {
    super();
  }

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const artifacts: WorkerArtifact[] = [];
    const alerts: WorkerResult["alerts"] = [];
    let processed = 0;

    for (let i = 0; i < 5; i++) {
      const result = await this.researchQueue.processNext();
      if (!result.processed) break;

      processed++;
      artifacts.push({
        type: "db_record",
        content: result.status === "completed"
          ? `Created research brief ${result.briefId} for queue item ${result.itemId}`
          : `Research queue item ${result.itemId} failed: ${result.error ?? "unknown error"}`,
        metadata: {
          queueItemId: result.itemId,
          briefId: result.briefId,
          status: result.status,
        },
      });

      if (result.status === "failed") {
        alerts.push({
          severity: "warning",
          title: "Research queue item failed",
          message: result.error ?? "Unknown processing error",
          actionRequired: false,
        });
      }
    }

    return {
      success: true,
      artifacts,
      alerts,
      tokensUsed: 0,
      durationMs: 0,
      summary: processed > 0
        ? `Processed ${processed} background research queue item(s)`
        : "No queued background research items",
    };
  }
}

