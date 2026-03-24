/**
 * Intel Sweep API — manage feeds, view sources, insights, stats
 *
 * Routes:
 *   GET    /api/intel/feeds          — list all feeds
 *   POST   /api/intel/feeds          — create a feed
 *   PUT    /api/intel/feeds/:id      — update a feed
 *   DELETE /api/intel/feeds/:id      — delete a feed
 *   GET    /api/intel/sources        — list sources (?feed_id=&status=&limit=)
 *   GET    /api/intel/insights       — list insights (?feed_id=&min_score=&limit=)
 *   GET    /api/intel/stats          — overview stats
 *   POST   /api/intel/sweep          — trigger a sweep now
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getRawDb } from "../db/connection.js";
import { json, error, parseBody } from "./index.js";
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;

export async function handleIntelRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getRawDb();
  const method = req.method ?? "GET";

  // ── /api/intel/feeds ──────────────────────────────────────────────

  if (sub === "feeds") {
    const feedId = parts[2];

    // GET /api/intel/feeds — list all
    if (!feedId && method === "GET") {
      const rows = db.prepare("SELECT * FROM intel_feeds ORDER BY created_at DESC").all() as Row[];
      const feeds = rows.map(normalizeFeedRow);
      return json(res, { feeds });
    }

    // POST /api/intel/feeds — create
    if (!feedId && method === "POST") {
      const body = (await parseBody(req)) as Row;
      const id = randomUUID();
      db.prepare(
        `INSERT INTO intel_feeds (id, name, description, enabled, search_queries, source_urls, youtube_channels, tags, project_id, schedule, max_items_per_sweep, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(
        id,
        String(body.name ?? "New Feed"),
        body.description ? String(body.description) : null,
        body.enabled === false ? 0 : 1,
        JSON.stringify(toArray(body.searchQueries ?? body.search_queries)),
        JSON.stringify(toArray(body.sourceUrls ?? body.source_urls)),
        JSON.stringify(toArray(body.youtubeChannels ?? body.youtube_channels)),
        JSON.stringify(toArray(body.tags)),
        body.projectId ? String(body.projectId) : null,
        String(body.schedule ?? "0 6 * * *"),
        Number(body.maxItemsPerSweep ?? body.max_items_per_sweep ?? 10),
      );
      const created = db.prepare("SELECT * FROM intel_feeds WHERE id = ?").get(id) as Row;
      return json(res, normalizeFeedRow(created), 201);
    }

    // GET /api/intel/feeds/:id — single feed details
    if (feedId && method === "GET") {
      const row = db.prepare("SELECT * FROM intel_feeds WHERE id = ?").get(feedId) as Row | undefined;
      if (!row) return error(res, "Feed not found", 404);
      return json(res, normalizeFeedRow(row));
    }

    // PUT /api/intel/feeds/:id — update
    if (feedId && method === "PUT") {
      const existing = db.prepare("SELECT * FROM intel_feeds WHERE id = ?").get(feedId) as Row | undefined;
      if (!existing) return error(res, "Feed not found", 404);

      const body = (await parseBody(req)) as Row;
      const sets: string[] = [];
      const vals: unknown[] = [];

      const stringFields = ["name", "description", "schedule", "project_id"] as const;
      for (const f of stringFields) {
        const camel = f.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        if (camel in body || f in body) {
          sets.push(`${f} = ?`);
          vals.push(body[camel] ?? body[f]);
        }
      }
      const arrayFields = ["search_queries", "source_urls", "youtube_channels", "tags"] as const;
      for (const f of arrayFields) {
        const camel = f.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        if (camel in body || f in body) {
          sets.push(`${f} = ?`);
          vals.push(JSON.stringify(toArray(body[camel] ?? body[f])));
        }
      }
      if ("enabled" in body) { sets.push("enabled = ?"); vals.push(body.enabled ? 1 : 0); }
      if ("maxItemsPerSweep" in body || "max_items_per_sweep" in body) {
        sets.push("max_items_per_sweep = ?");
        vals.push(Number(body.maxItemsPerSweep ?? body.max_items_per_sweep));
      }

      if (sets.length > 0) {
        sets.push("updated_at = datetime('now')");
        vals.push(feedId);
        db.prepare(`UPDATE intel_feeds SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      }

      const updated = db.prepare("SELECT * FROM intel_feeds WHERE id = ?").get(feedId) as Row;
      return json(res, normalizeFeedRow(updated));
    }

    // DELETE /api/intel/feeds/:id
    if (feedId && method === "DELETE") {
      const result = db.prepare("DELETE FROM intel_feeds WHERE id = ?").run(feedId);
      if (result.changes === 0) return error(res, "Feed not found", 404);
      return json(res, { deleted: true });
    }

    return error(res, "Method not allowed", 405);
  }

  // ── /api/intel/sources ────────────────────────────────────────────

  if (sub === "sources") {
    if (method !== "GET") return error(res, "Method not allowed", 405);
    const url = new URL(req.url ?? "/", "http://localhost");
    const feedId = url.searchParams.get("feed_id");
    const status = url.searchParams.get("status");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    let query = `SELECT s.*, f.name as feed_name FROM intel_sources s 
                 LEFT JOIN intel_feeds f ON s.feed_id = f.id WHERE 1=1`;
    const params: unknown[] = [];

    if (feedId) { query += " AND s.feed_id = ?"; params.push(feedId); }
    if (status) { query += " AND s.status = ?"; params.push(status); }

    // Get total count
    const countQuery = query.replace("SELECT s.*, f.name as feed_name", "SELECT COUNT(*) as total");
    const total = (db.prepare(countQuery).get(...params) as Row).total;

    query += " ORDER BY s.discovered_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as Row[];
    return json(res, { sources: rows, total, limit, offset });
  }

  // ── /api/intel/insights ───────────────────────────────────────────

  if (sub === "insights") {
    if (method !== "GET") return error(res, "Method not allowed", 405);
    const url = new URL(req.url ?? "/", "http://localhost");
    const feedId = url.searchParams.get("feed_id");
    const minScore = parseFloat(url.searchParams.get("min_score") ?? "0");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);

    let query = `SELECT i.*, s.url as source_url, s.title as source_title, f.name as feed_name
                 FROM intel_insights i
                 LEFT JOIN intel_sources s ON i.source_id = s.id
                 LEFT JOIN intel_feeds f ON i.feed_id = f.id
                 WHERE i.relevance_score >= ?`;
    const params: unknown[] = [minScore];

    if (feedId) { query += " AND i.feed_id = ?"; params.push(feedId); }
    query += " ORDER BY i.relevance_score DESC, i.created_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(query).all(...params) as Row[];
    return json(res, { insights: rows });
  }

  // ── /api/intel/stats ──────────────────────────────────────────────

  if (sub === "stats") {
    if (method !== "GET") return error(res, "Method not allowed", 405);

    const feedCount = (db.prepare("SELECT COUNT(*) as c FROM intel_feeds WHERE enabled = 1").get() as Row).c;
    const totalSources = (db.prepare("SELECT COUNT(*) as c FROM intel_sources").get() as Row).c;

    const statusCounts = db.prepare(
      "SELECT status, COUNT(*) as c FROM intel_sources GROUP BY status",
    ).all() as Row[];
    const byStatus: Record<string, number> = {};
    for (const r of statusCounts) byStatus[String(r.status)] = Number(r.c);

    const insightCount = (db.prepare("SELECT COUNT(*) as c FROM intel_insights").get() as Row).c;
    const actionableCount = (db.prepare(
      "SELECT COUNT(*) as c FROM intel_insights WHERE actionability IN ('investigate', 'implement', 'urgent')",
    ).get() as Row).c;
    const avgRelevance = (db.prepare("SELECT AVG(relevance_score) as avg FROM intel_insights").get() as Row).avg;

    // Per-feed stats
    const feedStats = db.prepare(`
      SELECT f.id, f.name, 
             COUNT(DISTINCT s.id) as source_count,
             COUNT(DISTINCT i.id) as insight_count,
             f.last_sweep_at
      FROM intel_feeds f
      LEFT JOIN intel_sources s ON s.feed_id = f.id
      LEFT JOIN intel_insights i ON i.feed_id = f.id
      WHERE f.enabled = 1
      GROUP BY f.id
    `).all() as Row[];

    return json(res, {
      feeds: feedCount,
      sources: {
        total: totalSources,
        byStatus,
      },
      insights: {
        total: insightCount,
        actionable: actionableCount,
        avgRelevance: avgRelevance ? Number(avgRelevance).toFixed(2) : null,
      },
      feedStats,
    });
  }

  // ── /api/intel/sweep — trigger manual sweep ───────────────────────

  if (sub === "sweep") {
    if (method !== "POST") return error(res, "Method not allowed", 405);
    // TODO: trigger the intel-sweep worker manually
    return json(res, { message: "Manual sweep trigger not yet wired — use cron or run the worker directly" });
  }

  return error(res, "Unknown intel sub-resource", 404);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* not json */ }
    return [value];
  }
  return [];
}

function normalizeFeedRow(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    searchQueries: safeParseArray(row.search_queries),
    sourceUrls: safeParseArray(row.source_urls),
    youtubeChannels: safeParseArray(row.youtube_channels),
    tags: safeParseArray(row.tags),
    projectId: row.project_id,
    schedule: row.schedule,
    maxItemsPerSweep: row.max_items_per_sweep,
    lastSweepAt: row.last_sweep_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
