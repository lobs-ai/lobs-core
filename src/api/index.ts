/**
 * API registration and HTTP helpers for PAW plugin.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerPawRouter } from "./router.js";

export function registerAllRoutes(api: OpenClawPluginApi): void {
  registerPawRouter(api);
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────

export function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

export function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const result: Record<string, string> = {};
  for (const [k, v] of params) result[k] = v;
  return result;
}
