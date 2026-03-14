/**
 * Memory Compliance Scanner Service
 *
 * Background service that scans all agent workspace memory directories and
 * maintains the `memory_compliance_index` table.
 *
 * ## What it does
 * - Scans `~/.lobs/agents/{agent}/context/memory/` and `memory-compliant/` for all agents
 * - Computes a SHA-1 hash of each file for change detection
 * - Upserts rows in `memory_compliance_index` with compliance status + anomaly flag
 * - Detects anomalies: files in `memory/` whose frontmatter declares `compliance_required: true`
 *   (these should be moved to `memory-compliant/` but are NOT auto-moved)
 * - Runs on startup and then every SCAN_INTERVAL_MS milliseconds
 *
 * ## Anomaly policy
 * Files that are misplaced are flagged with `anomaly=1` and `anomalyReason` text.
 * They are NOT automatically moved — the human or an admin UI action must fix them.
 *
 * @see docs/decisions/ADR-bifurcated-memory-compliance.md
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseMemoryFrontmatter } from "../util/memory-frontmatter.js";
import { getDb, getRawDb } from "../db/connection.js";
import { log } from "../util/logger.js";
import { getAgentCompliantMemoryDir, getAgentMemoryDir } from "../config/lobs.js";

const AGENT_TYPES = ["programmer", "writer", "researcher", "reviewer", "architect"];
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

type Directory = "memory" | "memory-compliant";

interface ScannedFile {
  agentType: string;
  filename: string;
  filePath: string;       // absolute path
  directory: Directory;
  contentHash: string;
  sizeBytes: number;
  complianceRequired: boolean;
  frontmatterCompliance: boolean | null;
  anomaly: boolean;
  anomalyReason: string | null;
}

function sha1(content: string): string {
  return createHash("sha1").update(content, "utf-8").digest("hex");
}

/**
 * Scan a single directory for memory files and return structured metadata.
 */
async function scanDirectory(agentType: string, dir: Directory): Promise<ScannedFile[]> {
  const dirPath = dir === "memory" ? getAgentMemoryDir(agentType) : getAgentCompliantMemoryDir(agentType);
  const results: ScannedFile[] = [];

  let files: string[];
  try {
    files = await readdir(dirPath);
  } catch {
    // Directory doesn't exist yet — skip silently
    return results;
  }

  for (const filename of files) {
    if (!filename.endsWith(".md") && !filename.endsWith(".txt")) continue;
    const filePath = join(dirPath, filename);
    try {
      const [content, s] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
      const fm = parseMemoryFrontmatter(content);
      const hash = sha1(content);

      // Structural compliance: files in memory-compliant/ are ALWAYS compliant
      const structuralCompliance = dir === "memory-compliant";

      // Derived: union of structural + frontmatter
      const complianceRequired = structuralCompliance || fm.complianceRequired;

      // Anomaly: file is in memory/ but frontmatter says it's sensitive
      let anomaly = false;
      let anomalyReason: string | null = null;
      if (dir === "memory" && fm.hasFrontmatter && fm.complianceRequired) {
        anomaly = true;
        anomalyReason = "File in memory/ declares compliance_required=true in frontmatter. Move to memory-compliant/.";
      }

      results.push({
        agentType,
        filename,
        filePath,
        directory: dir,
        contentHash: hash,
        sizeBytes: s.size,
        complianceRequired,
        frontmatterCompliance: fm.hasFrontmatter ? fm.complianceRequired : null,
        anomaly,
        anomalyReason,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

/**
 * Upsert a scanned file entry into `memory_compliance_index`.
 */
function upsertEntry(scanned: ScannedFile): void {
  const db = getRawDb();
  const id = `${scanned.agentType}:${scanned.directory}/${scanned.filename}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO memory_compliance_index
      (id, agent_type, file_path, filename, directory,
       compliance_required, frontmatter_compliance,
       content_hash, size_bytes, last_scanned_at,
       anomaly, anomaly_reason, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?,  ?, ?,  ?, ?, ?,  ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_path              = excluded.file_path,
      directory              = excluded.directory,
      compliance_required    = excluded.compliance_required,
      frontmatter_compliance = excluded.frontmatter_compliance,
      content_hash           = excluded.content_hash,
      size_bytes             = excluded.size_bytes,
      last_scanned_at        = excluded.last_scanned_at,
      anomaly                = excluded.anomaly,
      anomaly_reason         = excluded.anomaly_reason,
      updated_at             = excluded.updated_at
  `).run(
    id,
    scanned.agentType,
    scanned.filePath,
    scanned.filename,
    scanned.directory,
    scanned.complianceRequired ? 1 : 0,
    scanned.frontmatterCompliance === null ? null : (scanned.frontmatterCompliance ? 1 : 0),
    scanned.contentHash,
    scanned.sizeBytes,
    now,
    scanned.anomaly ? 1 : 0,
    scanned.anomalyReason,
    now,
    now,
  );
}

/**
 * Remove stale index entries (files that no longer exist on disk).
 * Compares the set of currently-seen file paths against what's in the index.
 */
function pruneStaleEntries(seenIds: Set<string>): void {
  const db = getRawDb();
  const existing = db.prepare("SELECT id FROM memory_compliance_index").all() as Array<{ id: string }>;
  for (const row of existing) {
    if (!seenIds.has(row.id)) {
      db.prepare("DELETE FROM memory_compliance_index WHERE id = ?").run(row.id);
    }
  }
}

/**
 * Run a full scan of all agent memory directories.
 * Upserts the index and prunes stale entries.
 * Returns counts for logging.
 */
export async function scanNow(): Promise<{ total: number; anomalies: number; pruned: number }> {
  const all: ScannedFile[] = [];

  for (const agentType of AGENT_TYPES) {
    const [memFiles, compliantFiles] = await Promise.all([
      scanDirectory(agentType, "memory"),
      scanDirectory(agentType, "memory-compliant"),
    ]);
    all.push(...memFiles, ...compliantFiles);
  }

  const seenIds = new Set<string>();
  for (const entry of all) {
    upsertEntry(entry);
    seenIds.add(`${entry.agentType}:${entry.directory}/${entry.filename}`);
  }

  const prevCount = getRawDb()
    .prepare("SELECT COUNT(*) as n FROM memory_compliance_index")
    .get() as { n: number };

  pruneStaleEntries(seenIds);

  const afterCount = getRawDb()
    .prepare("SELECT COUNT(*) as n FROM memory_compliance_index")
    .get() as { n: number };

  const anomalies = all.filter(f => f.anomaly).length;
  const pruned = Math.max(0, prevCount.n - afterCount.n);

  if (anomalies > 0) {
    const names = all.filter(f => f.anomaly).map(f => `${f.agentType}:${f.filename}`).join(", ");
    log().warn?.(`[MemoryScanner] ${anomalies} anomalous memory file(s) detected: ${names}`);
  }

  log().debug?.(`[MemoryScanner] Scan complete — ${all.length} files, ${anomalies} anomalies, ${pruned} pruned`);
  return { total: all.length, anomalies, pruned };
}

let _intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background memory scanner.
 * Runs an immediate scan, then repeats every SCAN_INTERVAL_MS.
 */
export function startMemoryScanner(): void {
  log().info?.("[MemoryScanner] Starting background memory compliance scanner...");

  // Run immediately (async, don't block startup)
  scanNow().catch(err => log().warn?.(`[MemoryScanner] Initial scan failed: ${err}`));

  _intervalHandle = setInterval(() => {
    scanNow().catch(err => log().warn?.(`[MemoryScanner] Periodic scan failed: ${err}`));
  }, SCAN_INTERVAL_MS);

  // Don't block process exit
  if (_intervalHandle.unref) _intervalHandle.unref();
}

/**
 * Stop the background memory scanner.
 */
export function stopMemoryScanner(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    log().debug?.("[MemoryScanner] Stopped.");
  }
}
