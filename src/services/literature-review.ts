/**
 * Literature Review Service
 *
 * Autonomous multi-hop literature review using arXiv + Semantic Scholar APIs.
 * Takes a research question, discovers papers through multi-hop expansion
 * (seed search → related papers → key references), reads abstracts and
 * open-access content, then synthesizes a structured markdown + LaTeX review
 * with gap analysis and contradiction detection.
 *
 * arXiv API: free, 3 req/sec, no key required.
 * Semantic Scholar API: free tier (1 req/sec), optional API key for higher limits.
 *   Set S2_API_KEY env var or pass ssApiKey in LitReviewRequest.
 */

import { callApiModelJSON } from "../workers/base-worker.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LitReviewRequest {
  question: string;
  seedCount?: number;
  expansionDepth?: number;      // How many multi-hop rounds (0=no expansion, default 1)
  relatedPerPaper?: number;     // Papers to fetch per multi-hop step (default 3)
  maxPapers?: number;
  tier?: "micro" | "small" | "standard" | "strong";
  ssApiKey?: string;            // Semantic Scholar API key (optional, improves rate limits)
  outputFormat?: "markdown" | "latex" | "both";
}

export interface PaperSummary {
  paperId: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
  url: string | null;
  pdfUrl: string | null;
  citationCount: number;
  fields: string[];
  discoveryPath: string;
  source: "arxiv" | "semantic-scholar";
  tldr?: string;
  externalIds?: Record<string, string>; // arXivId, DOI, etc.
}

export interface PaperAnalysis {
  paperId: string;
  title: string;
  year: number | null;
  keyFindings: string[];
  methodology: string;
  limitations: string[];
  claims: string[];
}

export interface LiteratureReview {
  question: string;
  generatedAt: string;
  papersAnalyzed: number;
  totalPapersDiscovered: number;
  markdown: string;
  latex?: string;
  themes: ReviewTheme[];
  gaps: string[];
  contradictions: Contradiction[];
  topPapers: PaperSummary[];
  tokensUsed: number;
  expansionGraph: ExpansionNode[];
}

export interface ReviewTheme {
  name: string;
  description: string;
  supportingPapers: string[];
  consensus: "strong" | "emerging" | "contested";
}

export interface Contradiction {
  claim: string;
  supportedBy: string[];
  contradictedBy: string[];
  resolution: string;
}

export interface ExpansionNode {
  paperId: string;
  title: string;
  depth: number;
  parentId: string | null;
}

// ─── API Clients ──────────────────────────────────────────────────────────────

const ARXIV_BASE = "http://export.arxiv.org/api/query";
const SS_BASE = "https://api.semanticscholar.org/graph/v1";
const SS_PAPER_FIELDS = "paperId,title,authors,year,abstract,url,openAccessPdf,citationCount,tldr,fieldsOfStudy,externalIds,references";
const SS_SEARCH_FIELDS = "paperId,title,authors,year,abstract,url,openAccessPdf,citationCount,tldr,fieldsOfStudy,externalIds";

const ARXIV_RATE_LIMIT_MS = 400; // 3 req/sec for arXiv
const SS_RATE_LIMIT_MS = 1100;   // ~1 req/sec for Semantic Scholar free tier
let lastArxivRequestTime = 0;
let lastSsRequestTime = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff for transient HTTP errors (429, 503, etc.).
 * Returns the successful response or throws after maxRetries exhausted.
 */
async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const { maxRetries = 3, baseDelayMs = 1000, signal } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: signal ?? AbortSignal.timeout(20000) });
      if (res.ok) return res;

      // Retry on rate-limit and service-unavailable
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const retryAfter = res.headers.get("Retry-After");
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : baseDelayMs * Math.pow(2, attempt);
        console.warn(`[lit-review] HTTP ${res.status} — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(delay);
        continue;
      }

      // Non-retryable error
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        console.warn(`[lit-review] Fetch error: ${lastError.message} — retrying (${attempt + 1}/${maxRetries})`);
        await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
  }

  throw lastError ?? new Error("fetchWithRetry: all attempts failed");
}

async function rateLimitedFetch(url: string, opts: RequestInit, lastTime: number, limitMs: number, updateFn: (t: number) => void): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastTime;
  if (elapsed < limitMs) {
    await sleep(limitMs - elapsed);
  }
  updateFn(Date.now());
  // Use retry-enabled fetch for reliability
  return fetchWithRetry(url, opts, { maxRetries: 2, baseDelayMs: 2000 });
}

function parseArxivDate(dateStr: string): number | null {
  try {
    const year = parseInt(dateStr.split("-")[0], 10);
    return year > 1990 && year < 2100 ? year : null;
  } catch {
    return null;
  }
}

// ─── arXiv Client ─────────────────────────────────────────────────────────────

export async function searchArxiv(query: string, maxResults = 10): Promise<PaperSummary[]> {
  const encoded = encodeURIComponent(query);
  const url = `${ARXIV_BASE}?search_query=all:${encoded}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;

  try {
    const res = await rateLimitedFetch(
      url,
      { headers: { "User-Agent": "LobsResearchAgent/1.0 (academic research)" } },
      lastArxivRequestTime,
      ARXIV_RATE_LIMIT_MS,
      (t) => { lastArxivRequestTime = t; },
    );
    if (!res.ok) {
      console.warn(`[lit-review] arXiv search returned ${res.status}`);
      return [];
    }

    const text = await res.text();
    return parseArxivAtom(text, "arxiv-seed-search");
  } catch (err) {
    console.error("[lit-review] arXiv search failed:", (err as Error).message);
    return [];
  }
}

async function fetchArxivPaper(paperId: string, discoveryPath: string): Promise<PaperSummary | null> {
  const url = `${ARXIV_BASE}?id_list=${encodeURIComponent(paperId)}&max_results=1`;
  try {
    const res = await rateLimitedFetch(
      url,
      { headers: { "User-Agent": "LobsResearchAgent/1.0 (academic research)" } },
      lastArxivRequestTime,
      ARXIV_RATE_LIMIT_MS,
      (t) => { lastArxivRequestTime = t; },
    );
    if (!res.ok) return null;
    const text = await res.text();
    const papers = parseArxivAtom(text, discoveryPath);
    return papers[0] ?? null;
  } catch {
    return null;
  }
}

function parseArxivAtom(xml: string, discoveryPath: string): PaperSummary[] {
  const entries: PaperSummary[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const idMatch = /<id>http:\/\/arxiv\.org\/abs\/([\d.v]+)<\/id>/i.exec(entry);
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(entry);
    const summaryMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(entry);
    const publishedMatch = /<published>([\d\-]+)/i.exec(entry);
    const authorsMatch = entry.match(/<author>\s*<name>(.*?)<\/name>/gi) || [];
    // arXiv links: look for PDF link
    const pdfMatch = /<link[^>]*title="pdf"[^>]*href="([^"]+)"[^>]*/i.exec(entry)
      || /<link[^>]*href="([^"]+)"[^>]*title="pdf"[^>]*/i.exec(entry);

    if (!idMatch || !titleMatch || !summaryMatch) continue;

    const rawId = idMatch[1];
    // Normalize: strip version suffix for stable ID
    const paperId = rawId.replace(/v\d+$/, "");

    entries.push({
      paperId,
      title: titleMatch[1].trim().replace(/\s+/g, " "),
      authors: authorsMatch.map(a => a.replace(/<[^>]+>/g, "").trim()).slice(0, 5),
      year: parseArxivDate(publishedMatch ? publishedMatch[1] : ""),
      abstract: summaryMatch[1].trim().replace(/\s+/g, " "),
      url: `https://arxiv.org/abs/${paperId}`,
      pdfUrl: pdfMatch ? pdfMatch[1] : `https://arxiv.org/pdf/${paperId}`,
      citationCount: 0,
      fields: [],
      discoveryPath,
      source: "arxiv",
      externalIds: { arXiv: paperId },
    });
  }

  return entries;
}

// ─── Semantic Scholar Client ───────────────────────────────────────────────────

export async function searchSemanticScholar(
  query: string,
  maxResults = 10,
  apiKey?: string,
): Promise<PaperSummary[]> {
  const url = `${SS_BASE}/paper/search?query=${encodeURIComponent(query)}&limit=${maxResults}&fields=${SS_SEARCH_FIELDS}`;

  try {
    const headers: Record<string, string> = { "User-Agent": "LobsResearchAgent/1.0" };
    if (apiKey) headers["x-api-key"] = apiKey;

    const res = await rateLimitedFetch(
      url,
      { headers },
      lastSsRequestTime,
      SS_RATE_LIMIT_MS,
      (t) => { lastSsRequestTime = t; },
    );

    if (res.status === 429) {
      console.warn("[lit-review] Semantic Scholar rate limited, falling back to arXiv only");
      return [];
    }
    if (!res.ok) {
      console.warn(`[lit-review] Semantic Scholar returned ${res.status}`);
      return [];
    }

    const data = await res.json() as { data?: SsApiPaper[] };
    return (data.data ?? []).map(p => ssPaperToSummary(p, "ss-seed-search"));
  } catch (err) {
    console.warn("[lit-review] Semantic Scholar search failed:", (err as Error).message);
    return [];
  }
}

async function fetchRelatedPapersFromSS(
  paperId: string,
  count: number,
  apiKey?: string,
): Promise<PaperSummary[]> {
  // For arXiv IDs, prefix with "arXiv:"
  const ssId = paperId.match(/^\d{4}\.\d+/) ? `arXiv:${paperId}` : paperId;
  const url = `${SS_BASE}/paper/${encodeURIComponent(ssId)}?fields=${SS_PAPER_FIELDS}`;

  try {
    const headers: Record<string, string> = { "User-Agent": "LobsResearchAgent/1.0" };
    if (apiKey) headers["x-api-key"] = apiKey;

    const res = await rateLimitedFetch(
      url,
      { headers },
      lastSsRequestTime,
      SS_RATE_LIMIT_MS,
      (t) => { lastSsRequestTime = t; },
    );

    if (res.status === 429 || res.status === 404) return [];
    if (!res.ok) return [];

    const paper = await res.json() as SsApiPaper & { references?: Array<{ paperId: string; title?: string; year?: number; authors?: Array<{ name: string }>; abstract?: string; citationCount?: number; openAccessPdf?: { url: string } }> };
    const refs = paper.references ?? [];

    // Sort by citationCount desc and take top N
    return refs
      .filter(r => r.paperId && r.title && r.abstract)
      .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))
      .slice(0, count)
      .map(r => ({
        paperId: r.paperId,
        title: r.title ?? "",
        authors: (r.authors ?? []).map((a) => a.name).slice(0, 5),
        year: r.year ?? null,
        abstract: r.abstract ?? "",
        url: `https://www.semanticscholar.org/paper/${r.paperId}`,
        pdfUrl: r.openAccessPdf?.url ?? null,
        citationCount: r.citationCount ?? 0,
        fields: [],
        discoveryPath: `ss-reference-of:${paperId}`,
        source: "semantic-scholar" as const,
      }));
  } catch {
    return [];
  }
}

// Fallback: use arXiv "related" by querying with paper title keywords
async function fetchRelatedPapersFromArxiv(
  paper: PaperSummary,
  count: number,
): Promise<PaperSummary[]> {
  // Extract key terms from title for related search
  const stopWords = new Set(["the", "a", "an", "of", "in", "on", "for", "with", "using", "via", "and", "or"]);
  const keywords = paper.title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 6)
    .join(" ");

  if (!keywords) return [];

  const results = await searchArxiv(keywords, count + 2);
  // Filter out the paper itself
  return results
    .filter(p => p.paperId !== paper.paperId)
    .slice(0, count)
    .map(p => ({ ...p, discoveryPath: `arxiv-related-to:${paper.paperId}` }));
}

interface SsApiPaper {
  paperId: string;
  title?: string;
  authors?: Array<{ name: string }>;
  year?: number;
  abstract?: string;
  url?: string;
  openAccessPdf?: { url: string };
  citationCount?: number;
  tldr?: { text: string };
  fieldsOfStudy?: string[];
  externalIds?: Record<string, string>;
}

function ssPaperToSummary(p: SsApiPaper, discoveryPath: string): PaperSummary {
  return {
    paperId: p.paperId,
    title: p.title ?? "",
    authors: (p.authors ?? []).map(a => a.name).slice(0, 5),
    year: p.year ?? null,
    abstract: p.abstract ?? "",
    url: p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`,
    pdfUrl: p.openAccessPdf?.url ?? null,
    citationCount: p.citationCount ?? 0,
    fields: p.fieldsOfStudy ?? [],
    discoveryPath,
    source: "semantic-scholar",
    tldr: p.tldr?.text,
    externalIds: p.externalIds,
  };
}

// ─── PDF / Full Text Fetching ─────────────────────────────────────────────────

/**
 * Attempt to fetch paper body text for analysis.
 * Strategy (in order):
 *   1. ar5iv.org HTML — full semantic HTML rendering of the arXiv paper (no PDF parsing needed)
 *   2. arXiv abstract page — HTML abstract (better than API abstract, includes subject class)
 *   3. Stored abstract fallback — minimum viable content
 *
 * ar5iv strips LaTeX, math, and figures but preserves the full semantic text of the paper,
 * which is substantially more useful for LLM analysis than just the abstract.
 * Returns null on failure (never throws).
 */
async function fetchPaperText(paper: PaperSummary, maxChars = 8000): Promise<string | null> {
  // ── 1. ar5iv HTML (full paper body) ──────────────────────────────────────────
  if (paper.externalIds?.arXiv || paper.source === "arxiv") {
    const arxivId = paper.externalIds?.arXiv ?? paper.paperId;

    try {
      const res = await fetch(`https://ar5iv.org/html/${arxivId}`, {
        headers: { "User-Agent": "LobsResearchAgent/1.0 (academic research)" },
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        const html = await res.text();
        // ar5iv wraps content in <div class="ltx_page_content"> or <main>
        // Extract paragraph text by stripping all tags inside the body
        let bodyMatch: RegExpExecArray | null = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
        if (!bodyMatch) {
          bodyMatch = /<div class="ltx_page_content">([\s\S]*?)<\/div>/i.exec(html);
        }
        if (!bodyMatch) {
          // Fallback: strip all tags and get remaining text
          const fallback = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
          bodyMatch = [0, fallback] as unknown as RegExpExecArray;
        }

        const rawText = bodyMatch![1]
          .replace(/<[^>]+>/g, " ")   // strip remaining tags
          .replace(/\s+/g, " ")
          .replace(/doi:[^\s]+/gi, "") // drop bare DOIs
          .trim();

        // Only use if it's meaningfully longer than the abstract
        if (rawText.length > paper.abstract.length + 300) {
          return rawText.slice(0, maxChars);
        }
      }
    } catch {
      // ar5iv failed — fall through to abstract
    }
  }

  // ── 2. arXiv abstract page ───────────────────────────────────────────────────
  if (paper.externalIds?.arXiv || paper.source === "arxiv") {
    const arxivId = paper.externalIds?.arXiv ?? paper.paperId;
    try {
      const res = await fetch(`https://arxiv.org/abs/${arxivId}`, {
        headers: { "User-Agent": "LobsResearchAgent/1.0 (academic research)" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const html = await res.text();
        const abstractMatch = /<blockquote[^>]*class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i.exec(html);
        if (abstractMatch) {
          const text = abstractMatch[1]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return text.slice(0, maxChars);
        }
      }
    } catch {
      // Fall through to abstract
    }
  }

  // ── 3. Stored abstract fallback ─────────────────────────────────────────────
  return paper.abstract.length > 100 ? paper.abstract.slice(0, maxChars) : null;
}

// ─── LLM Analysis ─────────────────────────────────────────────────────────────

async function analyzePaper(
  paper: PaperSummary,
  fullText: string | null,
  tier: "micro" | "small" | "standard" | "strong",
): Promise<PaperAnalysis> {
  const content = fullText && fullText.length > paper.abstract.length + 100
    ? fullText
    : paper.abstract;

  const tldrLine = paper.tldr ? `\nTL;DR: ${paper.tldr}` : "";

  const { data } = await callApiModelJSON<{
    keyFindings: string[];
    methodology: string;
    limitations: string[];
    claims: string[];
  }>(
    `Analyze this academic paper and return JSON with exactly these fields:
{
  "keyFindings": ["3-5 concrete findings with specifics"],
  "methodology": "1-2 sentence description of methods used",
  "limitations": ["1-3 explicit or implied limitations"],
  "claims": ["3-5 specific testable claims useful for contradiction detection"]
}

Paper: "${paper.title}" (${paper.year ?? "unknown"})
Authors: ${paper.authors.slice(0, 3).join(", ")}${tldrLine}

Content:
${content}`,
    {
      tier,
      maxTokens: 600,
      systemPrompt: "Extract precise findings from academic papers. Return only valid JSON.",
    },
  );

  // Guard against callApiModelJSON returning undefined (model returned no parseable JSON)
  if (!data || typeof data !== "object") {
    console.warn(`[lit-review] analyzePaper: LLM returned no JSON for "${paper.title.slice(0, 50)}"`);
    return {
      paperId: paper.paperId,
      title: paper.title,
      year: paper.year,
      keyFindings: [],
      methodology: "",
      limitations: [],
      claims: [],
    };
  }

  return {
    paperId: paper.paperId,
    title: paper.title,
    year: paper.year,
    keyFindings: Array.isArray(data.keyFindings) ? data.keyFindings : [],
    methodology: typeof data.methodology === "string" ? data.methodology : "",
    limitations: Array.isArray(data.limitations) ? data.limitations : [],
    claims: Array.isArray(data.claims) ? data.claims : [],
  };
}

async function synthesizeReview(
  question: string,
  papers: PaperSummary[],
  analyses: PaperAnalysis[],
  tier: "micro" | "small" | "standard" | "strong",
): Promise<{
  themes: ReviewTheme[];
  gaps: string[];
  contradictions: Contradiction[];
  executiveSummary: string;
  futureDirections: string[];
  practitionerTakeaways: string[];
  tokensUsed: number;
}> {
  const corpus = analyses.map(a => {
    const paper = papers.find(p => p.paperId === a.paperId);
    return `## [${a.year ?? "?"}] ${a.title}
Methodology: ${a.methodology}
Key Findings: ${a.keyFindings.join(" | ")}
Claims: ${a.claims.join(" | ")}`;
  }).join("\n\n");

  const { data, tokensUsed } = await callApiModelJSON<{
    themes: ReviewTheme[];
    gaps: string[];
    contradictions: Contradiction[];
    executiveSummary: string;
    futureDirections: string[];
    practitionerTakeaways: string[];
  }>(
    `You are synthesizing a literature review for the research question: "${question}"

Analyzed papers:
${corpus}

Return JSON with ALL of these fields:
{
  "themes": [
    {
      "name": "Theme name",
      "description": "2-3 sentences describing what papers agree/disagree on",
      "supportingPapers": ["paper title or partial title"],
      "consensus": "strong|emerging|contested"
    }
  ],
  "gaps": [
    "Specific gap 1: what is NOT studied or answered",
    "Specific gap 2"
  ],
  "contradictions": [
    {
      "claim": "The specific contested claim",
      "supportedBy": ["paper titles that support it"],
      "contradictedBy": ["paper titles that contradict it"],
      "resolution": "How to reconcile or what would resolve the contradiction"
    }
  ],
  "executiveSummary": "3-5 sentence overview of the state of research",
  "futureDirections": ["Promising research direction 1", "..."],
  "practitionerTakeaways": ["Actionable insight for practitioners 1", "..."]
}`,
    {
      tier,
      maxTokens: 3000,
      systemPrompt: "Synthesize academic literature. Identify real contradictions and gaps. Return only valid JSON.",
    },
  );

  if (!data || typeof data !== "object") {
    console.warn(`[lit-review] synthesizeReview: LLM returned no JSON for question "${question}". Analyses available: ${analyses.length}`);
    return {
      themes: [],
      gaps: [],
      contradictions: [],
      executiveSummary: "",
      futureDirections: [],
      practitionerTakeaways: [],
      tokensUsed,
    };
  }

  return {
    themes: data.themes ?? [],
    gaps: data.gaps ?? [],
    contradictions: data.contradictions ?? [],
    executiveSummary: data.executiveSummary ?? "",
    futureDirections: data.futureDirections ?? [],
    practitionerTakeaways: data.practitionerTakeaways ?? [],
    tokensUsed,
  };
}

// ─── Markdown Output ──────────────────────────────────────────────────────────

function buildMarkdown(
  question: string,
  papers: PaperSummary[],
  analyses: PaperAnalysis[],
  synthesis: {
    themes: ReviewTheme[];
    gaps: string[];
    contradictions: Contradiction[];
    executiveSummary: string;
    futureDirections: string[];
    practitionerTakeaways: string[];
  },
  expansionGraph: ExpansionNode[],
): string {
  const now = new Date().toISOString().split("T")[0];
  const lines: string[] = [];

  lines.push(`# Literature Review: ${question}`);
  lines.push(`*Generated ${now} · ${papers.length} papers analyzed*`);
  lines.push("");

  // Executive Summary
  lines.push("## Executive Summary");
  lines.push("");
  lines.push(synthesis.executiveSummary ?? "");
  lines.push("");

  // Themes
  lines.push("## Major Themes");
  lines.push("");
  for (const theme of (synthesis.themes ?? [])) {
    const consensusEmoji = theme.consensus === "strong" ? "✅" : theme.consensus === "emerging" ? "🔄" : "⚠️";
    lines.push(`### ${theme.name} ${consensusEmoji}`);
    lines.push(`*Consensus: ${theme.consensus}*`);
    lines.push("");
    lines.push(theme.description);
    lines.push("");
    if (theme.supportingPapers?.length) {
      lines.push(`**Supporting papers:** ${theme.supportingPapers.join(", ")}`);
      lines.push("");
    }
  }

  // Contradictions
  if ((synthesis.contradictions ?? []).length > 0) {
    lines.push("## Contradictions & Debates");
    lines.push("");
    for (const c of synthesis.contradictions) {
      lines.push(`### ⚡ ${c.claim}`);
      if (c.supportedBy?.length) lines.push(`- **Supported by:** ${c.supportedBy.join(", ")}`);
      if (c.contradictedBy?.length) lines.push(`- **Contradicted by:** ${c.contradictedBy.join(", ")}`);
      if (c.resolution) lines.push(`- **Resolution path:** ${c.resolution}`);
      lines.push("");
    }
  }

  // Research Gaps
  lines.push("## Research Gaps");
  lines.push("");
  for (const gap of (synthesis.gaps ?? [])) {
    lines.push(`- ${gap}`);
  }
  lines.push("");

  // Future Directions
  if ((synthesis.futureDirections ?? []).length > 0) {
    lines.push("## Future Directions");
    lines.push("");
    for (const dir of synthesis.futureDirections) {
      lines.push(`- ${dir}`);
    }
    lines.push("");
  }

  // Practitioner Takeaways
  if ((synthesis.practitionerTakeaways ?? []).length > 0) {
    lines.push("## Practitioner Takeaways");
    lines.push("");
    for (const pt of synthesis.practitionerTakeaways) {
      lines.push(`- ${pt}`);
    }
    lines.push("");
  }

  // Papers Table
  lines.push("## Papers Analyzed");
  lines.push("");
  lines.push("| Title | Year | Authors | Source |");
  lines.push("|-------|------|---------|--------|");
  for (const p of papers.slice(0, 25)) {
    const authorsStr = p.authors.slice(0, 2).join(", ") + (p.authors.length > 2 ? " et al." : "");
    const titleLink = p.url ? `[${p.title}](${p.url})` : p.title;
    const source = p.source === "arxiv" ? "arXiv" : "S2";
    lines.push(`| ${titleLink} | ${p.year ?? "—"} | ${authorsStr} | ${source} |`);
  }
  lines.push("");

  // Per-paper analysis detail
  if (analyses.length > 0) {
    lines.push("## Detailed Paper Analyses");
    lines.push("");
    for (const a of analyses.slice(0, 15)) {
      lines.push(`### ${a.title} (${a.year ?? "?"})`);
      if (a.keyFindings.length) {
        lines.push("**Key findings:**");
        for (const f of a.keyFindings) lines.push(`- ${f}`);
      }
      if (a.methodology) lines.push(`\n**Methodology:** ${a.methodology}`);
      if (a.limitations.length) {
        lines.push("\n**Limitations:**");
        for (const l of a.limitations) lines.push(`- ${l}`);
      }
      lines.push("");
    }
  }

  // Discovery graph
  if (expansionGraph.length > 0) {
    const depths = [...new Set(expansionGraph.map(n => n.depth))].sort();
    lines.push("## Discovery Graph");
    lines.push("");
    for (const depth of depths) {
      const nodes = expansionGraph.filter(n => n.depth === depth);
      const label = depth === 0 ? "Seed papers" : `Expansion depth ${depth}`;
      lines.push(`**${label}** (${nodes.length} papers)`);
      for (const n of nodes.slice(0, 5)) {
        lines.push(`- ${n.title}`);
      }
      if (nodes.length > 5) lines.push(`  *(+${nodes.length - 5} more)*`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── LaTeX Output ─────────────────────────────────────────────────────────────

function escapeLatex(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/[&%$#_{}~^]/g, c => `\\${c}`)
    .replace(/</g, "\\textless{}")
    .replace(/>/g, "\\textgreater{}")
    .replace(/\|/g, "\\textbar{}");
}

function buildLatex(
  question: string,
  papers: PaperSummary[],
  analyses: PaperAnalysis[],
  synthesis: {
    themes: ReviewTheme[];
    gaps: string[];
    contradictions: Contradiction[];
    executiveSummary: string;
    futureDirections: string[];
    practitionerTakeaways: string[];
  },
): string {
  const now = new Date().toISOString().split("T")[0];
  const lines: string[] = [];

  lines.push("\\documentclass[12pt]{article}");
  lines.push("\\usepackage[utf8]{inputenc}");
  lines.push("\\usepackage[T1]{fontenc}");
  lines.push("\\usepackage{hyperref}");
  lines.push("\\usepackage{booktabs}");
  lines.push("\\usepackage{longtable}");
  lines.push("\\usepackage{geometry}");
  lines.push("\\geometry{margin=1in}");
  lines.push("\\usepackage{enumitem}");
  lines.push("\\usepackage{xcolor}");
  lines.push("");
  lines.push("\\title{Literature Review: " + escapeLatex(question) + "}");
  lines.push("\\author{Lobs AI Research Agent}");
  lines.push(`\\date{${now}}`);
  lines.push("");
  lines.push("\\begin{document}");
  lines.push("\\maketitle");
  lines.push("\\tableofcontents");
  lines.push("\\newpage");
  lines.push("");

  // Abstract / Executive Summary
  lines.push("\\begin{abstract}");
  lines.push(escapeLatex(synthesis.executiveSummary ?? ""));
  lines.push("\\end{abstract}");
  lines.push("");

  // Themes
  lines.push("\\section{Major Themes}");
  for (const theme of (synthesis.themes ?? [])) {
    lines.push(`\\subsection{${escapeLatex(theme.name)}}`);
    lines.push(`\\textit{Consensus level: ${theme.consensus}}`);
    lines.push("");
    lines.push(escapeLatex(theme.description));
    lines.push("");
    if (theme.supportingPapers?.length) {
      lines.push("\\textbf{Supporting papers:} " + escapeLatex(theme.supportingPapers.join(", ")));
      lines.push("");
    }
  }

  // Contradictions
  if ((synthesis.contradictions ?? []).length > 0) {
    lines.push("\\section{Contradictions and Debates}");
    for (const c of synthesis.contradictions) {
      lines.push(`\\subsection{${escapeLatex(c.claim)}}`);
      lines.push("\\begin{itemize}");
      if (c.supportedBy?.length) lines.push(`  \\item \\textbf{Supported by:} ${escapeLatex(c.supportedBy.join(", "))}`);
      if (c.contradictedBy?.length) lines.push(`  \\item \\textbf{Contradicted by:} ${escapeLatex(c.contradictedBy.join(", "))}`);
      if (c.resolution) lines.push(`  \\item \\textbf{Resolution path:} ${escapeLatex(c.resolution)}`);
      lines.push("\\end{itemize}");
      lines.push("");
    }
  }

  // Gaps
  lines.push("\\section{Research Gaps}");
  lines.push("\\begin{itemize}");
  for (const gap of (synthesis.gaps ?? [])) {
    lines.push(`  \\item ${escapeLatex(gap)}`);
  }
  lines.push("\\end{itemize}");
  lines.push("");

  // Future Directions
  if ((synthesis.futureDirections ?? []).length > 0) {
    lines.push("\\section{Future Directions}");
    lines.push("\\begin{itemize}");
    for (const dir of synthesis.futureDirections) {
      lines.push(`  \\item ${escapeLatex(dir)}`);
    }
    lines.push("\\end{itemize}");
    lines.push("");
  }

  // Practitioner Takeaways
  if ((synthesis.practitionerTakeaways ?? []).length > 0) {
    lines.push("\\section{Practitioner Takeaways}");
    lines.push("\\begin{itemize}");
    for (const pt of synthesis.practitionerTakeaways) {
      lines.push(`  \\item ${escapeLatex(pt)}`);
    }
    lines.push("\\end{itemize}");
    lines.push("");
  }

  // Papers Table
  lines.push("\\section{Papers Analyzed}");
  lines.push("\\begin{longtable}{p{0.5\\textwidth}p{0.08\\textwidth}p{0.35\\textwidth}}");
  lines.push("\\toprule");
  lines.push("\\textbf{Title} & \\textbf{Year} & \\textbf{Authors} \\\\");
  lines.push("\\midrule");
  lines.push("\\endfirsthead");
  lines.push("\\toprule");
  lines.push("\\textbf{Title} & \\textbf{Year} & \\textbf{Authors} \\\\");
  lines.push("\\midrule");
  lines.push("\\endhead");
  for (const p of papers.slice(0, 25)) {
    const title = p.url
      ? `\\href{${p.url}}{${escapeLatex(p.title)}}`
      : escapeLatex(p.title);
    const authorsStr = escapeLatex(
      p.authors.slice(0, 2).join(", ") + (p.authors.length > 2 ? " et al." : "")
    );
    lines.push(`${title} & ${p.year ?? "—"} & ${authorsStr} \\\\`);
  }
  lines.push("\\bottomrule");
  lines.push("\\end{longtable}");
  lines.push("");

  // Per-paper analysis
  if (analyses.length > 0) {
    lines.push("\\section{Detailed Paper Analyses}");
    for (const a of analyses.slice(0, 15)) {
      lines.push(`\\subsection{${escapeLatex(a.title)} (${a.year ?? "?"})}`);
      if (a.keyFindings.length) {
        lines.push("\\textbf{Key Findings:}");
        lines.push("\\begin{itemize}");
        for (const f of a.keyFindings) lines.push(`  \\item ${escapeLatex(f)}`);
        lines.push("\\end{itemize}");
      }
      if (a.methodology) {
        lines.push("");
        lines.push("\\textbf{Methodology:} " + escapeLatex(a.methodology));
      }
      if (a.limitations.length) {
        lines.push("\\textbf{Limitations:}");
        lines.push("\\begin{itemize}");
        for (const l of a.limitations) lines.push(`  \\item ${escapeLatex(l)}`);
        lines.push("\\end{itemize}");
      }
      lines.push("");
    }
  }

  lines.push("\\end{document}");
  return lines.join("\n");
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runLiteratureReview(req: LitReviewRequest): Promise<LiteratureReview> {
  const {
    question,
    seedCount = 10,
    expansionDepth = 1,
    relatedPerPaper = 3,
    maxPapers = 15,
    tier = "small",
    ssApiKey = process.env.S2_API_KEY,
    outputFormat = "markdown",
  } = req;

  let totalTokens = 0;
  const seenIds = new Set<string>();
  const allPapers: PaperSummary[] = [];
  const expansionGraph: ExpansionNode[] = [];

  console.log(`[lit-review] Starting: "${question}" (depth=${expansionDepth}, maxPapers=${maxPapers})`);

  // ── Step 1: Seed search ────────────────────────────────────────────────────
  console.log("[lit-review] Step 1: Seed search (arXiv + Semantic Scholar)...");

  // Run both searches in parallel when possible
  const [arxivSeeds, ssSeeds] = await Promise.all([
    searchArxiv(question, Math.ceil(seedCount * 0.6)),
    searchSemanticScholar(question, Math.ceil(seedCount * 0.6), ssApiKey),
  ]);

  const seedPapers = [...arxivSeeds, ...ssSeeds];
  console.log(`[lit-review]   arXiv: ${arxivSeeds.length}, S2: ${ssSeeds.length}`);

  for (const p of seedPapers) {
    if (!seenIds.has(p.paperId) && p.abstract.length > 50) {
      seenIds.add(p.paperId);
      allPapers.push(p);
      expansionGraph.push({ paperId: p.paperId, title: p.title, depth: 0, parentId: null });
    }
  }

  // ── Step 2: Multi-hop expansion ───────────────────────────────────────────
  if (expansionDepth > 0 && allPapers.length > 0) {
    // Pick top N seed papers for expansion (most relevant first)
    const papersToExpand = allPapers.slice(0, Math.min(5, allPapers.length));

    for (let depth = 1; depth <= expansionDepth; depth++) {
      console.log(`[lit-review] Step 2.${depth}: Multi-hop expansion (depth ${depth})...`);

      // Use papers from previous depth as expansion candidates
      const prevDepthPapers = depth === 1
        ? papersToExpand
        : allPapers.filter(p => expansionGraph.find(n => n.paperId === p.paperId && n.depth === depth - 1));

      for (const paper of prevDepthPapers.slice(0, 4)) {
        if (allPapers.length >= maxPapers * 2) break; // Cap total discovered

        let related: PaperSummary[] = [];

        // Try Semantic Scholar references first (higher quality) — always try SS
        related = await fetchRelatedPapersFromSS(paper.paperId, relatedPerPaper, ssApiKey);

        // Fall back to arXiv keyword search if SS gave nothing
        if (related.length === 0) {
          related = await fetchRelatedPapersFromArxiv(paper, relatedPerPaper);
        }

        let addedCount = 0;
        for (const rel of related) {
          if (!seenIds.has(rel.paperId) && rel.abstract.length > 50) {
            seenIds.add(rel.paperId);
            allPapers.push(rel);
            expansionGraph.push({
              paperId: rel.paperId,
              title: rel.title,
              depth,
              parentId: paper.paperId,
            });
            addedCount++;
          }
        }

        console.log(`[lit-review]   "${paper.title.slice(0, 50)}..." → +${addedCount} related`);
      }
    }
  }

  console.log(`[lit-review] Discovered ${allPapers.length} total papers`);

  // ── Step 3: Select papers for analysis ───────────────────────────────────
  // Score: prefer high citation count, non-empty abstract, prefer recent
  const papersToAnalyze = [...allPapers]
    .filter(p => p.abstract.length > 50)
    .sort((a, b) => {
      const citScore = (b.citationCount ?? 0) - (a.citationCount ?? 0);
      const yearScore = ((b.year ?? 2000) - (a.year ?? 2000)) * 2;
      return citScore + yearScore;
    })
    .slice(0, maxPapers);

  console.log(`[lit-review] Step 3: Analyzing ${papersToAnalyze.length} papers...`);

  // ── Step 4: Fetch full text (best-effort) for top papers ──────────────────
  const fullTexts = new Map<string, string | null>();
  const textFetchCount = Math.min(5, papersToAnalyze.length);
  for (let i = 0; i < textFetchCount; i++) {
    const paper = papersToAnalyze[i];
    console.log(`[lit-review]   Fetching full text ${i + 1}/${textFetchCount}: ${paper.title.slice(0, 50)}...`);
    const text = await fetchPaperText(paper, 4000);
    fullTexts.set(paper.paperId, text);
    if (i < textFetchCount - 1) await sleep(300);
  }

  // ── Step 5: LLM analysis per paper ───────────────────────────────────────
  const analyses: PaperAnalysis[] = [];
  for (let i = 0; i < papersToAnalyze.length; i++) {
    const paper = papersToAnalyze[i];
    console.log(`[lit-review]   [${i + 1}/${papersToAnalyze.length}] ${paper.title.slice(0, 60)}`);

    try {
      const fullText = fullTexts.get(paper.paperId) ?? null;
      const analysis = await analyzePaper(paper, fullText, tier);
      analyses.push(analysis);
      totalTokens += 600;
    } catch (err) {
      console.warn(`[lit-review]   Failed: ${(err as Error).message}`);
    }

    if (i < papersToAnalyze.length - 1) await sleep(100);
  }

  // ── Step 6: Synthesis ─────────────────────────────────────────────────────
  console.log(`[lit-review] Step 4: Synthesizing ${analyses.length} analyses...`);
  const synthesis = await synthesizeReview(question, papersToAnalyze, analyses, tier);
  totalTokens += synthesis.tokensUsed;

  // ── Step 7: Build output ──────────────────────────────────────────────────
  const markdown = buildMarkdown(question, papersToAnalyze, analyses, synthesis, expansionGraph);
  const latex = (outputFormat === "latex" || outputFormat === "both")
    ? buildLatex(question, papersToAnalyze, analyses, synthesis)
    : undefined;

  console.log(`[lit-review] Done. ${analyses.length} papers analyzed, ${allPapers.length} discovered, ${totalTokens} tokens.`);

  return {
    question,
    generatedAt: new Date().toISOString(),
    papersAnalyzed: analyses.length,
    totalPapersDiscovered: allPapers.length,
    markdown,
    latex,
    themes: synthesis.themes,
    gaps: synthesis.gaps,
    contradictions: synthesis.contradictions,
    topPapers: papersToAnalyze.slice(0, 10),
    tokensUsed: totalTokens,
    expansionGraph,
  };
}

export async function lookupPaper(query: string): Promise<PaperSummary[]> {
  const [arxivResults, ssResults] = await Promise.all([
    searchArxiv(query, 4),
    searchSemanticScholar(query, 3, process.env.S2_API_KEY),
  ]);

  // Deduplicate by title similarity
  const seen = new Set<string>();
  const merged: PaperSummary[] = [];
  for (const p of [...arxivResults, ...ssResults]) {
    const key = p.title.toLowerCase().slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(p);
    }
  }
  return merged.slice(0, 7);
}
