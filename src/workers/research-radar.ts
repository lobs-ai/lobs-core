/**
 * Research Radar Worker — identifies opportunities across three tracks.
 *
 * Runs after intel sweeps. Analyzes recent insights and identifies:
 *
 *   🎓 PAPERS — Novel research publishable at top venues (NeurIPS, ICML, etc.)
 *     Our edge: Lobs IS a production agentic system. Real experiments, real data.
 *
 *   🔧 LOBS IMPROVEMENTS — Things to build that make Lobs better
 *     What capabilities are others building that we're missing? What architectures
 *     are proving themselves? What would make our agent more capable?
 *
 *   💰 PRODUCTS — Ideas for products, SaaS, companies, things to sell
 *     Market gaps, unmet needs, emerging demand. What could be a business?
 */

import type {
  ResearchRadarService, ResearchRadarItem, CreateRadarInput,
  RelatedWork, IdeaTrack,
} from "../services/research-radar.js";
import type { IntelSweepService, IntelInsight } from "../services/intel-sweep.js";
import {
  BaseWorker,
  callLocalModelJSON,
  type WorkerArtifact,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
} from "./base-worker.js";

// ── LLM Response Types ──────────────────────────────────────────────────

interface IdentifiedIdea {
  track: IdeaTrack;
  title: string;
  thesis: string;
  gapAnalysis: string;
  ourAngle: string;
  methodology: string;       // For papers: research methodology. For lobs: implementation plan. For products: go-to-market.
  keyExperiments: string;    // For papers: experiments. For lobs: key milestones. For products: validation steps.
  noveltyScore: number;
  feasibilityScore: number;
  impactScore: number;
  researchArea: string;
  tags: string[];
  relatedWork: RelatedWork[];
}

interface IdeaIdentificationResponse {
  papers: IdentifiedIdea[];
  lobsImprovements: IdentifiedIdea[];
  products: IdentifiedIdea[];
  themes: string[];
}

interface IdeaRefinementResponse {
  updatedThesis: string;
  updatedGapAnalysis: string;
  updatedAngle: string;
  updatedMethodology: string;
  updatedExperiments: string;
  noveltyDelta: number;
  newRelatedWork: RelatedWork[];
  evolutionNote: string;
}

// ── Worker ───────────────────────────────────────────────────────────────

export class ResearchRadarWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "research-radar",
    name: "Research Radar",
    description: "Identifies opportunities: research papers, Lobs improvements, and product ideas from intel insights",
    schedule: "30 7 * * *", // 7:30 AM daily, after intel sweep at 6-7 AM
    enabled: true,
    maxTokens: 4096,
    timeoutMs: 180_000,
  };

  constructor(
    private readonly radar: ResearchRadarService,
    private readonly intel: IntelSweepService,
  ) {
    super();
  }

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    const artifacts: WorkerArtifact[] = [];
    const alerts: WorkerResult["alerts"] = [];
    let totalTokens = 0;

    // ── Phase 1: Gather recent insights ───────────────────────────────
    const recentInsights = this.intel.listInsights({
      minRelevance: 0.4,
      limit: 30,
    });

    if (recentInsights.length < 3) {
      return {
        success: true,
        artifacts: [],
        alerts: [],
        tokensUsed: 0,
        durationMs: 0,
        summary: `Only ${recentInsights.length} relevant insights — skipping analysis (need ≥3)`,
      };
    }

    // ── Phase 2: Identify new ideas across all tracks ─────────────────
    const existingIdeas = this.radar.getActiveIdeas();
    let newIdeas = 0;

    try {
      const prompt = this.buildIdentificationPrompt(recentInsights, existingIdeas);
      const { data, tokensUsed } = await callLocalModelJSON<IdeaIdentificationResponse>(prompt, {
        maxTokens: 4096,
        temperature: 0.6,
        systemPrompt: IDENTIFICATION_SYSTEM_PROMPT,
        timeoutMs: 90_000,
      });
      totalTokens += tokensUsed;

      // Process all three tracks
      const allIdeas: IdentifiedIdea[] = [
        ...(data.papers ?? []).map(i => ({ ...i, track: "paper" as IdeaTrack })),
        ...(data.lobsImprovements ?? []).map(i => ({ ...i, track: "lobs" as IdeaTrack })),
        ...(data.products ?? []).map(i => ({ ...i, track: "product" as IdeaTrack })),
      ];

      for (const idea of allIdeas) {
        const similar = this.radar.hasSimilarIdea(idea.title, idea.track);
        if (similar) {
          this.radar.update(similar.id, {
            evolutionEvent: "new_evidence",
            evolutionDetail: `New insights reinforce this: ${idea.thesis.slice(0, 200)}`,
            sourceInsightIds: recentInsights.slice(0, 5).map(i => i.id),
          });
          continue;
        }

        const input: CreateRadarInput = {
          title: idea.title,
          thesis: idea.thesis,
          track: idea.track,
          researchArea: idea.researchArea || "agentic_engineering",
          tags: idea.tags || [],
          gapAnalysis: idea.gapAnalysis,
          relatedWork: idea.relatedWork || [],
          ourAngle: idea.ourAngle,
          methodology: idea.methodology,
          keyExperiments: idea.keyExperiments,
          noveltyScore: clamp(idea.noveltyScore, 0, 1),
          feasibilityScore: clamp(idea.feasibilityScore, 0, 1),
          impactScore: clamp(idea.impactScore, 0, 1),
          sourceInsightIds: recentInsights.slice(0, 5).map(i => i.id),
          sourceFeedIds: [...new Set(recentInsights.map(i => i.feedId).filter(Boolean) as string[])],
        };

        this.radar.create(input);
        newIdeas++;
      }

      if (data.themes?.length) {
        artifacts.push({
          type: "db_record",
          content: `Themes detected: ${data.themes.join(", ")}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alerts.push({
        severity: "warning",
        title: "Idea identification failed",
        message: msg,
        actionRequired: false,
      });
    }

    // ── Phase 3: Refine top existing ideas ────────────────────────────
    let refined = 0;

    const staleIdeas = existingIdeas
      .filter(i => i.status === "idea" || i.status === "developing")
      .filter(i => {
        if (!i.lastAnalyzedAt) return true;
        const hoursSince = (Date.now() - new Date(i.lastAnalyzedAt + "Z").getTime()) / 3_600_000;
        return hoursSince > 24;
      })
      .slice(0, 3);

    for (const idea of staleIdeas) {
      try {
        const prompt = this.buildRefinementPrompt(idea, recentInsights);
        const { data, tokensUsed } = await callLocalModelJSON<IdeaRefinementResponse>(prompt, {
          maxTokens: 2048,
          temperature: 0.4,
          systemPrompt: REFINEMENT_SYSTEM_PROMPT,
          timeoutMs: 60_000,
        });
        totalTokens += tokensUsed;

        this.radar.update(idea.id, {
          thesis: data.updatedThesis || idea.thesis,
          gapAnalysis: data.updatedGapAnalysis || idea.gapAnalysis || undefined,
          ourAngle: data.updatedAngle || idea.ourAngle || undefined,
          methodology: data.updatedMethodology || idea.methodology || undefined,
          keyExperiments: data.updatedExperiments || idea.keyExperiments || undefined,
          relatedWork: [...idea.relatedWork, ...(data.newRelatedWork || [])],
          status: shouldPromote(idea, data.noveltyDelta) ? "developing" : undefined,
          evolutionEvent: "refined",
          evolutionDetail: data.evolutionNote || "Refined based on new insights",
          sourceInsightIds: recentInsights.slice(0, 3).map(i => i.id),
        });
        this.radar.markAnalyzed(idea.id);
        refined++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        alerts.push({
          severity: "info",
          title: `Refinement skipped: ${idea.title}`,
          message: msg,
          actionRequired: false,
        });
      }
    }

    // ── Phase 4: Surface high-potential ideas ─────────────────────────
    const highPotential = this.radar.list({
      status: ["developing", "ready"],
      minNovelty: 0.7,
      sortBy: "composite",
      limit: 5,
    });

    const trackLabels: Record<IdeaTrack, string> = {
      paper: "📄 Paper",
      lobs: "🔧 Lobs",
      product: "💰 Product",
    };

    for (const idea of highPotential) {
      const composite = (idea.noveltyScore * 0.4 + idea.feasibilityScore * 0.3 + idea.impactScore * 0.3);
      if (composite >= 0.7) {
        alerts.push({
          severity: "info",
          title: `${trackLabels[idea.track]} — ${idea.title}`,
          message: `N:${(idea.noveltyScore * 100).toFixed(0)} F:${(idea.feasibilityScore * 100).toFixed(0)} I:${(idea.impactScore * 100).toFixed(0)} — ${idea.thesis.slice(0, 150)}`,
          actionRequired: false,
        });
      }
    }

    // ── Summary ───────────────────────────────────────────────────────
    const parts: string[] = [];
    parts.push(`Analyzed ${recentInsights.length} insights`);
    if (newIdeas > 0) parts.push(`${newIdeas} new ideas`);
    if (refined > 0) parts.push(`${refined} refined`);
    if (highPotential.length > 0) parts.push(`${highPotential.length} high-potential`);

    if (newIdeas > 0) {
      artifacts.push({
        type: "db_record",
        content: `Research radar: ${newIdeas} new ideas identified across tracks`,
      });
    }

    return {
      success: true,
      artifacts,
      alerts,
      tokensUsed: totalTokens,
      durationMs: 0,
      summary: parts.join(" · "),
    };
  }

  // ── Prompt Builders ─────────────────────────────────────────────────

  private buildIdentificationPrompt(insights: IntelInsight[], existing: ResearchRadarItem[]): string {
    const insightBlock = insights.map((i, idx) =>
      `${idx + 1}. [${i.category ?? "general"}] ${i.title}\n   ${i.insight}`,
    ).join("\n\n");

    const existingByTrack = {
      paper: existing.filter(e => e.track === "paper"),
      lobs: existing.filter(e => e.track === "lobs"),
      product: existing.filter(e => e.track === "product"),
    };

    const formatExisting = (items: ResearchRadarItem[]) =>
      items.length > 0
        ? items.map(e => `- "${e.title}" (${e.status}, score: ${((e.noveltyScore + e.feasibilityScore + e.impactScore) / 3).toFixed(2)})`).join("\n")
        : "None yet.";

    return `## Recent Intelligence Insights

${insightBlock}

## Existing Ideas (avoid duplicates)

### Papers
${formatExisting(existingByTrack.paper)}

### Lobs Improvements
${formatExisting(existingByTrack.lobs)}

### Product Ideas
${formatExisting(existingByTrack.product)}

## Your Task

Analyze the insights above and identify opportunities across THREE tracks:

### 🎓 Track 1: PAPERS (0-2 ideas)
Novel research publishable at top venues (NeurIPS, ICML, AAAI, CHI, workshops).
- What gaps exist in current research?
- What can we uniquely study because we operate a living AI agent system?
- What contrarian takes does the evidence support?
- Focus on empirical work where we have data others don't.

### 🔧 Track 2: LOBS IMPROVEMENTS (0-2 ideas)
Things we should build to make Lobs a better agent system.
- What capabilities are others building that we're missing?
- What architectures or techniques are proving themselves in the wild?
- What would make our agent meaningfully more capable or reliable?
- Think: new tools, better memory, smarter planning, self-improvement, etc.

### 💰 Track 3: PRODUCTS (0-2 ideas)
Ideas for products, SaaS tools, companies, or things to sell.
- What unmet needs do the insights reveal?
- Where is there market demand but no good solution?
- What could be a real business based on what we're seeing?
- Think: developer tools, AI infrastructure, data products, platforms, etc.

## Our System (Lobs)
- Autonomous workers running on cron schedules
- Memory systems (embedding search, daily journals, permanent learnings)
- Multi-agent orchestration (spawning sub-agents for tasks)
- Tool use (web search, file ops, code execution, GitHub, Discord, Google APIs)
- Self-monitoring (usage tracking, worker health, error patterns)
- Intel pipeline (web scraping → insight extraction → routing)
- Built by a grad student at UMich (real academic publishing context)

For each idea across ALL tracks, provide:
- **thesis**: Core claim/pitch in 1-2 sentences
- **gapAnalysis**: What's missing that this addresses
- **ourAngle**: Why WE specifically can do this (our unique advantage)
- **methodology**: For papers: research plan. For lobs: implementation plan. For products: go-to-market plan.
- **keyExperiments**: For papers: experiments to run. For lobs: key milestones. For products: validation steps.

Quality > quantity. If nothing novel emerges for a track, return an empty array.

Respond with JSON:
\`\`\`json
{
  "papers": [
    {
      "title": "...",
      "thesis": "...",
      "gapAnalysis": "...",
      "ourAngle": "...",
      "methodology": "...",
      "keyExperiments": "...",
      "noveltyScore": 0.8,
      "feasibilityScore": 0.7,
      "impactScore": 0.6,
      "researchArea": "agentic_engineering",
      "tags": ["memory", "self-improvement"],
      "relatedWork": [{"url": "...", "title": "...", "relevance": "..."}]
    }
  ],
  "lobsImprovements": [...],
  "products": [...],
  "themes": ["theme1", "theme2"]
}
\`\`\``;
  }

  private buildRefinementPrompt(idea: ResearchRadarItem, recentInsights: IntelInsight[]): string {
    const trackContext: Record<IdeaTrack, string> = {
      paper: "This is a RESEARCH PAPER idea. Focus on publishability, methodology rigor, and empirical contribution.",
      lobs: "This is a LOBS IMPROVEMENT idea. Focus on implementation feasibility, capability gain, and integration effort.",
      product: "This is a PRODUCT idea. Focus on market viability, differentiation, and go-to-market strategy.",
    };

    const relatedBlock = idea.relatedWork.length > 0
      ? idea.relatedWork.map(r => `- [${r.title}](${r.url}) — ${r.relevance}`).join("\n")
      : "None tracked yet.";

    const insightBlock = recentInsights.slice(0, 10).map((i, idx) =>
      `${idx + 1}. [${i.category ?? "general"}] ${i.title}: ${i.insight.slice(0, 200)}`,
    ).join("\n");

    const logBlock = idea.evolutionLog.slice(-5).map(
      e => `- ${e.date.slice(0, 10)}: ${e.event} — ${e.detail}`,
    ).join("\n");

    return `## Idea to Refine

**Track:** ${idea.track.toUpperCase()}
${trackContext[idea.track]}

**Title:** ${idea.title}
**Status:** ${idea.status}
**Thesis:** ${idea.thesis}
**Gap Analysis:** ${idea.gapAnalysis ?? "Not yet written"}
**Our Angle:** ${idea.ourAngle ?? "Not yet written"}
**Methodology:** ${idea.methodology ?? "Not yet written"}
**Key Experiments/Milestones:** ${idea.keyExperiments ?? "Not yet written"}
**Scores:** Novelty ${idea.noveltyScore}, Feasibility ${idea.feasibilityScore}, Impact ${idea.impactScore}

### Related Work / Competition
${relatedBlock}

### Evolution History
${logBlock || "Newly created."}

### Recent Insights (may contain new evidence)
${insightBlock}

## Your Task
Refine this idea based on the new insights. Consider:
1. Does new evidence strengthen or weaken the thesis?
2. Are there new competitors, related work, or similar products?
3. Can we sharpen the approach based on new info?
4. Has novelty changed? (positive delta = more novel, negative = someone beat us to it / market saturated)

Respond with JSON:
\`\`\`json
{
  "updatedThesis": "...",
  "updatedGapAnalysis": "...",
  "updatedAngle": "...",
  "updatedMethodology": "...",
  "updatedExperiments": "...",
  "noveltyDelta": 0.0,
  "newRelatedWork": [{"url": "...", "title": "...", "relevance": "..."}],
  "evolutionNote": "Brief note on what changed and why"
}
\`\`\``;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function shouldPromote(idea: ResearchRadarItem, noveltyDelta: number): boolean {
  if (idea.status !== "idea") return false;
  const refinements = idea.evolutionLog.filter(e => e.event === "refined").length;
  return refinements >= 1 && (idea.noveltyScore + (noveltyDelta ?? 0)) >= 0.6;
}

// ── System Prompts ───────────────────────────────────────────────────────

const IDENTIFICATION_SYSTEM_PROMPT = `You are a strategic advisor for an AI agent project called Lobs. You identify opportunities across three domains:

1. RESEARCH PAPERS — Novel academic contributions publishable at top venues
2. LOBS IMPROVEMENTS — Technical capabilities to build into the agent system
3. PRODUCT IDEAS — Commercial opportunities, SaaS tools, companies to build

You work with a team that operates Lobs — a production AI agent system with:
- Autonomous task execution, cron-scheduled workers
- Hybrid memory (embeddings + structured DB + daily journals)
- Multi-agent orchestration with sub-agent spawning
- Real tool use: web search, GitHub, file I/O, code execution, Discord, Google APIs
- Self-monitoring and telemetry
- Intel pipeline (web scraping, insight extraction, research routing)

The operator is a grad student at UMich (MS in CSE), so academic publishing is a real output channel.

For PAPERS: Find gaps where this system gives unique empirical advantage. Avoid generic "apply X to Y."
For LOBS: Find capabilities that would make the agent meaningfully better. Avoid trivial improvements.
For PRODUCTS: Find market gaps with real demand. Avoid ideas that are already well-served.

Be ruthlessly selective. Quality over quantity. An empty array is better than weak ideas.

Always respond with valid JSON.`;

const REFINEMENT_SYSTEM_PROMPT = `You are a strategic advisor refining an idea for the Lobs AI agent project.

Be critical and honest:
- If someone published similar work or a competitor launched, lower the novelty.
- If new evidence strengthens the thesis, sharpen it.
- If the approach is vague, make it concrete with specifics.
- If the idea is getting weaker over time, say so.

For PAPERS: Focus on publishability at a top venue.
For LOBS IMPROVEMENTS: Focus on implementation feasibility and capability gain.
For PRODUCTS: Focus on market viability and differentiation.

Always respond with valid JSON.`;
