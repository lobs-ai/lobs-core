/**
 * Citation Chaser
 *
 * Claim-anchored paper search: given a specific claim, finds supporting,
 * contradicting, and tangential papers from arXiv + Semantic Scholar.
 */

import { callApiModelJSON } from "../workers/base-worker.js";
import { searchArxiv, searchSemanticScholar } from "./literature-review.js";
import type { PaperSummary } from "./literature-review.js";

export interface CitationRequest {
  claim: string;
  paperContext?: string;
  maxResults?: number;
  ssApiKey?: string;
}

export interface CitationSuggestion {
  paperId: string;
  title: string;
  authors: string[];
  year: number | null;
  citationCount: number;
  url: string;
  relevanceScore: number;
  stance: "supporting" | "contradicting" | "tangential";
  relevanceNote: string;
  bibtexKey: string;
}

export interface CitationResult {
  claim: string;
  suggestions: CitationSuggestion[];
  markdown: string;
  searchQueries: string[];
  generatedAt: string;
}

// ── Query generation ─────────────────────────────────────────────────────────

async function generateSearchQueries(
  claim: string,
  paperContext?: string,
): Promise<string[]> {
  const contextBlock = paperContext
    ? `\nPaper context: ${paperContext}`
    : "";

  const prompt = `You are a research assistant. Given a specific academic claim, generate 2-3 focused search queries to find relevant papers on arXiv and Semantic Scholar.

Claim: "${claim}"${contextBlock}

Return a JSON array of 2-3 short search queries. Each query should target a different angle: the core finding, the methodology, and a contrasting perspective.

Example: ["attention mechanism transformer NLP", "self-attention computational complexity", "recurrent networks vs attention translation"]

Return ONLY the JSON array, no other text.`;

  const { data } = await callApiModelJSON<string[]>(prompt, { tier: "micro" });
  return Array.isArray(data) ? data.slice(0, 3) : [claim];
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicatePapers(papers: PaperSummary[]): PaperSummary[] {
  const seen = new Map<string, PaperSummary>();
  for (const p of papers) {
    const key = p.paperId;
    if (!seen.has(key)) {
      seen.set(key, p);
    } else {
      // Prefer semantic-scholar entries (have citation counts)
      const existing = seen.get(key)!;
      if (p.source === "semantic-scholar" && existing.source === "arxiv") {
        seen.set(key, p);
      }
    }
  }
  return Array.from(seen.values());
}

// ── LLM scoring ───────────────────────────────────────────────────────────────

interface PaperScore {
  paperId: string;
  relevanceScore: number;
  stance: "supporting" | "contradicting" | "tangential";
  relevanceNote: string;
}

async function scorePapers(
  claim: string,
  papers: PaperSummary[],
): Promise<PaperScore[]> {
  if (papers.length === 0) return [];

  const paperList = papers
    .map(
      (p, i) =>
        `[${i}] ${p.title} (${p.year ?? "?"})\nAbstract: ${p.abstract?.slice(0, 300) ?? "N/A"}`,
    )
    .join("\n\n");

  const prompt = `You are a research assistant evaluating papers for relevance to a specific claim.

Claim: "${claim}"

Papers to evaluate:
${paperList}

For each paper, return a JSON array with one object per paper. Fields:
- paperId: the paper's ID (use the index number as a string, e.g. "0", "1", etc.)
- relevanceScore: float 0-1 (1 = highly relevant, 0 = irrelevant)
- stance: "supporting" (paper supports the claim), "contradicting" (paper challenges or contradicts the claim), or "tangential" (related background but doesn't directly address the claim)
- relevanceNote: 1-2 sentence explanation of why this paper is relevant and its stance

Return ONLY the JSON array, no other text.`;

  const { data } = await callApiModelJSON<PaperScore[]>(prompt, {
    tier: "small",
  });

  if (!Array.isArray(data)) return [];

  // Map index-based IDs back to real paperIds
  return data.map((score, i) => ({
    ...score,
    paperId: papers[parseInt(score.paperId, 10) ?? i]?.paperId ?? score.paperId,
  }));
}

// ── BibTeX key generation ─────────────────────────────────────────────────────

function makeBibtexKey(
  authors: string[],
  year: number | null,
  title: string,
): string {
  const lastName = (authors[0] ?? "unknown")
    .split(" ")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  const yearStr = year ? String(year) : "xxxx";

  const firstWord = title
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  return `${lastName}${yearStr}${firstWord}`;
}

// ── Citation boost ────────────────────────────────────────────────────────────

function applyBoost(score: number, citationCount: number): number {
  const boost = Math.min(0.2, Math.floor(citationCount / 100) * 0.05);
  return Math.min(1.0, score + boost);
}

// ── Sort order ────────────────────────────────────────────────────────────────

const STANCE_ORDER: Record<CitationSuggestion["stance"], number> = {
  supporting: 0,
  contradicting: 1,
  tangential: 2,
};

function sortSuggestions(suggestions: CitationSuggestion[]): CitationSuggestion[] {
  return [...suggestions].sort((a, b) => {
    const stanceDiff = STANCE_ORDER[a.stance] - STANCE_ORDER[b.stance];
    if (stanceDiff !== 0) return stanceDiff;
    return b.relevanceScore - a.relevanceScore;
  });
}

// ── Markdown formatting ───────────────────────────────────────────────────────

function formatMarkdown(
  claim: string,
  suggestions: CitationSuggestion[],
): string {
  const supporting = suggestions.filter((s) => s.stance === "supporting");
  const contradicting = suggestions.filter((s) => s.stance === "contradicting");
  const tangential = suggestions.filter((s) => s.stance === "tangential");

  const formatEntry = (s: CitationSuggestion): string => {
    const authorStr =
      s.authors.length > 0
        ? s.authors.length > 3
          ? `${s.authors.slice(0, 3).join(", ")} et al.`
          : s.authors.join(", ")
        : "Unknown";
    const yearStr = s.year ? ` (${s.year})` : "";
    return [
      `**${s.title}**${yearStr}`,
      `*${authorStr}*`,
      `Score: ${s.relevanceScore.toFixed(2)} | Citations: ${s.citationCount}`,
      s.relevanceNote,
      `[${s.bibtexKey}](${s.url})`,
    ].join("  \n");
  };

  const sections: string[] = [
    `## Citation Suggestions for: "${claim}"\n`,
  ];

  if (supporting.length > 0) {
    sections.push("### ✅ Supporting Citations\n");
    sections.push(...supporting.map((s) => formatEntry(s) + "\n"));
  }

  if (contradicting.length > 0) {
    sections.push("### ⚔️ Contradicting / Contrasting Work\n");
    sections.push(...contradicting.map((s) => formatEntry(s) + "\n"));
  }

  if (tangential.length > 0) {
    sections.push("### 🔗 Related Background\n");
    sections.push(...tangential.map((s) => formatEntry(s) + "\n"));
  }

  if (suggestions.length === 0) {
    sections.push("*No relevant papers found.*\n");
  }

  return sections.join("\n");
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function chaseCitations(
  req: CitationRequest,
): Promise<CitationResult> {
  const maxResults = req.maxResults ?? 8;

  // 1. Generate search queries
  const searchQueries = await generateSearchQueries(req.claim, req.paperContext);

  // 2. Search arXiv + Semantic Scholar for each query
  const allPapers: PaperSummary[] = [];

  for (const query of searchQueries) {
    // Run both sources in parallel; fall back gracefully if S2 fails
    const [arxivResults, s2Results] = await Promise.allSettled([
      searchArxiv(query, Math.ceil(maxResults / 2)),
      searchSemanticScholar(query, Math.ceil(maxResults / 2), req.ssApiKey),
    ]);

    if (arxivResults.status === "fulfilled") {
      allPapers.push(...arxivResults.value);
    } else {
      console.warn("[citation-chaser] arXiv search failed:", arxivResults.reason);
    }

    if (s2Results.status === "fulfilled") {
      allPapers.push(...s2Results.value);
    } else {
      console.warn("[citation-chaser] Semantic Scholar search failed:", s2Results.reason);
    }
  }

  // 3. Deduplicate
  const uniquePapers = deduplicatePapers(allPapers);

  // Take top candidates by citation count before scoring (keep LLM call manageable)
  const candidates = uniquePapers
    .sort((a, b) => b.citationCount - a.citationCount)
    .slice(0, Math.min(20, uniquePapers.length));

  // 4. Score papers with LLM
  const scores = await scorePapers(req.claim, candidates);

  const scoreMap = new Map<string, PaperScore>(
    scores.map((s) => [s.paperId, s]),
  );

  // 5. Build suggestions
  const suggestions: CitationSuggestion[] = candidates
    .map((paper): CitationSuggestion | null => {
      const score = scoreMap.get(paper.paperId);
      if (!score) return null;

      const boostedScore = applyBoost(score.relevanceScore, paper.citationCount);

      return {
        paperId: paper.paperId,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        citationCount: paper.citationCount,
        url: paper.url ?? `https://arxiv.org/abs/${paper.paperId}`,
        relevanceScore: boostedScore,
        stance: score.stance,
        relevanceNote: score.relevanceNote,
        bibtexKey: makeBibtexKey(paper.authors, paper.year, paper.title),
      };
    })
    .filter((s): s is CitationSuggestion => s !== null)
    .filter((s) => s.relevanceScore >= 0.2);

  // 6. Sort and truncate
  const sorted = sortSuggestions(suggestions).slice(0, maxResults);

  return {
    claim: req.claim,
    suggestions: sorted,
    markdown: formatMarkdown(req.claim, sorted),
    searchQueries,
    generatedAt: new Date().toISOString(),
  };
}
