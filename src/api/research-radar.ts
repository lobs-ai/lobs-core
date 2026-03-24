/**
 * Research Radar API — manage research ideas, view analysis, trigger refinement
 *
 * Routes:
 *   GET    /api/research-radar             — list research ideas (?status=&area=&sort=&limit=)
 *   POST   /api/research-radar             — create a research idea
 *   GET    /api/research-radar/stats       — overview stats
 *   GET    /api/research-radar/:id         — get a specific idea
 *   PUT    /api/research-radar/:id         — update an idea
 *   DELETE /api/research-radar/:id         — delete an idea
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody } from "./index.js";
import {
  getResearchRadarService,
  type CreateRadarInput,
  type ResearchStatus,
  type IdeaTrack,
} from "../services/research-radar.js";

export async function handleResearchRadarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  _parts: string[] = [],
): Promise<void> {
  const method = req.method ?? "GET";
  const radar = getResearchRadarService();

  try {
    // /api/research-radar/stats
    if (sub === "stats" && method === "GET") {
      return json(res, radar.getStats());
    }

    // /api/research-radar/:id
    if (sub && sub !== "stats") {
      const id = sub;

      if (method === "GET") {
        const item = radar.get(id);
        if (!item) return error(res, "Research idea not found", 404);
        return json(res, item);
      }

      if (method === "PUT") {
        const body = await parseBody(req) as Record<string, unknown>;
        const updated = radar.update(id, body as Parameters<typeof radar.update>[1]);
        if (!updated) return error(res, "Research idea not found", 404);
        return json(res, updated);
      }

      if (method === "DELETE") {
        const ok = radar.delete(id);
        if (!ok) return error(res, "Research idea not found", 404);
        return json(res, { ok: true });
      }

      return error(res, "Method not allowed", 405);
    }

    // /api/research-radar (collection)
    if (method === "GET") {
      const url = new URL(req.url ?? "/", "http://localhost");
      const status = url.searchParams.get("status") as ResearchStatus | null;
      const track = url.searchParams.get("track") as IdeaTrack | null;
      const area = url.searchParams.get("area") ?? undefined;
      const sort = url.searchParams.get("sort") as "novelty" | "feasibility" | "impact" | "composite" | "created" | undefined;
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);

      const items = radar.list({
        status: status ? (status.includes(",") ? status.split(",") as ResearchStatus[] : status) : undefined,
        track: track ? (track.includes(",") ? track.split(",") as IdeaTrack[] : track) : undefined,
        area,
        sortBy: sort || "composite",
        limit,
      });
      return json(res, items);
    }

    if (method === "POST") {
      const body = await parseBody(req) as CreateRadarInput;
      if (!body.title?.trim() || !body.thesis?.trim()) {
        return error(res, "title and thesis are required", 400);
      }
      const item = radar.create(body);
      return json(res, item, 201);
    }

    return error(res, "Method not allowed", 405);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return error(res, msg, 500);
  }
}
