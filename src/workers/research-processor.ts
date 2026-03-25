import type { ResearchQueueService, ResearchBrief } from "../services/research-queue.js";
import type { IntelSweepService } from "../services/intel-sweep.js";
import { log } from "../util/logger.js";
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
    description: "Consumes queued research, creates briefs and extracts actionable insights",
    schedule: "*/10 * * * *",
    enabled: true,
    maxTokens: 1024,
    timeoutMs: 60_000,
  };

  constructor(
    private readonly researchQueue: ResearchQueueService,
    private readonly intelSweep?: IntelSweepService,
  ) {
    super();
  }

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const artifacts: WorkerArtifact[] = [];
    const alerts: WorkerResult["alerts"] = [];
    let processed = 0;
    let insightsCreated = 0;

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

      // Bridge: create intel_insights from completed briefs so Research Radar can consume them
      if (result.status === "completed" && result.briefId && this.intelSweep) {
        const brief = this.researchQueue.getBrief(result.briefId);
        if (brief) {
          insightsCreated += this.extractInsights(brief);
        }
      }

      if (result.status === "failed") {
        alerts.push({
          severity: "warning",
          title: "Research queue item failed",
          message: result.error ?? "Unknown processing error",
          actionRequired: false,
        });
      }
    }

    const parts: string[] = [];
    if (processed > 0) parts.push(`Processed ${processed} research queue item(s)`);
    if (insightsCreated > 0) parts.push(`${insightsCreated} insights extracted`);

    return {
      success: true,
      artifacts,
      alerts,
      tokensUsed: 0,
      durationMs: 0,
      summary: parts.length > 0 ? parts.join(", ") : "No queued background research items",
    };
  }

  /**
   * Extract actionable insights from a completed research brief.
   * Creates one insight per key point that contains actionable/novel information.
   * Returns the number of insights created.
   */
  private extractInsights(brief: ResearchBrief): number {
    if (!this.intelSweep) return 0;

    let count = 0;

    // Find the source_id from intel_sources if this brief came from a sweep
    const sourceId = this.findSourceId(brief);

    // Create a main insight from the summary
    try {
      const actionability = this.classifyActionability(brief.summary, brief.keyPoints);
      this.intelSweep.addInsight({
        sourceId: sourceId ?? undefined,
        title: brief.title,
        insight: brief.summary,
        category: this.inferCategory(brief.keyPoints),
        relevanceScore: actionability === "actionable" ? 0.8 : actionability === "strategic" ? 0.7 : 0.5,
        actionability,
      });
      count++;

      // Also create insights for particularly actionable key points
      for (const point of brief.keyPoints) {
        if (this.isActionablePoint(point)) {
          this.intelSweep.addInsight({
            sourceId: sourceId ?? undefined,
            title: `${brief.title} — Key finding`,
            insight: point,
            category: this.inferCategory([point]),
            relevanceScore: 0.65,
            actionability: "informational",
          });
          count++;
        }
      }

      // Create insights from follow-up questions (these signal opportunities)
      for (const followUp of brief.followUps) {
        if (this.isOpportunitySignal(followUp)) {
          this.intelSweep.addInsight({
            sourceId: sourceId ?? undefined,
            title: `${brief.title} — Opportunity signal`,
            insight: followUp,
            category: "opportunity",
            relevanceScore: 0.7,
            actionability: "strategic",
          });
          count++;
        }
      }
    } catch (err) {
      log().warn(`[research-processor] Failed to extract insights from brief ${brief.id}: ${err}`);
    }

    if (count > 0) {
      log().info(`[research-processor] Extracted ${count} insight(s) from brief "${brief.title}"`);
    }
    return count;
  }

  /** Try to find the intel_sources row matching this brief's URL */
  private findSourceId(brief: ResearchBrief): string | null {
    if (!brief.sourceUrl) return null;
    try {
      const row = this.intelSweep!.findSourceByUrl(brief.sourceUrl);
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Classify whether the summary is actionable, strategic, or informational */
  private classifyActionability(summary: string, keyPoints: string[]): string {
    const text = `${summary} ${keyPoints.join(" ")}`.toLowerCase();
    const actionableSignals = [
      "should build", "could implement", "opportunity", "market gap", "unmet need",
      "we can", "worth exploring", "competitive advantage", "emerging", "breakthrough",
      "novel approach", "outperform", "state-of-the-art", "sota", "new technique",
      "open source", "released", "launched", "announced", "available",
    ];
    const strategicSignals = [
      "trend", "shift", "moving toward", "industry", "adoption", "growing",
      "research direction", "future", "prediction", "forecast", "convergence",
    ];
    const actionableCount = actionableSignals.filter(s => text.includes(s)).length;
    const strategicCount = strategicSignals.filter(s => text.includes(s)).length;

    if (actionableCount >= 2) return "actionable";
    if (strategicCount >= 2 || actionableCount >= 1) return "strategic";
    return "informational";
  }

  /** Infer a category from key points */
  private inferCategory(points: string[]): string {
    const text = points.join(" ").toLowerCase();
    if (text.includes("memory") || text.includes("rag") || text.includes("retrieval")) return "memory_systems";
    if (text.includes("agent") || text.includes("autonomous") || text.includes("orchestrat")) return "agentic_systems";
    if (text.includes("model") || text.includes("llm") || text.includes("fine-tun")) return "model_capabilities";
    if (text.includes("tool") || text.includes("function call") || text.includes("api")) return "tool_use";
    if (text.includes("market") || text.includes("product") || text.includes("saas") || text.includes("business")) return "market_opportunity";
    if (text.includes("paper") || text.includes("research") || text.includes("benchmark")) return "research";
    if (text.includes("security") || text.includes("safety") || text.includes("alignment")) return "safety";
    return "general";
  }

  /** Check if a key point is substantial enough to be its own insight */
  private isActionablePoint(point: string): boolean {
    // Skip short/generic points
    if (point.length < 40) return false;
    const lower = point.toLowerCase();
    // Skip generic definitional points
    if (lower.startsWith("ai agents are") || lower.startsWith("large language models")) return false;
    return true;
  }

  /** Check if a follow-up question signals a real opportunity */
  private isOpportunitySignal(followUp: string): boolean {
    if (followUp.length < 30) return false;
    const lower = followUp.toLowerCase();
    const signals = [
      "how could", "what if", "opportunity", "build", "implement", "create",
      "explore", "investigate", "compare", "benchmark", "evaluate", "test",
      "market", "monetize", "product", "competitive",
    ];
    return signals.some(s => lower.includes(s));
  }
}

