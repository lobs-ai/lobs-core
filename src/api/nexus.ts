/**
 * Nexus dashboard — static file handler.
 * Serves the web UI from src/web/ at the root path.
 * API routes (/api/*, /paw/api/*) take priority via router.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = process.env.NEXUS_WEB_ROOT || '/Users/lobs/lobs-nexus/dist';

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

export function registerNexusHandler(api: OpenClawPluginApi): void {
  (api as any).registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);

    // Don't intercept API routes
    if (pathname.startsWith("/api/") || pathname.startsWith("/paw/api/")) return false;

    // Resolve file path
    if (pathname === "/") pathname = "/index.html";
    
    // Security: prevent path traversal
    const filePath = join(WEB_ROOT, pathname);
    if (!filePath.startsWith(WEB_ROOT)) {
      res.writeHead(403); res.end("Forbidden"); return true;
    }

    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      const mime = MIME[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
      res.end(data);
      return true;
    } catch {
      // SPA fallback: serve index.html for unknown paths
      if (!pathname.includes(".")) {
        try {
          const html = await readFile(join(WEB_ROOT, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
          res.end(html);
          return true;
        } catch { /* fall through */ }
      }
      return false;
    }
  });
}
