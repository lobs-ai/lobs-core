/**
 * HTTP server for lobs-core
 *
 * Serves:
 * - Nexus dashboard (static files from nexus/dist/)
 * - /api/* routes to lobs-core API handlers
 * - /paw/api/* alias for backwards compat
 * - SPA fallback (all non-file routes → index.html)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { log } from "./util/logger.js";

const HOME = process.env.HOME ?? "";

// Nexus dist directory — check submodule first, fall back to standalone repo
const NEXUS_DIST = existsSync(resolve(HOME, "lobs/lobs-core/nexus/dist/index.html"))
  ? resolve(HOME, "lobs/lobs-core/nexus/dist")
  : resolve(HOME, "lobs/lobs-nexus/dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

/** API route handler type (matches existing router pattern) */
type ApiHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

let apiRouter: ApiHandler | null = null;

/**
 * Register the API router function.
 * Called from main.ts after API routes are set up.
 */
export function setApiRouter(handler: ApiHandler): void {
  apiRouter = handler;
}

/**
 * Serve a static file from Nexus dist directory.
 */
function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  let filePath = join(NEXUS_DIST, url.pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(NEXUS_DIST)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  // Check if file exists
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return false; // not a static file
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  // Cache headers for hashed assets
  const cacheControl = url.pathname.startsWith("/static/") || url.pathname.includes(".")
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "Cache-Control": cacheControl,
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serve index.html for SPA fallback.
 */
function serveSpaFallback(_req: IncomingMessage, res: ServerResponse): void {
  const indexPath = join(NEXUS_DIST, "index.html");
  if (!existsSync(indexPath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Nexus dashboard not built. Run: cd nexus && npm run build");
    return;
  }

  const content = readFileSync(indexPath, "utf-8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(content);
}

/**
 * Start the HTTP server.
 */
export function startServer(port: number): void {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";

    // CORS headers for dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes: /api/* and /paw/api/* (backwards compat)
    if (url.startsWith("/api/") || url.startsWith("/paw/api/")) {
      if (apiRouter) {
        try {
          await apiRouter(req, res);
        } catch (err) {
          log().error(`API error: ${err}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
      } else {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "API not ready" }));
      }
      return;
    }

    // Health check
    if (url === "/healthz" || url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    // Static files
    if (serveStatic(req, res)) return;

    // SPA fallback — serve index.html for all other routes
    serveSpaFallback(req, res);
  });

  server.listen(port, "0.0.0.0", () => {
    log().info(`HTTP server listening on port ${port}`);
    log().info(`Nexus dashboard: http://localhost:${port}`);
    log().info(`Nexus dist: ${NEXUS_DIST}`);
  });
}
