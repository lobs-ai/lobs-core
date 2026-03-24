/**
 * Research Radar Service — identifies opportunities from intel analysis.
 *
 * Three tracks:
 *   1. Papers — novel research, publishable at top venues
 *   2. Lobs improvements — things we can build to make Lobs better
 *   3. Products — ideas for products/companies/things to sell
 *
 * Analyzes intel insights to find:
 *   - Research gaps nobody's addressing
 *   - Capabilities we're missing that others are building
 *   - Market opportunities and unmet needs
 *   - Emerging trends across multiple sources
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { log } from "../util/logger.js";

// ── Types ────────────────────────────────────────────────────────────────

export type IdeaTrack = "paper" | "lobs" | "product";

export type ResearchStatus = "idea" | "developing" | "ready" | "in_progress" | "done" | "archived";

export interface ResearchRadarItem {
  id: string;
  title: string;
  thesis: string;
  track: IdeaTrack;
  status: ResearchStatus;
  noveltyScore: number;
  feasibilityScore: number;
  impactScore: number;
  researchArea: string;
  tags: string[];
  gapAnalysis: string | null;
  relatedWork: RelatedWork[];
  ourAngle: string | null;
  methodology: string | null;
  keyExperiments: string | null;
  sourceInsightIds: string[];
  sourceFeedIds: string[];
  evolutionLog: EvolutionEntry[];
  lastAnalyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RelatedWork {
  url: string;
  title: string;
  relevance: string;
}

export interface EvolutionEntry {
  date: string;
  event: string;
  detail: string;
}

export interface CreateRadarInput {
  title: string;
  thesis: string;
  track?: IdeaTrack;
  researchArea?: string;
  tags?: string[];
  gapAnalysis?: string;
  relatedWork?: RelatedWork[];
  ourAngle?: string;
  methodology?: string;
  keyExperiments?: string;
  noveltyScore?: number;
  feasibilityScore?: number;
  impactScore?: number;
  sourceInsightIds?: string[];
  sourceFeedIds?: string[];
}

export interface AnalysisResult {
  newIdeas: number;
  updatedIdeas: number;
  tokensUsed: number;
  themes: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function normalizeItem(row: Record<string, unknown>): ResearchRadarItem {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    thesis: String(row.thesis ?? ""),
    track: (String(row.track ?? "paper") as IdeaTrack),
    status: String(row.status ?? "idea") as ResearchStatus,
    noveltyScore: Number(row.novelty_score ?? 0.5),
    feasibilityScore: Number(row.feasibility_score ?? 0.5),
    impactScore: Number(row.impact_score ?? 0.5),
    researchArea: String(row.research_area ?? "agentic_engineering"),
    tags: safeParseJson<string[]>(row.tags, []),
    gapAnalysis: row.gap_analysis ? String(row.gap_analysis) : null,
    relatedWork: safeParseJson<RelatedWork[]>(row.related_work, []),
    ourAngle: row.our_angle ? String(row.our_angle) : null,
    methodology: row.methodology ? String(row.methodology) : null,
    keyExperiments: row.key_experiments ? String(row.key_experiments) : null,
    sourceInsightIds: safeParseJson<string[]>(row.source_insight_ids, []),
    sourceFeedIds: safeParseJson<string[]>(row.source_feed_ids, []),
    evolutionLog: safeParseJson<EvolutionEntry[]>(row.evolution_log, []),
    lastAnalyzedAt: row.last_analyzed_at ? String(row.last_analyzed_at) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
  };
}

// ── Schema ───────────────────────────────────────────────────────────────

const ENSURE_TABLE = `
  CREATE TABLE IF NOT EXISTS research_radar (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    thesis TEXT NOT NULL,
    track TEXT NOT NULL DEFAULT 'paper',
    status TEXT NOT NULL DEFAULT 'idea',
    novelty_score REAL NOT NULL DEFAULT 0.5,
    feasibility_score REAL NOT NULL DEFAULT 0.5,
    impact_score REAL NOT NULL DEFAULT 0.5,
    research_area TEXT NOT NULL DEFAULT 'agentic_engineering',
    tags TEXT NOT NULL DEFAULT '[]',
    gap_analysis TEXT,
    related_work TEXT NOT NULL DEFAULT '[]',
    our_angle TEXT,
    methodology TEXT,
    key_experiments TEXT,
    source_insight_ids TEXT NOT NULL DEFAULT '[]',
    source_feed_ids TEXT NOT NULL DEFAULT '[]',
    evolution_log TEXT NOT NULL DEFAULT '[]',
    last_analyzed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_research_radar_status ON research_radar(status);
  CREATE INDEX IF NOT EXISTS idx_research_radar_novelty ON research_radar(novelty_score DESC);
  CREATE INDEX IF NOT EXISTS idx_research_radar_area ON research_radar(research_area);
  CREATE INDEX IF NOT EXISTS idx_research_radar_track ON research_radar(track);
`;

// Migration: add track column to existing tables
const MIGRATE_TRACK = `
  ALTER TABLE research_radar ADD COLUMN track TEXT NOT NULL DEFAULT 'paper';
`;

// ── Service ──────────────────────────────────────────────────────────────

export class ResearchRadarService {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(ENSURE_TABLE);
    // Safe migration — add track column if missing
    try {
      this.db.exec(MIGRATE_TRACK);
    } catch {
      // Column already exists — fine
    }
    // Ensure index exists for track
    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_research_radar_track ON research_radar(track)");
    } catch { /* already exists */ }
  }

  // ── CRUD ───────────────────────────────────────────────────────────

  create(input: CreateRadarInput): ResearchRadarItem {
    const id = randomUUID();
    const now = new Date().toISOString();
    const track = input.track ?? "paper";
    const initialLog: EvolutionEntry[] = [{ date: now, event: "created", detail: "Idea identified" }];

    this.db.prepare(
      `INSERT INTO research_radar
        (id, title, thesis, track, status, novelty_score, feasibility_score, impact_score,
         research_area, tags, gap_analysis, related_work, our_angle, methodology,
         key_experiments, source_insight_ids, source_feed_ids, evolution_log,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, 'idea', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.thesis,
      track,
      input.noveltyScore ?? 0.5,
      input.feasibilityScore ?? 0.5,
      input.impactScore ?? 0.5,
      input.researchArea ?? "agentic_engineering",
      JSON.stringify(input.tags ?? []),
      input.gapAnalysis ?? null,
      JSON.stringify(input.relatedWork ?? []),
      input.ourAngle ?? null,
      input.methodology ?? null,
      input.keyExperiments ?? null,
      JSON.stringify(input.sourceInsightIds ?? []),
      JSON.stringify(input.sourceFeedIds ?? []),
      JSON.stringify(initialLog),
      now,
      now,
    );

    log().info(`[research-radar] Created ${track} idea: "${input.title}"`);
    return this.get(id)!;
  }

  get(id: string): ResearchRadarItem | null {
    const row = this.db.prepare("SELECT * FROM research_radar WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? normalizeItem(row) : null;
  }

  list(options: {
    status?: ResearchStatus | ResearchStatus[];
    track?: IdeaTrack | IdeaTrack[];
    area?: string;
    minNovelty?: number;
    sortBy?: "novelty" | "feasibility" | "impact" | "composite" | "created";
    limit?: number;
  } = {}): ResearchRadarItem[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (options.track) {
      const tracks = Array.isArray(options.track) ? options.track : [options.track];
      conditions.push(`track IN (${tracks.map(() => "?").join(",")})`);
      params.push(...tracks);
    }
    if (options.area) { conditions.push("research_area = ?"); params.push(options.area); }
    if (options.minNovelty !== undefined) { conditions.push("novelty_score >= ?"); params.push(options.minNovelty); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let orderBy: string;
    switch (options.sortBy) {
      case "novelty": orderBy = "novelty_score DESC"; break;
      case "feasibility": orderBy = "feasibility_score DESC"; break;
      case "impact": orderBy = "impact_score DESC"; break;
      case "composite": orderBy = "(novelty_score * 0.4 + feasibility_score * 0.3 + impact_score * 0.3) DESC"; break;
      default: orderBy = "created_at DESC";
    }

    const limit = Math.min(options.limit ?? 50, 200);

    const rows = this.db.prepare(
      `SELECT * FROM research_radar ${where} ORDER BY ${orderBy} LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map(normalizeItem);
  }

  update(id: string, updates: Partial<CreateRadarInput> & {
    status?: ResearchStatus;
    evolutionEvent?: string;
    evolutionDetail?: string;
  }): ResearchRadarItem | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const vals: unknown[] = [now];

    if (updates.title !== undefined) { sets.push("title = ?"); vals.push(updates.title); }
    if (updates.thesis !== undefined) { sets.push("thesis = ?"); vals.push(updates.thesis); }
    if (updates.track !== undefined) { sets.push("track = ?"); vals.push(updates.track); }
    if (updates.status !== undefined) { sets.push("status = ?"); vals.push(updates.status); }
    if (updates.noveltyScore !== undefined) { sets.push("novelty_score = ?"); vals.push(updates.noveltyScore); }
    if (updates.feasibilityScore !== undefined) { sets.push("feasibility_score = ?"); vals.push(updates.feasibilityScore); }
    if (updates.impactScore !== undefined) { sets.push("impact_score = ?"); vals.push(updates.impactScore); }
    if (updates.researchArea !== undefined) { sets.push("research_area = ?"); vals.push(updates.researchArea); }
    if (updates.tags !== undefined) { sets.push("tags = ?"); vals.push(JSON.stringify(updates.tags)); }
    if (updates.gapAnalysis !== undefined) { sets.push("gap_analysis = ?"); vals.push(updates.gapAnalysis); }
    if (updates.relatedWork !== undefined) { sets.push("related_work = ?"); vals.push(JSON.stringify(updates.relatedWork)); }
    if (updates.ourAngle !== undefined) { sets.push("our_angle = ?"); vals.push(updates.ourAngle); }
    if (updates.methodology !== undefined) { sets.push("methodology = ?"); vals.push(updates.methodology); }
    if (updates.keyExperiments !== undefined) { sets.push("key_experiments = ?"); vals.push(updates.keyExperiments); }

    // Append to source IDs rather than replace
    if (updates.sourceInsightIds?.length) {
      const merged = [...new Set([...existing.sourceInsightIds, ...updates.sourceInsightIds])];
      sets.push("source_insight_ids = ?"); vals.push(JSON.stringify(merged));
    }
    if (updates.sourceFeedIds?.length) {
      const merged = [...new Set([...existing.sourceFeedIds, ...updates.sourceFeedIds])];
      sets.push("source_feed_ids = ?"); vals.push(JSON.stringify(merged));
    }

    // Append evolution log entry
    if (updates.evolutionEvent) {
      const newLog = [...existing.evolutionLog, {
        date: now,
        event: updates.evolutionEvent,
        detail: updates.evolutionDetail ?? "",
      }];
      sets.push("evolution_log = ?"); vals.push(JSON.stringify(newLog));
    }

    vals.push(id);
    this.db.prepare(`UPDATE research_radar SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM research_radar WHERE id = ?").run(id).changes > 0;
  }

  // ── Analysis helpers ───────────────────────────────────────────────

  /** Get all active ideas (not archived/done) for LLM context */
  getActiveIdeas(track?: IdeaTrack): ResearchRadarItem[] {
    return this.list({
      status: ["idea", "developing", "ready", "in_progress"],
      track,
      sortBy: "composite",
    });
  }

  /** Check if we already have a similar idea (title fuzzy match) */
  hasSimilarIdea(title: string, track?: IdeaTrack): ResearchRadarItem | null {
    const keywords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const active = this.getActiveIdeas(track);

    for (const item of active) {
      const itemWords = item.title.toLowerCase().split(/\s+/);
      const overlap = keywords.filter(k => itemWords.some(w => w.includes(k) || k.includes(w)));
      if (overlap.length >= 2) return item;
    }
    return null;
  }

  /** Mark an idea as analyzed (update timestamp) */
  markAnalyzed(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE research_radar SET last_analyzed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  }

  /** Get stats */
  getStats(): {
    total: number;
    byStatus: Record<string, number>;
    byTrack: Record<string, number>;
    avgNovelty: number | null;
    avgFeasibility: number | null;
    avgImpact: number | null;
    topAreas: Array<{ area: string; count: number }>;
  } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM research_radar").get() as { c: number }).c;

    const statusRows = this.db.prepare(
      "SELECT status, COUNT(*) as c FROM research_radar GROUP BY status",
    ).all() as Array<{ status: string; c: number }>;
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.c;

    const trackRows = this.db.prepare(
      "SELECT track, COUNT(*) as c FROM research_radar GROUP BY track",
    ).all() as Array<{ track: string; c: number }>;
    const byTrack: Record<string, number> = {};
    for (const r of trackRows) byTrack[r.track] = r.c;

    const avgRow = this.db.prepare(
      `SELECT AVG(novelty_score) as n, AVG(feasibility_score) as f, AVG(impact_score) as i
       FROM research_radar WHERE status NOT IN ('archived', 'done')`,
    ).get() as { n: number | null; f: number | null; i: number | null };

    const areaRows = this.db.prepare(
      "SELECT research_area, COUNT(*) as c FROM research_radar GROUP BY research_area ORDER BY c DESC LIMIT 10",
    ).all() as Array<{ research_area: string; c: number }>;

    return {
      total,
      byStatus,
      byTrack,
      avgNovelty: avgRow.n,
      avgFeasibility: avgRow.f,
      avgImpact: avgRow.i,
      topAreas: areaRows.map(r => ({ area: r.research_area, count: r.c })),
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let singleton: ResearchRadarService | null = null;

export function initResearchRadarService(db: Database.Database): ResearchRadarService {
  if (!singleton) {
    singleton = new ResearchRadarService(db);
  }
  return singleton;
}

export function getResearchRadarService(): ResearchRadarService {
  if (!singleton) throw new Error("ResearchRadarService not initialized");
  return singleton;
}
