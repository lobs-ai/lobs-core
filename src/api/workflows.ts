/**
 * Workflow definitions & runs API — /paw/api/workflows
 */

import { randomUUID } from "node:crypto";
import { eq, and, inArray, desc } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workflowDefinitions, workflowRuns, workflowEvents } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";
import { WorkflowExecutor } from "../workflow/engine.js";

export function registerWorkflowRoutes(api: OpenClawPluginApi): void {
  // ── Workflow Definitions ─────────────────────────────────────────────────

  // GET /paw/api/workflows
  api.registerHttpRoute({
    path: "/paw/api/workflows",
    handler: async (req, res) => {
      if (req.method === "GET") {
        const db = getDb();
        const q = parseQuery(req.url ?? "");
        const activeOnly = q.active !== "false";

        const rows = activeOnly
          ? db.select().from(workflowDefinitions)
              .where(eq(workflowDefinitions.isActive, true))
              .orderBy(workflowDefinitions.name)
              .all()
          : db.select().from(workflowDefinitions)
              .orderBy(workflowDefinitions.name)
              .all();

        json(res, rows);
      } else if (req.method === "POST") {
        const db = getDb();
        const body = await parseBody(req) as Record<string, unknown>;
        if (!body.name) return error(res, "name is required");
        if (!body.nodes) return error(res, "nodes is required");

        const id = (body.id as string) ?? randomUUID();
        const now = new Date().toISOString();

        db.insert(workflowDefinitions).values({
          id,
          name: body.name as string,
          description: body.description as string ?? null,
          version: 1,
          nodes: body.nodes as unknown[],
          edges: (body.edges as unknown[]) ?? [],
          trigger: body.trigger as Record<string, unknown> ?? null,
          metadata: body.metadata as Record<string, unknown> ?? null,
          isActive: (body.is_active as boolean) ?? true,
          createdAt: now,
          updatedAt: now,
        }).run();

        const created = db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id)).get();
        json(res, created, 201);
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });

  // GET/PATCH/DELETE /paw/api/workflows/:id
  api.registerHttpRoute({
    path: "/paw/api/workflows/",
    handler: async (req, res) => {
      const url = req.url ?? "";
      const match = url.match(/\/paw\/api\/workflows\/([^/?]+)/);
      if (!match) return error(res, "Workflow ID required", 400);
      const wfId = match[1];

      const db = getDb();

      if (req.method === "GET") {
        const row = db.select().from(workflowDefinitions)
          .where(eq(workflowDefinitions.id, wfId))
          .get();
        if (!row) return error(res, "Not found", 404);
        json(res, row);
      } else if (req.method === "PATCH") {
        const body = await parseBody(req) as Record<string, unknown>;
        const now = new Date().toISOString();
        const update: Record<string, unknown> = { updatedAt: now };

        if ("description" in body) update["description"] = body.description;
        if ("nodes" in body) update["nodes"] = body.nodes;
        if ("edges" in body) update["edges"] = body.edges;
        if ("trigger" in body) update["trigger"] = body.trigger;
        if ("metadata" in body) update["metadata"] = body.metadata;
        if ("is_active" in body) update["isActive"] = body.is_active;

        // Bump version on any update
        const existing = db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).get();
        if (!existing) return error(res, "Not found", 404);
        update["version"] = (existing.version ?? 1) + 1;

        db.update(workflowDefinitions).set(update).where(eq(workflowDefinitions.id, wfId)).run();
        const updated = db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).get();
        json(res, updated);
      } else if (req.method === "DELETE") {
        db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).run();
        json(res, { deleted: true });
      } else {
        error(res, "Method not allowed", 405);
      }
    },
  });

  // ── Workflow Runs ────────────────────────────────────────────────────────

  // GET /paw/api/workflows/runs
  api.registerHttpRoute({
    path: "/paw/api/workflows/runs",
    handler: async (req, res) => {
      if (req.method !== "GET") return error(res, "Method not allowed", 405);
      const db = getDb();
      const q = parseQuery(req.url ?? "");
      const limit = Math.min(parseInt(q.limit ?? "20", 10), 100);
      const status = q.status;
      const wfId = q.workflow_id;

      const rows = db.select().from(workflowRuns)
        .where(
          status ? eq(workflowRuns.status, status) :
          wfId   ? eq(workflowRuns.workflowId, wfId) :
          undefined,
        )
        .orderBy(desc(workflowRuns.createdAt))
        .limit(limit)
        .all();

      json(res, rows);
    },
  });

  // GET /paw/api/workflows/runs/:id
  api.registerHttpRoute({
    path: "/paw/api/workflows/runs/",
    handler: async (req, res) => {
      const url = req.url ?? "";
      const match = url.match(/\/paw\/api\/workflows\/runs\/([^/?]+)/);
      if (!match) return error(res, "Run ID required", 400);
      const runId = match[1];

      const db = getDb();
      const row = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
      if (!row) return error(res, "Not found", 404);
      json(res, row);
    },
  });

  // POST /paw/api/workflows/:id/trigger — manually trigger a workflow
  api.registerHttpRoute({
    path: "/paw/api/workflows/trigger",
    handler: async (req, res) => {
      if (req.method !== "POST") return error(res, "Method not allowed", 405);

      const url = req.url ?? "";
      const match = url.match(/\/paw\/api\/workflows\/([^/?]+)\/trigger/);
      if (!match) return error(res, "Workflow ID required", 400);
      const wfId = match[1];

      const db = getDb();
      const workflow = db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).get();
      if (!workflow) return error(res, "Workflow not found", 404);

      const body = await parseBody(req) as Record<string, unknown>;
      const executor = new WorkflowExecutor();
      const run = executor.startRun(workflow, {
        triggerType: "manual",
        triggerPayload: body ?? {},
      });

      json(res, run, 201);
    },
  });

  // POST /paw/api/workflows/events — emit a workflow event
  api.registerHttpRoute({
    path: "/paw/api/workflows/events",
    handler: async (req, res) => {
      if (req.method !== "POST") return error(res, "Method not allowed", 405);

      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.event_type) return error(res, "event_type is required", 400);

      const executor = new WorkflowExecutor();
      const id = executor.emitEvent(
        body.event_type as string,
        (body.payload as Record<string, unknown>) ?? {},
        (body.source as string) ?? "api",
      );

      json(res, { id, queued: true });
    },
  });
}
