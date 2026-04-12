/**
 * Research Gap Finder
 *
 * Pipelines LiteratureReview output into the Research Radar automatically.
 * After a literature review completes, this service:
 *   1. Asks an LLM to extract 3-5 concrete research gap hypotheses
 *   2. Deduplicates against existing radar items (title fuzzy match)
 *   3. Creates new radar entries for any novel gaps found
 *
 * This closes the loop: literature review → gap identification → radar item.
 */

import { callApiModelJSON } from "../workers/base-worker.js";
import { getResearchRadarService } from "./research-radar.js";
import type { LiteratureReview } from "./literature-review.js";
import type { CreateRadarInput } from "./research-radar.js";
import { log } from "../util/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GapHypothesis {
  title: string;
  thesis: string;
  researchArea: string;
  gapAnalysis: string;
  ourAngle: string;
  tags: string[];
  noveltyScore: number;
  feasibilityScore: number;
  impactScore: number;
}

export interface GapFinderResult {
  gaps: GapHypothesis[];
  radarItemsCreated: number;
  radarItemsSkipped: number;
  skippedTitles: string[];
  tokensUsed: number;
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Extract research gaps from a literature review and populate the Research Radar.
 *
 * @param review  The completed LiteratureReview result
 * @param tier    LLM tier to use (defaults to "small" — haiku is sufficient)
 * @returns       Summary of what was created / skipped
 */
export async function findAndPopulateGaps(
  review: LiteratureReview,
  tier: "micro" | "small" | "standard" | "strong" = "small",
): Promise<GapFinderResult> {
  log().info(`[gap-finder] Starting gap extraction for: "${review.question}"`);

  // Build a compact corpus from the review for the LLM prompt
  const gapList = review.gaps.length > 0
    ? review.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")
    : "(no explicit gaps identified)";

  const themeList = review.themes.length > 0
    ? review.themes.map(t => `- ${t.name} [${t.consensus}]: ${t.description}`).join("\n")
    : "(no themes identified)";

  const contradictionList = review.contradictions.length > 0
    ? review.contradictions.map(c => `- ${c.claim} (unresolved: ${c.resolution})`).join("\n")
    : "(no contradictions)";

  const prompt = `You are a research strategy advisor. Given this literature review, identify 3-5 concrete, actionable research gap hypotheses that would be publishable at a top AI/CS venue.

Research question: "${review.question}"
Papers analyzed: ${review.papersAnalyzed}

Identified gaps from review:
${gapList}

Major themes:
${themeList}

Contradictions / debates:
${contradictionList}

Return a JSON array of gap hypotheses. Each must be specific, novel, and feasible:
[
  {
    "title": "Short title for the research idea (8-12 words)",
    "thesis": "One sentence: what you'd show / claim / build",
    "researchArea": "One of: agentic_engineering, llm_alignment, multimodal_ai, systems_ml, nlp, computer_vision, robotics, other",
    "gapAnalysis": "2-3 sentences: what gap exists, why it matters, what existing work misses",
    "ourAngle": "1-2 sentences: what unique angle or contribution we could make",
    "tags": ["tag1", "tag2", "tag3"],
    "noveltyScore": 0.0-1.0,
    "feasibilityScore": 0.0-1.0,
    "impactScore": 0.0-1.0
  }
]

Prioritize gaps that are:
1. Grounded in the actual review content (not generic)
2. Specific enough to be testable
3. Novel relative to existing work described in the review`;

  const { data, tokensUsed } = await callApiModelJSON<GapHypothesis[]>(
    prompt,
    {
      tier,
      maxTokens: 2000,
      systemPrompt: "You identify actionable research gaps from literature reviews. Return only a valid JSON array.",
    },
  );

  const gaps: GapHypothesis[] = Array.isArray(data) ? data : [];
  log().info(`[gap-finder] Extracted ${gaps.length} gap hypotheses`);

  // ── Populate Research Radar ───────────────────────────────────────────────

  let radarItemsCreated = 0;
  let radarItemsSkipped = 0;
  const skippedTitles: string[] = [];

  let radar;
  try {
    radar = getResearchRadarService();
  } catch {
    log().warn("[gap-finder] ResearchRadarService not initialized — skipping radar population");
    return { gaps, radarItemsCreated: 0, radarItemsSkipped: gaps.length, skippedTitles: gaps.map(g => g.title), tokensUsed };
  }

  for (const gap of gaps) {
    // Deduplicate: skip if a similar idea already exists
    const existing = radar.hasSimilarIdea(gap.title, "paper");
    if (existing) {
      log().info(`[gap-finder] Skipping "${gap.title}" — similar to existing: "${existing.title}"`);
      radarItemsSkipped++;
      skippedTitles.push(gap.title);
      continue;
    }

    const input: CreateRadarInput = {
      title: gap.title,
      thesis: gap.thesis,
      track: "paper",
      researchArea: gap.researchArea,
      tags: [...(gap.tags ?? []), "lit-review-gap", ...slugifyQuestion(review.question)],
      gapAnalysis: gap.gapAnalysis,
      ourAngle: gap.ourAngle,
      noveltyScore: clampScore(gap.noveltyScore),
      feasibilityScore: clampScore(gap.feasibilityScore),
      impactScore: clampScore(gap.impactScore),
      // Link to the literature review as a related work entry
      relatedWork: [{
        url: "#lit-review",
        title: `Literature Review: ${review.question}`,
        relevance: `Source review — ${review.papersAnalyzed} papers analyzed`,
      }],
    };

    radar.create(input);
    radarItemsCreated++;
    log().info(`[gap-finder] Created radar item: "${gap.title}"`);
  }

  log().info(`[gap-finder] Done. Created ${radarItemsCreated}, skipped ${radarItemsSkipped} (duplicates).`);

  return {
    gaps,
    radarItemsCreated,
    radarItemsSkipped,
    skippedTitles,
    tokensUsed,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/** Turn a research question into 1-2 short slug tags */
function slugifyQuestion(question: string): string[] {
  const stopWords = new Set(["the", "a", "an", "of", "in", "on", "for", "with", "using", "via", "and", "or", "is", "are", "do", "does", "how", "what", "why", "when"]);
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 3);
  return words.length > 0 ? [words.join("-")] : [];
}
