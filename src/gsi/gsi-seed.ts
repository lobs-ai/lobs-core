/**
 * GSI Office Hours — Seed Knowledge Base
 *
 * Seeds lobs-memory with course FAQ data on first run.
 * Tracks what's been seeded via a stamp file to avoid re-ingesting.
 *
 * Called automatically on lobs-core startup if course configs exist.
 * Also callable directly:
 *   npx ts-node src/gsi/gsi-seed.ts --course eecs281 [--force]
 */

import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { log } from "../util/logger.js";
import { loadAllCourseConfigs, loadCourseConfig, type GsiCourseConfig } from "./gsi-config.js";
import { ingestFile, ingestText, type IngestOptions } from "./gsi-ingest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const SEED_STAMP_DIR = resolve(HOME, ".lobs/gsi/seeds");

// Built-in seed data shipped with lobs-core
interface BuiltinSeedFile {
  file: string;
  label: string;
  tags?: string[];
}
const BUILTIN_SEEDS: Record<string, BuiltinSeedFile[]> = {
  eecs281: [
    {
      file: resolve(__dirname, "seed-data/eecs281-faq.json"),
      label: "EECS 281 Frequently Asked Questions",
      tags: ["eecs281", "faq", "seed"],
    },
    {
      file: resolve(__dirname, "seed-data/eecs281-syllabus.md"),
      label: "EECS 281 Course Syllabus",
      tags: ["eecs281", "syllabus", "seed", "policies", "grading"],
    },
  ],
};

// ── Stamp tracking ────────────────────────────────────────────────────────────

interface SeedStamp {
  courseId: string;
  seededAt: string;
  files: string[];
  chunkCount: number;
  version: number;
}

const SEED_VERSION = 2; // v2: added eecs281-syllabus.md seed document

function getStampPath(courseId: string): string {
  return join(SEED_STAMP_DIR, `${courseId}.seed.json`);
}

function readStamp(courseId: string): SeedStamp | null {
  const path = getStampPath(courseId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SeedStamp;
  } catch {
    return null;
  }
}

function writeStamp(stamp: SeedStamp): void {
  mkdirSync(SEED_STAMP_DIR, { recursive: true });
  writeFileSync(getStampPath(stamp.courseId), JSON.stringify(stamp, null, 2), "utf8");
}

function isAlreadySeeded(courseId: string): boolean {
  const stamp = readStamp(courseId);
  return stamp !== null && stamp.version >= SEED_VERSION;
}

// ── Seeding ───────────────────────────────────────────────────────────────────

export interface SeedResult {
  courseId: string;
  skipped: boolean;
  filesIndexed: number;
  totalChunks: number;
  errors: string[];
}

/**
 * Seed built-in FAQ data for a single course.
 * Skips if already seeded (unless force=true).
 */
export async function seedCourse(courseId: string, force = false): Promise<SeedResult> {
  const result: SeedResult = {
    courseId,
    skipped: false,
    filesIndexed: 0,
    totalChunks: 0,
    errors: [],
  };

  if (!force && isAlreadySeeded(courseId)) {
    log().debug?.(`[gsi-seed] ${courseId}: already seeded, skipping`);
    result.skipped = true;
    return result;
  }

  const seedFiles = BUILTIN_SEEDS[courseId];
  if (!seedFiles || seedFiles.length === 0) {
    log().debug?.(`[gsi-seed] ${courseId}: no built-in seed data, skipping`);
    result.skipped = true;
    return result;
  }

  const seededFilePaths: string[] = [];

  for (const seed of seedFiles) {
    if (!existsSync(seed.file)) {
      log().warn(`[gsi-seed] ${courseId}: seed file not found: ${seed.file}`);
      result.errors.push(`Seed file not found: ${seed.file}`);
      continue;
    }

    log().info(`[gsi-seed] Seeding ${courseId} from ${seed.file}...`);

    const opts: IngestOptions = {
      courseId,
      label: seed.label,
      tags: seed.tags ?? [courseId, "seed"],
    };

    const ingestResult = await ingestFile(seed.file, opts);

    if (ingestResult.success) {
      result.filesIndexed += 1;
      result.totalChunks += ingestResult.chunkCount ?? 0;
      seededFilePaths.push(seed.file);
      log().info(`[gsi-seed] ✓ Ingested "${seed.label}": ${ingestResult.chunkCount} chunks`);
    } else {
      result.errors.push(ingestResult.error ?? `Unknown error ingesting ${seed.label}`);
      log().warn(`[gsi-seed] ✗ Failed to ingest "${seed.label}": ${ingestResult.error}`);
    }
  }

  if (result.filesIndexed > 0) {
    writeStamp({
      courseId,
      seededAt: new Date().toISOString(),
      files: seededFilePaths,
      chunkCount: result.totalChunks,
      version: SEED_VERSION,
    });

    log().info(`[gsi-seed] ✓ Seeded ${courseId}: ${result.filesIndexed} files, ${result.totalChunks} chunks indexed`);
  } else {
    log().warn(`[gsi-seed] ✗ Failed to seed ${courseId}: no files indexed`);
  }

  return result;
}

/**
 * Seed built-in FAQ data for all configured courses that have seed data.
 * Safe to call on every startup — skips already-seeded courses.
 */
export async function seedAllCourses(force = false): Promise<SeedResult[]> {
  const courses = loadAllCourseConfigs();
  if (courses.length === 0) {
    log().debug?.("[gsi-seed] No course configs found, skipping seed");
    return [];
  }

  const results: SeedResult[] = [];
  for (const course of courses) {
    const result = await seedCourse(course.courseId, force);
    results.push(result);
  }

  const seeded = results.filter(r => !r.skipped && r.filesIndexed > 0);
  const totalChunks = results.reduce((s, r) => s + r.totalChunks, 0);

  if (seeded.length > 0) {
    log().info(`[gsi-seed] Startup seed complete: ${seeded.length} courses, ${totalChunks} chunks`);
  }

  return results;
}

/**
 * Seed FAQ items provided as raw Q&A pairs (e.g. scraped from Piazza).
 * Each item is indexed as a separate chunk with source attribution.
 */
export async function seedQAPairs(
  pairs: Array<{ question: string; answer: string; source?: string; tags?: string[] }>,
  opts: IngestOptions
): Promise<SeedResult> {
  const result: SeedResult = {
    courseId: opts.courseId,
    skipped: false,
    filesIndexed: 0,
    totalChunks: 0,
    errors: [],
  };

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const text = `Q: ${pair.question}\n\nA: ${pair.answer}`;
    const source = pair.source ?? `${opts.courseId.toUpperCase()} FAQ item ${i + 1}`;

    const ingestResult = await ingestText(text, source, {
      ...opts,
      tags: [...(opts.tags ?? []), ...(pair.tags ?? [])],
    });

    if (ingestResult.success) {
      result.filesIndexed++;
      result.totalChunks += ingestResult.chunkCount ?? 0;
    } else {
      result.errors.push(`Item ${i + 1}: ${ingestResult.error}`);
    }
  }

  log().info(
    `[gsi-seed] Seeded ${result.filesIndexed}/${pairs.length} Q&A pairs for ${opts.courseId}`
  );
  return result;
}

// ── CLI Entry Point ───────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("gsi-seed.ts") || process.argv[1]?.endsWith("gsi-seed.js");

if (isMain) {
  const args = process.argv.slice(2);
  const courseArg = args.find(a => !a.startsWith("--"));
  const force = args.includes("--force");
  const all = args.includes("--all");

  if (all || !courseArg) {
    console.log("Seeding all configured courses...");
    seedAllCourses(force).then(results => {
      for (const r of results) {
        if (r.skipped) console.log(`  ${r.courseId}: skipped (already seeded)`);
        else if (r.filesIndexed > 0) console.log(`  ✓ ${r.courseId}: ${r.totalChunks} chunks`);
        else console.log(`  ✗ ${r.courseId}: ${r.errors.join(", ")}`);
      }
      process.exit(0);
    }).catch(err => { console.error(err); process.exit(1); });
  } else {
    console.log(`Seeding ${courseArg}${force ? " (forced)" : ""}...`);
    seedCourse(courseArg, force).then(r => {
      if (r.skipped) console.log("Skipped (already seeded). Use --force to re-seed.");
      else if (r.filesIndexed > 0) console.log(`✓ Seeded: ${r.totalChunks} chunks indexed`);
      else console.log(`✗ Failed: ${r.errors.join(", ")}`);
      process.exit(r.errors.length > 0 ? 1 : 0);
    }).catch(err => { console.error(err); process.exit(1); });
  }
}
