/**
 * HTTP server for lobs-core
 *
 * Serves:
 * - Nexus dashboard (static files from nexus/dist/ via sirv)
 * - /api/* routes to lobs-core API handlers
 * - SPA fallback (all non-file routes → index.html)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import sirv from "sirv";
import { log } from "./util/logger.js";
import { handleApiRequest } from "./api/router.js";

const HOME = process.env.HOME ?? "";

// Nexus dist directory — check submodule first, fall back to standalone repo
const NEXUS_DIST = existsSync(resolve(HOME, "lobs/lobs-core/nexus/dist/index.html"))
  ? resolve(HOME, "lobs/lobs-core/nexus/dist")
  : resolve(HOME, "lobs/lobs-nexus/dist");

/**
 * Start the HTTP server.
 */
export function startServer(port: number): void {
  // sirv handles static files + SPA fallback
  const serve = sirv(NEXUS_DIST, {
    single: true,      // SPA mode: serve index.html for non-file routes
    dev: false,         // Production mode: caching headers
    etag: true,
  });

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes: /api/* and /paw/api/*
    if (url.startsWith("/api/") || url.startsWith("/paw/api/")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      try {
        await handleApiRequest(req, res);
      } catch (err) {
        log().error(`API error: ${err}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    // Health check
    if (url === "/healthz" || url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    // Everything else: sirv handles static files + SPA fallback
    serve(req, res);
  });

  server.listen(port, "0.0.0.0", () => {
    log().info(`HTTP server listening on port ${port}`);
    log().info(`Nexus dashboard: http://localhost:${port}`);
    log().info(`Nexus dist: ${NEXUS_DIST}`);
  });
}
