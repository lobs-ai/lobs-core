import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { browserService } from "./browser.js";
import { callApiModelJSON } from "../workers/base-worker.js";

export type ResearchSourceType = "url" | "text";
export type ResearchQueueStatus = "queued" | "processing" | "completed" | "failed";

export interface ResearchQueueItem {
  id: string;
  title: string;
  sourceType: ResearchSourceType;
  sourceUrl: string | null;
  sourceText: string | null;
  topic: string | null;
  tags: string[];
  priority: number;
  status: ResearchQueueStatus;
  projectId: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchBrief {
  id: string;
  queueItemId: string;
  title: string;
  summary: string;
  keyPoints: string[];
  followUps: string[];
  sourceType: ResearchSourceType;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceExcerpt: string;
  model: string;
  tokensUsed: number;
  createdAt: string;
}

interface SourceMaterial {
  sourceTitle: string;
  sourceText: string;
  sourceUrl: string | null;
}

interface SummaryPayload {
  summary: string;
  keyPoints: string[];
  followUps: string[];
}

export interface EnqueueResearchInput {
  title: string;
  sourceType: ResearchSourceType;
  sourceUrl?: string;
  sourceText?: string;
  topic?: string;
  tags?: string[];
  priority?: number;
  projectId?: string;
}

export interface ProcessResearchResult {
  processed: boolean;
  itemId?: string;
  briefId?: string;
  status?: ResearchQueueStatus;
  error?: string;
}

export interface ResearchQueueDeps {
  fetchSource?: (item: ResearchQueueItem) => Promise<SourceMaterial>;
  summarize?: (input: {
    item: ResearchQueueItem;
    material: SourceMaterial;
  }) => Promise<SummaryPayload & { tokensUsed: number; model: string }>;
}

const CREATE_QUEUE_TABLE = `
  CREATE TABLE IF NOT EXISTS research_queue (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT,
    source_text TEXT,
    topic TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'queued',
    project_id TEXT,
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const CREATE_QUEUE_STATUS_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_research_queue_status
  ON research_queue(status, priority DESC, created_at ASC);
`;

const CREATE_BRIEFS_TABLE = `
  CREATE TABLE IF NOT EXISTS research_briefs (
    id TEXT PRIMARY KEY,
    queue_item_id TEXT NOT NULL REFERENCES research_queue(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    key_points TEXT NOT NULL DEFAULT '[]',
    follow_ups TEXT NOT NULL DEFAULT '[]',
    source_type TEXT NOT NULL,
    source_url TEXT,
    source_title TEXT,
    source_excerpt TEXT,
    model TEXT,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const CREATE_BRIEFS_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_research_briefs_queue_item
  ON research_briefs(queue_item_id, created_at DESC);
`;

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function clampPriority(value: number | undefined): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(1000, Math.trunc(value as number)));
}

function normalizeItem(row: Record<string, unknown>): ResearchQueueItem {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    sourceType: (row.source_type === "text" ? "text" : "url"),
    sourceUrl: row.source_url ? String(row.source_url) : null,
    sourceText: row.source_text ? String(row.source_text) : null,
    topic: row.topic ? String(row.topic) : null,
    tags: parseJsonArray(row.tags),
    priority: Number(row.priority ?? 100),
    status: normalizeStatus(row.status),
    projectId: row.project_id ? String(row.project_id) : null,
    error: row.error ? String(row.error) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
  };
}

function normalizeBrief(row: Record<string, unknown>): ResearchBrief {
  return {
    id: String(row.id),
    queueItemId: String(row.queue_item_id),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    keyPoints: parseJsonArray(row.key_points),
    followUps: parseJsonArray(row.follow_ups),
    sourceType: row.source_type === "text" ? "text" : "url",
    sourceUrl: row.source_url ? String(row.source_url) : null,
    sourceTitle: row.source_title ? String(row.source_title) : null,
    sourceExcerpt: String(row.source_excerpt ?? ""),
    model: String(row.model ?? ""),
    tokensUsed: Number(row.tokens_used ?? 0),
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

function normalizeStatus(value: unknown): ResearchQueueStatus {
  return value === "processing" || value === "completed" || value === "failed" ? value : "queued";
}

async function defaultFetchSource(item: ResearchQueueItem): Promise<SourceMaterial> {
  if (item.sourceType === "text") {
    return {
      sourceTitle: item.title,
      sourceText: item.sourceText ?? "",
      sourceUrl: null,
    };
  }

  if (!item.sourceUrl) {
    throw new Error("Queued URL item is missing sourceUrl");
  }

  const fetched = await browserService.fetch(item.sourceUrl, 40_000);
  return {
    sourceTitle: fetched.title || item.title,
    sourceText: fetched.content || "",
    sourceUrl: fetched.url || item.sourceUrl,
  };
}

async function defaultSummarize(input: {
  item: ResearchQueueItem;
  material: SourceMaterial;
}): Promise<SummaryPayload & { tokensUsed: number; model: string }> {
  const { data, tokensUsed } = await callApiModelJSON<SummaryPayload>(
    `Read this research input and return strict JSON:
{
  "summary": "2-5 sentence summary focusing on what's novel, important, or actionable",
  "keyPoints": ["3-8 concise factual bullets without bullet markers"],
  "followUps": ["0-3 useful next research questions or actions"]
}

Rules:
- Focus on novel findings, concrete techniques, tools, or architectural patterns.
- If the content is not about AI, agents, ML, or software engineering, set summary to "NOT_RELEVANT" and return empty arrays.
- Do not invent details not present in the source.
- Keep keyPoints short and retrieval-friendly.
- Return JSON only.

Queue item title: ${input.item.title}
Topic: ${input.item.topic ?? "none"}
Source title: ${input.material.sourceTitle}
Source URL: ${input.material.sourceUrl ?? "n/a"}

Source text (first 8000 chars):
${input.material.sourceText.slice(0, 8000)}`,
    {
      tier: "small",  // Uses Haiku — cheap but much better than qwen3-4b
      maxTokens: 800,
      systemPrompt: "You are a research analyst for an AI agent platform. Produce compact factual summaries for downstream retrieval and task planning. If the content is irrelevant to AI/ML/agents/software, say so clearly.",
    },
  );

  return {
    summary: String(data.summary ?? "").trim(),
    keyPoints: parseJsonArray(data.keyPoints),
    followUps: parseJsonArray(data.followUps),
    tokensUsed,
    model: "haiku",
  };
}

export class ResearchQueueService {
  private readonly db: Database.Database;
  private readonly deps: Required<ResearchQueueDeps>;

  constructor(db: Database.Database, deps: ResearchQueueDeps = {}) {
    this.db = db;
    this.deps = {
      fetchSource: deps.fetchSource ?? defaultFetchSource,
      summarize: deps.summarize ?? defaultSummarize,
    };
    this.ensureTables();
  }

  ensureTables(): void {
    this.db.exec(CREATE_QUEUE_TABLE);
    this.db.exec(CREATE_QUEUE_STATUS_INDEX);
    this.db.exec(CREATE_BRIEFS_TABLE);
    this.db.exec(CREATE_BRIEFS_INDEX);
  }

  enqueue(input: EnqueueResearchInput): ResearchQueueItem {
    if (!input.title?.trim()) throw new Error("title is required");
    if (input.sourceType !== "url" && input.sourceType !== "text") {
      throw new Error("sourceType must be 'url' or 'text'");
    }
    if (input.sourceType === "url" && !input.sourceUrl?.trim()) {
      throw new Error("sourceUrl is required for url items");
    }
    if (input.sourceType === "text" && !input.sourceText?.trim()) {
      throw new Error("sourceText is required for text items");
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const tags = JSON.stringify((input.tags ?? []).map((tag) => String(tag).trim()).filter(Boolean));

    this.db.prepare(
      `INSERT INTO research_queue
        (id, title, source_type, source_url, source_text, topic, tags, priority, status, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(
      id,
      input.title.trim(),
      input.sourceType,
      input.sourceUrl?.trim() ?? null,
      input.sourceText?.trim() ?? null,
      input.topic?.trim() ?? null,
      tags,
      clampPriority(input.priority),
      input.projectId?.trim() ?? null,
      now,
      now,
    );

    return this.getQueueItem(id)!;
  }

  listQueue(options: { status?: ResearchQueueStatus; limit?: number } = {}): ResearchQueueItem[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const rows = options.status
      ? this.db.prepare(
        `SELECT * FROM research_queue
         WHERE status = ?
         ORDER BY priority DESC, created_at ASC
         LIMIT ?`,
      ).all(options.status, limit)
      : this.db.prepare(
        `SELECT * FROM research_queue
         ORDER BY
           CASE status
             WHEN 'processing' THEN 0
             WHEN 'queued' THEN 1
             WHEN 'failed' THEN 2
             ELSE 3
           END,
           priority DESC,
           created_at DESC
         LIMIT ?`,
      ).all(limit);

    return (rows as Array<Record<string, unknown>>).map(normalizeItem);
  }

  getQueueItem(id: string): ResearchQueueItem | null {
    const row = this.db.prepare("SELECT * FROM research_queue WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? normalizeItem(row) : null;
  }

  getBrief(id: string): ResearchBrief | null {
    const row = this.db.prepare("SELECT * FROM research_briefs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? normalizeBrief(row) : null;
  }

  listBriefs(limit = 50): ResearchBrief[] {
    const rows = this.db.prepare(
      `SELECT * FROM research_briefs
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return rows.map(normalizeBrief);
  }

  listBriefsForItem(queueItemId: string): ResearchBrief[] {
    const rows = this.db.prepare(
      `SELECT * FROM research_briefs
       WHERE queue_item_id = ?
       ORDER BY created_at DESC`,
    ).all(queueItemId) as Array<Record<string, unknown>>;
    return rows.map(normalizeBrief);
  }

  getStats(): {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    briefs: number;
  } {
    const queueRows = this.db.prepare(
      `SELECT status, COUNT(*) as count
       FROM research_queue
       GROUP BY status`,
    ).all() as Array<{ status: string; count: number }>;
    const counts = Object.fromEntries(queueRows.map((row) => [row.status, row.count]));
    const briefsRow = this.db.prepare("SELECT COUNT(*) as count FROM research_briefs").get() as { count: number };
    return {
      queued: Number(counts.queued ?? 0),
      processing: Number(counts.processing ?? 0),
      completed: Number(counts.completed ?? 0),
      failed: Number(counts.failed ?? 0),
      briefs: Number(briefsRow.count ?? 0),
    };
  }

  /** Reset all failed items back to queued for retry */
  resetFailed(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE research_queue
       SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL, updated_at = ?
       WHERE status = 'failed'`,
    ).run(now);
    return result.changes;
  }

  async processNext(): Promise<ProcessResearchResult> {
    const claimed = this.claimNextQueuedItem();
    if (!claimed) return { processed: false };
    return this.processClaimedItem(claimed);
  }

  async processItem(id: string): Promise<ProcessResearchResult> {
    const row = this.db.prepare("SELECT * FROM research_queue WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return { processed: false, itemId: id, error: "Queue item not found" };
    }

    const item = normalizeItem(row);
    if (item.status === "processing") {
      return { processed: false, itemId: id, status: "processing", error: "Queue item is already processing" };
    }

    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE research_queue
       SET status = 'processing', error = NULL, started_at = ?, finished_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, now, id);

    return this.processClaimedItem(this.getQueueItem(id)!);
  }

  private claimNextQueuedItem(): ResearchQueueItem | null {
    const row = this.db.prepare(
      `SELECT * FROM research_queue
       WHERE status = 'queued'
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;

    const item = normalizeItem(row);
    const now = new Date().toISOString();
    const updated = this.db.prepare(
      `UPDATE research_queue
       SET status = 'processing', error = NULL, started_at = ?, finished_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
    ).run(now, now, item.id);

    if (updated.changes === 0) return null;
    return this.getQueueItem(item.id);
  }

  private async processClaimedItem(item: ResearchQueueItem): Promise<ProcessResearchResult> {
    try {
      const material = await this.deps.fetchSource(item);
      if (!material.sourceText.trim()) {
        throw new Error("Source content was empty");
      }

      const summary = await this.deps.summarize({ item, material });
      const briefId = randomUUID();
      const now = new Date().toISOString();
      const excerpt = material.sourceText.slice(0, 2000);

      this.db.prepare(
        `INSERT INTO research_briefs
          (id, queue_item_id, title, summary, key_points, follow_ups, source_type, source_url, source_title, source_excerpt, model, tokens_used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        briefId,
        item.id,
        item.title,
        summary.summary.trim(),
        JSON.stringify(summary.keyPoints),
        JSON.stringify(summary.followUps),
        item.sourceType,
        material.sourceUrl ?? item.sourceUrl,
        material.sourceTitle,
        excerpt,
        summary.model,
        summary.tokensUsed,
        now,
      );

      this.db.prepare(
        `UPDATE research_queue
         SET status = 'completed', error = NULL, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(now, now, item.id);

      return { processed: true, itemId: item.id, briefId, status: "completed" };
    } catch (err) {
      const now = new Date().toISOString();
      const message = err instanceof Error ? err.message : String(err);
      this.db.prepare(
        `UPDATE research_queue
         SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(message, now, now, item.id);

      return { processed: true, itemId: item.id, status: "failed", error: message };
    }
  }
}

let singleton: ResearchQueueService | null = null;

export function initResearchQueueService(db: Database.Database, deps?: ResearchQueueDeps): ResearchQueueService {
  if (!singleton) {
    singleton = new ResearchQueueService(db, deps);
  }
  return singleton;
}

export function getResearchQueueService(): ResearchQueueService | null {
  return singleton;
}

