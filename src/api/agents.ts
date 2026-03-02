/**
 * Agent profiles & status API — /paw/api/agents
 */

import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { agentProfiles, agentStatus } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";

export function registerAgentRoutes(api: OpenClawPluginApi): void {
  // GET /paw/api/agents
  api.registerHttpRoute({
    path: "/paw/api/agents",
    handler: async (req, res) => {
      if (req.method === "GET") {
        const db = getDb();
        const profiles = db.select().from(agentProfiles)
          .orderBy(agentProfiles.agentType)
          .all();
        const statuses = db.select().from(agentStatus).all();
        const statusMap = new Map(statuses.map(s => [s.agentType, s]));

        const rows = profiles.map(p => ({
          ...p,
          status: statusMap.get(p.agentType) ?? null,
        }));

        json(res, rows);
      } else if (req.method === "POST") {
        const db = getDb();
        const body = await parseBody(req) as Record<string, unknown>;
        if (!body.agent_type) return error(res, "agent_type is required");

        const id = (body.id as string) ?? randomUUID();
        const now = new Date().toISOString();

        db.insert(agentProfiles).values({
          id,
          agentType: body.agent_type as string,
          displayName: body.display_name as string ?? null,
          promptTemplate: body.prompt_template as string ?? null,
          config: body.config as Record<string, unknown> ?? null,
          policyTier: body.policy_tier as string ?? "standard",
          active: true,
          createdAt: now,
          updatedAt: now,
        }).run();

        const created = db.select().from(agentProfiles).where(eq(agentProfiles.id, id)).get();
        json(res, created, 201);
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });

  // GET/PATCH /paw/api/agents/:type
  api.registerHttpRoute({
    path: "/paw/api/agents/",
    handler: async (req, res) => {
      const url = req.url ?? "";
      const match = url.match(/\/paw\/api\/agents\/([^/?]+)/);
      if (!match) return error(res, "Agent type required", 400);
      const agentType = match[1];

      const db = getDb();

      if (req.method === "GET") {
        const profile = db.select().from(agentProfiles)
          .where(eq(agentProfiles.agentType, agentType))
          .get();
        if (!profile) return error(res, "Not found", 404);

        const status = db.select().from(agentStatus)
          .where(eq(agentStatus.agentType, agentType))
          .get();

        json(res, { ...profile, status: status ?? null });
      } else if (req.method === "PATCH") {
        const body = await parseBody(req) as Record<string, unknown>;
        const now = new Date().toISOString();
        const update: Record<string, unknown> = { updatedAt: now };

        if ("display_name" in body) update["displayName"] = body.display_name;
        if ("prompt_template" in body) update["promptTemplate"] = body.prompt_template;
        if ("config" in body) update["config"] = body.config;
        if ("policy_tier" in body) update["policyTier"] = body.policy_tier;
        if ("active" in body) update["active"] = body.active;

        db.update(agentProfiles).set(update)
          .where(eq(agentProfiles.agentType, agentType))
          .run();
        const updated = db.select().from(agentProfiles)
          .where(eq(agentProfiles.agentType, agentType))
          .get();
        if (!updated) return error(res, "Not found", 404);
        json(res, updated);
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });

  // GET /paw/api/agents/status — all agent statuses
  api.registerHttpRoute({
    path: "/paw/api/agents/status",
    handler: async (_req, res) => {
      const db = getDb();
      const rows = db.select().from(agentStatus).all();
      json(res, rows);
    },
  });
}
