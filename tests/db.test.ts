import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "../src/db/connection.js";
import { projects, tasks, agentProfiles, agentStatus, workerRuns, inboxItems } from "../src/db/schema.js";

describe("Database Layer", () => {
  describe("Projects CRUD", () => {
    it("should create and retrieve a project", () => {
      const db = getDb();
      const id = randomUUID();
      db.insert(projects).values({ id, title: "Test Project", type: "kanban" }).run();
      const row = db.select().from(projects).where(eq(projects.id, id)).get();
      expect(row).toBeDefined();
      expect(row!.title).toBe("Test Project");
      expect(row!.type).toBe("kanban");
      expect(row!.archived).toBe(false);
    });

    it("should update a project", () => {
      const db = getDb();
      const id = randomUUID();
      db.insert(projects).values({ id, title: "Old Title", type: "kanban" }).run();
      db.update(projects).set({ title: "New Title" }).where(eq(projects.id, id)).run();
      const row = db.select().from(projects).where(eq(projects.id, id)).get();
      expect(row!.title).toBe("New Title");
    });

    it("should delete a project", () => {
      const db = getDb();
      const id = randomUUID();
      db.insert(projects).values({ id, title: "Doomed", type: "kanban" }).run();
      db.delete(projects).where(eq(projects.id, id)).run();
      const row = db.select().from(projects).where(eq(projects.id, id)).get();
      expect(row).toBeUndefined();
    });
  });

  describe("Tasks CRUD", () => {
    it("should create a task with all fields", () => {
      const db = getDb();
      const projId = randomUUID();
      db.insert(projects).values({ id: projId, title: "Proj", type: "kanban" }).run();

      const taskId = randomUUID();
      db.insert(tasks).values({
        id: taskId,
        title: "Fix bug",
        status: "active",
        owner: "lobs",
        workState: "not_started",
        projectId: projId,
        notes: "Important fix",
        agent: "programmer",
        modelTier: "standard",
      }).run();

      const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      expect(row).toBeDefined();
      expect(row!.title).toBe("Fix bug");
      expect(row!.status).toBe("active");
      expect(row!.agent).toBe("programmer");
      expect(row!.projectId).toBe(projId);
      expect(row!.escalationTier).toBe(0);
      expect(row!.retryCount).toBe(0);
    });

    it("should filter tasks by status", () => {
      const db = getDb();
      const id1 = randomUUID();
      const id2 = randomUUID();
      db.insert(tasks).values({ id: id1, title: "Active", status: "active" }).run();
      db.insert(tasks).values({ id: id2, title: "Done", status: "completed" }).run();

      const active = db.select().from(tasks).where(eq(tasks.status, "active")).all();
      expect(active.length).toBeGreaterThanOrEqual(1);
      expect(active.some(t => t.id === id1)).toBe(true);
      expect(active.some(t => t.id === id2)).toBe(false);
    });

    it("should filter tasks by multiple statuses", () => {
      const db = getDb();
      const open = db.select().from(tasks)
        .where(inArray(tasks.status, ["active", "inbox"]))
        .all();
      // Should include active tasks created above
      expect(open.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Agent Profiles & Status", () => {
    it("should create and query agent profiles", () => {
      const db = getDb();
      const id = randomUUID();
      db.insert(agentProfiles).values({
        id,
        agentType: "test-agent",
        displayName: "Test Agent",
        policyTier: "standard",
      }).run();
      const row = db.select().from(agentProfiles).where(eq(agentProfiles.agentType, "test-agent")).get();
      expect(row!.displayName).toBe("Test Agent");
    });

    it("should upsert agent status", () => {
      const db = getDb();
      db.insert(agentStatus).values({
        agentType: "programmer",
        status: "idle",
      }).onConflictDoUpdate({
        target: agentStatus.agentType,
        set: { status: "busy" },
      }).run();

      const row = db.select().from(agentStatus).where(eq(agentStatus.agentType, "programmer")).get();
      expect(row).toBeDefined();
    });
  });

  describe("Worker Runs", () => {
    it("should record a worker run lifecycle", () => {
      const db = getDb();
      const taskId = randomUUID();
      db.insert(tasks).values({ id: taskId, title: "Worker test", status: "active" }).run();

      db.insert(workerRuns).values({
        workerId: "session-123",
        agentType: "programmer",
        taskId,
        startedAt: new Date().toISOString(),
      }).run();

      const active = db.select().from(workerRuns)
        .where(and(eq(workerRuns.workerId, "session-123")))
        .get();
      expect(active).toBeDefined();
      expect(active!.endedAt).toBeNull();

      db.update(workerRuns).set({
        endedAt: new Date().toISOString(),
        succeeded: true,
        summary: "Fixed the bug",
      }).where(eq(workerRuns.workerId, "session-123")).run();

      const completed = db.select().from(workerRuns)
        .where(eq(workerRuns.workerId, "session-123"))
        .get();
      expect(completed!.endedAt).toBeDefined();
      expect(completed!.succeeded).toBe(true);
    });
  });

  describe("Inbox Items", () => {
    it("should create and read inbox items", () => {
      const db = getDb();
      const id = randomUUID();
      db.insert(inboxItems).values({
        id,
        title: "Review needed",
        content: "Please review PR #42",
        isRead: false,
      }).run();

      const row = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
      expect(row!.title).toBe("Review needed");
      expect(row!.isRead).toBe(false);

      db.update(inboxItems).set({ isRead: true }).where(eq(inboxItems.id, id)).run();
      const updated = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
      expect(updated!.isRead).toBe(true);
    });
  });
});
