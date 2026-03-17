import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/connection.js";
import { workflowDefinitions, workflowRuns, workflowEvents, tasks } from "../src/db/schema.js";
import { WorkflowExecutor } from "../src/workflow/engine.js";
import { seedDefaultWorkflows } from "../src/workflow/seeds.js";

describe("Workflow Engine", () => {
  let executor: WorkflowExecutor;

  beforeEach(() => {
    executor = new WorkflowExecutor();
  });

  describe("Workflow Seeding", () => {
    it("should seed default workflows", () => {
      seedDefaultWorkflows();
      const db = getDb();
      const workflows = db.select().from(workflowDefinitions).all();
      expect(workflows.length).toBeGreaterThanOrEqual(10);

      const names = workflows.map(w => w.name);
      expect(names).toContain("task-router");
      expect(names).toContain("reflection-cycle");
      expect(names).toContain("calendar-sync");
    });

    it("should be idempotent", () => {
      seedDefaultWorkflows();
      const count2 = seedDefaultWorkflows();
      expect(count2).toBe(0);
    });
  });

  describe("Run Lifecycle", () => {
    it("should create a workflow run", () => {
      const db = getDb();
      const wfId = randomUUID();
      db.insert(workflowDefinitions).values({
        id: wfId,
        name: `test-wf-${randomUUID().slice(0, 8)}`,
        version: 1,
        nodes: [{ id: "start", type: "notify", config: { channel: "internal", message_template: "test" } }],
        edges: [],
        isActive: true,
      }).run();

      const wf = db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).get()!;
      const run = executor.startRun(wf, { triggerType: "manual" });

      expect(run.status).toBe("pending");
      expect(run.workflowId).toBe(wfId);
    });

    it("should advance pending to running with current node set", async () => {
      const db = getDb();
      const wfId = randomUUID();
      db.insert(workflowDefinitions).values({
        id: wfId,
        name: `test-advance-${randomUUID().slice(0, 8)}`,
        version: 1,
        nodes: [
          { id: "step1", type: "notify", config: { channel: "internal", message_template: "hello" } },
          { id: "step2", type: "notify", config: { channel: "internal", message_template: "done" } },
        ],
        edges: [],
        isActive: true,
      }).run();

      const wf = db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).get()!;
      const run = executor.startRun(wf);

      const didWork = await executor.advance(run);
      expect(didWork).toBe(true);

      const updated = db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).get()!;
      expect(updated.status).toBe("running");
      expect(updated.currentNode).toBe("step1");
    });

    it("should deduplicate runs for the same task", () => {
      const db = getDb();
      const taskId = randomUUID();
      db.insert(tasks).values({ id: taskId, title: "Dedup test", status: "active" }).run();

      const wfId = randomUUID();
      db.insert(workflowDefinitions).values({
        id: wfId,
        name: `test-dedup-${randomUUID().slice(0, 8)}`,
        version: 1,
        nodes: [{ id: "start", type: "notify", config: { channel: "internal", message_template: "test" } }],
        edges: [],
        isActive: true,
      }).run();

      const wf = db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)).get()!;

      const run1 = executor.startRun(wf, { task: { id: taskId }, triggerType: "task_match" });
      const run2 = executor.startRun(wf, { task: { id: taskId }, triggerType: "task_match" });

      expect(run2.id).toBe(run1.id);
    });
  });

  describe("Workflow Matching", () => {
    it("should match task-router for programmer tasks", () => {
      seedDefaultWorkflows();
      const matched = executor.matchWorkflow({ agent: "programmer" });
      expect(matched).not.toBeNull();
      expect(matched!.name).toBe("task-router");
    });

    it("should return null for unknown agent types", () => {
      seedDefaultWorkflows();
      const matched = executor.matchWorkflow({ agent: "nonexistent" });
      expect(matched).toBeNull();
    });
  });

  describe("Event Emission", () => {
    it("should emit events to the event bus", () => {
      const db = getDb();
      const eventId = executor.emitEvent("test.event", { foo: "bar" }, "test");
      expect(eventId).toBeDefined();

      const event = db.select().from(workflowEvents).where(eq(workflowEvents.id, eventId)).get()!;
      expect(event.eventType).toBe("test.event");
      expect(event.processed).toBe(false);
    });
  });
});
