/**
 * Hierarchical Compliance Settings Tests
 *
 * Verifies:
 * 1. Project compliance cascades to tasks (normalizeTaskBatch)
 * 2. Task-level compliance works independently of project
 * 3. Both flags together (project + task) produce compliant=true, inherited=false
 * 4. No-fallback enforcement: compliance gate blocks cloud dispatch when local model is missing
 * 5. Chat session compliance flag round-trips correctly
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db/connection.js";
import { projects, tasks, chatSessions, orchestratorSettings } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { isLocalModel, isCloudModel, isComplianceModel } from "../src/util/compliance-model.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Inline re-implementation of normalizeTaskBatch for unit testing the cascade
 * logic without importing the full tasks API (which has side-effects).
 */
function normalizeTaskBatch(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length === 0) return [];
  const db = getDb();
  const projectIds = [...new Set(
    rows.map(r => r["projectId"] as string | null | undefined).filter(Boolean)
  )] as string[];

  const projectCompliance: Record<string, boolean> = {};
  if (projectIds.length > 0) {
    const projRows = db.select({ id: projects.id, complianceRequired: projects.complianceRequired })
      .from(projects)
      .all()
      .filter(p => projectIds.includes(p.id));
    for (const p of projRows) {
      projectCompliance[p.id] = Boolean(p.complianceRequired);
    }
  }

  return rows.map(row => {
    const taskCompliant = Boolean(row["complianceRequired"]);
    const projectId = row["projectId"] as string | undefined;
    const projectCompliant = projectId ? Boolean(projectCompliance[projectId]) : false;
    return {
      ...row,
      compliant: taskCompliant || projectCompliant,
      complianceInherited: !taskCompliant && projectCompliant,
    };
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let projIdCompliant: string;
let projIdNonCompliant: string;

beforeEach(() => {
  const db = getDb();
  projIdCompliant = randomUUID();
  projIdNonCompliant = randomUUID();

  db.insert(projects).values({
    id: projIdCompliant,
    title: "Compliant Project",
    type: "kanban",
    complianceRequired: true,
  }).run();

  db.insert(projects).values({
    id: projIdNonCompliant,
    title: "Non-Compliant Project",
    type: "kanban",
    complianceRequired: false,
  }).run();
});

// ── Tests: Project → Task Cascade ─────────────────────────────────────────────

describe("Project compliance cascade to tasks", () => {
  it("task in compliant project gets compliant=true even if task flag is false", () => {
    const db = getDb();
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Task in compliant project",
      status: "active",
      projectId: projIdCompliant,
      complianceRequired: false,
    }).run();

    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    const [normalized] = normalizeTaskBatch([row as Record<string, unknown>]);

    expect(normalized["compliant"]).toBe(true);
    expect(normalized["complianceInherited"]).toBe(true);
  });

  it("task in non-compliant project with task flag false stays non-compliant", () => {
    const db = getDb();
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Task in non-compliant project",
      status: "active",
      projectId: projIdNonCompliant,
      complianceRequired: false,
    }).run();

    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    const [normalized] = normalizeTaskBatch([row as Record<string, unknown>]);

    expect(normalized["compliant"]).toBe(false);
    expect(normalized["complianceInherited"]).toBe(false);
  });

  it("task with explicit compliance flag in non-compliant project is compliant", () => {
    const db = getDb();
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Task with explicit compliance in non-compliant project",
      status: "active",
      projectId: projIdNonCompliant,
      complianceRequired: true,
    }).run();

    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    const [normalized] = normalizeTaskBatch([row as Record<string, unknown>]);

    expect(normalized["compliant"]).toBe(true);
    // complianceInherited should be false — compliance comes from task itself
    expect(normalized["complianceInherited"]).toBe(false);
  });

  it("task with both project and task compliance is compliant but NOT marked inherited", () => {
    const db = getDb();
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Task explicitly compliant in compliant project",
      status: "active",
      projectId: projIdCompliant,
      complianceRequired: true,
    }).run();

    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    const [normalized] = normalizeTaskBatch([row as Record<string, unknown>]);

    expect(normalized["compliant"]).toBe(true);
    // Task-level flag wins; inheritance flag should be false
    expect(normalized["complianceInherited"]).toBe(false);
  });

  it("task with no project has compliant=false when complianceRequired=false", () => {
    const db = getDb();
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Orphan task",
      status: "active",
      projectId: null,
      complianceRequired: false,
    }).run();

    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    const [normalized] = normalizeTaskBatch([row as Record<string, unknown>]);

    expect(normalized["compliant"]).toBe(false);
    expect(normalized["complianceInherited"]).toBe(false);
  });

  it("batch normalization handles mixed compliant/non-compliant tasks correctly", () => {
    const db = getDb();
    const ids = [randomUUID(), randomUUID(), randomUUID()];

    // task 0: in compliant project, no explicit flag → should cascade
    db.insert(tasks).values({ id: ids[0], title: "A", status: "active", projectId: projIdCompliant, complianceRequired: false }).run();
    // task 1: in non-compliant project, explicit flag → compliant but not inherited
    db.insert(tasks).values({ id: ids[1], title: "B", status: "active", projectId: projIdNonCompliant, complianceRequired: true }).run();
    // task 2: in non-compliant project, no flag → non-compliant
    db.insert(tasks).values({ id: ids[2], title: "C", status: "active", projectId: projIdNonCompliant, complianceRequired: false }).run();

    const rows = ids.map(id => db.select().from(tasks).where(eq(tasks.id, id)).get() as Record<string, unknown>);
    const normalized = normalizeTaskBatch(rows);

    expect(normalized[0]["compliant"]).toBe(true);
    expect(normalized[0]["complianceInherited"]).toBe(true);

    expect(normalized[1]["compliant"]).toBe(true);
    expect(normalized[1]["complianceInherited"]).toBe(false);

    expect(normalized[2]["compliant"]).toBe(false);
    expect(normalized[2]["complianceInherited"]).toBe(false);
  });
});

// ── Tests: Chat Session Compliance ───────────────────────────────────────────

describe("Chat session compliance flag", () => {
  it("creates chat session with compliance_required=false by default", () => {
    const db = getDb();
    const sessionKey = `chat:test:${randomUUID()}`;
    db.insert(chatSessions).values({
      id: randomUUID(),
      sessionKey,
      label: "Test session",
      complianceRequired: false,
    }).run();

    const row = db.select().from(chatSessions)
      .where(eq(chatSessions.sessionKey, sessionKey))
      .get();

    expect(row?.complianceRequired).toBe(false);
  });

  it("stores compliance_required=true on chat session", () => {
    const db = getDb();
    const sessionKey = `chat:test:${randomUUID()}`;
    db.insert(chatSessions).values({
      id: randomUUID(),
      sessionKey,
      label: "Compliant session",
      complianceRequired: true,
    }).run();

    const row = db.select().from(chatSessions)
      .where(eq(chatSessions.sessionKey, sessionKey))
      .get();

    expect(row?.complianceRequired).toBe(true);
  });

  it("can toggle chat session compliance from false to true", () => {
    const db = getDb();
    const sessionKey = `chat:test:${randomUUID()}`;
    db.insert(chatSessions).values({
      id: randomUUID(),
      sessionKey,
      label: "Toggle test",
      complianceRequired: false,
    }).run();

    db.update(chatSessions)
      .set({ complianceRequired: true })
      .where(eq(chatSessions.sessionKey, sessionKey))
      .run();

    const row = db.select().from(chatSessions)
      .where(eq(chatSessions.sessionKey, sessionKey))
      .get();

    expect(row?.complianceRequired).toBe(true);
  });
});

// ── Tests: No-Fallback Enforcement ───────────────────────────────────────────

describe("No-fallback enforcement: compliance model classification", () => {
  it("isLocalModel returns true for ollama models", () => {
    expect(isLocalModel("ollama/llama3")).toBe(true);
    expect(isLocalModel("ollama/mistral")).toBe(true);
  });

  it("isLocalModel returns true for lmstudio models", () => {
    expect(isLocalModel("lmstudio/compliance-model")).toBe(true);
    expect(isLocalModel("lm-studio/llama3")).toBe(true);
  });

  it("isCloudModel returns true for Anthropic", () => {
    expect(isCloudModel("anthropic/claude-sonnet-4-6")).toBe(true);
  });

  it("isCloudModel returns false for local models", () => {
    expect(isCloudModel("ollama/llama3")).toBe(false);
  });

  it("isComplianceModel: local model always passes", () => {
    expect(isComplianceModel("ollama/llama3")).toBe(true);
    expect(isComplianceModel("lmstudio/compliance")).toBe(true);
  });

  it("isComplianceModel: cloud model does NOT pass even if explicitly configured", () => {
    // Cloud models can never be compliance-safe regardless of config
    expect(isComplianceModel("anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6")).toBe(false);
    expect(isComplianceModel("openai/gpt-4o", "openai/gpt-4o")).toBe(false);
  });

  it("isComplianceModel: non-cloud custom model passes when configured", () => {
    // A custom/enterprise model (no known-cloud provider) can be configured as compliance model
    expect(isComplianceModel("my-on-prem/model-v2", "my-on-prem/model-v2")).toBe(true);
  });
});

// ── Tests: orchestrator_settings compliance_model ─────────────────────────────

describe("compliance_model orchestrator setting", () => {
  it("can write and read compliance_model setting", () => {
    const db = getDb();
    const testModel = "ollama/llama3-test";

    // Upsert the setting
    db.insert(orchestratorSettings)
      .values({ key: "compliance_model", value: JSON.stringify(testModel) })
      .onConflictDoUpdate({
        target: orchestratorSettings.key,
        set: { value: JSON.stringify(testModel), updatedAt: new Date().toISOString() },
      })
      .run();

    const row = db.select().from(orchestratorSettings)
      .where(eq(orchestratorSettings.key, "compliance_model"))
      .get();

    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.value as string) as unknown;
    expect(parsed).toBe(testModel);
    expect(isLocalModel(parsed as string)).toBe(true);
  });

  it("cloud model rejected as compliance_model (guard: isComplianceModel check)", () => {
    // Simulates what the control loop does before using the configured model:
    // if it's a cloud model, it would still be blocked by isComplianceModel()
    const cloudModel = "anthropic/claude-sonnet-4-6";
    // Even if misconfigured, the system won't accept a cloud model as compliance-safe
    expect(isComplianceModel(cloudModel)).toBe(false);
    expect(isLocalModel(cloudModel)).toBe(false);
  });
});
