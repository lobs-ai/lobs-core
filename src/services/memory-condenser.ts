/**
 * Memory condensation service — manages daily memory files and condenses old ones.
 *
 * Daily memory files live at ~/.lobs/agents/main/context/memory/YYYY-MM-DD.md
 * and accumulate events, notes, learnings, decisions, and findings throughout the day.
 *
 * Condensation rules (rule-based, no LLM):
 * - Files 1–7 days old: left as-is (still useful for context)
 * - Files > 7 days old: condensed — keep learning/decision entries, drop events/notes,
 *   add a summary header noting how many entries were condensed
 * - Important learnings/decisions from old files are promoted to permanent memory
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../util/logger.js";

const HOME = process.env.HOME ?? "";
const DAILY_MEMORY_DIR = join(HOME, ".lobs/agents/main/context/memory");
const PERMANENT_FILE = join(HOME, "lobs-shared-memory/learnings.md");
const CONDENSE_STATE_FILE = join(HOME, ".lobs/config/memory-condense-state.json");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get today's date string in YYYY-MM-DD format (America/New_York timezone).
 */
function todayDateStr(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  }); // en-CA gives YYYY-MM-DD
}

/**
 * Parse a YYYY-MM-DD string into a Date at midnight UTC.
 */
function parseDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Calculate age in days between a date string and today.
 */
function daysOld(dateStr: string): number {
  const today = parseDate(todayDateStr());
  const date = parseDate(dateStr);
  const diffMs = today.getTime() - date.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the file path for today's daily memory file.
 */
export function getTodaysMemoryPath(): string {
  return join(DAILY_MEMORY_DIR, `${todayDateStr()}.md`);
}

/**
 * Create today's daily memory file if it doesn't exist.
 * Returns the path.
 */
export function ensureTodaysMemoryFile(): string {
  const filePath = getTodaysMemoryPath();

  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    const dateStr = todayDateStr();
    const header = `# ${dateStr} — Daily Memory\n\n## Events\n\n`;
    writeFileSync(filePath, header, "utf-8");
    log().info(`[memory-condenser] Created daily memory file: ${dateStr}.md`);
  }

  return filePath;
}

/**
 * Condense old daily memory files.
 *
 * - Files 1–7 days old: left as-is
 * - Files > 7 days old with > 30 entries: condensed (keep learning/decision, drop event/note)
 * - Learnings/decisions from condensed files are promoted to permanent memory
 *
 * @param minDaysOld - Only process files older than this many days (default 1)
 */
export function condenseDailyMemory(minDaysOld = 1): CondensationResult {
  const result: CondensationResult = {
    filesScanned: 0,
    filesCondensed: 0,
    entriesPromoted: 0,
    entriesDropped: 0,
  };

  if (!existsSync(DAILY_MEMORY_DIR)) {
    log().info("[memory-condenser] No daily memory directory found, skipping");
    return result;
  }

  // List all .md files that look like YYYY-MM-DD.md (strict match)
  const files = readdirSync(DAILY_MEMORY_DIR).filter((f) => {
    return /^\d{4}-\d{2}-\d{2}\.md$/.test(f);
  });

  for (const filename of files) {
    const dateStr = filename.replace(".md", "");
    const age = daysOld(dateStr);

    // Skip files that aren't old enough
    if (age < minDaysOld) continue;

    result.filesScanned++;

    // Only condense files older than 7 days
    if (age <= 7) continue;

    const filePath = join(DAILY_MEMORY_DIR, filename);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // Parse entries (lines starting with "- ")
    const entries = lines.filter((l) => l.startsWith("- "));

    // Only condense if there are enough entries to warrant it
    if (entries.length <= 30) continue;

    // Separate keepers from droppable entries
    const keepers: string[] = [];
    const promoted: string[] = [];
    let dropped = 0;

    for (const entry of entries) {
      if (entry.includes("[learning]") || entry.includes("[decision]")) {
        keepers.push(entry);

        // Promote to permanent memory
        const promotedEntry = convertToPermanentFormat(entry, dateStr);
        if (promotedEntry) {
          promoted.push(promotedEntry);
        }
      } else if (entry.includes("[finding]")) {
        // Keep findings in the file but don't promote
        keepers.push(entry);
      } else {
        // Events, notes, and unrecognized entries — drop
        dropped++;
      }
    }

    // Write promoted entries to permanent file
    if (promoted.length > 0) {
      mkdirSync(dirname(PERMANENT_FILE), { recursive: true });
      const promotedBlock = promoted.join("\n") + "\n";
      appendFileSync(PERMANENT_FILE, promotedBlock, "utf-8");
      result.entriesPromoted += promoted.length;
    }

    // Rewrite the condensed file
    const condensedHeader = `# ${dateStr} — Daily Memory (Condensed)\n\n> Condensed from ${entries.length} entries. ${keepers.length} kept, ${dropped} ephemeral entries removed.\n`;
    const keeperBlock =
      keepers.length > 0 ? "\n" + keepers.join("\n") + "\n" : "";
    writeFileSync(filePath, condensedHeader + keeperBlock, "utf-8");

    result.filesCondensed++;
    result.entriesDropped += dropped;

    log().info(
      `[memory-condenser] Condensed ${filename}: ${entries.length} → ${keepers.length} entries (${dropped} dropped, ${promoted.length} promoted)`,
    );
  }

  if (result.filesCondensed > 0) {
    log().info(
      `[memory-condenser] Done: ${result.filesCondensed} files condensed, ${result.entriesPromoted} promoted, ${result.entriesDropped} dropped`,
    );
  }

  return result;
}

/**
 * Check if condensation should run today (max once per day).
 * Returns true if it hasn't run yet today.
 */
export function shouldRunCondensation(): boolean {
  const today = todayDateStr();

  try {
    if (existsSync(CONDENSE_STATE_FILE)) {
      const raw = readFileSync(CONDENSE_STATE_FILE, "utf-8");
      const state = JSON.parse(raw) as { lastCondensationDate?: string };
      if (state.lastCondensationDate === today) {
        return false;
      }
    }
  } catch {
    // Corrupted or missing state file — safe to run
  }

  return true;
}

/**
 * Mark condensation as having run today.
 */
export function markCondensationDone(): void {
  const today = todayDateStr();
  const state = { lastCondensationDate: today };

  mkdirSync(dirname(CONDENSE_STATE_FILE), { recursive: true });
  writeFileSync(CONDENSE_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Run condensation if it hasn't been done today.
 * Called from the heartbeat — safe to call multiple times.
 */
export function runCondensationIfNeeded(): CondensationResult | null {
  if (!shouldRunCondensation()) {
    return null;
  }

  log().info("[memory-condenser] Running daily condensation");
  const result = condenseDailyMemory(1);
  markCondensationDone();
  return result;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Convert a daily-format entry to permanent format.
 * Daily:    - **[HH:MM]** [category] — content
 * Permanent: - **[YYYY-MM-DD] [category]** — content
 */
function convertToPermanentFormat(
  entry: string,
  dateStr: string,
): string | null {
  // Match patterns like: - **[HH:MM]** [category] — content
  const match = entry.match(
    /^- \*\*\[\d{2}:\d{2}\]\*\* \[(learning|decision|finding)\] — (.+)$/,
  );
  if (match) {
    const [, category, content] = match;
    return `- **[${dateStr}] [${category}]** — ${content}`;
  }

  // Also handle entries already in some other format — extract what we can
  const fallback = entry.match(/\[(learning|decision)\].*?— (.+)$/);
  if (fallback) {
    const [, category, content] = fallback;
    return `- **[${dateStr}] [${category}]** — ${content}`;
  }

  return null;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CondensationResult {
  filesScanned: number;
  filesCondensed: number;
  entriesPromoted: number;
  entriesDropped: number;
}
