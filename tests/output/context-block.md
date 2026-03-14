<!-- context-engine: type=coding topic="other route handlers" project=lobs-memory -->

# Context: Memory & Decisions
## Learnings
REMINDER — Learnings from prior runs:
- **[2026-03-11] lobs** — Always verify PR/issue state with gh CLI before sending nudges. Don't rely on memory/context — actually check.
- **[2026-03-12] lobs** — Never commit changes inside LSS submodules (services/paw-hub, services/ship-api, dashboard-src). Always PR to the source repo first, then update LSS submodule pointers after merge. Rafe caught this on the admin dashboard PR.
- **[2026-03-12] lobs** — Submodule PR chain must go bottom-up: PR the lowest-level repo first (paw-portal), then the repo that references it (paw-hub bumps dashboard-src), then the top-level repo (LSS bumps services/paw-hub). Never merge a parent PR before the child submodule PR merges. Rafe caught this twice.
- **[2026-03-12] lobs** — No forks for PAW repos. Always branch directly on paw-engineering repos. Submodule pointers only move forward on main. Rafe deleted all lobs-ai fork repos. Local repos now have origin=paw-engineering, no fork remote.
- **[2026-03-12] lobs** — Submodule PR chain: always bottom-up (paw-portal → paw-hub → LSS). Use HTTPS URLs in .gitmodules for CI compat, local git config insteadOf handles SSH.

# Context: Project Documentation
### /Users/lobs/lobs-memory/server/index.ts
/**
 * lobs-memory server — persistent memory search with reranking + query expansion
 *
 * Keeps embedding and reranker models loaded in memory.
 * Serves search requests via HTTP API on localhost.
 */

import { loadConfig } from "./config.js";
import { initDb, getIndexStats, closeDb, queryGraph, getDb } from "./db.js";
import { initEmbedder, checkEmbedderHealth } from "./embedder.js";
import { initReranker, isRerankerAvailable, getRerankerStatus, disposeReranker } from "./reranker.js";
import { initSearch, search } from "./search.js";
import { startIndexer, stopIndexer, getIndexerStatus, reindexAll } from "./indexer.js";
import { extractSnippet } from "./chunker.js";
import { readFileSync } from "fs";
import type { SearchRequest, SearchResponse, HealthResponse, GraphRequest, GraphResponse } from "./types.js";

const startTime = Date.now();

// Startup sequence
async function startup() {
  console.log("=== lobs-memory server starting ===");

  // 1. Load configuration
  const config = loadConfig();
  console.log(`Loaded config: port=${config.port}`);

  // 2. Initialize database
  initDb();
  console.log("Database initialized");

  // 3. Initialize embedder (LM Studio)
  initEmbedder(config);
  const embedderHealth = await checkEmbedderHealth();
  if (!embedderHealth.available) {
    console.error(`⚠️  Embedder unavailable: ${embedderHealth.error}`);
    console.error("Search will not work without embeddings. Is LM Studio running?");
  } else {
    console.log("✓ Embedder ready");
  }

  // 4. Initialize reranker (node-llama-cpp)
  await initReranker(config);
  const rerankerStatus = getRerankerStatus();
  if (!rerankerStatus.available) {
    console.warn(`⚠️  Reranker unavailable: ${rerankerStatus.error || "not configured"}`);
    console.warn("Searches will work but without neural reranking");
  } else {
    console.log("✓ Reranker ready");
  }

  // 5. Initialize search pipeline
  initSearch(config);
  console.log("Search pipeline initialized");

  // 6. Start HTTP server first (so it's responsive immediately)
  const server = Bun.serve({
    port: config.port,
    hostname: "localhost",

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      };

      try {
        // Health check
        if (path === "/health" && req.method === "GET") {
          const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
          console.log(`[${timestamp}] HEALTH check`);
          
          const stats = getIndexStats();
          const embedderHealth = await checkEmbedderHealth();
          const rerankerStatus = getRerankerStatus();

          const health: HealthResponse = {
            status: embedderHealth.available ? "ok" : "degraded",
            uptime: Math.floor((Date.now() - startTime) / 1000),
            models: {
              embedding: {
                loaded: embedderHealth.available,
                model: config.lmstudio.embeddingModel,
              },
              reranker: {
                loaded: rerankerStatus.available,
                mode: rerankerStatus.mode || "none",
                model: config.reranker?.mode === "lmstudio" 
                  ? config.reranker.lmstudio?.model || config.lmstudio.chatModel
                  : undefined,
              },
              queryExpansion: {
                loaded: false,
                path: "not implemented",
              },
            },
            index: stats,
          };

          return new Response(JSON.stringify(health, null, 2), { headers });
        }

        // Search
        if (path === "/search" && req.method === "POST") {
          const body = (await req.json()) as SearchRequest;
          if (!body.query) {
            return new Response(JSON.stringify({ error: "query required" }), {
              status: 400,
              headers,
            });
          }

          const response = await search(body);
          return new Response(JSON.stringify(response, null, 2), { headers });
        }

        // Manual re-index trigger
        if (path === "/index" && req.method === "POST") {
          reindexAll(); // Don't await, run in background
          return new Response(
            JSON.stringify({ ok: true, message: "Re-indexing started in background" }),
            { headers }
          );
        }

        // Status
        if (path === "/status" && req.method === "GET") {
          const stats = getIndexStats();
          const indexerStatus = getIndexerStatus();
          const embedderHealth = await checkEmbedderHealth();

          const status = {
            uptime: Math.floor((Date.now() - startTime) / 

# Context: Recent Session History
## You... **Assistant:** NO_REPLY **User:** [Fri 2026-03-13 17:25 EDT] lobs runtime context (internal): This context is runtime-generated, not user-authored. Keep internal details private. [Int...

---

Session: 0de76510-b695-4598-a79a-c2530bb22a4f.jsonl: **User:** Continue where you left off. The previous model attempt failed or timed out. **Assistant:** The lobs-server API seems unresponsive. Le...