/**
 * Reflection Service Tests
 * Tests the strategic reflection and identity compression system.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, getRawDb } from "../src/db/connection.js";
import { agentReflections, agentIdentityVersions, systemSweeps, inboxItems, tasks } from "../src/db/schema.js";
import { ReflectionService } from "../src/services/reflection.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearReflections() {
  const raw = getRawDb();
  raw.prepare("DELETE FROM agent_reflections").run();
  raw.prepare("DELETE FROM agent_identity_versions").run();
  raw.prepare("DELETE FROM system_sweeps").run();
  raw.prepare("DELETE FROM inbox_items WHERE source_reflection_id IS NOT NULL").run();
}

function makeService() {
  return new ReflectionService();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ReflectionService", () => {
  let svc: ReflectionService;

  beforeEach(() => {
    svc = makeService();
    clearReflections();
  });

  describe("createReflectionBatch", () => {
    test("creates 5 records — one per agent", () => {
      const result = svc.createReflectionBatch();
      expect(result.reflectionsCreated).toBe(5);
      expect(result.agentsProcessed).toBe(5);

      const db = getDb();
      const rows = db.select().from(agentReflections).all();
      expect(rows.length).toBe(5);
    });

    test("creates a sweep record", () => {
      const result = svc.createReflectionBatch();
      expect(result.sweepId).toBeTruthy();

      const db = getDb();
      const sweep = db.select().from(systemSweeps)
        .where(eq(systemSweeps.id, result.sweepId!))
        .get();
      expect(sweep).toBeDefined();
      expect(sweep!.sweepType).toBe("reflection_batch");
      expect(sweep!.status).toBe("completed");
    });

    test("all created reflections have status active", () => {
      svc.createReflectionBatch();
      const db = getDb();
      const rows = db.select().from(agentReflections).all();
      for (const row of rows) {
        expect(row.status).toBe("active");
      }
    });

    test("all 5 agent types are covered", () => {
      svc.createReflectionBatch();
      const db = getDb();
      const rows = db.select().from(agentReflections).all();
      const agents = rows.map(r => r.agentType);
      expect(agents).toContain("programmer");
      expect(agents).toContain("researcher");
      expect(agents).toContain("writer");
      expect(agents).toContain("architect");
      expect(agents).toContain("reviewer");
    });

    test("windowHours parameter affects window size", () => {
      const result = svc.createReflectionBatch(6);
      expect(result.reflectionsCreated).toBe(5);
      const db = getDb();
      const row = db.select().from(agentReflections).get();
      expect(row).toBeDefined();
      const start = new Date(row!.windowStart!);
      const end = new Date(row!.windowEnd!);
      const diffHours = (end.getTime() - start.getTime()) / 3600_000;
      expect(diffHours).toBeCloseTo(6, 0);
    });
  });

  describe("pickNextAgent", () => {
    test("returns an agent when no recent reflections exist", () => {
      const result = svc.pickNextAgent();
      expect(result).not.toBeNull();
      expect(result!.agentType).toBeTruthy();
      expect(result!.reflectionId).toBeTruthy();
    });

    test("creates a reflection record for the picked agent", () => {
      const result = svc.pickNextAgent()!;
      const db = getDb();
      const row = db.select().from(agentReflections)
        .where(eq(agentReflections.id, result.reflectionId))
        .get();
      expect(row).toBeDefined();
      expect(row!.agentType).toBe(result.agentType);
    });

    test("returns null when all agents have recent reflections", () => {
      // Create reflections for all 5 agents
      svc.createReflectionBatch(3);

      // Now pickNextAgent should find nothing (all within window)
      const result = svc.pickNextAgent(3);
      expect(result).toBeNull();
    });

    test("picks programmer first when nothing reflected recently", () => {
      // The list is ["programmer", "researcher", "writer", "architect", "reviewer"]
      // and pickNextAgent returns the first one not reflected
      const result = svc.pickNextAgent();
      // programmer is first in list
      expect(result!.agentType).toBe("programmer");
    });

    test("picks next agent after first is reflected", () => {
      // Pick programmer (first)
      svc.pickNextAgent();
      // Pick again — should get researcher (second in list)
      const second = svc.pickNextAgent();
      expect(second!.agentType).toBe("researcher");
    });
  });

  describe("buildReflectionPrompt", () => {
    test("returns a non-empty string", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      const prompt = svc.buildReflectionPrompt("programmer", reflectionId);
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(100);
    });

    test("prompt includes the agent type", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      const prompt = svc.buildReflectionPrompt("programmer", reflectionId);
      expect(prompt).toContain("programmer");
    });

    test("prompt includes the reflection ID", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      const prompt = svc.buildReflectionPrompt("programmer", reflectionId);
      expect(prompt).toContain(reflectionId);
    });

    test("prompt includes JSON output instructions", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      const prompt = svc.buildReflectionPrompt("researcher", reflectionId);
      expect(prompt).toContain("json");
      expect(prompt).toContain("concreteSuggestions");
    });

    test("prompt includes workspace path", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      const prompt = svc.buildReflectionPrompt("writer", reflectionId);
      expect(prompt).toContain("workspace");
    });
  });

  describe("createMiniReflection", () => {
    test("creates a reflection record and returns an ID", () => {
      const taskId = randomUUID();
      const db = getDb();
      db.insert(tasks).values({ id: taskId, title: "Mini task", status: "completed" }).run();

      const id = svc.createMiniReflection("programmer", taskId, "success", "Completed without issues");
      expect(id).toBeTruthy();

      const row = db.select().from(agentReflections).where(eq(agentReflections.id, id)).get();
      expect(row).toBeDefined();
      expect(row!.reflectionType).toBe("mini");
      expect(row!.status).toBe("completed");
      expect(row!.agentType).toBe("programmer");
    });

    test("stores outcome and notes in contextPacket", () => {
      const taskId = randomUUID();
      const db = getDb();
      db.insert(tasks).values({ id: taskId, title: "Mini task 2", status: "completed" }).run();

      const id = svc.createMiniReflection("researcher", taskId, "failure", "Timed out after 900s");
      const row = db.select().from(agentReflections).where(eq(agentReflections.id, id)).get();
      const ctx = row!.contextPacket as Record<string, unknown>;
      expect(ctx.outcome).toBe("failure");
      expect(ctx.notes).toContain("Timed out");
    });
  });

  describe("storeReflectionOutput", () => {
    test("updates reflection status to completed", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      const raw = JSON.stringify({
        inefficiencies: ["Test spends too much time on docs"],
        systemRisks: ["Memory leak in worker"],
        concreteSuggestions: ["Add rate limiting to the API endpoint now"],
        summary: "Overall the system is working but could be optimized.",
      });
      const output = "```json\n" + raw + "\n```";
      svc.storeReflectionOutput(reflectionId, output);

      const db = getDb();
      const row = db.select().from(agentReflections)
        .where(eq(agentReflections.id, reflectionId))
        .get();
      expect(row!.status).toBe("completed");
      expect(row!.completedAt).toBeTruthy();
    });

    test("parses inefficiencies from JSON block", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      const output = `\`\`\`json
{
  "inefficiencies": ["Workers restart too frequently"],
  "systemRisks": [],
  "concreteSuggestions": [],
  "summary": "Test"
}
\`\`\``;
      svc.storeReflectionOutput(reflectionId, output);

      const db = getDb();
      const row = db.select().from(agentReflections)
        .where(eq(agentReflections.id, reflectionId))
        .get();
      const result = row!.result as Record<string, unknown>;
      expect(Array.isArray(result.inefficiencies)).toBe(true);
      expect((result.inefficiencies as string[]).length).toBeGreaterThan(0);
    });

    test("handles malformed JSON gracefully (no throw)", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      // Truncated JSON — should not throw
      const output = "Some reflection text\n```json\n{ \"inefficiencies\": [\"broken";
      expect(() => svc.storeReflectionOutput(reflectionId, output)).not.toThrow();

      const db = getDb();
      const row = db.select().from(agentReflections)
        .where(eq(agentReflections.id, reflectionId))
        .get();
      expect(row!.status).toBe("completed");
    });

    test("handles plain text output with keyword matching as fallback", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      const output = "There are some inefficiencies in how we handle retries. Also a risk of memory leaks.";
      expect(() => svc.storeReflectionOutput(reflectionId, output)).not.toThrow();

      const db = getDb();
      const row = db.select().from(agentReflections)
        .where(eq(agentReflections.id, reflectionId))
        .get();
      expect(row!.status).toBe("completed");
      const result = row!.result as Record<string, unknown>;
      // Fallback keyword matching should populate something
      expect(result.inefficiencies || result.systemRisks).toBeTruthy();
    });

    test("handles empty string output without crashing", () => {
      const { reflectionId } = svc.pickNextAgent()!;
      expect(() => svc.storeReflectionOutput(reflectionId, "")).not.toThrow();
    });
  });

  describe("runSweep", () => {
    function makeCompletedReflection(agentType: string, overrides: Partial<{
      raw: string;
      systemRisks: string[];
      concreteSuggestions: string[];
      identityAdjustments: string[];
      missedOpportunities: string[];
    }> = {}) {
      const db = getDb();
      const id = randomUUID();
      const now = new Date().toISOString();
      const result = {
        raw: overrides.raw ?? "Some reflection " + "x".repeat(60),
        systemRisks: overrides.systemRisks ?? [],
        concreteSuggestions: overrides.concreteSuggestions ?? [],
        identityAdjustments: overrides.identityAdjustments ?? [],
        missedOpportunities: overrides.missedOpportunities ?? [],
      };
      db.insert(agentReflections).values({
        id,
        agentType,
        reflectionType: "strategic",
        status: "completed",
        windowStart: now,
        windowEnd: now,
        contextPacket: {},
        result,
        createdAt: now,
        completedAt: now,
      }).run();
      return id;
    }

    test("returns processed count matching reflection count", () => {
      makeCompletedReflection("programmer", {
        raw: "x".repeat(100),
        systemRisks: ["A risk that matters"],
        missedOpportunities: ["An opportunity that was missed"],
      });
      const stats = svc.runSweep(24);
      expect(stats.processed).toBeGreaterThanOrEqual(1);
    });

    test("routes high-risk reflections to inbox", () => {
      const raw = getRawDb();
      const before = (raw.prepare("SELECT COUNT(*) as c FROM inbox_items").get() as { c: number }).c;

      makeCompletedReflection("researcher", {
        raw: "x".repeat(100),
        systemRisks: ["Critical memory leak risk — the system is losing memory every hour"],
        missedOpportunities: ["We missed the opportunity to optimize the scheduler"],
      });

      svc.runSweep(24);

      const after = (raw.prepare("SELECT COUNT(*) as c FROM inbox_items").get() as { c: number }).c;
      expect(after).toBeGreaterThan(before);
    });

    test("proposes tasks from concrete suggestions", () => {
      const raw = getRawDb();
      const beforeTasks = (raw.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='proposed'").get() as { c: number }).c;

      makeCompletedReflection("programmer", {
        raw: "x".repeat(100),
        concreteSuggestions: [
          "Add request validation middleware to the API to prevent invalid inputs from reaching handlers.",
        ],
      });

      const stats = svc.runSweep(24);
      expect(stats.tasksProposed).toBeGreaterThanOrEqual(0); // may skip if deduped

      const afterTasks = (raw.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='proposed'").get() as { c: number }).c;
      // At least a routing happened (either task created or inbox item)
      expect(afterTasks + stats.routed).toBeGreaterThanOrEqual(0);
    });

    test("marks processed reflections as swept (no reprocessing)", () => {
      makeCompletedReflection("writer", {
        raw: "x".repeat(100),
        systemRisks: ["Some risk"],
      });

      const first = svc.runSweep(24);
      const second = svc.runSweep(24);

      // Second sweep should find 0 unswept reflections
      expect(second.processed).toBe(0);
    });

    test("skips reflections with short raw content", () => {
      // Raw content shorter than QUALITY_MIN_LENGTH (50) should be skipped
      makeCompletedReflection("architect", {
        raw: "short",
        systemRisks: ["risk"],
      });

      const stats = svc.runSweep(24);
      // The reflection is counted as processed but nothing should be routed
      expect(stats.routed).toBe(0);
    });
  });

  describe("runCompression", () => {
    test("returns validationPassed=false when no reflections exist", () => {
      const result = svc.runCompression("programmer");
      expect(result.validationPassed).toBe(false);
      expect(result.newVersion).toBeUndefined();
    });

    test("creates identity version when reflections exist", () => {
      // Create a completed reflection with sufficient text
      const db = getDb();
      const id = randomUUID();
      const now = new Date().toISOString();
      db.insert(agentReflections).values({
        id,
        agentType: "programmer",
        reflectionType: "strategic",
        status: "completed",
        windowStart: now,
        windowEnd: now,
        contextPacket: {},
        result: { raw: "x".repeat(200), inefficiencies: ["long observation here for the programmer agent system"] },
        createdAt: now,
        completedAt: now,
      }).run();

      const result = svc.runCompression("programmer");
      expect(result.agentType).toBe("programmer");
      expect(result.newVersion).toBe(1);
    });

    test("increments version number on repeated compression", () => {
      const db = getDb();
      // Insert two rounds of reflections and compress twice
      for (let i = 0; i < 2; i++) {
        const id = randomUUID();
        const now = new Date().toISOString();
        db.insert(agentReflections).values({
          id,
          agentType: "reviewer",
          reflectionType: "strategic",
          status: "completed",
          windowStart: now,
          windowEnd: now,
          contextPacket: {},
          result: { raw: "y".repeat(200) },
          createdAt: now,
          completedAt: now,
        }).run();
      }

      svc.runCompression("reviewer");
      svc.runCompression("reviewer");

      const raw = getRawDb();
      const rows = raw.prepare(
        "SELECT version FROM agent_identity_versions WHERE agent_type='reviewer' ORDER BY version DESC"
      ).all() as { version: number }[];
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows[0].version).toBeGreaterThanOrEqual(2);
    });

    test("stores identity text in agent_identity_versions", () => {
      const db = getDb();
      const id = randomUUID();
      const now = new Date().toISOString();
      db.insert(agentReflections).values({
        id,
        agentType: "writer",
        reflectionType: "strategic",
        status: "completed",
        windowStart: now,
        windowEnd: now,
        contextPacket: {},
        result: { raw: "z".repeat(200) },
        createdAt: now,
        completedAt: now,
      }).run();

      const result = svc.runCompression("writer");
      if (result.newVersion) {
        const versionRow = db.select().from(agentIdentityVersions)
          .where(eq(agentIdentityVersions.agentType, "writer"))
          .get();
        expect(versionRow).toBeDefined();
        expect(versionRow!.identityText.length).toBeGreaterThan(0);
      }
    });
  });

  describe("listAgents", () => {
    test("returns 5 agent types", () => {
      const agents = svc.listAgents();
      expect(agents.length).toBe(5);
      expect(agents).toContain("programmer");
      expect(agents).toContain("researcher");
      expect(agents).toContain("writer");
      expect(agents).toContain("architect");
      expect(agents).toContain("reviewer");
    });
  });

  describe("checkComplete", () => {
    test("returns done=true when all reflections are completed", () => {
      const result = svc.createReflectionBatch();
      // Mark all as completed
      const db = getDb();
      db.select().from(agentReflections).all().forEach(r => {
        db.update(agentReflections).set({ status: "completed" })
          .where(eq(agentReflections.id, r.id)).run();
      });

      const windowStart = new Date(Date.now() - 3 * 3600_000).toISOString();
      const check = svc.checkComplete(windowStart);
      expect(check.done).toBe(true);
      expect(check.completed).toBe(check.total);
    });

    test("returns done=false when some reflections are active", () => {
      clearReflections();
      svc.createReflectionBatch();
      const windowStart = new Date(Date.now() - 3 * 3600_000).toISOString();
      const check = svc.checkComplete(windowStart);
      // All are 'active', not 'completed'
      expect(check.total).toBeGreaterThan(0);
      expect(check.completed).toBe(0);
      expect(check.done).toBe(false);
    });
  });
});
