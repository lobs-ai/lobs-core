/**
 * Intelligence Sweep Worker — daily autonomous web intelligence gathering.
 *
 * Pipeline:
 *   1. Sweep: Run all enabled feeds → discover sources → enqueue into research pipeline
 *   2. Extract: Pick up processed research briefs → call local model → extract insights
 *   3. Route: Score insights → create inbox items for actionable findings
 *
 * Runs daily at 6 AM ET. Each run does all three phases sequentially.
 * Phase 2 + 3 also process newly completed briefs each run.
 */

import { getDb, getRawDb } from "../db/connection.js";
import { inboxItems } from "../db/schema.js";
import { randomUUID } from "node:crypto";
import {
  type IntelSweepService,
  type IntelSource,
  type SweepResult,
} from "../services/intel-sweep.js";
import {
  BaseWorker,
  callLocalModelJSON,
  type WorkerArtifact,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
} from "./base-worker.js";

// ── LLM Response Types ──────────────────────────────────────────────────

interface ExtractedInsight {
  title: string;
  insight: string;
  category: string;
  relevanceScore: number;
  actionability: "informational" | "actionable" | "urgent";
}

interface ExtractionResponse {
  insights: ExtractedInsight[];
}

// ── Worker ───────────────────────────────────────────────────────────────

export class IntelSweepWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "intel-sweep",
    name: "Intelligence Sweep",
    description: "Discovers new web content, extracts actionable insights, and routes to inbox/tasks",
    schedule: "0 6 * * *", // Daily at 6 AM ET
    enabled: true,
    maxTokens: 2048,
    timeoutMs: 120_000,
  };

  constructor(private readonly intelSweep: IntelSweepService) {
    super();
  }

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const artifacts: WorkerArtifact[] = [];
    const alerts: WorkerResult["alerts"] = [];
    let totalTokens = 0;

    // ── Phase 1: Sweep all feeds ──────────────────────────────────────
    let sweepResults: SweepResult[] = [];
    try {
      sweepResults = await this.intelSweep.sweepAll();

      const totalDiscovered = sweepResults.reduce((s, r) => s + r.sourcesDiscovered, 0);
      const totalNew = sweepResults.reduce((s, r) => s + r.sourcesNew, 0);
      const totalEnqueued = sweepResults.reduce((s, r) => s + r.sourcesEnqueued, 0);

      if (totalEnqueued > 0) {
        artifacts.push({
          type: "db_record",
          content: `Sweep: ${sweepResults.length} feeds scanned, ${totalDiscovered} discovered, ${totalNew} new, ${totalEnqueued} enqueued`,
        });
      }

      // Collect any sweep errors
      for (const r of sweepResults) {
        for (const err of r.errors) {
          alerts.push({
            severity: "warning",
            title: `Sweep error: ${r.feedName}`,
            message: err,
            actionRequired: false,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alerts.push({
        severity: "warning",
        title: "Sweep phase failed",
        message: msg,
        actionRequired: false,
      });
    }

    // ── Phase 2: Extract insights from completed briefs ───────────────
    let insightsExtracted = 0;
    try {
      const unprocessed = this.intelSweep.getUnprocessedSources(10);
      if (unprocessed.length > 0) {
        const result = await this.extractInsights(unprocessed);
        insightsExtracted = result.insightsExtracted;
        totalTokens += result.tokensUsed;

        if (insightsExtracted > 0) {
          artifacts.push({
            type: "db_record",
            content: `Extraction: ${insightsExtracted} insights from ${unprocessed.length} sources`,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alerts.push({
        severity: "warning",
        title: "Insight extraction failed",
        message: msg,
        actionRequired: false,
      });
    }

    // ── Phase 3: Route actionable insights to inbox ───────────────────
    let itemsRouted = 0;
    try {
      itemsRouted = this.routeInsights();
      if (itemsRouted > 0) {
        artifacts.push({
          type: "db_record",
          content: `Routing: ${itemsRouted} actionable insights routed to inbox`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alerts.push({
        severity: "warning",
        title: "Insight routing failed",
        message: msg,
        actionRequired: false,
      });
    }

    // ── Summary ───────────────────────────────────────────────────────
    const totalEnqueued = sweepResults.reduce((s, r) => s + r.sourcesEnqueued, 0);
    const parts: string[] = [];
    if (sweepResults.length > 0) parts.push(`${sweepResults.length} feeds swept, ${totalEnqueued} new sources`);
    if (insightsExtracted > 0) parts.push(`${insightsExtracted} insights extracted`);
    if (itemsRouted > 0) parts.push(`${itemsRouted} routed to inbox`);

    return {
      success: true,
      artifacts,
      alerts,
      tokensUsed: totalTokens,
      durationMs: 0,
      summary: parts.length > 0 ? parts.join(" · ") : "No feeds configured or no new content found",
    };
  }

  // ── Phase 2: Insight Extraction ─────────────────────────────────────

  private async extractInsights(sources: IntelSource[]): Promise<{
    insightsExtracted: number;
    tokensUsed: number;
  }> {
    let totalInsights = 0;
    let totalTokens = 0;

    for (const source of sources) {
      try {
        // Get the research brief content for this source
        const brief = this.getResearchBrief(source.researchQueueId);
        if (!brief) {
          // Mark processed even without brief — don't retry forever
          this.intelSweep.markSourceProcessed(source.id);
          continue;
        }

        // Use local model to extract insights
        const prompt = this.buildExtractionPrompt(source, brief);
        const { data, tokensUsed } = await callLocalModelJSON<ExtractionResponse>(prompt, {
          maxTokens: 1024,
          temperature: 0.3,
          systemPrompt: EXTRACTION_SYSTEM_PROMPT,
          timeoutMs: 60_000,
        });

        totalTokens += tokensUsed;

        // Save extracted insights
        for (const insight of data.insights ?? []) {
          this.intelSweep.addInsight({
            sourceId: source.id,
            feedId: source.feedId,
            title: insight.title,
            insight: insight.insight,
            category: insight.category,
            relevanceScore: Math.max(0, Math.min(1, insight.relevanceScore ?? 0.5)),
            actionability: insight.actionability ?? "informational",
          });
          totalInsights++;
        }

        // Mark source as processed
        this.intelSweep.markSourceProcessed(source.id, brief.id);
      } catch (err) {
        // Log but don't stop — process remaining sources
        const msg = err instanceof Error ? err.message : String(err);
        // Still mark as processed to avoid infinite retry loops
        this.intelSweep.markSourceProcessed(source.id);
        console.warn(`[intel-sweep] Failed to extract insights from ${source.url}: ${msg}`);
      }
    }

    return { insightsExtracted: totalInsights, tokensUsed: totalTokens };
  }

  private getResearchBrief(researchQueueId: string | null): { id: string; summary: string; keyPoints: string; tags: string } | null {
    if (!researchQueueId) return null;

    // Look up the research brief via the research_queue → research_briefs link
    const rawDb = getRawDb();
    const row = rawDb.prepare(
      `SELECT rb.id, rb.summary, rb.key_points, rb.tags
       FROM research_briefs rb
       JOIN research_queue rq ON rb.queue_item_id = rq.id
       WHERE rq.id = ? AND rq.status = 'completed'
       LIMIT 1`,
    ).get(researchQueueId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: String(row.id),
      summary: String(row.summary ?? ""),
      keyPoints: String(row.key_points ?? ""),
      tags: String(row.tags ?? ""),
    };
  }

  private buildExtractionPrompt(source: IntelSource, brief: { summary: string; keyPoints: string; tags: string }): string {
    return `Analyze the following research brief and extract actionable insights.

## Source
- **URL:** ${source.url}
- **Title:** ${source.title ?? "Unknown"}
- **Type:** ${source.sourceType}

## Research Brief Summary
${brief.summary}

## Key Points
${brief.keyPoints}

## Tags
${brief.tags}

## Instructions
Extract 1-3 insights that are relevant to building AI agent systems, self-improvement of AI agents, or software engineering best practices.

For each insight, provide:
- **title**: A concise title (under 80 chars)
- **insight**: A 1-3 sentence explanation of what's useful and how it could be applied
- **category**: One of: self_improvement, new_tool, architecture_pattern, technique, project_idea, security, performance, other
- **relevanceScore**: 0.0-1.0 how relevant this is to building better AI agent systems
- **actionability**: "informational" (nice to know), "actionable" (could act on this), or "urgent" (should act now)

If the content has nothing relevant, return an empty insights array.

Respond with JSON only:
\`\`\`json
{
  "insights": [
    {
      "title": "...",
      "insight": "...",
      "category": "...",
      "relevanceScore": 0.8,
      "actionability": "actionable"
    }
  ]
}
\`\`\``;
  }

  // ── Phase 3: Routing ────────────────────────────────────────────────

  /**
   * Route unrouted insights to inbox items. Only routes insights above
   * a relevance threshold or marked as actionable/urgent.
   */
  private routeInsights(): number {
    const insights = this.intelSweep.listInsights({
      unrouted: true,
      minRelevance: 0.3, // Low bar for now — surface more rather than less
      limit: 20,
    });

    let routed = 0;
    const db = getDb();
    const now = new Date().toISOString();

    for (const insight of insights) {
      // Only route actionable/urgent insights, or high-relevance informational ones
      if (insight.actionability === "informational" && insight.relevanceScore < 0.7) {
        // Still mark as routed (to "skipped") so we don't re-process
        this.intelSweep.markInsightRouted(insight.id, "skipped", "");
        continue;
      }

      try {
        // Create inbox item
        const inboxId = `intel_${randomUUID().slice(0, 8)}`;
        const icon = insight.actionability === "urgent" ? "🚨" : insight.actionability === "actionable" ? "💡" : "📰";
        const categoryTag = insight.category ? ` [${insight.category}]` : "";

        db.insert(inboxItems).values({
          id: inboxId,
          title: `${icon} Intel: ${insight.title}`,
          content: `${insight.insight}\n\n**Category:** ${insight.category ?? "general"}${categoryTag}\n**Relevance:** ${(insight.relevanceScore * 100).toFixed(0)}%\n**Actionability:** ${insight.actionability}`,
          summary: insight.insight.slice(0, 200),
          type: "intel_insight",
          isRead: false,
          requiresAction: insight.actionability !== "informational",
          actionStatus: insight.actionability === "urgent" ? "pending" : "none",
          modifiedAt: now,
        }).run();

        this.intelSweep.markInsightRouted(insight.id, "inbox", inboxId);
        routed++;
      } catch (err) {
        console.warn(`[intel-sweep] Failed to route insight ${insight.id}: ${err}`);
      }
    }

    return routed;
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are an intelligence analyst for an AI agent platform called Lobs. Your job is to extract actionable insights from research briefs.

Focus on:
- New techniques for building autonomous AI agents
- Tools, frameworks, or libraries relevant to agent systems
- Architecture patterns for agent orchestration, memory, tool use
- Self-improvement strategies for AI agents
- Security, reliability, and performance patterns
- Novel project ideas that could improve the Lobs platform

Be selective. Only extract genuinely useful insights. If the content is generic, low-quality, or not relevant, return an empty array.

Always respond with valid JSON.`;
