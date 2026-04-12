/**
 * GSI Office Hours — Course Material Ingestion
 *
 * Ingests PDFs, text files, and markdown documents into lobs-memory
 * under a named course collection so the GSI agent can search them.
 *
 * Usage (CLI):
 *   npx ts-node src/gsi/gsi-ingest.ts --course eecs281 --dir ~/courses/eecs281/
 *   npx ts-node src/gsi/gsi-ingest.ts --course eecs281 --file syllabus.pdf --label "EECS 281 Syllabus"
 *
 * Usage (programmatic):
 *   await ingestCourseDirectory("eecs281", "/path/to/course/materials/");
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { log } from "../util/logger.js";

const MEMORY_URL = "http://localhost:7420";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IngestOptions {
  /** Course ID — used as the collection prefix in lobs-memory */
  courseId: string;
  /** Human-readable label for this document */
  label?: string;
  /** Collection name override (default: `<courseId>-course`) */
  collection?: string;
  /** Tags to attach to this document */
  tags?: string[];
}

export interface IngestResult {
  file: string;
  collection: string;
  success: boolean;
  chunkCount?: number;
  error?: string;
}

// ── Text Extraction ───────────────────────────────────────────────────────────

/**
 * Extract raw text from a file.
 * Supports: .txt, .md, .pdf (via pdftotext if available), .json
 */
async function extractText(filePath: string): Promise<string | null> {
  const ext = extname(filePath).toLowerCase();

  if (ext === ".txt" || ext === ".md") {
    try {
      return readFileSync(filePath, "utf8");
    } catch (err) {
      log().warn(`[gsi-ingest] Failed to read ${filePath}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  if (ext === ".pdf") {
    return extractPdfText(filePath);
  }

  if (ext === ".json") {
    try {
      const raw = readFileSync(filePath, "utf8");
      const data = JSON.parse(raw);
      // If it's an array of Q&A pairs, format as text
      if (Array.isArray(data)) {
        return data.map((item: Record<string, unknown>, i) => {
          if (typeof item.question === "string" && typeof item.answer === "string") {
            return `Q${i + 1}: ${item.question}\nA${i + 1}: ${item.answer}`;
          }
          return JSON.stringify(item);
        }).join("\n\n");
      }
      return JSON.stringify(data, null, 2);
    } catch (err) {
      log().warn(`[gsi-ingest] Failed to parse JSON ${filePath}`);
      return null;
    }
  }

  log().warn(`[gsi-ingest] Unsupported file type: ${ext} (${filePath})`);
  return null;
}

async function extractPdfText(filePath: string): Promise<string | null> {
  // Try pdftotext (poppler-utils) first — best quality
  try {
    const { execSync } = await import("node:child_process");
    const text = execSync(`pdftotext "${filePath}" -`, { encoding: "utf8", timeout: 30_000 });
    return text;
  } catch {}

  // Try pdfminer (Python) as fallback
  try {
    const { execSync } = await import("node:child_process");
    const text = execSync(
      `python3 -c "import pdfminer.high_level; import sys; print(pdfminer.high_level.extract_text(sys.argv[1]))" "${filePath}"`,
      { encoding: "utf8", timeout: 30_000 }
    );
    return text;
  } catch {}

  log().warn(`[gsi-ingest] Could not extract PDF text from ${filePath} — install pdftotext (brew install poppler) or pdfminer`);
  return null;
}

// ── Chunking ──────────────────────────────────────────────────────────────────

interface TextChunk {
  text: string;
  index: number;
}

/**
 * Split text into overlapping chunks suitable for embedding.
 * Tries to split on paragraph boundaries when possible.
 */
function chunkText(text: string, chunkSize = 800, overlap = 150): TextChunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 20); // skip empty/tiny paragraphs

  const chunks: TextChunk[] = [];
  let current = "";
  let chunkIdx = 0;

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > chunkSize && current.length > 0) {
      chunks.push({ text: current.trim(), index: chunkIdx++ });
      // Keep the last `overlap` chars for continuity
      current = current.slice(-overlap) + "\n\n" + para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push({ text: current.trim(), index: chunkIdx });
  }

  return chunks;
}

// ── Memory Ingestion ──────────────────────────────────────────────────────────

/**
 * Index a single document into lobs-memory.
 */
async function indexDocument(
  text: string,
  source: string,
  collection: string,
  tags: string[] = []
): Promise<{ success: boolean; chunkCount: number; error?: string }> {
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return { success: false, chunkCount: 0, error: "No content after chunking" };
  }

  let indexed = 0;
  const errors: string[] = [];

  for (const chunk of chunks) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);

      const res = await fetch(`${MEMORY_URL}/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: chunk.text,
          source: `${source} (chunk ${chunk.index + 1}/${chunks.length})`,
          collection,
          tags: [...tags, "gsi-course"],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        errors.push(`chunk ${chunk.index}: HTTP ${res.status} ${body}`);
      } else {
        indexed++;
      }
    } catch (err) {
      errors.push(`chunk ${chunk.index}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    log().warn(`[gsi-ingest] Errors indexing ${source}: ${errors.join(", ")}`);
  }

  return {
    success: indexed > 0,
    chunkCount: indexed,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ingest a single file into the course collection.
 */
export async function ingestFile(filePath: string, opts: IngestOptions): Promise<IngestResult> {
  const collection = opts.collection ?? `${opts.courseId}-course`;
  const label = opts.label ?? basename(filePath);

  log().info(`[gsi-ingest] Ingesting ${filePath} → collection:${collection}`);

  const text = await extractText(filePath);
  if (!text || text.trim().length < 50) {
    return { file: filePath, collection, success: false, error: "Could not extract usable text" };
  }

  const result = await indexDocument(text, label, collection, opts.tags ?? [opts.courseId]);

  if (result.success) {
    log().info(`[gsi-ingest] ✓ Indexed "${label}": ${result.chunkCount} chunks → ${collection}`);
  } else {
    log().warn(`[gsi-ingest] ✗ Failed to index "${label}": ${result.error}`);
  }

  return {
    file: filePath,
    collection,
    success: result.success,
    chunkCount: result.chunkCount,
    error: result.error,
  };
}

/**
 * Ingest all supported files in a directory (recursively).
 */
export async function ingestCourseDirectory(
  dirPath: string,
  opts: IngestOptions
): Promise<IngestResult[]> {
  if (!existsSync(dirPath)) {
    log().warn(`[gsi-ingest] Directory not found: ${dirPath}`);
    return [];
  }

  const SUPPORTED = new Set([".txt", ".md", ".pdf", ".json"]);
  const results: IngestResult[] = [];

  function collectFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...collectFiles(full));
      } else if (SUPPORTED.has(extname(entry).toLowerCase())) {
        files.push(full);
      }
    }
    return files;
  }

  const files = collectFiles(dirPath);
  log().info(`[gsi-ingest] Found ${files.length} files to ingest in ${dirPath}`);

  for (const file of files) {
    const result = await ingestFile(file, {
      ...opts,
      label: opts.label ?? basename(file),
    });
    results.push(result);
  }

  const succeeded = results.filter(r => r.success).length;
  const totalChunks = results.reduce((s, r) => s + (r.chunkCount ?? 0), 0);
  log().info(`[gsi-ingest] Done: ${succeeded}/${files.length} files, ${totalChunks} total chunks`);

  return results;
}

/**
 * Ingest raw text content directly (e.g. scraped Piazza posts).
 */
export async function ingestText(
  text: string,
  source: string,
  opts: IngestOptions
): Promise<IngestResult> {
  const collection = opts.collection ?? `${opts.courseId}-course`;
  log().info(`[gsi-ingest] Ingesting text from "${source}" → ${collection}`);

  const result = await indexDocument(text, source, collection, opts.tags ?? [opts.courseId]);

  return {
    file: source,
    collection,
    success: result.success,
    chunkCount: result.chunkCount,
    error: result.error,
  };
}

// ── CLI Entry Point ───────────────────────────────────────────────────────────

// Allow running directly: npx ts-node src/gsi/gsi-ingest.ts --course eecs281 --dir ./materials/
const isMain = process.argv[1]?.endsWith("gsi-ingest.ts") || process.argv[1]?.endsWith("gsi-ingest.js");

if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const course = get("--course");
  const dir = get("--dir");
  const file = get("--file");
  const label = get("--label");

  if (!course) {
    console.error("Usage: gsi-ingest --course <courseId> [--dir <path> | --file <path>] [--label <name>]");
    process.exit(1);
  }

  const opts: IngestOptions = { courseId: course, label };

  if (dir) {
    ingestCourseDirectory(dir, opts).then(results => {
      const ok = results.filter(r => r.success).length;
      console.log(`\n✓ Ingested ${ok}/${results.length} files`);
      process.exit(ok > 0 ? 0 : 1);
    }).catch(err => {
      console.error(err);
      process.exit(1);
    });
  } else if (file) {
    ingestFile(file, opts).then(result => {
      console.log(`\n${result.success ? "✓" : "✗"} ${result.file}: ${result.chunkCount ?? 0} chunks`);
      process.exit(result.success ? 0 : 1);
    }).catch(err => {
      console.error(err);
      process.exit(1);
    });
  } else {
    console.error("Provide --dir or --file");
    process.exit(1);
  }
}
