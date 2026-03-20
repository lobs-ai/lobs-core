/**
 * Tests for src/api/tasks.ts
 *
 * Covers: task creation, listing, filtering, updating, deleting,
 * deduplication (24h window), sensitivity classification, compliance
 * inheritance, and error/edge cases.
 *
 * Uses the real in-memory SQLite DB wired up in tests/setup.ts.
 * External LLM calls from intake-triage are mocked.
 *
 * Router convention from src/api/router.ts line 67:
 *   handleTaskRequest(req, res, parts[1], parts)
 * where parts = path segments after "/api/" e.g. ["tasks", "<id>", "sub"]
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/connection.js";
import { tasks, projects } from "../src/db/schema.js";
import { handleTaskRequest } from "../src/api/tasks.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Prevent real LLM calls from intake-triage during tests
vi.mock("../src/runner/local-classifier.js", () => ({
  classifyAgent: vi.fn().mockResolvedValue({
    agent: "programmer",
    urgency: "medium",
    modelTier: "standard",
    reasoning: "test mock",
  }),
  isLocalModelAvailable: vi.fn().mockResolvedValue(false),
}));

vi.mock("../src/services/data-extraction.js", () => ({
  extractStructuredData: vi.fn().mockResolvedValue({ summary: "mock" }),
}));

vi.mock("../src/services/training-data.js", () => ({
  logTrainingExample: vi.fn().mockResolvedValue(undefined),
}));

// ── Request / response helpers ────────────────────────────────────────────────

function makeReq(method: string, url: string, body: unknown = {}): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  (req as unknown as Record<string, unknown>).method = method;
  (req as unknown as Record<string, unknown>).url = url;
  process.nextTick(() => {
    (req as unknown as Readable).push(JSON.stringify(body));
    (req as unknown as Readable).push(null);
  });
  return req;
}

type ResHelper = {
  res: ServerResponse;
  body: () => Record<string, unknown>;
  arrayBody: () => Record<string, unknown>[];
  statusCode: () => number;
};

function makeRes(): ResHelper {
  let captured = "";
  let code = 200;
  const res = {
    statusCode: 200,
    writeHead(c: number) { code = c; this.statusCode = c; },
    setHeader() {},
    end(data: string) { captured = data; },
  } as unknown as ServerResponse;
  return {
    res,
    body: () => JSON.parse(captured) as Record<string, unknown>,
    arrayBody: () => JSON.parse(captured) as Record<string, unknown>[],
    statusCode: () => code,
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const createdIds: string[] = [];

afterEach(() => {
  const db = getDb();
  for (const id of createdIds) {
    try { db.delete(tasks).where(eq(tasks.id, id)).run(); } catch {}
  }
  createdIds.length = 0;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a task via the handler, returning parsed body.
 * Router passes: handleTaskRequest(req, res, parts[1], parts)
 * For POST /api/tasks: parts = ["tasks"], id = undefined
 */
async function createTask(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { res, body } = makeRes();
  await handleTaskRequest(
    makeReq("POST", "/api/tasks", {
      title: "Test task",
      notes: "Some notes",
      force: true,
      ...overrides,
    }),
    res,
    undefined,       // id
    ["tasks"],       // parts
  );
  const b = body();
  if (b["id"]) createdIds.push(b["id"] as string);
  return b;
}

/**
 * GET a single task via the handler.
 * For GET /api/tasks/:id: parts = ["tasks", id], id = id
 */
async function getTask(id: string): Promise<{ body: Record<string, unknown>; statusCode: number }> {
  const h = makeRes();
  await handleTaskRequest(
    makeReq("GET", `/api/tasks/${id}`),
    h.res,
    id,              // id
    ["tasks", id],   // parts
  );
  return { body: h.body(), statusCode: h.statusCode() };
}

/**
 * PATCH a single task via the handler.
 */
async function patchTask(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const h = makeRes();
  await handleTaskRequest(
    makeReq("PATCH", `/api/tasks/${id}`, patch),
    h.res,
    id,
    ["tasks", id],
  );
  return h.body();
}

// ── POST /api/tasks — creation ────────────────────────────────────────────────

describe("POST /api/tasks — creation", () => {
  it("creates a task and returns an id", async () => {
    const task = await createTask({ title: "Write unit tests" });
    expect(task["id"]).toBeTruthy();
    expect(task["title"]).toBe("Write unit tests");
    expect(typeof task["id"]).toBe("string");
  });

  it("returns HTTP 201 on success", async () => {
    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("POST", "/api/tasks", { title: "Quick task", force: true }),
      res,
      undefined,
      ["tasks"],
    );
    const b = body();
    if (b["id"]) createdIds.push(b["id"] as string);
    expect(res.statusCode).toBe(201);
  });

  it("returns 400 when title is missing", async () => {
    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("POST", "/api/tasks", { notes: "No title here", force: true }),
      res,
      undefined,
      ["tasks"],
    );
    expect(res.statusCode).toBe(400);
    expect(body()["error"]).toBeTruthy();
  });

  it("accepts caller-specified status", async () => {
    const task = await createTask({ title: "Status task", status: "completed" });
    expect(task["status"]).toBe("completed");
  });

  it("defaults status to 'active' when not specified", async () => {
    const task = await createTask({ title: "Default status task" });
    expect(task["status"]).toBe("active");
  });

  it("accepts caller-specified id and stores it", async () => {
    const customId = "custom-task-id-999";
    const task = await createTask({ title: "Custom ID task", id: customId });
    expect(task["id"]).toBe(customId);
    if (!createdIds.includes(customId)) createdIds.push(customId);
  });

  it("stores notes field", async () => {
    const task = await createTask({ title: "Notes task", notes: "important notes here" });
    expect(task["notes"]).toBe("important notes here");
  });

  it("stores owner field", async () => {
    const task = await createTask({ title: "Owned task", owner: "lobs" });
    expect(task["owner"]).toBe("lobs");
  });

  it("sets createdAt and updatedAt timestamps", async () => {
    const task = await createTask({ title: "Timestamp task" });
    expect(task["createdAt"]).toBeTruthy();
    expect(task["updatedAt"]).toBeTruthy();
  });

  it("includes isCompliant field in response", async () => {
    // POST returns the raw DB row — isCompliant is set by the sensitivity classifier
    const task = await createTask({ title: "Compliant check task" });
    expect("isCompliant" in task).toBe(true);
  });

  it("sets isCompliant=true when title contains HIPAA-sensitive pattern (SSN)", async () => {
    const task = await createTask({
      title: "Patient SSN 123-45-6789 needs updating",
      notes: "",
    });
    // task-sensitivity.ts classifies this as sensitive → isCompliant=1
    expect(Boolean(task["isCompliant"])).toBe(true);
  });

  it("respects caller's is_compliant flag", async () => {
    const task = await createTask({ title: "Forced compliant task", is_compliant: 1 });
    expect(Boolean(task["isCompliant"])).toBe(true);
  });
});

// ── GET /api/tasks — listing ──────────────────────────────────────────────────

describe("GET /api/tasks — listing", () => {
  beforeEach(async () => {
    await createTask({ title: "Active task A", status: "active" });
    await createTask({ title: "Done task", status: "completed" });
    await createTask({ title: "Active task B", status: "active" });
  });

  it("returns an array", async () => {
    const { res, arrayBody } = makeRes();
    await handleTaskRequest(makeReq("GET", "/api/tasks"), res, undefined, ["tasks"]);
    expect(Array.isArray(arrayBody())).toBe(true);
  });

  it("returns at least the tasks created in beforeEach", async () => {
    const { res, arrayBody } = makeRes();
    await handleTaskRequest(makeReq("GET", "/api/tasks"), res, undefined, ["tasks"]);
    expect(arrayBody().length).toBeGreaterThanOrEqual(3);
  });

  it("filters by status=active — only active tasks returned", async () => {
    const { res, arrayBody } = makeRes();
    await handleTaskRequest(makeReq("GET", "/api/tasks?status=active"), res, undefined, ["tasks"]);
    const rows = arrayBody();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every(r => r["status"] === "active")).toBe(true);
  });

  it("filters by status=completed", async () => {
    const { res, arrayBody } = makeRes();
    await handleTaskRequest(makeReq("GET", "/api/tasks?status=completed"), res, undefined, ["tasks"]);
    const rows = arrayBody();
    expect(rows.every(r => r["status"] === "completed")).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("each task has a boolean compliant field", async () => {
    const { res, arrayBody } = makeRes();
    await handleTaskRequest(makeReq("GET", "/api/tasks"), res, undefined, ["tasks"]);
    for (const t of arrayBody()) {
      expect(typeof t["compliant"]).toBe("boolean");
    }
  });

  it("filters by compliant=false — non-compliant tasks only", async () => {
    const { res, arrayBody } = makeRes();
    await handleTaskRequest(makeReq("GET", "/api/tasks?compliant=false"), res, undefined, ["tasks"]);
    for (const t of arrayBody()) {
      expect(t["compliant"]).toBe(false);
    }
  });

  it("filters by project_id — returns only tasks for that project", async () => {
    const db = getDb();
    const projId = "proj-test-filter-" + Date.now();
    db.insert(projects).values({ id: projId, title: "Filter Project", type: "kanban" }).run();
    const task = await createTask({ title: "Project task", project_id: projId });
    const taskId = task["id"] as string;

    const { res, arrayBody } = makeRes();
    await handleTaskRequest(
      makeReq("GET", `/api/tasks?project_id=${projId}`),
      res,
      undefined,
      ["tasks"],
    );
    const rows = arrayBody();
    expect(rows.some(r => r["id"] === taskId)).toBe(true);
    expect(rows.every(r => r["projectId"] === projId)).toBe(true);

    db.delete(tasks).where(eq(tasks.projectId, projId)).run();
    db.delete(projects).where(eq(projects.id, projId)).run();
  });
});

// ── GET /api/tasks/:id — fetch single ────────────────────────────────────────

describe("GET /api/tasks/:id — fetch single", () => {
  it("returns a single task by id", async () => {
    const created = await createTask({ title: "Fetch me" });
    const id = created["id"] as string;
    const { body, statusCode } = await getTask(id);
    expect(statusCode).toBe(200);
    expect(body["id"]).toBe(id);
    expect(body["title"]).toBe("Fetch me");
  });

  it("returns 404 for a nonexistent id", async () => {
    const { body, statusCode } = await getTask("does-not-exist-at-all");
    expect(statusCode).toBe(404);
    expect(body["error"]).toBeTruthy();
  });

  it("single task response includes compliant field", async () => {
    const created = await createTask({ title: "Compliant check" });
    const id = created["id"] as string;
    const { body } = await getTask(id);
    expect(typeof body["compliant"]).toBe("boolean");
  });

  it("single task includes complianceInherited field", async () => {
    const created = await createTask({ title: "Inheritance check" });
    const id = created["id"] as string;
    const { body } = await getTask(id);
    expect(typeof body["complianceInherited"]).toBe("boolean");
  });
});

// ── PATCH /api/tasks/:id — updates ───────────────────────────────────────────

describe("PATCH /api/tasks/:id — updates", () => {
  it("updates title", async () => {
    const created = await createTask({ title: "Old title" });
    const id = created["id"] as string;
    const updated = await patchTask(id, { title: "New title" });
    expect(updated["title"]).toBe("New title");
  });

  it("updates status", async () => {
    const created = await createTask({ title: "Status update task" });
    const id = created["id"] as string;
    const updated = await patchTask(id, { status: "completed" });
    expect(updated["status"]).toBe("completed");
  });

  it("updates work_state", async () => {
    const created = await createTask({ title: "Work state task" });
    const id = created["id"] as string;
    const updated = await patchTask(id, { work_state: "in_progress" });
    expect(updated["workState"]).toBe("in_progress");
  });

  it("updates notes", async () => {
    const created = await createTask({ title: "Notes update" });
    const id = created["id"] as string;
    const updated = await patchTask(id, { notes: "updated notes content" });
    expect(updated["notes"]).toBe("updated notes content");
  });

  it("updates model_tier", async () => {
    const created = await createTask({ title: "Model tier task" });
    const id = created["id"] as string;
    const updated = await patchTask(id, { model_tier: "strong" });
    expect(updated["modelTier"]).toBe("strong");
  });

  it("updates compliance_required via compliant alias", async () => {
    const created = await createTask({ title: "Compliance toggle" });
    const id = created["id"] as string;
    const updated = await patchTask(id, { compliant: true });
    // The PATCH fieldMap maps `compliant` → `complianceRequired`
    expect(Boolean(updated["complianceRequired"])).toBe(true);
  });

  it("updates review_state", async () => {
    const created = await createTask({ title: "Review state task" });
    const id = created["id"] as string;
    const updated = await patchTask(id, { review_state: "accepted" });
    expect(updated["reviewState"]).toBe("accepted");
  });

  it("updates owner", async () => {
    const created = await createTask({ title: "Owner update task" });
    const id = created["id"] as string;
    const updated = await patchTask(id, { owner: "rafe" });
    expect(updated["owner"]).toBe("rafe");
  });

  it("updatedAt timestamp advances on PATCH", async () => {
    const created = await createTask({ title: "Timestamp advance task" });
    const id = created["id"] as string;
    const original = created["updatedAt"] as string;

    await new Promise(r => setTimeout(r, 15));

    const updated = await patchTask(id, { title: "Slightly later" });
    expect((updated["updatedAt"] as string) >= original).toBe(true);
  });
});

// ── DELETE /api/tasks/:id ─────────────────────────────────────────────────────

describe("DELETE /api/tasks/:id", () => {
  it("deletes a task and returns deleted:true", async () => {
    const created = await createTask({ title: "To be deleted" });
    const id = created["id"] as string;
    // Remove from cleanup list — we're deleting it manually
    const idx = createdIds.indexOf(id);
    if (idx !== -1) createdIds.splice(idx, 1);

    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("DELETE", `/api/tasks/${id}`),
      res,
      id,
      ["tasks", id],
    );
    expect(body()["deleted"]).toBe(true);
  });

  it("task is actually removed from DB after DELETE", async () => {
    const created = await createTask({ title: "Gone after delete" });
    const id = created["id"] as string;
    const idx = createdIds.indexOf(id);
    if (idx !== -1) createdIds.splice(idx, 1);

    await handleTaskRequest(
      makeReq("DELETE", `/api/tasks/${id}`),
      makeRes().res,
      id,
      ["tasks", id],
    );

    const row = getDb().select().from(tasks).where(eq(tasks.id, id)).get();
    expect(row).toBeUndefined();
  });
});

// ── Deduplication (24h window) ────────────────────────────────────────────────

describe("Deduplication (24h window)", () => {
  it("returns 409 with duplicate:true on duplicate title + agent", async () => {
    const first = await createTask({ title: "Deduplicate me x17", agent: "programmer" });
    const firstId = first["id"] as string;

    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("POST", "/api/tasks", { title: "Deduplicate me x17", agent: "programmer" }),
      res,
      undefined,
      ["tasks"],
    );
    expect(res.statusCode).toBe(409);
    const b = body();
    expect(b["duplicate"]).toBe(true);
    const existing = b["existing"] as Record<string, unknown>;
    expect(existing["id"]).toBe(firstId);
  });

  it("dedup response includes existing task object", async () => {
    await createTask({ title: "Dedup body check", agent: "writer" });

    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("POST", "/api/tasks", { title: "Dedup body check", agent: "writer" }),
      res,
      undefined,
      ["tasks"],
    );
    const b = body();
    const existing = b["existing"] as Record<string, unknown>;
    expect(existing["title"]).toBe("Dedup body check");
    expect(existing["id"]).toBeTruthy();
  });

  it("allows creation when force=true even with duplicate title", async () => {
    await createTask({ title: "Force override task zz", agent: "researcher" });

    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("POST", "/api/tasks", {
        title: "Force override task zz",
        agent: "researcher",
        force: true,
      }),
      res,
      undefined,
      ["tasks"],
    );
    expect(res.statusCode).toBe(201);
    const b = body();
    if (b["id"]) createdIds.push(b["id"] as string);
  });
});

// ── Compliance inheritance ────────────────────────────────────────────────────

describe("Compliance inheritance from project", () => {
  it("task inherits compliant=true from a compliant project", async () => {
    const db = getDb();
    const projId = "compliant-proj-" + Date.now();
    db.insert(projects).values({
      id: projId,
      title: "Compliant Project",
      type: "kanban",
      complianceRequired: true,
    }).run();

    const task = await createTask({
      title: "Inherited compliance check",
      project_id: projId,
    });
    const id = task["id"] as string;

    const { body } = await getTask(id);
    expect(body["compliant"]).toBe(true);
    expect(body["complianceInherited"]).toBe(true);

    db.delete(tasks).where(eq(tasks.id, id)).run();
    createdIds.splice(createdIds.indexOf(id), 1);
    db.delete(projects).where(eq(projects.id, projId)).run();
  });

  it("task remains non-compliant when project has complianceRequired=false", async () => {
    const db = getDb();
    const projId = "non-compliant-proj-" + Date.now();
    db.insert(projects).values({
      id: projId,
      title: "Non-Compliant Project",
      type: "kanban",
      complianceRequired: false,
    }).run();

    const task = await createTask({
      title: "Non-compliant project task",
      project_id: projId,
    });
    const id = task["id"] as string;

    const { body } = await getTask(id);
    expect(body["compliant"]).toBe(false);
    expect(body["complianceInherited"]).toBe(false);

    db.delete(tasks).where(eq(tasks.id, id)).run();
    createdIds.splice(createdIds.indexOf(id), 1);
    db.delete(projects).where(eq(projects.id, projId)).run();
  });

  it("task-level complianceRequired wins even without project", async () => {
    const task = await createTask({ title: "Self-compliant task" });
    const id = task["id"] as string;

    await patchTask(id, { compliance_required: true });

    const { body } = await getTask(id);
    expect(body["compliant"]).toBe(true);
  });
});

// ── Method not allowed ────────────────────────────────────────────────────────

describe("Method not allowed", () => {
  it("returns 405 for PUT on /api/tasks (list route)", async () => {
    const { res } = makeRes();
    await handleTaskRequest(
      makeReq("PUT", "/api/tasks", {}),
      res,
      undefined,
      ["tasks"],
    );
    expect(res.statusCode).toBe(405);
  });

  it("returns 405 for PUT on /api/tasks/:id (single-task route)", async () => {
    const { res } = makeRes();
    await handleTaskRequest(
      makeReq("PUT", "/api/tasks/some-id", {}),
      res,
      "some-id",
      ["tasks", "some-id"],
    );
    expect(res.statusCode).toBe(405);
  });
});

// ── Sub-routes ────────────────────────────────────────────────────────────────

describe("Sub-routes", () => {
  it("GET /api/tasks/open returns active/inbox/waiting_on tasks", async () => {
    await createTask({ title: "Open task", status: "active" });
    const { res, arrayBody } = makeRes();
    await handleTaskRequest(
      makeReq("GET", "/api/tasks/open"),
      res,
      "open",       // id = "open" triggers the special branch
      ["tasks", "open"],
    );
    const rows = arrayBody();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.every(r => ["inbox", "active", "waiting_on"].includes(r["status"] as string))).toBe(true);
  });

  it("POST /api/tasks/:id/archive changes status to archived", async () => {
    const created = await createTask({ title: "Archive me" });
    const id = created["id"] as string;

    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("POST", `/api/tasks/${id}/archive`),
      res,
      id,
      ["tasks", id, "archive"],
    );
    const b = body();
    expect(b["status"]).toBe("archived");
  });

  it("GET /api/tasks/:id/artifact returns artifact_path field", async () => {
    const created = await createTask({ title: "Artifact task" });
    const id = created["id"] as string;

    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("GET", `/api/tasks/${id}/artifact`),
      res,
      id,
      ["tasks", id, "artifact"],
    );
    const b = body();
    expect("artifact_path" in b).toBe(true);
  });

  it("PATCH /api/tasks/:id/review-state updates reviewState", async () => {
    const created = await createTask({ title: "Review state patch task" });
    const id = created["id"] as string;

    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("PATCH", `/api/tasks/${id}/review-state`, { review_state: "accepted" }),
      res,
      id,
      ["tasks", id, "review-state"],
    );
    const b = body();
    expect(b["reviewState"]).toBe("accepted");
  });

  it("GET /api/tasks/:id/runs returns runs array", async () => {
    const created = await createTask({ title: "Runs check" });
    const id = created["id"] as string;

    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("GET", `/api/tasks/${id}/runs`),
      res,
      id,
      ["tasks", id, "runs"],
    );
    const b = body();
    expect(Array.isArray(b["runs"])).toBe(true);
  });

  it("PATCH /api/tasks/:id/compliance requires boolean compliant field", async () => {
    const created = await createTask({ title: "Compliance sub-route task" });
    const id = created["id"] as string;

    // Missing compliant field → 400
    const { res: r1, statusCode: sc1 } = makeRes();
    await handleTaskRequest(
      makeReq("PATCH", `/api/tasks/${id}/compliance`, { compliant: "yes" }),
      r1,
      id,
      ["tasks", id, "compliance"],
    );
    expect(sc1()).toBe(400);

    // Valid boolean → 200
    const { res: r2, body: b2 } = makeRes();
    await handleTaskRequest(
      makeReq("PATCH", `/api/tasks/${id}/compliance`, { compliant: true }),
      r2,
      id,
      ["tasks", id, "compliance"],
    );
    expect(r2.statusCode).toBe(200);
    expect(Boolean(b2()["complianceRequired"])).toBe(true);
  });
});
