/**
 * Nexus dashboard — static file handler.
 * Served under /nexus to avoid collisions with OpenClaw core web assets.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { log } from "../util/logger.js";

const WEB_ROOT = process.env.NEXUS_WEB_ROOT || "/Users/lobs/lobs-nexus/dist";
const ASSETS_ROOT = join(WEB_ROOT, "assets");

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

async function sendFile(res: ServerResponse, filePath: string, cacheControl = "no-cache"): Promise<boolean> {
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": cacheControl });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function sendIndex(res: ServerResponse): Promise<boolean> {
  try {
    const raw = await readFile(join(WEB_ROOT, "index.html"), "utf-8");
    const html = raw
      .replace(/"\/assets\//g, '"/nexus/static/')
      .replace(/"\/vite\.svg"/g, '"/nexus/static/vite.svg"');
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
    return true;
  } catch {
    return false;
  }
}

export function registerNexusHandler(api: OpenClawPluginApi): void {
  log().info(`paw: registering nexus routes (root=${WEB_ROOT})`);

  api.registerHttpRoute({
    path: "/nexus/static",
    match: "prefix",
    auth: "plugin",
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      if (req.method !== "GET" && req.method !== "HEAD") return false;
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/nexus/static/vite.svg") {
        return sendFile(res, join(WEB_ROOT, "vite.svg"), "public, max-age=300");
      }

      const rel = pathname.startsWith("/nexus/static/") ? pathname.slice("/nexus/static/".length) : "";
      if (!rel) return false;
      const filePath = join(ASSETS_ROOT, rel);
      if (!filePath.startsWith(ASSETS_ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return true;
      }

      return sendFile(res, filePath, "public, max-age=300");
    },
  });

  api.registerHttpRoute({
    path: "/nexus",
    match: "prefix",
    auth: "plugin",
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      if (req.method !== "GET" && req.method !== "HEAD") return false;

      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith("/nexus/static/")) return false;
      if (pathname === "/nexus" || pathname === "/nexus/") return sendIndex(res);

      // SPA fallback under /nexus/*
      if (pathname.startsWith("/nexus/") && !pathname.slice("/nexus/".length).includes(".")) {
        return sendIndex(res);
      }

      return false;
    },
  });

  log().info("paw: nexus routes registered at /nexus and /nexus/static/*");
}
