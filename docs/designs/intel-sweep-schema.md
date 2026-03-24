# Design: Intelligence Sweep — Database Schema

**Date:** 2026-03-24
**Status:** Proposed
**Author:** architect agent

## Problem Statement

We need a system that discovers new content across the web daily on configurable topics, feeds it through the existing `research_queue` → `research_briefs` pipeline, and routes processed insights into actionable items (inbox, tasks, features, project proposals). No such tables exist today.

## Proposed Solution

Three new tables forming a pipeline:

```
intel_feeds ──1:N──▸ intel_sources ──1:N──▸ intel_insights
     │                     │                       │
     │              (enqueues into)          (routes into)
     │                     │                       │
     ▼                     ▼                       ▼
 projects          research_queue             inbox_items
                   research_briefs              tasks
                                              projects
```

**`intel_feeds`** — What to watch. Configurable topic feeds with search queries, blog URLs, YouTube channels. Owns the schedule and routing defaults.

**`intel_sources`** — What was found. Every discovered URL/content piece, deduplicated by URL and content hash. Links forward to `research_queue` and `research_briefs` once processed.

**`intel_insights`** — What it means. Extracted actionable insights from processed briefs. Scored by relevance and actionability. Links to whatever item was created when routed.

## Integration with Existing Tables

The intel sweep system connects to existing infrastructure at two points:

1. **Input**: `intel_sources.research_queue_id` → `research_queue.id` — when a source is enqueued for processing
2. **Output**: `intel_sources.research_brief_id` → `research_briefs.id` — when the research brief is generated
3. **Routing**: `intel_feeds.project_id` → `projects.id` — optional default project for routing
4. **Routing**: `intel_insights.routed_id` → `inbox_items.id` | `tasks.id` — the created item (polymorphic, not FK-enforced)

## Key Queries & Index Strategy

| Query | Frequency | Covered by |
|---|---|---|
| Get all unprocessed sources for a feed | Every sweep cycle | `idx_intel_sources_feed_status` |
| Has this URL been seen before? (dedup) | Every discovered URL | `idx_intel_sources_url` (unique) |
| Get high-relevance unrouted insights | Routing pass | `idx_intel_insights_unrouted` |
| Feed sweep stats (counts by status) | Dashboard/reporting | `idx_intel_sources_feed_status` |
| Sources by content hash (cross-URL dedup) | Dedup pass | `idx_intel_sources_content_hash` |
| Active feeds due for sweep | Scheduler | `idx_intel_feeds_enabled_schedule` |
| Sources linked to research items | Pipeline tracking | `idx_intel_sources_research_queue_id` |

## SQL Schema

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Intelligence Sweep Tables
-- Added: 2026-03-24
-- ═══════════════════════════════════════════════════════════════════════════

-- ── intel_feeds: configurable topic feeds ──────────────────────────────────
-- Each feed defines WHAT to search for and WHERE to look.
-- The sweep routine iterates enabled feeds on schedule, discovers content,
-- and enqueues it into intel_sources → research_queue.
CREATE TABLE IF NOT EXISTS intel_feeds (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    description           TEXT,
    enabled               INTEGER NOT NULL DEFAULT 1,
    -- JSON array of search query strings to run (e.g. ["agentic engineering 2026", "AI agent orchestration"])
    search_queries        TEXT NOT NULL DEFAULT '[]',
    -- JSON array of specific URLs/blogs to check for new content
    source_urls           TEXT NOT NULL DEFAULT '[]',
    -- JSON array of YouTube channel IDs to check for new uploads
    youtube_channels      TEXT NOT NULL DEFAULT '[]',
    -- JSON array of tags to apply to research_queue items created from this feed
    tags                  TEXT NOT NULL DEFAULT '[]',
    -- Optional: link to a specific project for routing discovered content
    project_id            TEXT REFERENCES projects(id),
    -- Cron expression controlling sweep frequency (default: daily at 6 AM ET)
    schedule              TEXT NOT NULL DEFAULT '0 6 * * *',
    -- Max items to enqueue per sweep cycle (prevents flooding the research queue)
    max_items_per_sweep   INTEGER NOT NULL DEFAULT 10,
    -- Timestamp of last completed sweep
    last_sweep_at         TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Find feeds that are enabled and due for a sweep
CREATE INDEX IF NOT EXISTS idx_intel_feeds_enabled_schedule
    ON intel_feeds(enabled, last_sweep_at);

-- ── intel_sources: discovered content (dedup + pipeline tracking) ──────────
-- Every piece of content discovered by a sweep. Tracks the full lifecycle:
--   discovered → queued → processed → routed (or skipped)
-- Dedup by URL (unique) and content_hash (index for cross-URL dedup).
CREATE TABLE IF NOT EXISTS intel_sources (
    id                    TEXT PRIMARY KEY,
    feed_id               TEXT NOT NULL REFERENCES intel_feeds(id),
    -- The canonical URL of the discovered content
    url                   TEXT NOT NULL,
    title                 TEXT,
    -- web_search | blog | youtube | rss
    source_type           TEXT NOT NULL DEFAULT 'web_search',
    -- SHA-256 of normalized content body (for cross-URL dedup of same article)
    content_hash          TEXT,
    -- Forward link: research_queue item created when this source was enqueued
    research_queue_id     TEXT,
    -- Forward link: research_brief created when the research agent processed it
    research_brief_id     TEXT,
    -- Pipeline status: discovered → queued → processed → routed | skipped
    status                TEXT NOT NULL DEFAULT 'discovered',
    -- Where the insight was routed after processing
    -- inbox | task | feature | project_proposal | skipped
    routed_to             TEXT,
    -- ID of the created item (inbox_items.id, tasks.id, etc.) — polymorphic
    routed_id             TEXT,
    discovered_at         TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at          TEXT
);

-- Primary query: "get all unprocessed sources for feed X"
-- Also powers sweep stats: SELECT status, COUNT(*) FROM intel_sources WHERE feed_id = ? GROUP BY status
CREATE INDEX IF NOT EXISTS idx_intel_sources_feed_status
    ON intel_sources(feed_id, status);

-- Dedup: "has this URL been seen before?" — must be fast, runs on every discovered URL
CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_sources_url
    ON intel_sources(url);

-- Cross-URL dedup: same content republished at different URLs
CREATE INDEX IF NOT EXISTS idx_intel_sources_content_hash
    ON intel_sources(content_hash)
    WHERE content_hash IS NOT NULL;

-- Pipeline tracking: find source by research_queue linkage
CREATE INDEX IF NOT EXISTS idx_intel_sources_research_queue_id
    ON intel_sources(research_queue_id)
    WHERE research_queue_id IS NOT NULL;

-- ── intel_insights: extracted actionable insights ──────────────────────────
-- Each processed source may yield 0-N insights. These are scored and routed.
-- The routing engine reads unrouted insights, creates inbox/task/feature items,
-- and back-links via routed_to + routed_id.
CREATE TABLE IF NOT EXISTS intel_insights (
    id                    TEXT PRIMARY KEY,
    source_id             TEXT REFERENCES intel_sources(id),
    feed_id               TEXT REFERENCES intel_feeds(id),
    title                 TEXT NOT NULL,
    -- The actual insight/learning extracted from the research brief
    insight               TEXT NOT NULL,
    -- Classification of the insight type
    -- self_improvement | new_tool | architecture_pattern | technique |
    -- project_idea | security | performance
    category              TEXT,
    -- 0.0–1.0: how relevant is this to our current work/projects
    relevance_score       REAL,
    -- informational | actionable | urgent
    actionability         TEXT NOT NULL DEFAULT 'informational',
    -- Where this insight was routed (inbox | task | feature | project_proposal)
    routed_to             TEXT,
    -- ID of the created item — polymorphic (inbox_items.id, tasks.id, etc.)
    routed_id             TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Primary query: "get high-relevance unrouted insights" for the routing pass
-- Orders by relevance_score DESC naturally via the B-tree
CREATE INDEX IF NOT EXISTS idx_intel_insights_unrouted
    ON intel_insights(routed_to, relevance_score DESC)
    WHERE routed_to IS NULL;

-- Look up all insights from a specific source
CREATE INDEX IF NOT EXISTS idx_intel_insights_source
    ON intel_insights(source_id);

-- Look up all insights from a specific feed (for feed-level reporting)
CREATE INDEX IF NOT EXISTS idx_intel_insights_feed
    ON intel_insights(feed_id);

-- Filter insights by category (dashboard: "show me all new_tool insights")
CREATE INDEX IF NOT EXISTS idx_intel_insights_category
    ON intel_insights(category)
    WHERE category IS NOT NULL;
```

## Drizzle ORM Definitions

For `src/db/schema.ts` — follows existing project conventions:

```typescript
// ─── Intelligence Sweep ─────────────────────────────────────────────────

export const intelFeeds = sqliteTable("intel_feeds", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  searchQueries: text("search_queries", { mode: "json" }).notNull().default([]),
  sourceUrls: text("source_urls", { mode: "json" }).notNull().default([]),
  youtubeChannels: text("youtube_channels", { mode: "json" }).notNull().default([]),
  tags: text("tags", { mode: "json" }).notNull().default([]),
  projectId: text("project_id").references(() => projects.id),
  schedule: text("schedule").notNull().default("0 6 * * *"),
  maxItemsPerSweep: integer("max_items_per_sweep").notNull().default(10),
  lastSweepAt: text("last_sweep_at"),
  ...timestamps,
});

export const intelSources = sqliteTable("intel_sources", {
  id: id(),
  feedId: text("feed_id").notNull().references(() => intelFeeds.id),
  url: text("url").notNull(),
  title: text("title"),
  sourceType: text("source_type").notNull().default("web_search"),
  contentHash: text("content_hash"),
  researchQueueId: text("research_queue_id"),
  researchBriefId: text("research_brief_id"),
  status: text("status").notNull().default("discovered"),
  routedTo: text("routed_to"),
  routedId: text("routed_id"),
  discoveredAt: text("discovered_at").notNull().default(sql`(datetime('now'))`),
  processedAt: text("processed_at"),
}, (t) => ({
  idxFeedStatus: index("idx_intel_sources_feed_status").on(t.feedId, t.status),
  uniqUrl: uniqueIndex("idx_intel_sources_url").on(t.url),
}));

export const intelInsights = sqliteTable("intel_insights", {
  id: id(),
  sourceId: text("source_id").references(() => intelSources.id),
  feedId: text("feed_id").references(() => intelFeeds.id),
  title: text("title").notNull(),
  insight: text("insight").notNull(),
  category: text("category"),
  relevanceScore: real("relevance_score"),
  actionability: text("actionability").notNull().default("informational"),
  routedTo: text("routed_to"),
  routedId: text("routed_id"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});
```

## Trade-offs

### URL uniqueness is global, not per-feed
The `UNIQUE` constraint on `intel_sources.url` means the same URL can only appear once across all feeds. This is intentional — if two feeds discover the same article, we want to process it once and link insights back to both feeds via the `feed_id` on `intel_insights`. However, this means the first feed to discover a URL "owns" the `intel_sources` row. If this becomes a problem, we can add a junction table `intel_feed_sources(feed_id, source_id)` later.

### Polymorphic `routed_id` instead of typed foreign keys
Both `intel_sources.routed_id` and `intel_insights.routed_id` are free-text IDs pointing to different tables depending on `routed_to`. This avoids four nullable FK columns per row but loses referential integrity enforcement. This matches the existing pattern in lobs-core (e.g., `inbox_items.source_reflection_id` is not FK-enforced).

### No `research_queue` / `research_briefs` foreign keys
`intel_sources.research_queue_id` and `research_brief_id` are plain TEXT, not `REFERENCES research_queue(id)`. This is because research_queue/research_briefs are created via raw SQL in `migrate.ts` without Drizzle schema definitions, so FK enforcement isn't available at the Drizzle level anyway. The application layer maintains these links.

### JSON arrays in TEXT columns (search_queries, source_urls, etc.)
Following the existing convention (e.g., `tasks.blocked_by`, `tasks.context_refs`, `agent_initiatives.overlap_with_ids`). These are configuration data read as a whole, never queried with SQL WHERE clauses on individual array elements. If we later need per-query or per-URL tracking, we'd extract to a `intel_feed_queries` table.

### Partial indexes for NULL-heavy columns
`idx_intel_sources_content_hash` and `idx_intel_insights_unrouted` use `WHERE` clauses to avoid indexing NULL rows. This keeps the index small since most sources won't have content hashes initially, and routed insights don't need to be in the unrouted index.

## Open Questions

1. **Feed ownership across URLs**: Should we add a junction table now or wait to see if cross-feed URL conflicts actually occur?
2. **Content expiry**: Should `intel_sources` rows expire after N days? Old discovered-but-never-queued sources could accumulate. A `ttl_days` column on `intel_feeds` could drive cleanup.
3. **Rate limiting**: `max_items_per_sweep` caps per-feed, but should there be a global cap across all feeds to prevent overwhelming the research queue?
4. **YouTube transcript handling**: YouTube sources will likely need transcript extraction before research processing. Should `intel_sources` have a `raw_content` TEXT column, or should that be handled entirely in the research queue pipeline?
