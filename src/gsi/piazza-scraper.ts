/**
 * GSI Office Hours — Piazza Scraper
 *
 * Ingests Piazza course content into lobs-memory so the GSI agent can answer
 * questions based on real past Q&A from the course.
 *
 * Two ingestion modes:
 *
 * 1. **HTML export** (recommended): Download the Piazza HTML archive via
 *    your browser (see instructions below) and point this script at the folder.
 *    Parses questions, instructor answers, and student answers.
 *
 * 2. **API mode** (requires Piazza credentials): Uses the unofficial Piazza
 *    Python API wrapper to fetch posts programmatically.
 *
 * Usage (HTML export):
 *   npx ts-node src/gsi/piazza-scraper.ts --course eecs281 --html-dir ~/piazza-export/
 *
 * Usage (JSON dump from python-piazza):
 *   npx ts-node src/gsi/piazza-scraper.ts --course eecs281 --json ~/piazza-posts.json
 *
 * How to get a Piazza HTML export:
 *   1. Go to your Piazza course → Q&A tab
 *   2. Open DevTools → Network tab
 *   3. Use the Piazza "Export to CSV/JSON" feature if available (Instructor Tools → Export)
 *   4. Or use the python-piazza library: `pip install piazza-api`
 *      Then: python3 scripts/fetch-piazza.py --email you@umich.edu --course-id <nid> > posts.json
 *
 * See src/gsi/scripts/fetch-piazza.py for the Python helper script.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { log } from "../util/logger.js";
import { ingestText } from "./gsi-ingest.js";

const MEMORY_URL = "http://localhost:7420";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PiazzaPost {
  /** Post number (e.g. @142) */
  nr: number;
  /** Post title / subject */
  subject: string;
  /** Original question body (HTML stripped) */
  question: string;
  /** Instructor answer (if any) */
  instructorAnswer?: string;
  /** Best student answer (if any) */
  studentAnswer?: string;
  /** Tags/folders */
  folders: string[];
  /** Whether the post is resolved */
  resolved: boolean;
  /** Creation timestamp */
  created?: string;
  /** Views */
  views?: number;
}

export interface ScrapeResult {
  totalPosts: number;
  resolvedPosts: number;
  indexedPosts: number;
  skippedPosts: number;
  errors: string[];
}

// ── HTML Stripping ────────────────────────────────────────────────────────────

/**
 * Strip HTML tags and decode common HTML entities.
 * Lightweight — no DOM parser required.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Piazza JSON Format Parsing ────────────────────────────────────────────────

/**
 * Parse posts from the python-piazza JSON dump format.
 *
 * The python-piazza library returns posts in this structure:
 * [{ id, nr, subject, content, children: [{type: 'i_answer'|'s_answer'|'followup', ...}], folders, created, ... }]
 */
export function parsePiazzaJson(rawJson: string): PiazzaPost[] {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : err}`);
  }

  const rawPosts = Array.isArray(data) ? data : (data as Record<string, unknown[]>).feed ?? [];
  const posts: PiazzaPost[] = [];

  for (const raw of rawPosts as Record<string, unknown>[]) {
    try {
      const post = parseSinglePost(raw);
      if (post) posts.push(post);
    } catch {
      // Skip malformed posts
    }
  }

  return posts;
}

function parseSinglePost(raw: Record<string, unknown>): PiazzaPost | null {
  const subject = stripHtml(String(raw.subject ?? raw.title ?? "")).trim();
  if (!subject) return null;

  // Extract question body
  const questionHtml = String(
    (raw.history as Record<string, unknown>[])?.[0]?.content ??
    raw.content ??
    ""
  );
  const question = stripHtml(questionHtml).trim();

  // Extract answers from children
  let instructorAnswer: string | undefined;
  let studentAnswer: string | undefined;

  const children = (raw.children ?? []) as Record<string, unknown>[];
  for (const child of children) {
    const type = String(child.type ?? "");
    const history = (child.history as Record<string, unknown>[])?.[0];
    const content = stripHtml(String(history?.content ?? child.content ?? "")).trim();

    if (!content) continue;

    if (type === "i_answer" && !instructorAnswer) {
      instructorAnswer = content;
    } else if (type === "s_answer" && !studentAnswer) {
      studentAnswer = content;
    }
  }

  // Consider resolved if there's any answer
  const resolved = !!(instructorAnswer || studentAnswer);

  const folders = Array.isArray(raw.folders)
    ? (raw.folders as string[]).map(String)
    : typeof raw.folders === "string"
    ? [raw.folders]
    : [];

  return {
    nr: Number(raw.nr ?? raw.id ?? 0),
    subject,
    question,
    instructorAnswer,
    studentAnswer,
    folders,
    resolved,
    created: String(raw.created ?? raw.created_at ?? ""),
    views: Number(raw.unique_views ?? raw.views ?? 0),
  };
}

// ── Piazza HTML Export Parsing ────────────────────────────────────────────────

/**
 * Parse posts from a Piazza HTML export directory.
 * Piazza's HTML export creates one HTML file per post, or a single index file.
 */
export function parsePiazzaHtmlExport(htmlDir: string): PiazzaPost[] {
  const posts: PiazzaPost[] = [];

  if (!existsSync(htmlDir)) {
    throw new Error(`Directory not found: ${htmlDir}`);
  }

  const files = readdirSync(htmlDir)
    .filter(f => f.endsWith(".html") || f.endsWith(".htm"))
    .map(f => join(htmlDir, f));

  if (files.length === 0) {
    log().warn(`[piazza-scraper] No HTML files found in ${htmlDir}`);
    return [];
  }

  log().info(`[piazza-scraper] Parsing ${files.length} HTML files from ${htmlDir}`);

  for (const file of files) {
    try {
      const html = readFileSync(file, "utf8");
      const parsed = parseHtmlFile(html, basename(file));
      if (parsed) posts.push(parsed);
    } catch (err) {
      log().warn(`[piazza-scraper] Failed to parse ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return posts;
}

/**
 * Parse a single Piazza HTML file.
 * Handles both the single-page export format and individual post pages.
 */
function parseHtmlFile(html: string, filename: string): PiazzaPost | null {
  // Extract post number from filename (e.g. post_142.html → 142)
  const nrMatch = filename.match(/(\d+)/);
  const nr = nrMatch ? parseInt(nrMatch[1], 10) : 0;

  // Extract subject/title
  const titleMatch = html.match(/<h[12][^>]*class="[^"]*(?:subject|title)[^"]*"[^>]*>(.*?)<\/h[12]>/is)
    ?? html.match(/<title[^>]*>(.*?)<\/title>/is);
  const subject = titleMatch ? stripHtml(titleMatch[1]).trim() : `Post #${nr}`;

  // Extract question body
  const questionMatch = html.match(/<div[^>]*class="[^"]*(?:question|post-body|content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const question = questionMatch ? stripHtml(questionMatch[1]).slice(0, 2000) : "";

  // Extract instructor answer
  const iAnswerMatch = html.match(/<div[^>]*class="[^"]*i[_-]answer[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const instructorAnswer = iAnswerMatch ? stripHtml(iAnswerMatch[1]).slice(0, 2000) : undefined;

  // Extract student answer
  const sAnswerMatch = html.match(/<div[^>]*class="[^"]*s[_-]answer[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const studentAnswer = sAnswerMatch ? stripHtml(sAnswerMatch[1]).slice(0, 2000) : undefined;

  if (!subject && !question) return null;

  return {
    nr,
    subject,
    question: question || "(no question body)",
    instructorAnswer: instructorAnswer || undefined,
    studentAnswer: studentAnswer || undefined,
    folders: [],
    resolved: !!(instructorAnswer || studentAnswer),
    created: "",
  };
}

// ── Formatting Posts for Indexing ─────────────────────────────────────────────

/**
 * Format a Piazza post into a text document suitable for embedding.
 */
function formatPostForIndexing(post: PiazzaPost, courseId: string): string {
  const parts: string[] = [];

  parts.push(`[Piazza @${post.nr}] ${post.subject}`);
  parts.push("");

  if (post.question && post.question !== "(no question body)") {
    parts.push(`QUESTION:\n${post.question}`);
    parts.push("");
  }

  if (post.instructorAnswer) {
    parts.push(`INSTRUCTOR ANSWER:\n${post.instructorAnswer}`);
    parts.push("");
  }

  if (post.studentAnswer && !post.instructorAnswer) {
    // Only include student answer if there's no instructor answer (avoid confusion)
    parts.push(`STUDENT ANSWER (endorsed):\n${post.studentAnswer}`);
    parts.push("");
  }

  if (post.folders.length > 0) {
    parts.push(`Topics: ${post.folders.join(", ")}`);
  }

  return parts.join("\n").trim();
}

// ── Main Ingestion Logic ──────────────────────────────────────────────────────

/**
 * Ingest Piazza posts into lobs-memory.
 * Only indexes posts that have at least one answer (resolved posts).
 */
export async function ingestPiazzaPosts(
  posts: PiazzaPost[],
  courseId: string,
  opts: {
    /** Only index resolved posts (default: true) */
    resolvedOnly?: boolean;
    /** Minimum view count to include (filters out obscure posts) */
    minViews?: number;
    /** Maximum posts to ingest (default: unlimited) */
    maxPosts?: number;
    /** Batch delay in ms to avoid overwhelming lobs-memory (default: 50ms) */
    batchDelay?: number;
  } = {}
): Promise<ScrapeResult> {
  const {
    resolvedOnly = true,
    minViews = 0,
    maxPosts = Infinity,
    batchDelay = 50,
  } = opts;

  const collection = `${courseId}-course`;
  const result: ScrapeResult = {
    totalPosts: posts.length,
    resolvedPosts: posts.filter(p => p.resolved).length,
    indexedPosts: 0,
    skippedPosts: 0,
    errors: [],
  };

  log().info(
    `[piazza-scraper] ${result.totalPosts} total posts, ${result.resolvedPosts} resolved. ` +
    `Indexing${resolvedOnly ? " resolved only" : " all"} into collection:${collection}`
  );

  let processed = 0;
  for (const post of posts) {
    if (processed >= maxPosts) break;

    // Filter: skip unresolved if resolvedOnly
    if (resolvedOnly && !post.resolved) {
      result.skippedPosts++;
      continue;
    }

    // Filter: skip posts with too few views
    if (post.views !== undefined && post.views < minViews) {
      result.skippedPosts++;
      continue;
    }

    // Skip posts without meaningful content
    if (post.question.length < 20 && !post.instructorAnswer) {
      result.skippedPosts++;
      continue;
    }

    const text = formatPostForIndexing(post, courseId);
    const source = `Piazza @${post.nr}: ${post.subject.slice(0, 60)}`;

    try {
      const ingestResult = await ingestText(text, source, {
        courseId,
        collection,
        tags: [courseId, "piazza", ...post.folders],
      });

      if (ingestResult.success) {
        result.indexedPosts++;
        if (result.indexedPosts % 50 === 0) {
          log().info(`[piazza-scraper] Progress: ${result.indexedPosts} posts indexed...`);
        }
      } else {
        result.skippedPosts++;
        if (ingestResult.error) result.errors.push(`@${post.nr}: ${ingestResult.error}`);
      }
    } catch (err) {
      result.skippedPosts++;
      result.errors.push(`@${post.nr}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Throttle to avoid hammering lobs-memory
    if (batchDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }

    processed++;
  }

  log().info(
    `[piazza-scraper] Done: ${result.indexedPosts} indexed, ${result.skippedPosts} skipped, ` +
    `${result.errors.length} errors`
  );

  return result;
}

/**
 * Full pipeline: parse + ingest from a JSON dump file.
 */
export async function ingestFromJsonFile(
  jsonPath: string,
  courseId: string,
  opts: Parameters<typeof ingestPiazzaPosts>[2] = {}
): Promise<ScrapeResult> {
  if (!existsSync(jsonPath)) {
    throw new Error(`JSON file not found: ${jsonPath}`);
  }

  log().info(`[piazza-scraper] Loading posts from ${jsonPath}`);
  const raw = readFileSync(jsonPath, "utf8");
  const posts = parsePiazzaJson(raw);
  log().info(`[piazza-scraper] Parsed ${posts.length} posts from JSON`);

  return ingestPiazzaPosts(posts, courseId, opts);
}

/**
 * Full pipeline: parse + ingest from an HTML export directory.
 */
export async function ingestFromHtmlDir(
  htmlDir: string,
  courseId: string,
  opts: Parameters<typeof ingestPiazzaPosts>[2] = {}
): Promise<ScrapeResult> {
  const posts = parsePiazzaHtmlExport(htmlDir);
  log().info(`[piazza-scraper] Parsed ${posts.length} posts from HTML export`);
  return ingestPiazzaPosts(posts, courseId, opts);
}

// ── CLI Entry Point ───────────────────────────────────────────────────────────

const isMain =
  process.argv[1]?.endsWith("piazza-scraper.ts") ||
  process.argv[1]?.endsWith("piazza-scraper.js");

if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const courseId = get("--course");
  const jsonFile = get("--json");
  const htmlDir = get("--html-dir");
  const maxPostsArg = get("--max-posts");
  const minViewsArg = get("--min-views");
  const includeUnresolved = args.includes("--include-unresolved");

  if (!courseId || (!jsonFile && !htmlDir)) {
    console.error([
      "Usage:",
      "  piazza-scraper --course <courseId> --json <path/to/posts.json>",
      "  piazza-scraper --course <courseId> --html-dir <path/to/export/>",
      "",
      "Options:",
      "  --max-posts <n>         Limit number of posts ingested",
      "  --min-views <n>         Only ingest posts with >= n views",
      "  --include-unresolved    Include posts without answers",
    ].join("\n"));
    process.exit(1);
  }

  const opts = {
    resolvedOnly: !includeUnresolved,
    maxPosts: maxPostsArg ? parseInt(maxPostsArg, 10) : undefined,
    minViews: minViewsArg ? parseInt(minViewsArg, 10) : undefined,
  };

  const run = jsonFile
    ? ingestFromJsonFile(jsonFile, courseId!, opts)
    : ingestFromHtmlDir(htmlDir!, courseId!, opts);

  run
    .then(result => {
      console.log("\n📚 Piazza Ingestion Complete");
      console.log(`  Total posts:    ${result.totalPosts}`);
      console.log(`  Resolved posts: ${result.resolvedPosts}`);
      console.log(`  Indexed:        ${result.indexedPosts} ✓`);
      console.log(`  Skipped:        ${result.skippedPosts}`);
      if (result.errors.length > 0) {
        console.log(`  Errors (${result.errors.length}):`);
        result.errors.slice(0, 10).forEach(e => console.log(`    - ${e}`));
      }
      process.exit(0);
    })
    .catch(err => {
      console.error("Fatal error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
