/**
 * Intelligence Sweep Service — autonomous web intelligence gathering.
 *
 * Discovers new content across configurable topic feeds, deduplicates,
 * enqueues into the research pipeline, and routes processed insights
 * into actionable items (inbox, tasks, features, project proposals).
 *
 * Architecture:
 *   1. Feeds define what to search for (queries, URLs, YouTube channels)
 *   2. Sweep discovers new sources via SearXNG + web fetch
 *   3. New sources are enqueued into the existing research_queue → research_briefs pipeline
 *   4. Processed briefs are analyzed for actionable insights
 *   5. Insights are routed to inbox_items, tasks, or stored for review
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { browserService } from "./browser.js";
import { log } from "../util/logger.js";
import type { ResearchQueueService } from "./research-queue.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface IntelFeed {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  searchQueries: string[];
  sourceUrls: string[];
  youtubeChannels: string[];
  tags: string[];
  projectId: string | null;
  schedule: string;
  maxItemsPerSweep: number;
  lastSweepAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntelSource {
  id: string;
  feedId: string;
  url: string;
  title: string | null;
  snippet: string | null;
  sourceType: string;
  contentHash: string | null;
  researchQueueId: string | null;
  researchBriefId: string | null;
  status: string;
  routedTo: string | null;
  routedId: string | null;
  discoveredAt: string;
  processedAt: string | null;
}

export interface IntelInsight {
  id: string;
  sourceId: string | null;
  feedId: string | null;
  title: string;
  insight: string;
  category: string | null;
  relevanceScore: number;
  actionability: string;
  routedTo: string | null;
  routedId: string | null;
  createdAt: string;
}

export interface SweepResult {
  feedId: string;
  feedName: string;
  sourcesDiscovered: number;
  sourcesNew: number;
  sourcesEnqueued: number;
  errors: string[];
}

export interface CreateFeedInput {
  name: string;
  description?: string;
  searchQueries?: string[];
  sourceUrls?: string[];
  youtubeChannels?: string[];
  tags?: string[];
  projectId?: string;
  schedule?: string;
  maxItemsPerSweep?: number;
}

// ── Schema ───────────────────────────────────────────────────────────────

const CREATE_FEEDS_TABLE = `
  CREATE TABLE IF NOT EXISTS intel_feeds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    search_queries TEXT NOT NULL DEFAULT '[]',
    source_urls TEXT NOT NULL DEFAULT '[]',
    youtube_channels TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    project_id TEXT,
    schedule TEXT NOT NULL DEFAULT '0 6 * * *',
    max_items_per_sweep INTEGER NOT NULL DEFAULT 10,
    last_sweep_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const CREATE_SOURCES_TABLE = `
  CREATE TABLE IF NOT EXISTS intel_sources (
    id TEXT PRIMARY KEY,
    feed_id TEXT NOT NULL REFERENCES intel_feeds(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    snippet TEXT,
    source_type TEXT NOT NULL DEFAULT 'web_search',
    content_hash TEXT,
    research_queue_id TEXT,
    research_brief_id TEXT,
    status TEXT NOT NULL DEFAULT 'discovered',
    routed_to TEXT,
    routed_id TEXT,
    discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  );
`;

const CREATE_SOURCES_URL_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_sources_url ON intel_sources(url);
`;

const CREATE_SOURCES_FEED_STATUS_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_intel_sources_feed_status ON intel_sources(feed_id, status);
`;

const CREATE_SOURCES_HASH_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_intel_sources_hash ON intel_sources(content_hash);
`;

const CREATE_INSIGHTS_TABLE = `
  CREATE TABLE IF NOT EXISTS intel_insights (
    id TEXT PRIMARY KEY,
    source_id TEXT REFERENCES intel_sources(id),
    feed_id TEXT REFERENCES intel_feeds(id),
    title TEXT NOT NULL,
    insight TEXT NOT NULL,
    category TEXT,
    relevance_score REAL NOT NULL DEFAULT 0.5,
    actionability TEXT NOT NULL DEFAULT 'informational',
    routed_to TEXT,
    routed_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const CREATE_INSIGHTS_RELEVANCE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_intel_insights_relevance ON intel_insights(relevance_score DESC);
`;

const CREATE_INSIGHTS_FEED_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_intel_insights_feed ON intel_insights(feed_id);
`;

// ── Helpers ──────────────────────────────────────────────────────────────

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Hash content for cross-URL dedup — will be used when we add full-page fetch */
function _hashContent(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase().slice(0, 5000)).digest("hex").slice(0, 16);
}

function normalizeFeed(row: Record<string, unknown>): IntelFeed {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: row.description ? String(row.description) : null,
    enabled: Boolean(row.enabled),
    searchQueries: parseJsonArray(row.search_queries),
    sourceUrls: parseJsonArray(row.source_urls),
    youtubeChannels: parseJsonArray(row.youtube_channels),
    tags: parseJsonArray(row.tags),
    projectId: row.project_id ? String(row.project_id) : null,
    schedule: String(row.schedule ?? "0 6 * * *"),
    maxItemsPerSweep: Number(row.max_items_per_sweep ?? 10),
    lastSweepAt: row.last_sweep_at ? String(row.last_sweep_at) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
  };
}

function normalizeSource(row: Record<string, unknown>): IntelSource {
  return {
    id: String(row.id),
    feedId: String(row.feed_id),
    url: String(row.url ?? ""),
    title: row.title ? String(row.title) : null,
    snippet: row.snippet ? String(row.snippet) : null,
    sourceType: String(row.source_type ?? "web_search"),
    contentHash: row.content_hash ? String(row.content_hash) : null,
    researchQueueId: row.research_queue_id ? String(row.research_queue_id) : null,
    researchBriefId: row.research_brief_id ? String(row.research_brief_id) : null,
    status: String(row.status ?? "discovered"),
    routedTo: row.routed_to ? String(row.routed_to) : null,
    routedId: row.routed_id ? String(row.routed_id) : null,
    discoveredAt: String(row.discovered_at ?? new Date().toISOString()),
    processedAt: row.processed_at ? String(row.processed_at) : null,
  };
}

function normalizeInsight(row: Record<string, unknown>): IntelInsight {
  return {
    id: String(row.id),
    sourceId: row.source_id ? String(row.source_id) : null,
    feedId: row.feed_id ? String(row.feed_id) : null,
    title: String(row.title ?? ""),
    insight: String(row.insight ?? ""),
    category: row.category ? String(row.category) : null,
    relevanceScore: Number(row.relevance_score ?? 0.5),
    actionability: String(row.actionability ?? "informational"),
    routedTo: row.routed_to ? String(row.routed_to) : null,
    routedId: row.routed_id ? String(row.routed_id) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

// ── Quality / Language Filters ───────────────────────────────────────────

/** Domains that are never useful as intel sources */
const BLOCKED_DOMAINS = new Set([
  "dict.leo.org",
  "translate.google.com",
  "www.autonomous.ai",         // standing desk company
  "www.deepl.com",
  "play.google.com",
  "apps.apple.com",
  "www.reddit.com",            // community posts are low-signal and often stale
  "old.reddit.com",
  "www.quora.com",             // Q&A sites are rarely actionable intel
  "stackoverflow.com",
  "www.youtube.com",           // handled separately via youtube_channels
  "twitter.com",
  "x.com",
  "www.amazon.com",
  "www.ebay.com",
  "www.udemy.com",             // course sales pages
  "www.coursera.org",
  "www.skillshare.com",
  // Reference / dictionary sites
  "www.merriam-webster.com",
  "www.dictionary.com",
  "www.thefreedictionary.com",
  "en.wikipedia.org",           // too generic, not news
  "www.investopedia.com",
  // Job / social media sites
  "www.indeed.com",
  "www.linkedin.com",
  "www.glassdoor.com",
  "www.facebook.com",
  "www.instagram.com",
  "www.tiktok.com",
  "www.pinterest.com",
  // SEO spam / paywalled listicles
  "medium.com",
  "www.medium.com",
  "www.forbes.com",
  "www.entrepreneur.com",
  // Academic journal homepages (not AI-specific)
  "onlinelibrary.wiley.com",
  "www.sciencedirect.com",
  "www.springer.com",
  "link.springer.com",
  // Misc non-tech
  "customer-service.on-running.com",
  // Law / education (false positives for "LLM")
  "www.lsac.org",
  "llm.law.harvard.edu",
]);

/** URL path patterns that indicate non-article pages (homepages, product pages, login) */
const BLOCKED_PATH_PATTERNS = [
  /^\/$/,                        // bare homepage
  /^\/(office-chairs|standing-desks|pod-adus)\b/i,  // product categories
  /^\/(login|signup|register|cart|checkout)\b/i,
  /^\/(pricing|plans|contact|about|careers|jobs)\b/i,  // company pages, not content
  /\/(download|install|quickstart|getting-started|introduction)\b/i,  // docs/setup pages, not news (anywhere in path)
  /^\/(docs|documentation|api-reference|reference)\/?$/i,  // doc homepages
  /^\/(docs|documentation)\/(?!blog)/i,  // deep doc pages (except blog posts under /docs/)
  /\/(toc|current|archive|issue)\b/i,  // journal table-of-contents pages
  /\/topic\//i,  // topic index pages (e.g. news.mit.edu/topic/artificial-intelligence2)
  /^\/(import|windows|linux|macos)\/?$/i,  // OS-specific install pages
];

/** TLD / domain patterns strongly associated with non-English content */
const NON_ENGLISH_DOMAIN_PATTERNS = [
  /\.cn$/,  /\.jp$/,  /\.kr$/,  /\.ru$/,  /\.de$/,  /\.fr$/,  /\.es$/,  /\.it$/,  /\.pt$/,  /\.br$/,
  /\.tw$/,  /\.hk$/,  /\.th$/,  /\.vn$/,  /\.pl$/,  /\.cz$/,  /\.nl$/,  /\.se$/,  /\.no$/,  /\.fi$/,
  /zhihu\.com$/,  /baidu\.com$/,  /csdn\.net$/,  /weixin\.qq\.com$/,
  /naver\.com$/,  /daum\.net$/,  /hatena\.ne\.jp$/,
];

/** CJK / Cyrillic / Arabic / Thai / Korean character ranges */
const NON_LATIN_RE = /[\u3000-\u9FFF\u{AC00}-\u{D7AF}\u0400-\u04FF\u0600-\u06FF\u0E00-\u0E7F]/u;

/**
 * Returns true if a candidate looks like a quality, English-language article or video.
 * Rejects:
 *  - blocked domains / product pages / homepages
 *  - non-English TLDs or domains
 *  - titles/snippets with significant non-Latin characters
 *  - generic "what is X" explainer pages (too basic to be useful intel)
 */
/**
 * AI/tech relevance check — requires STRONG AI signal, not just tangential keywords.
 *
 * Two-tier approach:
 *  - STRONG keywords: A single match is enough (very specific to AI/ML)
 *  - WEAK keywords: Need 2+ matches (words like "model", "research" appear in many domains)
 */
const STRONG_AI_KEYWORDS = [
  // Specific AI/ML terms (won't appear on shoe stores or chemistry journals)
  "artificial intelligence", "machine learning", "deep learning", "neural network",
  "large language model", "language model", "generative ai",
  "llm", "gpt-4", "gpt-5", "chatgpt", "claude", "gemini", "llama 3", "llama 4",
  "mistral", "qwen", "phi-4", "deepseek",
  "agentic", "multi-agent", "function calling", "tool use",
  "fine-tuning", "fine tuning", "quantization", "gguf", "onnx", "tensorrt", "vllm",
  "langchain", "llamaindex", "crewai", "autogen", "semantic kernel",
  "huggingface", "hugging face", "openai", "anthropic", "google deepmind",
  "ollama", "lm studio", "mlx", "lmstudio",
  "retrieval augmented generation", "vector database", "embedding model",
  "prompt engineering", "chain of thought", "in-context learning",
  "transformer architecture", "attention mechanism",
  "arxiv", "neurips", "icml", "iclr",
  "copilot", "cursor", "windsurf", "codeium",
];

const WEAK_AI_KEYWORDS = [
  // These appear in many contexts — need multiple to signal AI relevance
  "ai", "model", "inference", "agent", "autonomous", "benchmark",
  "research", "paper", "framework", "open source", "evaluation",
  "training", "dataset", "token", "embedding", "retrieval", "rag",
  "api", "sdk", "neural", "transformer", "reasoning", "planning",
];

/** False-positive patterns — if matched, the source is NOT about AI despite keyword hits */
const FALSE_POSITIVE_PATTERNS = [
  /llm\s*(degree|program|law|master of laws|admission)/i,
  /master of laws/i,
  /law school/i,
  /juris doctor/i,
];

/** Returns true if title+snippet contain strong AI/tech relevance signal */
function isRelevantToAI(title: string, snippet: string): boolean {
  const text = `${title} ${snippet}`.toLowerCase();

  // Check for false positives first
  const rawText = `${title} ${snippet}`;
  if (FALSE_POSITIVE_PATTERNS.some(re => re.test(rawText))) return false;

  // One strong keyword is enough
  if (STRONG_AI_KEYWORDS.some(kw => text.includes(kw))) return true;

  // Need 2+ weak keyword matches
  let weakMatches = 0;
  for (const kw of WEAK_AI_KEYWORDS) {
    if (text.includes(kw)) {
      weakMatches++;
      if (weakMatches >= 2) return true;
    }
  }

  return false;
}

function isQualityEnglishSource(url: string, title: string, snippet: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // Blocked domain
    if (BLOCKED_DOMAINS.has(host)) return false;

    // Non-English domain pattern
    if (NON_ENGLISH_DOMAIN_PATTERNS.some(re => re.test(host))) return false;

    // Blocked path pattern
    if (BLOCKED_PATH_PATTERNS.some(re => re.test(u.pathname))) return false;

    // Check title + snippet for non-Latin characters (CJK, Cyrillic, etc.)
    const text = `${title} ${snippet}`;
    const nonLatinMatches = text.match(NON_LATIN_RE);
    if (nonLatinMatches) {
      // If more than 10% of characters are non-Latin, reject
      const nonLatinCount = [...text].filter(c => NON_LATIN_RE.test(c)).length;
      if (nonLatinCount / text.length > 0.1) return false;
    }

    // Reject bare homepages (path is just "/" with no meaningful content indicator)
    if (u.pathname === "/" && !u.search) return false;

    // Reject generic "what is X" / "beginner guide" / listicle fluff
    const lowerTitle = title.toLowerCase();
    const fluffPatterns = [
      /^what (?:is|are) /,
      /beginner'?s? guide/,
      /for dummies/,
      /\btop \d+ /,
      /\b\d+ best /,
      /everything you need to know/,
      /complete guide for beginners/,
      /^introduction to /,
      /^a guide to /,
    ];
    if (fluffPatterns.some(re => re.test(lowerTitle))) return false;

    return true;
  } catch {
    return false; // malformed URL → reject
  }
}

/** Normalize a URL for dedup — strip trailing slashes, fragments, tracking params */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove common tracking params
    for (const p of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "source"]) {
      u.searchParams.delete(p);
    }
    u.hash = "";
    let result = u.toString();
    // Strip trailing slash for consistency
    if (result.endsWith("/") && u.pathname !== "/") {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    return url.trim();
  }
}

// ── Service ──────────────────────────────────────────────────────────────

export class IntelSweepService {
  private readonly db: Database.Database;
  private readonly researchQueue: ResearchQueueService;

  constructor(db: Database.Database, researchQueue: ResearchQueueService) {
    this.db = db;
    this.researchQueue = researchQueue;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(CREATE_FEEDS_TABLE);
    this.db.exec(CREATE_SOURCES_TABLE);
    this.db.exec(CREATE_SOURCES_URL_INDEX);
    this.db.exec(CREATE_SOURCES_FEED_STATUS_INDEX);
    this.db.exec(CREATE_SOURCES_HASH_INDEX);
    this.db.exec(CREATE_INSIGHTS_TABLE);
    this.db.exec(CREATE_INSIGHTS_RELEVANCE_INDEX);
    this.db.exec(CREATE_INSIGHTS_FEED_INDEX);
  }

  // ── Feed Management ─────────────────────────────────────────────────

  createFeed(input: CreateFeedInput): IntelFeed {
    if (!input.name?.trim()) throw new Error("Feed name is required");

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO intel_feeds
        (id, name, description, search_queries, source_urls, youtube_channels, tags, project_id, schedule, max_items_per_sweep, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name.trim(),
      input.description?.trim() ?? null,
      JSON.stringify(input.searchQueries ?? []),
      JSON.stringify(input.sourceUrls ?? []),
      JSON.stringify(input.youtubeChannels ?? []),
      JSON.stringify(input.tags ?? []),
      input.projectId?.trim() ?? null,
      input.schedule ?? "0 6 * * *",
      input.maxItemsPerSweep ?? 10,
      now,
      now,
    );

    return this.getFeed(id)!;
  }

  getFeed(id: string): IntelFeed | null {
    const row = this.db.prepare("SELECT * FROM intel_feeds WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? normalizeFeed(row) : null;
  }

  listFeeds(enabledOnly = false): IntelFeed[] {
    const sql = enabledOnly
      ? "SELECT * FROM intel_feeds WHERE enabled = 1 ORDER BY name"
      : "SELECT * FROM intel_feeds ORDER BY name";
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;
    return rows.map(normalizeFeed);
  }

  updateFeed(id: string, updates: Partial<CreateFeedInput> & { enabled?: boolean }): IntelFeed | null {
    const existing = this.getFeed(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name.trim()); }
    if (updates.description !== undefined) { sets.push("description = ?"); values.push(updates.description?.trim() ?? null); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
    if (updates.searchQueries !== undefined) { sets.push("search_queries = ?"); values.push(JSON.stringify(updates.searchQueries)); }
    if (updates.sourceUrls !== undefined) { sets.push("source_urls = ?"); values.push(JSON.stringify(updates.sourceUrls)); }
    if (updates.youtubeChannels !== undefined) { sets.push("youtube_channels = ?"); values.push(JSON.stringify(updates.youtubeChannels)); }
    if (updates.tags !== undefined) { sets.push("tags = ?"); values.push(JSON.stringify(updates.tags)); }
    if (updates.projectId !== undefined) { sets.push("project_id = ?"); values.push(updates.projectId?.trim() ?? null); }
    if (updates.schedule !== undefined) { sets.push("schedule = ?"); values.push(updates.schedule); }
    if (updates.maxItemsPerSweep !== undefined) { sets.push("max_items_per_sweep = ?"); values.push(updates.maxItemsPerSweep); }

    values.push(id);
    this.db.prepare(`UPDATE intel_feeds SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.getFeed(id);
  }

  deleteFeed(id: string): boolean {
    const result = this.db.prepare("DELETE FROM intel_feeds WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ── Source Deduplication ────────────────────────────────────────────

  /** Check if a URL has already been discovered (across all feeds) */
  hasUrl(url: string): boolean {
    const normalized = normalizeUrl(url);
    const row = this.db.prepare(
      "SELECT 1 FROM intel_sources WHERE url = ? LIMIT 1",
    ).get(normalized);
    return !!row;
  }

  /** Check if content hash exists (catches same content at different URLs) */
  hasContentHash(hash: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM intel_sources WHERE content_hash = ? LIMIT 1",
    ).get(hash);
    return !!row;
  }

  // ── Sweep Execution ────────────────────────────────────────────────

  /**
   * Run a sweep for a single feed. Discovers sources, deduplicates,
   * and enqueues new finds into the research pipeline.
   */
  async sweepFeed(feedId: string): Promise<SweepResult> {
    const feed = this.getFeed(feedId);
    if (!feed) throw new Error(`Feed ${feedId} not found`);

    const result: SweepResult = {
      feedId: feed.id,
      feedName: feed.name,
      sourcesDiscovered: 0,
      sourcesNew: 0,
      sourcesEnqueued: 0,
      errors: [],
    };

    const candidates: Array<{
      url: string;
      title: string;
      snippet: string;
      sourceType: string;
    }> = [];

    // 1. Run search queries
    for (const query of feed.searchQueries) {
      try {
        // timeRange: "month" parameter on the search handles recency
        const recentQuery = query;
        const results = await browserService.search(recentQuery, 8, { timeRange: "month" });
        for (const r of results) {
          if (r.url && r.title) {
            candidates.push({
              url: normalizeUrl(r.url),
              title: r.title,
              snippet: r.snippet || "",
              sourceType: "web_search",
            });
          }
        }
      } catch (err) {
        const msg = `Search query "${query}" failed: ${err instanceof Error ? err.message : String(err)}`;
        log().warn(`[intel-sweep] ${msg}`);
        result.errors.push(msg);
      }
    }

    // 2. Check specific source URLs (blogs, docs pages)
    for (const sourceUrl of feed.sourceUrls) {
      try {
        candidates.push({
          url: normalizeUrl(sourceUrl),
          title: "", // Will be filled by research queue fetch
          snippet: "",
          sourceType: "blog",
        });
      } catch (err) {
        const msg = `Source URL "${sourceUrl}" failed: ${err instanceof Error ? err.message : String(err)}`;
        log().warn(`[intel-sweep] ${msg}`);
        result.errors.push(msg);
      }
    }

    // 3. Check YouTube channels
    for (const channelId of feed.youtubeChannels) {
      try {
        const videos = await this.fetchYouTubeRecent(channelId);
        for (const v of videos) {
          candidates.push({
            url: normalizeUrl(v.url),
            title: v.title,
            snippet: v.description || "",
            sourceType: "youtube",
          });
        }
      } catch (err) {
        const msg = `YouTube channel "${channelId}" failed: ${err instanceof Error ? err.message : String(err)}`;
        log().warn(`[intel-sweep] ${msg}`);
        result.errors.push(msg);
      }
    }

    // 3b. Filter out non-English, non-article, and low-quality results
    const preFilterCount = candidates.length;
    const filtered = candidates.filter(c => isQualityEnglishSource(c.url, c.title, c.snippet));
    const qualityRejected = preFilterCount - filtered.length;
    if (qualityRejected > 0) {
      log().info(`[intel-sweep] Filtered out ${qualityRejected}/${preFilterCount} low-quality/non-English candidates`);
    }

    // 3c. Filter for AI/tech relevance — must mention at least one relevant keyword
    const qualityCandidates = filtered.filter(c => isRelevantToAI(c.title, c.snippet));
    const relevanceRejected = filtered.length - qualityCandidates.length;
    if (relevanceRejected > 0) {
      log().info(`[intel-sweep] Filtered out ${relevanceRejected}/${filtered.length} candidates not relevant to AI/tech`);
    }

    result.sourcesDiscovered = qualityCandidates.length;

    // 4. Deduplicate and save new sources
    const newSources: IntelSource[] = [];
    const seen = new Set<string>();

    for (const candidate of qualityCandidates) {
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);

      // Check if URL already exists in our database
      if (this.hasUrl(candidate.url)) continue;

      const sourceId = randomUUID();
      const now = new Date().toISOString();

      this.db.prepare(
        `INSERT INTO intel_sources
          (id, feed_id, url, title, snippet, source_type, status, discovered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?)`,
      ).run(sourceId, feed.id, candidate.url, candidate.title || null, candidate.snippet || null, candidate.sourceType, now);

      newSources.push({
        id: sourceId,
        feedId: feed.id,
        url: candidate.url,
        title: candidate.title || null,
        snippet: candidate.snippet || null,
        sourceType: candidate.sourceType,
        contentHash: null,
        researchQueueId: null,
        researchBriefId: null,
        status: "discovered",
        routedTo: null,
        routedId: null,
        discoveredAt: now,
        processedAt: null,
      });

      if (newSources.length >= feed.maxItemsPerSweep) break;
    }

    result.sourcesNew = newSources.length;

    // 5. Enqueue new sources into research pipeline
    for (const source of newSources) {
      try {
        const queueItem = this.researchQueue.enqueue({
          title: source.title || `Intel: ${new URL(source.url).hostname}`,
          sourceType: "url",
          sourceUrl: source.url,
          topic: feed.name,
          tags: [...feed.tags, "intel-sweep", feed.name.toLowerCase().replace(/\s+/g, "-")],
          priority: 200, // Higher than manual research queue items
          projectId: feed.projectId ?? undefined,
        });

        // Update source with research queue link
        this.db.prepare(
          `UPDATE intel_sources SET status = 'queued', research_queue_id = ? WHERE id = ?`,
        ).run(queueItem.id, source.id);

        result.sourcesEnqueued++;
      } catch (err) {
        const msg = `Failed to enqueue "${source.url}": ${err instanceof Error ? err.message : String(err)}`;
        log().warn(`[intel-sweep] ${msg}`);
        result.errors.push(msg);
      }
    }

    // Update feed last_sweep_at
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE intel_feeds SET last_sweep_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, feed.id);

    log().info(
      `[intel-sweep] Feed "${feed.name}": ${result.sourcesDiscovered} discovered, ${result.sourcesNew} new, ${result.sourcesEnqueued} enqueued`,
    );

    return result;
  }

  /**
   * Run sweeps for all enabled feeds.
   */
  async sweepAll(): Promise<SweepResult[]> {
    const feeds = this.listFeeds(true);
    const results: SweepResult[] = [];

    for (const feed of feeds) {
      try {
        const result = await this.sweepFeed(feed.id);
        results.push(result);
      } catch (err) {
        log().error(`[intel-sweep] Feed "${feed.name}" sweep failed: ${err}`);
        results.push({
          feedId: feed.id,
          feedName: feed.name,
          sourcesDiscovered: 0,
          sourcesNew: 0,
          sourcesEnqueued: 0,
          errors: [err instanceof Error ? err.message : String(err)],
        });
      }
    }

    return results;
  }

  // ── Insight Extraction ─────────────────────────────────────────────

  /**
   * Get sources that have been processed (research brief completed)
   * but haven't been analyzed for insights yet.
   */
  getUnprocessedSources(limit = 20): IntelSource[] {
    // Find sources that are queued and whose research_queue item is completed
    const rows = this.db.prepare(
      `SELECT s.* FROM intel_sources s
       JOIN research_queue rq ON s.research_queue_id = rq.id
       WHERE s.status = 'queued' AND rq.status = 'completed'
       ORDER BY s.discovered_at ASC
       LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(normalizeSource);
  }

  /**
   * Find a source by its URL.
   */
  findSourceByUrl(url: string): IntelSource | null {
    const row = this.db.prepare(
      "SELECT * FROM intel_sources WHERE url = ? LIMIT 1",
    ).get(url) as Record<string, unknown> | undefined;
    return row ? normalizeSource(row) : null;
  }

  /**
   * Record an extracted insight.
   */
  addInsight(input: {
    sourceId?: string;
    feedId?: string;
    title: string;
    insight: string;
    category?: string;
    relevanceScore?: number;
    actionability?: string;
  }): IntelInsight {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO intel_insights
        (id, source_id, feed_id, title, insight, category, relevance_score, actionability, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.sourceId ?? null,
      input.feedId ?? null,
      input.title,
      input.insight,
      input.category ?? null,
      input.relevanceScore ?? 0.5,
      input.actionability ?? "informational",
      now,
    );

    return this.getInsight(id)!;
  }

  /**
   * Mark a source as processed (insights extracted).
   */
  markSourceProcessed(sourceId: string, briefId?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE intel_sources SET status = 'processed', research_brief_id = COALESCE(?, research_brief_id), processed_at = ? WHERE id = ?`,
    ).run(briefId ?? null, now, sourceId);
  }

  /**
   * Mark an insight as routed to a specific destination.
   */
  markInsightRouted(insightId: string, routedTo: string, routedId: string): void {
    this.db.prepare(
      `UPDATE intel_insights SET routed_to = ?, routed_id = ? WHERE id = ?`,
    ).run(routedTo, routedId, insightId);
  }

  /**
   * Mark a source as routed.
   */
  markSourceRouted(sourceId: string, routedTo: string, routedId: string): void {
    this.db.prepare(
      `UPDATE intel_sources SET status = 'routed', routed_to = ?, routed_id = ? WHERE id = ?`,
    ).run(routedTo, routedId, sourceId);
  }

  // ── Queries ────────────────────────────────────────────────────────

  getInsight(id: string): IntelInsight | null {
    const row = this.db.prepare("SELECT * FROM intel_insights WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? normalizeInsight(row) : null;
  }

  listInsights(options: { feedId?: string; minRelevance?: number; unrouted?: boolean; limit?: number } = {}): IntelInsight[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.feedId) { conditions.push("feed_id = ?"); params.push(options.feedId); }
    if (options.minRelevance !== undefined) { conditions.push("relevance_score >= ?"); params.push(options.minRelevance); }
    if (options.unrouted) { conditions.push("routed_to IS NULL"); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

    const rows = this.db.prepare(
      `SELECT * FROM intel_insights ${where} ORDER BY relevance_score DESC, created_at DESC LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map(normalizeInsight);
  }

  listSources(feedId: string, options: { status?: string; limit?: number } = {}): IntelSource[] {
    const conditions: string[] = ["feed_id = ?"];
    const params: unknown[] = [feedId];

    if (options.status) { conditions.push("status = ?"); params.push(options.status); }

    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const where = conditions.join(" AND ");

    const rows = this.db.prepare(
      `SELECT * FROM intel_sources WHERE ${where} ORDER BY discovered_at DESC LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map(normalizeSource);
  }

  getStats(): {
    feeds: { total: number; enabled: number };
    sources: { discovered: number; queued: number; processed: number; routed: number; skipped: number };
    insights: { total: number; unrouted: number; actionable: number };
  } {
    const feedRows = this.db.prepare(
      "SELECT enabled, COUNT(*) as count FROM intel_feeds GROUP BY enabled",
    ).all() as Array<{ enabled: number; count: number }>;
    const enabledCount = feedRows.find(r => r.enabled === 1)?.count ?? 0;
    const disabledCount = feedRows.find(r => r.enabled === 0)?.count ?? 0;

    const sourceRows = this.db.prepare(
      "SELECT status, COUNT(*) as count FROM intel_sources GROUP BY status",
    ).all() as Array<{ status: string; count: number }>;
    const sourceCounts = Object.fromEntries(sourceRows.map(r => [r.status, r.count]));

    const insightRow = this.db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN routed_to IS NULL THEN 1 ELSE 0 END) as unrouted,
        SUM(CASE WHEN actionability IN ('actionable', 'urgent') THEN 1 ELSE 0 END) as actionable
       FROM intel_insights`,
    ).get() as { total: number; unrouted: number; actionable: number };

    return {
      feeds: { total: enabledCount + disabledCount, enabled: enabledCount },
      sources: {
        discovered: Number(sourceCounts.discovered ?? 0),
        queued: Number(sourceCounts.queued ?? 0),
        processed: Number(sourceCounts.processed ?? 0),
        routed: Number(sourceCounts.routed ?? 0),
        skipped: Number(sourceCounts.skipped ?? 0),
      },
      insights: {
        total: Number(insightRow.total ?? 0),
        unrouted: Number(insightRow.unrouted ?? 0),
        actionable: Number(insightRow.actionable ?? 0),
      },
    };
  }

  // ── Internal ───────────────────────────────────────────────────────

  /** Fetch recent videos from a YouTube channel via SearXNG or direct scraping */
  private async fetchYouTubeRecent(channelId: string): Promise<Array<{ url: string; title: string; description: string }>> {
    try {
      // Use SearXNG to search for recent videos from this channel
      const results = await browserService.search(
        `site:youtube.com "${channelId}" OR channel/${channelId}`,
        5,
      );

      return results
        .filter(r => r.url.includes("youtube.com/watch"))
        .map(r => ({
          url: r.url,
          title: r.title,
          description: r.snippet,
        }));
    } catch {
      return [];
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let singleton: IntelSweepService | null = null;

export function initIntelSweepService(db: Database.Database, researchQueue: ResearchQueueService): IntelSweepService {
  if (!singleton) {
    singleton = new IntelSweepService(db, researchQueue);
  }
  return singleton;
}

export function getIntelSweepService(): IntelSweepService {
  if (!singleton) throw new Error("IntelSweepService not initialized");
  return singleton;
}
