/**
 * Intel Sweep API — manage feeds, view sources, insights
 *
 * Routes:
 *   GET  /api/intel/feeds          — list all feeds
 *   POST /api/intel/feeds          — create a feed
 *   PUT  /api/intel/feeds/:id      — update a feed
 *   DEL  /api/intel/feeds/:id      — delete a feed
 *   GET  /api/intel/sources        — list sources (with filters)
 *   GET  /api/intel/insights       — list insights
 *   GET  /api/intel/stats          — overview stats
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

  // Ensure tables exist (idempotent)
  ensureTables(db);

  // /api/intel/feeds
  if (sub === "feeds") {
    const feedId = parts[2];

    if (!feedId && method === "GET") {
      const rows = db.prepare("SELECT * FROM intel_feeds ORDER BY created_at DESC").all();
      return json(res, { feeds: rows });
    }

    if (!feedId && method === "POST") {
      const body = (await parseBody(req)) as Row;
      const id = randomUUID();
      db.prepare(
        `INSERT INTO intel_feeds (id, name, topic, feed_type, search_query, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(
        id,
        String(body.name ?? ""),
        String(body.topic ?? ""),
        String(body.feed_type ?? "web_search"),
        String(body.search_query ?? ""),
        body.enabled === false ? 0 : 1,
      );
      const created = db.prepare("SELECT * FROM intel_feeds WHERE id = ?").get(id);
      return json(res, created, 201);
    }

    if (feedId && method === "PUT") {
      const body = (await parseBody(req)) as Row;
      const existing = db.prepare("SELECT * FROM intel_feeds WHERE id = ?").get(feedId);
      if (!existing) return error(res, "Feed not found", 404);

      const fields: string[] = [];
      const values: unknown[] = [];
      for (const key of ["name", "topic", "feed_type", "search_query", "enabled"] as const) {
        if (key in body) {
          fields.push(`${key} = ?`);
          values.push(key === "enabled" ? (body[key] ? 1 : 0) : body[key]);
        }
      }
      if (fields.length > 0) {
        fields.push("updated_at = datetime('now')");
        values.push(feedId);
        db.prepare(`UPDATE intel_feeds SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      }
      const updated = db.prepare("SELECT * FROM intel_feeds WHERE id = ?").get(feedId);
      return json(res, updated);
    }

    if (feedId && method === "DELETE") {
      const result = db.prepare("DELETE FROM intel_feeds WHERE id = ?").run(feedId);
      if (result.changes === 0) return error(res, "Feed not found", 404);
      return json(res, { deleted: true });
    }

    return error(res, "Method not allowed", 405);
  }

  // /api/intel/sources
  if (sub === "sources") {
    if (method !== "GET") return error(res, "Method not allowed", 405);
    const url = new URL(req.url ?? "/", "http://localhost");
    const feedId = url.searchParams.get("feed_id");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);

    let query = "SELECT s.*, f.name as feed_name FROM intel_sources s LEFT JOIN intel_feeds f ON s.feed_id = f.id";
    const params: unknown[] = [];

    if (feedId) {
      query += " WHERE s.feed_id = ?";
      params.push(feedId);
    }
    query += " ORDER BY s.discovered_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(query).all(...params);
    return json(res, { sources: rows });
  }

  // /api/intel/insights
  if (sub === "insights") {
    if (method !== "GET") return error(res, "Method not allowed", 405);
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
    const minScore = parseFloat(url.searchParams.get("min_score") ?? "0");

    const rows = db.prepare(
      `SELECT i.*, s.url, s.title as source_title, f.name as feed_name
       FROM intel_insights i
       JOIN intel_sources s ON i.source_id = s.id
       LEFT JOIN intel_feeds f ON s.feed_id = f.id
       WHERE i.actionability_score >= ?
       ORDER BY i.actionability_score DESC, i.created_at DESC
       LIMIT ?`,
    ).all(minScore, limit);
    return json(res, { insights: rows });
  }

  // /api/intel/stats
  if (sub === "stats") {
    if (method !== "GET") return error(res, "Method not allowed", 405);

    const feedCount = (db.prepare("SELECT COUNT(*) as c FROM intel_feeds WHERE enabled = 1").get() as Row).c;
    const sourceCount = (db.prepare("SELECT COUNT(*) as c FROM intel_sources").get() as Row).c;
    const unbriefedCount = (db.prepare("SELECT COUNT(*) as c FROM intel_sources WHERE research_queue_id IS NULL").get() as Row).c;
    const insightCount = (db.prepare("SELECT COUNT(*) as c FROM intel_insights").get() as Row).c;
    const highActionCount = (db.prepare("SELECT COUNT(*) as c FROM intel_insights WHERE actionability_score >= 0.7").get() as Row).c;

    return json(res, {
      feeds: feedCount,
      sources: sourceCount,
      unbriefed: unbriefedCount,
      insights: insightCount,
      highActionInsights: highActionCount,
    });
  }

  return error(res, "Unknown intel sub-resource", 404);
}

/** Ensure intel tables exist — called on every request (cheap no-op if already created) */
function ensureTables(db: import("better-sqlite3").Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intel_feeds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      feed_type TEXT NOT NULL DEFAULT 'web_search',
      search_query TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_sweep_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS intel_sources (
      id TEXT PRIMARY KEY,
      feed_id TEXT NOT NULL REFERENCES intel_feeds(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'web_search',
      snippet TEXT NOT NULL DEFAULT '',
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      research_queue_id TEXT,
      routed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(url)
    );
    CREATE TABLE IF NOT EXISTS intel_insights (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES intel_sources(id) ON DELETE CASCADE,
      brief_id TEXT,
      insight_text TEXT NOT NULL DEFAULT '',
      actionability_score REAL NOT NULL DEFAULT 0,
      created_inbox_item_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
