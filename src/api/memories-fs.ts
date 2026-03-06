/**
 * Memories API — reads from agent workspaces (~/.openclaw/workspace-{agent}/memory/).
 *
 * ## Bifurcated Memory System
 *
 * Each agent workspace has two memory directories:
 *   memory/             — non-compliant (cloud-safe); safe for cloud AI to read
 *   memory-compliant/   — compliant (local-only); NEVER served to cloud AI sessions
 *
 * The `compliance_filter` query parameter controls what is returned:
 *   - "cloud" (default)  → only files in `memory/`  (non-compliant)
 *   - "local"            → files from both directories
 *   - "all"              → same as "local"
 *
 * An anomaly is a file in `memory/` whose frontmatter declares
 * `compliance_required: true` — it should be in `memory-compliant/` instead.
 *
 * @see docs/decisions/ADR-bifurcated-memory-compliance.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { json, parseQuery } from "./index.js";
import { isMemoryCompliant, parseMemoryFrontmatter } from "../util/memory-frontmatter.js";

const WORKSPACE_BASE = join(process.env.HOME || "/Users/lobs", ".openclaw");
const AGENTS = ["programmer", "writer", "researcher", "reviewer", "architect"];

type ComplianceFilter = "cloud" | "local" | "all";

export interface MemoryEntry {
  agent: string;
  file: string;
  /** Relative to workspace root, e.g. "memory/2026-02-12.md" */
  path: string;
  content: string;
  modified: string;
  size: number;
  /** True = sensitive/local-model-only; False = cloud-safe. */
  isCompliant: boolean;
  /** True if the file is in memory/ but frontmatter says compliance_required. Indicates misplacement. */
  isAnomaly: boolean;
}

/**
 * Read memories for a single agent, honouring the compliance filter.
 */
async function readAgentMemories(
  agent: string,
  filter: ComplianceFilter = "cloud",
): Promise<MemoryEntry[]> {
  const workspaceDir = join(WORKSPACE_BASE, `workspace-${agent}`);
  const results: MemoryEntry[] = [];

  // ── Non-compliant directory (always read) ─────────────────────────────
  const memDir = join(workspaceDir, "memory");
  try {
    const files = await readdir(memDir);
    for (const f of files) {
      if (!f.endsWith(".md") && !f.endsWith(".txt")) continue;
      const full = join(memDir, f);
      try {
        const [content, s] = await Promise.all([readFile(full, "utf-8"), stat(full)]);
        const fm = parseMemoryFrontmatter(content);
        // Anomaly: file lives in memory/ but frontmatter says it's sensitive
        const isAnomaly = fm.hasFrontmatter && fm.complianceRequired;
        results.push({
          agent,
          file: f,
          path: `memory/${f}`,
          content,
          modified: s.mtime.toISOString(),
          size: s.size,
          isCompliant: false,   // structural: in memory/ → non-compliant
          isAnomaly,
        });
      } catch {}
    }
  } catch {}

  // ── Compliant directory (only when filter allows) ─────────────────────
  if (filter === "local" || filter === "all") {
    const compliantDir = join(workspaceDir, "memory-compliant");
    try {
      const files = await readdir(compliantDir);
      for (const f of files) {
        if (!f.endsWith(".md") && !f.endsWith(".txt")) continue;
        const full = join(compliantDir, f);
        try {
          const [content, s] = await Promise.all([readFile(full, "utf-8"), stat(full)]);
          results.push({
            agent,
            file: f,
            path: `memory-compliant/${f}`,
            content,
            modified: s.mtime.toISOString(),
            size: s.size,
            isCompliant: true,  // structural: in memory-compliant/ → always compliant
            isAnomaly: false,
          });
        } catch {}
      }
    } catch {}
  }

  // When cloud filter is active, strip any anomalous files from the result to be safe
  // (they're in memory/ but tagged compliant via frontmatter — don't send to cloud)
  if (filter === "cloud") {
    return results.filter(m => !m.isAnomaly);
  }

  return results;
}

/**
 * Ensure `memory-compliant/` directories exist for all known agents.
 * Called on startup — idempotent.
 */
export async function ensureCompliantMemoryDirs(): Promise<void> {
  for (const agent of AGENTS) {
    const dir = join(WORKSPACE_BASE, `workspace-${agent}`, "memory-compliant");
    try {
      await mkdir(dir, { recursive: true });
    } catch {}
  }
}

export async function handleMemoriesFsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  const q = parseQuery(req.url ?? "");

  // ── Compliance summary endpoint ────────────────────────────────────────
  if (sub === "compliance-summary") {
    const summaries: Record<string, unknown>[] = [];
    for (const agent of AGENTS) {
      // Read all (local) to count both sides
      const all = await readAgentMemories(agent, "all");
      const compliant = all.filter(m => m.isCompliant);
      const nonCompliant = all.filter(m => !m.isCompliant);
      const anomalies = all.filter(m => m.isAnomaly);
      summaries.push({
        agent,
        total: all.length,
        compliantCount: compliant.length,
        nonCompliantCount: nonCompliant.length,
        anomalyCount: anomalies.length,
      });
    }
    return json(res, { summary: summaries });
  }

  // ── Anomalies endpoint ────────────────────────────────────────────────
  if (sub === "anomalies") {
    const anomalies: MemoryEntry[] = [];
    for (const agent of AGENTS) {
      const all = await readAgentMemories(agent, "all");
      anomalies.push(...all.filter(m => m.isAnomaly));
    }
    return json(res, { anomalies, count: anomalies.length });
  }

  // ── Parse compliance filter (default: cloud) ─────────────────────────
  const rawFilter = (q.compliance_filter ?? q.filter ?? "cloud").toLowerCase();
  const filter: ComplianceFilter =
    rawFilter === "local" || rawFilter === "all" ? rawFilter : "cloud";

  // ── Per-agent request ─────────────────────────────────────────────────
  if (sub && AGENTS.includes(sub)) {
    const memories = await readAgentMemories(sub, filter);
    return json(res, { agent: sub, memories, complianceFilter: filter });
  }

  // ── All agents ────────────────────────────────────────────────────────
  const all: MemoryEntry[] = [];
  for (const agent of AGENTS) {
    all.push(...(await readAgentMemories(agent, filter)));
  }
  all.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return json(res, { memories: all, complianceFilter: filter });
}
