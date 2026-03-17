/**
 * YouTube API — /api/youtube
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody, parseQuery } from "./index.js";
import { YouTubeService } from "../services/youtube.js";
import { getModelForTier } from "../config/models.js";
import { getGatewayConfig } from "../config/lobs.js";

const svc = new YouTubeService();

export async function handleYouTubeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id: string | undefined,
  parts: string[],
): Promise<void> {

  // POST /api/youtube/ingest — submit URL(s) for processing
  if (id === "ingest" && req.method === "POST") {
    const body = (await parseBody(req)) as any;
    const urls: string[] = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
    if (urls.length === 0) return error(res, "url or urls required", 400);

    const ids = urls.map(url => svc.submit(url, body.projectId));
    return json(res, { ok: true, ids, count: ids.length }, 201);
  }

  // GET /api/youtube — list videos
  if (!id && req.method === "GET") {
    const q = parseQuery(req.url ?? "");
    return json(res, svc.list({ status: q.status, limit: q.limit ? Number(q.limit) : undefined }));
  }

  // GET /api/youtube/:id — get full video details
  if (id && !parts[2] && req.method === "GET") {
    const video = svc.get(id);
    if (!video) return error(res, "Video not found", 404);
    return json(res, video);
  }

  // POST /api/youtube/:id/reprocess — re-run processing pipeline
  if (id && parts[2] === "reprocess" && req.method === "POST") {
    const video = svc.get(id);
    if (!video) return error(res, "Video not found", 404);
    svc.process(id).catch(() => {});
    return json(res, { ok: true, status: "reprocessing" });
  }

  // DELETE /api/youtube/:id
  if (id && req.method === "DELETE") {
    svc.delete(id);
    return json(res, { ok: true });
  }

  // POST /api/youtube/chat — discuss a video
  if (id === "chat" && req.method === "POST") {
    const body = (await parseBody(req)) as any;
    if (!body?.message || !body?.videoId) return error(res, "message and videoId required", 400);

    const video = svc.get(body.videoId);
    if (!video) return error(res, "Video not found", 404);

    try {
      const { port, token } = getGatewayConfig();

      const context = body.context || "";
      const prompt = `You are discussing a YouTube video with the user. Answer based on the video content provided.

${context}

USER QUESTION: ${body.message}`;

      const r = await fetch(`http://127.0.0.1:${port}/v2/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          tool: "sessions/spawn",
          args: { task: prompt, mode: "run", model: getModelForTier("standard"), runTimeoutSeconds: 60, cleanup: "keep" },
          sessionKey: "agent:sink:paw-orchestrator-v2",
        }),
      });

      const spawnData = (await r.json()) as any;
      const sessionKey = spawnData?.result?.details?.childSessionKey;
      if (!sessionKey) throw new Error("Spawn failed");

      // Poll for response
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const hr = await fetch(`http://127.0.0.1:${port}/v2/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({
            tool: "sessions/history",
            args: { sessionKey, limit: 5, includeTools: false },
            sessionKey: "agent:sink:paw-orchestrator-v2",
          }),
        });
        const hd = (await hr.json()) as any;
        const msgs = hd?.result?.details?.messages ?? [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant") {
            const text = Array.isArray(msgs[i].content)
              ? msgs[i].content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\
")
              : typeof msgs[i].content === "string" ? msgs[i].content : "";
            if (text.trim()) return json(res, { response: text });
          }
        }
      }
      return error(res, "Chat timed out", 504);
    } catch (e: any) {
      return error(res, e.message, 500);
    }
  }

  return error(res, "Method not allowed", 405);
}
