import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ResearchRadarService } from "../src/services/research-radar.js";

describe("ResearchRadarService", () => {
  it("migrates legacy tables without a track column before creating indexes", () => {
    const db = new Database(":memory:");

    db.exec(`
      CREATE TABLE research_radar (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        thesis TEXT NOT NULL,
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
    `);

    const service = new ResearchRadarService(db);
    const item = service.create({
      title: "Legacy migration coverage",
      thesis: "Schema bootstrap should not crash on old tables.",
    });

    const columns = db.prepare("PRAGMA table_info(research_radar)").all() as Array<{ name: string }>;
    const indexes = db.prepare("PRAGMA index_list(research_radar)").all() as Array<{ name: string }>;

    expect(columns.some((column) => column.name === "track")).toBe(true);
    expect(indexes.some((index) => index.name === "idx_research_radar_track")).toBe(true);
    expect(item.track).toBe("paper");

    db.close();
  });
});
