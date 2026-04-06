/**
 * Core File Auto-Sync Service
 *
 * Scans high-confidence memories from the structured-memory DB and applies
 * small, targeted edits to the always-loaded core files at ~/.lobs/agents/main/.
 *
 * Files managed:
 *   - MEMORY.md  — projects, people, system changes, directory changes, rules
 *   - USER.md    — user preferences, schedule changes, personal info
 *   - SOUL.md    — behavioral rules, voice preferences, anti-patterns
 *   - TOOLS.md   — new tools, changed tool configs, new repos
 *
 * Design:
 *   - Conservative edits only (append / small updates, never full rewrites)
 *   - Tracks synced memories via metadata JSON field on the memories row
 *   - Uses Claude Haiku (small tier) to classify + generate minimal edits
 *   - Dry-run mode logs changes without writing (default in development)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../util/logger.js";
import { getMemoryDb, isMemoryDbReady } from "../memory/db.js";
import { callApiModelJSON } from "../workers/base-worker.js";
import { getLobsRoot } from "../config/lobs.js";

// ── Constants ────────────────────────────────────────────────────────────────

const CORE_FILES_DIR = join(getLobsRoot(), "agents", "main");
const CORE_FILES = ["MEMORY.md", "USER.md", "SOUL.md", "TOOLS.md"] as const;
type CoreFile = (typeof CORE_FILES)[number];

/** Max memories to process per sync run — keeps LLM cost bounded */
const MAX_MEMORIES_PER_RUN = 50;

// ── Types ────────────────────────────────────────────────────────────────────

export interface CoreFileEdit {
  file: CoreFile;
  section: string;      // e.g., "## Projects", "## Rules", "## Voice"
  action: "append" | "update" | "add_section";
  content: string;      // the line(s) to add or the updated content
  memoryIds: string[];  // which memories this edit addresses
  reason: string;       // why this edit is being made
}

interface SyncResult {
  memoriesConsidered: number;
  editsGenerated: number;
  editsApplied: number;
  skipped: number;
  dryRun: boolean;
  errors: string[];
}

interface MemoryRow {
  id: string;
  category: string;
  memory_type: string | null;
  content: string;
  source_authority: number;
  confidence: number;
  status: string;
  metadata: string | null;
  created_at: string;
}

interface LLMEditPlan {
  edits: Array<{
    file: CoreFile;
    section: string;
    action: "append" | "update" | "add_section";
    content: string;
    memoryIds: string[];
    reason: string;
    skip: boolean;
    skipReason?: string;
  }>;
}

// ── DB migration helper ───────────────────────────────────────────────────────

/**
 * Ensure the metadata column exists on the memories table.
 * Uses the same safe try/catch pattern as db.ts addColumnIfMissing.
 */
function ensureMetadataColumn(): void {
  const db = getMemoryDb();
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN metadata TEXT`);
    log().info("[core-file-sync] Added metadata column to memories table");
  } catch {
    // Already exists — ignore
  }
}

// ── Core file helpers ─────────────────────────────────────────────────────────

function coreFilePath(file: CoreFile): string {
  return join(CORE_FILES_DIR, file);
}

function readCoreFile(file: CoreFile): string | null {
  const p = coreFilePath(file);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

/**
 * Apply a single edit to a core file's content string.
 * Returns the updated content, or null if the edit couldn't be applied safely.
 */
function applyEditToContent(
  originalContent: string,
  edit: CoreFileEdit,
): string | null {
  const lines = originalContent.split("\n");

  if (edit.action === "add_section") {
    // Append a brand-new section at the end of the file
    const newSection = `\n## ${edit.section}\n${edit.content}`;
    return originalContent.trimEnd() + "\n" + newSection + "\n";
  }

  // Find the target section header
  const sectionHeader = edit.section.startsWith("#") ? edit.section : `## ${edit.section}`;
  const sectionIdx = lines.findIndex(
    l => l.trim() === sectionHeader.trim()
  );

  if (sectionIdx === -1) {
    // Section doesn't exist — treat append/update as add_section
    log().warn(`[core-file-sync] Section "${edit.section}" not found in content — appending as new section`);
    const newSection = `\n${sectionHeader}\n${edit.content}`;
    return originalContent.trimEnd() + "\n" + newSection + "\n";
  }

  if (edit.action === "append") {
    // Find the end of this section (next ## heading or EOF)
    let insertIdx = lines.length;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ") || lines[i].startsWith("# ")) {
        insertIdx = i;
        break;
      }
    }
    // Insert before the next section (or at end), with blank line guard
    const insertLines = edit.content.split("\n");
    lines.splice(insertIdx, 0, ...insertLines);
    return lines.join("\n");
  }

  if (edit.action === "update") {
    // For update: append to the section (conservative — don't delete existing lines)
    // This avoids accidentally removing content; a human can clean up later
    let insertIdx = lines.length;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ") || lines[i].startsWith("# ")) {
        insertIdx = i;
        break;
      }
    }
    const insertLines = [
      `<!-- updated ${new Date().toISOString().slice(0, 10)} -->`,
      ...edit.content.split("\n"),
    ];
    lines.splice(insertIdx, 0, ...insertLines);
    return lines.join("\n");
  }

  return null;
}

// ── LLM classification ────────────────────────────────────────────────────────

/**
 * Read existing core file contents (for context in the LLM prompt).
 */
function buildCoreFileContext(): string {
  const parts: string[] = [];
  for (const file of CORE_FILES) {
    const content = readCoreFile(file);
    if (content) {
      // Truncate to 2000 chars per file to keep the prompt manageable
      const preview = content.length > 2000 ? content.slice(0, 2000) + "\n...(truncated)" : content;
      parts.push(`### ${file}\n${preview}`);
    }
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Ask Haiku to classify a batch of memories and generate minimal edits.
 */
async function classifyAndPlanEdits(
  memories: MemoryRow[],
  coreFileContext: string,
): Promise<LLMEditPlan> {
  const memorySummary = memories
    .map(m => `[${m.id}] (${m.category}/${m.memory_type ?? "general"}) confidence=${m.confidence.toFixed(2)}: ${m.content.slice(0, 300)}`)
    .join("\n");

  const prompt = `You are a memory sync assistant. You must decide which of the following memories should be written into the agent's core files, and generate the minimal edits needed.

## Core Files (current content)
${coreFileContext}

## Candidate Memories to sync
${memorySummary}

## Rules
- Only include memories that are genuinely new information not already present in the core files
- Be conservative: prefer "skip" over adding noise
- Each edit must be small: 1-3 lines of content at most
- Never suggest deleting or replacing existing content — only append or add
- Pick the right file:
  - MEMORY.md: projects, people, system state, directories, rules
  - USER.md: user preferences, schedule, personal facts about Rafe
  - SOUL.md: behavioral rules, voice/tone guidance, relationship dynamics
  - TOOLS.md: new tools, changed configs, new repos, endpoints

## Response format
Return a JSON object with this exact shape:
{
  "edits": [
    {
      "file": "MEMORY.md",
      "section": "## Projects",
      "action": "append",
      "content": "- new project info here",
      "memoryIds": ["memory-id-here"],
      "reason": "why this edit is needed",
      "skip": false
    },
    {
      "file": "MEMORY.md",
      "section": "## Rules",
      "action": "append",
      "content": "",
      "memoryIds": ["memory-id-2"],
      "reason": "already present in core files",
      "skip": true,
      "skipReason": "already captured in MEMORY.md Rules section"
    }
  ]
}

Important: every candidate memory must appear in the edits array — either as a real edit (skip:false) or as skipped (skip:true). Return exactly one entry per memory id.`;

  const { data } = await callApiModelJSON<LLMEditPlan>(prompt, {
    tier: "small",
    maxTokens: 4096,
    systemPrompt: "You are a precise memory sync assistant. Return only valid JSON.",
  });

  return data;
}

// ── DB operations ─────────────────────────────────────────────────────────────

function fetchUnsyncedMemories(): MemoryRow[] {
  const db = getMemoryDb();
  return db
    .prepare(
      `SELECT id, category, memory_type, content, source_authority, confidence, status, metadata, created_at
       FROM memories
       WHERE status = 'active'
         AND (source_authority >= 2 OR confidence >= 0.8)
         AND (metadata IS NULL OR json_extract(metadata, '$.synced_to_core_file') IS NULL)
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(MAX_MEMORIES_PER_RUN) as MemoryRow[];
}

function markMemoriesSynced(ids: string[]): void {
  const db = getMemoryDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE memories
     SET metadata = json_set(COALESCE(metadata, '{}'), '$.synced_to_core_file', json('true'), '$.synced_at', ?)
     WHERE id = ?`
  );
  const updateMany = db.transaction((memIds: string[]) => {
    for (const id of memIds) {
      stmt.run(now, id);
    }
  });
  updateMany(ids);
}

// ── Main sync logic ───────────────────────────────────────────────────────────

export interface CoreFileSyncOptions {
  dryRun?: boolean;
}

/**
 * Run one cycle of core-file sync.
 *
 * - Queries unsynced high-confidence memories
 * - Uses Haiku to classify + generate minimal edits
 * - Applies edits to the core files (or logs them in dry-run mode)
 * - Marks memories as synced
 */
export async function runCoreFileSync(
  opts: CoreFileSyncOptions = {},
): Promise<SyncResult> {
  const dryRun = opts.dryRun ?? true; // default dry-run for safety
  const errors: string[] = [];

  log().info(`[core-file-sync] Starting sync (dryRun=${dryRun})`);

  if (!isMemoryDbReady()) {
    log().warn("[core-file-sync] Memory DB not initialised — skipping");
    return { memoriesConsidered: 0, editsGenerated: 0, editsApplied: 0, skipped: 0, dryRun, errors: ["Memory DB not ready"] };
  }

  // Ensure metadata column exists
  ensureMetadataColumn();

  // Fetch candidate memories
  const memories = fetchUnsyncedMemories();
  log().info(`[core-file-sync] Found ${memories.length} unsynced memories`);

  if (memories.length === 0) {
    return { memoriesConsidered: 0, editsGenerated: 0, editsApplied: 0, skipped: 0, dryRun, errors: [] };
  }

  // Read current core files for LLM context
  const coreFileContext = buildCoreFileContext();

  // Ask Haiku to plan edits
  let plan: LLMEditPlan;
  try {
    plan = await classifyAndPlanEdits(memories, coreFileContext);
  } catch (err) {
    const msg = `LLM classification failed: ${String(err)}`;
    log().error(`[core-file-sync] ${msg}`);
    errors.push(msg);
    return { memoriesConsidered: memories.length, editsGenerated: 0, editsApplied: 0, skipped: 0, dryRun, errors };
  }

  log().info(`[core-file-sync] LLM returned ${plan.edits.length} edit decisions`);

  const realEdits = plan.edits.filter(e => !e.skip);
  const skippedEdits = plan.edits.filter(e => e.skip);
  let editsApplied = 0;

  // Log skipped items
  for (const s of skippedEdits) {
    log().debug?.(`[core-file-sync] SKIP [${s.memoryIds.join(",")}]: ${s.skipReason ?? s.reason}`);
  }

  // Apply real edits
  for (const edit of realEdits) {
    const coreEdit: CoreFileEdit = {
      file: edit.file,
      section: edit.section,
      action: edit.action,
      content: edit.content,
      memoryIds: edit.memoryIds,
      reason: edit.reason,
    };

    log().info(
      `[core-file-sync] ${dryRun ? "DRY-RUN " : ""}EDIT → ${edit.file} [${edit.action}] §"${edit.section}": ${edit.content.slice(0, 80)}`
    );

    if (!dryRun) {
      const current = readCoreFile(edit.file);
      if (current === null) {
        const msg = `Core file ${edit.file} not found at ${coreFilePath(edit.file)}`;
        log().error(`[core-file-sync] ${msg}`);
        errors.push(msg);
        continue;
      }

      const updated = applyEditToContent(current, coreEdit);
      if (updated === null) {
        const msg = `Failed to apply edit to ${edit.file} section "${edit.section}"`;
        log().error(`[core-file-sync] ${msg}`);
        errors.push(msg);
        continue;
      }

      try {
        writeFileSync(coreFilePath(edit.file), updated, "utf8");
        log().info(`[core-file-sync] Wrote ${edit.file}`);
        editsApplied++;
      } catch (err) {
        const msg = `Failed to write ${edit.file}: ${String(err)}`;
        log().error(`[core-file-sync] ${msg}`);
        errors.push(msg);
      }
    } else {
      editsApplied++; // count as "would apply" in dry-run
    }
  }

  // Mark all processed memories as synced (even skipped ones — they've been evaluated)
  const allMemoryIds = plan.edits.flatMap(e => e.memoryIds);
  if (!dryRun && allMemoryIds.length > 0) {
    try {
      markMemoriesSynced(allMemoryIds);
      log().info(`[core-file-sync] Marked ${allMemoryIds.length} memories as synced`);
    } catch (err) {
      const msg = `Failed to mark memories synced: ${String(err)}`;
      log().error(`[core-file-sync] ${msg}`);
      errors.push(msg);
    }
  } else if (dryRun) {
    log().info(`[core-file-sync] DRY-RUN: would mark ${allMemoryIds.length} memories as synced`);
  }

  const result: SyncResult = {
    memoriesConsidered: memories.length,
    editsGenerated: realEdits.length,
    editsApplied,
    skipped: skippedEdits.length,
    dryRun,
    errors,
  };

  log().info(`[core-file-sync] Done: ${JSON.stringify(result)}`);
  return result;
}

// ── Registration / cron hook ──────────────────────────────────────────────────

let syncInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Register the core-file-sync service to run every 30 minutes.
 * Does not hook into the main system — call this explicitly to enable.
 *
 * @param opts.dryRun - If true, logs changes without writing (default: false when registered)
 * @param opts.intervalMs - Override the 30-minute interval (default: 1800000)
 */
export function registerCoreFileSync(opts: CoreFileSyncOptions & { intervalMs?: number } = {}): void {
  const dryRun = opts.dryRun ?? false;
  const intervalMs = opts.intervalMs ?? 30 * 60 * 1000; // 30 minutes

  if (syncInterval) {
    log().warn("[core-file-sync] Already registered — clearing existing interval");
    clearInterval(syncInterval);
  }

  log().info(`[core-file-sync] Registered (every ${intervalMs / 60000} min, dryRun=${dryRun})`);

  // Run immediately on registration, then on interval
  void runCoreFileSync({ dryRun }).catch(err => {
    log().error(`[core-file-sync] Initial sync failed: ${String(err)}`);
  });

  syncInterval = setInterval(() => {
    void runCoreFileSync({ dryRun }).catch(err => {
      log().error(`[core-file-sync] Scheduled sync failed: ${String(err)}`);
    });
  }, intervalMs);
}

/**
 * Deregister the core-file-sync interval (useful in tests or graceful shutdown).
 */
export function deregisterCoreFileSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    log().info("[core-file-sync] Deregistered");
  }
}
