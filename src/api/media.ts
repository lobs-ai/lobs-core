/**
 * Media API — serves generated images and other media from ~/.lobs/media/
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { URL } from "node:url";
import { getLobsRoot } from "../config/lobs.js";

const MEDIA_DIR = join(getLobsRoot(), "media");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export async function handleMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  if (!sub) {
    res.writeHead(400);
    res.end("Missing file ID");
    return;
  }

  // Sanitize: only allow alphanumeric, dashes, dots
  if (!/^[\w\-\.]+$/.test(sub)) {
    res.writeHead(400);
    res.end("Invalid file ID");
    return;
  }

  const filePath = resolve(join(MEDIA_DIR, sub));

  // Prevent path traversal
  if (!filePath.startsWith(MEDIA_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = extname(sub).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    const data = await readFile(filePath);

    // Check for ?download=true or ?download=filename.ext
    const url = new URL(req.url || "/", "http://localhost");
    const downloadParam = url.searchParams.get("download");

    const headers: Record<string, string | number> = {
      "Content-Type": mime,
      "Content-Length": data.length,
      "Cache-Control": "public, max-age=86400, immutable",
    };

    if (downloadParam) {
      // Use provided filename or the original filename
      const filename = downloadParam === "true" ? sub : downloadParam;
      headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    }

    res.writeHead(200, headers);

    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(data);
    }
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}
