/**
 * Task CRUD — handles /api/tasks and /api/tasks/:id and sub-routes
 */

import { randomUUID } from "node:crypto";
import { inferProjectId } from "../util/project-inference.js";
import { eq, and, inArray, desc, lte } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { tasks, projects } from "../db/schema.js";
import { json, error, parseBody, parseQuery } from "./index.js";
import { readFileSync as _readFileSync } from "node:fs";
import { LearningService } from "../services/learning.js";
import { classifyAndLog } from "../services/task-sensitivity.js";
import { getModelForTier } from "../config/models.js";

const learningSvc = new LearningService();

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a raw task row from Drizzle by adding a `compliant` boolean alias
 * for `complianceRequired` (used by the Nexus UI).
 * Also resolves effective compliance: if the task's project has compliance_required=1,
 * the task is treated as compliant regardless of the task-level flag.
 *
 * Performs a project lookup when the task has a projectId so the single-task
 * GET endpoint correctly reflects inherited project compliance.
 */
function normalizeTask(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const taskCompliant = Boolean(row["complianceRequired"] ?? row["compliance_required"]);
  const projectId = row["projectId"] as string | undefined;
  let projectCompliant = false;
  if (!taskCompliant && projectId) {
    try {
      const db = getDb();
      const proj = db.select({ complianceRequired: projects.complianceRequired })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get();
      projectCompliant = Boolean(proj?.complianceRequired);
    } catch {}
  }
  return {
    ...row,
    compliant: taskCompliant || projectCompliant,
    complianceInherited: !taskCompliant && projectCompliant,
  };
}

/**
 * Batch-normalize tasks, resolving effective compliance via a project lookup.
 * For tasks that are not individually flagged, check if their parent project is compliant.
 */
function normalizeTaskBatch(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length === 0) return [];
  const db = getDb();
  // Collect unique project IDs that appear in the task list
  const projectIds = [...new Set(rows.map(r => r["projectId"] as string | null | undefined).filter(Boolean))] as string[];
  // Load compliance flags for those projects in one query
  const projectCompliance: Record<string, boolean> = {};
  if (projectIds.length > 0) {
    try {
      const projRows = db.select({ id: projects.id, complianceRequired: projects.complianceRequired })
        .from(projects)
        .where(inArray(projects.id, projectIds))
        .all();
      for (const p of projRows) {
        projectCompliance[p.id] = Boolean(p.complianceRequired);
      }
    } catch {}
  }
  return rows.map(row => {
    const taskCompliant = Boolean(row["complianceRequired"] ?? row["compliance_required"]);
    const projectId = row["projectId"] as string | undefined;
    const projectCompliant = projectId ? Boolean(projectCompliance[projectId]) : false;
    return {
      ...row,
      compliant: taskCompliant || projectCompliant,
      // If project is compliant and task is not flagged, indicate it's inherited
      complianceInherited: !taskCompliant && projectCompliant,
    };
  });
}

// ── Brain Dump Gateway helpers ──────────────────────────────────────────

function _brainDumpGatewayCfg(): { port: number; token: string } {
  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  try {
    const cfg = JSON.parse(_readFileSync(cfgPath, "utf8"));
    return { port: cfg?.gateway?.port ?? 18789, token: cfg?.gateway?.auth?.token ?? "" };
  } catch { return { port: 18789, token: "" }; }
}

async function _brainDumpInvoke(tool: string, args: Record<string, unknown>): Promise<any> {
  const { port, token } = _brainDumpGatewayCfg();
  if (!token) throw new Error("No gateway auth token configured");
  const r = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ tool, args, sessionKey: "agent:sink:paw-orchestrator-v2" }),
  });
  if (!r.ok) throw new Error(`Gateway ${tool} failed (${r.status}): ${await r.text()}`);
  const data = (await r.json()) as any;
  return data?.result?.details ?? data?.result ?? data;
}

export async function handleTaskRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id: string | undefined,
  parts: string[],
): Promise<void> {
  const db = getDb();
  const sub = parts[2]; // sub-route after /:id

  // /api/tasks/open — convenience endpoint
  if (id === "open") {
    const rows = db.select().from(tasks)
      .where(inArray(tasks.status, ["inbox", "active", "waiting_on"]))
      .orderBy(desc(tasks.updatedAt))
      .all();
    return json(res, normalizeTaskBatch(rows as Record<string, unknown>[]));
  }

  // /api/tasks/auto-archive — POST
  if (id === "auto-archive" && req.method === "POST") {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.select().from(tasks)
      .where(and(
        inArray(tasks.status, ["completed", "rejected"]),
        lte(tasks.updatedAt, cutoff),
      ))
      .all();
    for (const t of rows) {
      db.update(tasks).set({ status: "archived", updatedAt: now }).where(eq(tasks.id, t.id)).run();
    }
    return json(res, { archived: rows.length });
  }


  // /api/tasks/braindump — POST: parse brain dump text, return proposed tasks
  if (id === "braindump" && req.method === "POST") {
    const body = await parseBody(req) as { text?: string; project_id?: string; model_tier_override?: string };
    if (!body.text?.trim()) return error(res, "text is required");

    const systemPrompt = `You are a task extraction assistant. Given freeform text, extract discrete actionable tasks.
For each task assign:
- title: concise, action-oriented title
- agent: one of programmer/writer/researcher/reviewer/architect (pick best fit based on task nature)
- model_tier: one of micro/small/medium/standard/strong (complexity-based: micro=trivial, strong=complex/uncertain)
- notes: 1-3 sentences of clear context for the agent executing it

Return ONLY valid JSON in this exact format with no other text:
{"proposed_tasks": [{"title": "...", "agent": "...", "model_tier": "...", "notes": "..."}]}`;

    const userPrompt = `Extract actionable tasks from this text:

${body.text}`;

    const result = await _brainDumpInvoke("sessions_spawn", {
      task: userPrompt,
      system: systemPrompt,
      model: body.model_tier_override
        ? getModelForTier(body.model_tier_override)
        : getModelForTier("small"),
      mode: "run",
      cleanup: "kill",
      runTimeoutSeconds: 60,
      maxTokens: 2000,
    });

    const rawReply: string = result?.reply ?? result?.response ?? result?.text ?? "";
    // Extract JSON from reply (handle markdown code blocks)
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return error(res, "LLM did not return valid JSON. Reply: " + rawReply.slice(0, 200), 500);
    const parsed = JSON.parse(jsonMatch[0]);
    return json(res, { proposed_tasks: parsed.proposed_tasks ?? [] });
  }

  // /api/tasks/braindump/confirm — POST: bulk-create proposed tasks
  if (id === "braindump" && parts[2] === "confirm" && req.method === "POST") {
    const body = await parseBody(req) as { tasks?: Array<{ title: string; agent?: string; model_tier?: string; notes?: string; project_id?: string }> };
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) return error(res, "tasks array is required");
    const db = getDb();
    const now = new Date().toISOString();
    const created = [];
    for (const t of body.tasks) {
      if (!t.title?.trim()) continue;
      const taskId = randomUUID();
      const braindumpIsCompliant = classifyAndLog(taskId, t.title, t.notes ?? "");
      db.insert(tasks).values({
        id: taskId,
        title: t.title,
        status: "active",
        projectId: t.project_id || inferProjectId(t.title, t.notes),
        notes: t.notes,
        agent: t.agent,
        modelTier: t.model_tier ?? "standard",
        isCompliant: braindumpIsCompliant,
        createdAt: now,
        updatedAt: now,
      }).run();
      created.push(db.select().from(tasks).where(eq(tasks.id, taskId)).get());
    }
    return json(res, { created }, 201);
  }

  // /api/tasks/:id — single task + sub-routes
  if (id) {
    // Sub-routes
    if (sub === "status" && req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.status) return error(res, "status required");
      db.update(tasks).set({ status: body.status as string, updatedAt: new Date().toISOString() }).where(eq(tasks.id, id)).run();
      return json(res, db.select().from(tasks).where(eq(tasks.id, id)).get());
    }
    if (sub === "work-state" && req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.work_state) return error(res, "work_state required");
      db.update(tasks).set({ workState: body.work_state as string, updatedAt: new Date().toISOString() }).where(eq(tasks.id, id)).run();
      return json(res, db.select().from(tasks).where(eq(tasks.id, id)).get());
    }
    if (sub === "blocked-by" && req.method === "PATCH") {
      // Set task dependencies: body = { blocked_by: string[] | null }
      const body = await parseBody(req) as Record<string, unknown>;
      const blockedBy = body.blocked_by;
      if (blockedBy !== null && !Array.isArray(blockedBy)) {
        return error(res, "blocked_by must be an array of task IDs or null");
      }
      const rowCheck = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).get();
      if (!rowCheck) return error(res, "Not found", 404);

      // Circular dependency detection via BFS
      // Reject if adding these blockers would cause a cycle (including self-reference)
      if (Array.isArray(blockedBy) && blockedBy.length > 0) {
        // Self-reference check
        if (blockedBy.includes(id)) {
          return error(res, `Circular dependency: task ${id} cannot block itself`, 400);
        }
        // BFS: traverse from each proposed blocker; if we reach `id`, it's a cycle
        const visited = new Set<string>();
        const queue: string[] = [...blockedBy];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current === id) {
            return error(res, `Circular dependency detected: adding these blockers would create a dependency cycle`, 400);
          }
          if (visited.has(current)) continue;
          visited.add(current);
          // Fetch this task's blocked_by to continue traversal
          const dep = db.select({ blockedBy: tasks.blockedBy }).from(tasks).where(eq(tasks.id, current)).get();
          if (dep && Array.isArray(dep.blockedBy)) {
            for (const depId of dep.blockedBy as string[]) {
              if (!visited.has(depId)) queue.push(depId);
            }
          }
        }
      }

      // Validate that all blocker IDs exist in the database
      if (Array.isArray(blockedBy) && blockedBy.length > 0) {
        const found = db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, blockedBy as string[])).all();
        if (found.length !== blockedBy.length) {
          const notFound = (blockedBy as string[]).filter(bid => !found.find(r => r.id === bid));
          return error(res, `Blocker task IDs not found: ${notFound.join(", ")}`, 400);
        }
      }

      db.update(tasks).set({
        blockedBy: blockedBy as string[] | null,
        updatedAt: new Date().toISOString(),
      }).where(eq(tasks.id, id)).run();
      return json(res, db.select().from(tasks).where(eq(tasks.id, id)).get());
    }
    if (sub === "blockers" && req.method === "GET") {
      // GET /api/tasks/:id/blockers — returns full task objects for each blocker
      const row = db.select({ id: tasks.id, blockedBy: tasks.blockedBy }).from(tasks).where(eq(tasks.id, id)).get();
      if (!row) return error(res, "Not found", 404);
      const blockerIds: string[] = Array.isArray(row.blockedBy) ? row.blockedBy as string[] : [];
      if (blockerIds.length === 0) return json(res, { blockers: [], resolved: true });
      const blockerRows = blockerIds.length > 0
        ? db.select().from(tasks).where(inArray(tasks.id, blockerIds)).all()
        : [];
      const unresolvedStatuses = ["active", "pending", "queued", "in_progress", "blocked"];
      const unresolved = blockerRows.filter(t => unresolvedStatuses.includes(t.status ?? ""));
      return json(res, {
        blockers: blockerRows,
        resolved: unresolved.length === 0,
        unresolved_count: unresolved.length,
      });
    }
    if (sub === "review-state" && req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.review_state) return error(res, "review_state required");
      db.update(tasks).set({ reviewState: body.review_state as string, updatedAt: new Date().toISOString() }).where(eq(tasks.id, id)).run();
      return json(res, normalizeTask(db.select().from(tasks).where(eq(tasks.id, id)).get() as Record<string, unknown>));
    }
    // PATCH /api/tasks/:id/compliance — toggle compliance mode for a specific task
    // Accepts { compliant: boolean } (Nexus UI convention) or { compliance_required: boolean }
    if (sub === "compliance" && req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      const rawVal = "compliant" in body ? body["compliant"] : body["compliance_required"];
      if (typeof rawVal !== "boolean") return error(res, "compliant (boolean) is required", 400);
      const rowCheck = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).get();
      if (!rowCheck) return error(res, "Not found", 404);
      db.update(tasks).set({ complianceRequired: rawVal, updatedAt: new Date().toISOString() }).where(eq(tasks.id, id)).run();
      return json(res, normalizeTask(db.select().from(tasks).where(eq(tasks.id, id)).get() as Record<string, unknown>));
    }
    // PATCH /api/tasks/:id/feedback — submit human feedback and trigger learning extraction
    // Body: { feedback: string, review_state: "accepted" | "rejected" | "needs_revision" }
    if (sub === "feedback" && req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      if (!body.feedback || typeof body.feedback !== "string") {
        return error(res, "feedback (string) is required", 400);
      }
      const reviewState = (body.review_state ?? body.reviewState) as string;
      if (!["accepted", "rejected", "needs_revision"].includes(reviewState)) {
        return error(res, "review_state must be one of: accepted, rejected, needs_revision", 400);
      }
      const rowCheck = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).get();
      if (!rowCheck) return error(res, "Not found", 404);

      const result = learningSvc.addHumanFeedback({
        taskId: id,
        feedback: body.feedback,
        reviewState: reviewState as "accepted" | "rejected" | "needs_revision",
      });

      return json(res, { ok: true, outcomeId: result.outcomeId, extracted: result.extracted });
    }

    if (sub === "archive" && req.method === "POST") {
      db.update(tasks).set({ status: "archived", updatedAt: new Date().toISOString() }).where(eq(tasks.id, id)).run();
      return json(res, db.select().from(tasks).where(eq(tasks.id, id)).get());
    }
    if (sub === "artifact" && req.method === "GET") {
      const row = db.select({ artifactPath: tasks.artifactPath }).from(tasks).where(eq(tasks.id, id)).get();
      if (!row) return error(res, "Not found", 404);
      return json(res, { artifact_path: row.artifactPath ?? null });
    }

    if (req.method === "GET") {
      const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
      if (!row) return error(res, "Not found", 404);
      return json(res, normalizeTask(row as Record<string, unknown>));
    }
    if (req.method === "PATCH") {
      const body = await parseBody(req) as Record<string, unknown>;
      const now = new Date().toISOString();
      const update: Record<string, unknown> = { updatedAt: now };
      const fieldMap: Record<string, string> = {
        title: "title", status: "status", owner: "owner",
        work_state: "workState", review_state: "reviewState",
        project_id: "projectId", notes: "notes", agent: "agent",
        model_tier: "modelTier", failure_reason: "failureReason",
        escalation_tier: "escalationTier", retry_count: "retryCount", blocked_by: "blockedBy",
        compliance_required: "complianceRequired",
        // Also accept the Nexus UI convention
        compliant: "complianceRequired",
        // Sensitivity classifier flag: set by task-sensitivity.ts at creation time
        // or synced externally from lobs-server via PATCH. Forces local-model routing.
        is_compliant: "isCompliant",
        // Pre-flight artifact check: JSON array of ArtifactSpec objects
        expected_artifacts: "expectedArtifacts",
      };
      // Fields that must be JSON-stringified before persisting
      const jsonFields = new Set(["expected_artifacts", "blocked_by"]);
      for (const [apiKey, schemaKey] of Object.entries(fieldMap)) {
        if (apiKey in body) {
          update[schemaKey] = jsonFields.has(apiKey) && body[apiKey] != null
            ? JSON.stringify(body[apiKey])
            : body[apiKey];
        }
      }
      db.update(tasks).set(update).where(eq(tasks.id, id)).run();
      const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
      return json(res, normalizeTask(updated as Record<string, unknown>));
    }
    if (req.method === "DELETE") {
      db.delete(tasks).where(eq(tasks.id, id)).run();
      return json(res, { deleted: true });
    }
    return error(res, "Method not allowed", 405);
  }

  // /api/tasks — list or create
  if (req.method === "GET") {
    const query = parseQuery(req.url ?? "");
    const conditions = [];
    if (query.status) conditions.push(eq(tasks.status, query.status));
    if (query.project_id) conditions.push(eq(tasks.projectId, query.project_id));
    // Direct compliance flag filter (does NOT include project-inherited compliance —
    // use normalizeTaskBatch result's `compliant` field for the full effective value)
    if (query.compliance_required === "true") conditions.push(eq(tasks.complianceRequired, true));
    if (query.compliance_required === "false") conditions.push(eq(tasks.complianceRequired, false));

    const rows = conditions.length > 0
      ? db.select().from(tasks).where(and(...conditions)).orderBy(desc(tasks.updatedAt)).all()
      : db.select().from(tasks).orderBy(desc(tasks.updatedAt)).all();

    const normalized = normalizeTaskBatch(rows as Record<string, unknown>[]);

    // If caller requested effective compliance (including inheritance), post-filter
    if (query.compliant === "true") return json(res, normalized.filter(r => r["compliant"]));
    if (query.compliant === "false") return json(res, normalized.filter(r => !r["compliant"]));

    return json(res, normalized);
  }
  if (req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.title) return error(res, "title is required");
    const taskId = (body.id as string) ?? randomUUID();
    const now = new Date().toISOString();

    // ── Sensitivity classification (Tier 1 regex, <1ms) ──────────────────
    // Auto-classify the task based on FERPA/HIPAA/PII patterns in title+notes.
    // If the caller already sets is_compliant=1 (e.g., synced from lobs-server),
    // honour their value. Otherwise, run the classifier.
    // is_compliant=1 forces local-model-only routing in the compliance gate.
    const callerIsCompliant = body.is_compliant === 1 || body.is_compliant === true;
    const autoIsCompliant = callerIsCompliant
      ? true
      : classifyAndLog(taskId, body.title as string, (body.notes as string) ?? "");

    db.insert(tasks).values({
      id: taskId,
      title: body.title as string,
      status: (body.status as string) ?? "active",
      owner: body.owner as string,
      projectId: (body.project_id as string) || inferProjectId(body.title as string, body.notes as string | null),
      notes: body.notes as string,
      agent: body.agent as string,
      modelTier: (body.model_tier as string) ?? "standard",
      blockedBy: Array.isArray(body.blocked_by) ? body.blocked_by as string[] : null,
      complianceRequired: Boolean(body.compliance_required),
      isCompliant: autoIsCompliant,
      expectedArtifacts: body.expected_artifacts != null ? JSON.stringify(body.expected_artifacts) : undefined,
      createdAt: now,
      updatedAt: now,
    }).run();
    const created = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return json(res, created, 201);
  }
  return error(res, "Method not allowed", 405);
}
