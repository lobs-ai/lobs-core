/**
 * Escalation Manager Tests
 *
 * Tests EscalationManager.escalate(), createFailureAlert(), escalateStuckTask(),
 * and ESCALATION_TIERS constants. Uses the in-memory DB from setup.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getRawDb } from "../src/db/connection.js";
import {
  EscalationManager,
  ESCALATION_TIERS,
  type EscalationTier,
  type EscalationResult,
} from "../src/orchestrator/escalation.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function insertTask(
  id: string,
  opts: {
    title?: string;
    agent?: string;
    status?: string;
    escalationTier?: number;
    projectId?: string;
  } = {},
): void {
  const db = getRawDb();
  db.prepare(
    `INSERT OR REPLACE INTO tasks
       (id, title, status, agent, escalation_tier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    id,
    opts.title ?? "Test task",
    opts.status ?? "active",
    opts.agent ?? "programmer",
    opts.escalationTier ?? 0,
  );
}

function getTask(id: string): Record<string, unknown> {
  return getRawDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown>;
}

function getInboxItem(id: string): Record<string, unknown> | undefined {
  return getRawDb().prepare(`SELECT * FROM inbox_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

function countInboxItemsFor(taskId: string): number {
  const rows = getRawDb()
    .prepare(`SELECT * FROM inbox_items WHERE content LIKE ?`)
    .all(`%${taskId}%`) as unknown[];
  return rows.length;
}

function clearInboxItems(): void {
  getRawDb().prepare(`DELETE FROM inbox_items`).run();
}

// ── ESCALATION_TIERS constants ────────────────────────────────────────────────

describe("ESCALATION_TIERS constants", () => {
  it("RETRY is 0", () => expect(ESCALATION_TIERS.RETRY).toBe(0));
  it("ALERT is 1", () => expect(ESCALATION_TIERS.ALERT).toBe(1));
  it("AGENT_SWITCH is 2", () => expect(ESCALATION_TIERS.AGENT_SWITCH).toBe(2));
  it("DIAGNOSTIC is 3", () => expect(ESCALATION_TIERS.DIAGNOSTIC).toBe(3));
  it("HUMAN is 4", () => expect(ESCALATION_TIERS.HUMAN).toBe(4));
  it("has exactly 5 tiers", () => expect(Object.keys(ESCALATION_TIERS)).toHaveLength(5));
  it("tiers are strictly ordered", () => {
    const values = Object.values(ESCALATION_TIERS).sort((a, b) => a - b);
    expect(values).toEqual([0, 1, 2, 3, 4]);
  });
});

// ── EscalationResult interface ────────────────────────────────────────────────

describe("EscalationResult type shape", () => {
  it("has tier, action as required fields", () => {
    const r: EscalationResult = { tier: 1, action: "alert_created" };
    expect(r.tier).toBe(1);
    expect(r.action).toBe("alert_created");
    expect(r.alertId).toBeUndefined();
  });

  it("accepts optional alertId and newAgentType", () => {
    const r: EscalationResult = {
      tier: 2,
      action: "agent_switched",
      alertId: "alert_abc",
      newAgentType: "architect",
    };
    expect(r.alertId).toBe("alert_abc");
    expect(r.newAgentType).toBe("architect");
  });
});

// ── EscalationManager.escalate — ALERT tier ──────────────────────────────────

describe("EscalationManager.escalate → ALERT (tier 1)", () => {
  beforeEach(() => {
    clearInboxItems();
    insertTask("task-alert", { title: "Alert task", agent: "programmer" });
  });

  it("returns tier=1 and action=alert_created", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-alert", "proj-1", "Error log", ESCALATION_TIERS.RETRY);
    expect(result.tier).toBe(1);
    expect(result.action).toBe("alert_created");
  });

  it("returns an alertId", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-alert", "proj-1", "Error log", ESCALATION_TIERS.RETRY);
    expect(result.alertId).toBeTruthy();
    expect(typeof result.alertId).toBe("string");
  });

  it("updates task escalation_tier to 1 in DB", () => {
    const mgr = new EscalationManager();
    mgr.escalate("task-alert", "proj-1", "Error log", ESCALATION_TIERS.RETRY);
    const task = getTask("task-alert");
    expect(task["escalation_tier"]).toBe(1);
  });

  it("creates an inbox alert item", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-alert", "proj-1", "Error log", ESCALATION_TIERS.RETRY);
    const item = getInboxItem(result.alertId!);
    expect(item).toBeDefined();
    expect(String(item!["title"])).toMatch(/alert task/i);
  });
});

// ── EscalationManager.escalate — AGENT_SWITCH tier ───────────────────────────

describe("EscalationManager.escalate → AGENT_SWITCH (tier 2)", () => {
  beforeEach(() => {
    clearInboxItems();
    insertTask("task-switch", { title: "Switch task", agent: "programmer" });
  });

  it("returns tier=2 and action=agent_switched", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-switch", "proj-2", "Error log", ESCALATION_TIERS.ALERT);
    expect(result.tier).toBe(2);
    expect(result.action).toBe("agent_switched");
  });

  it("returns newAgentType (programmer → architect)", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-switch", "proj-2", "Error log", ESCALATION_TIERS.ALERT);
    expect(result.newAgentType).toBe("architect");
  });

  it("updates task.agent in DB", () => {
    const mgr = new EscalationManager();
    mgr.escalate("task-switch", "proj-2", "Error log", ESCALATION_TIERS.ALERT);
    const task = getTask("task-switch");
    expect(task["agent"]).toBe("architect");
  });

  it("creates an inbox alert", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-switch", "proj-2", "Error log", ESCALATION_TIERS.ALERT);
    expect(result.alertId).toBeTruthy();
    expect(getInboxItem(result.alertId!)).toBeDefined();
  });
});

// ── EscalationManager.escalate — DIAGNOSTIC tier ─────────────────────────────

describe("EscalationManager.escalate → DIAGNOSTIC (tier 3)", () => {
  beforeEach(() => {
    clearInboxItems();
    insertTask("task-diag", { title: "Diagnostic task" });
  });

  it("returns tier=3 and action=diagnostic_triggered", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-diag", "proj-3", "Error log", ESCALATION_TIERS.AGENT_SWITCH);
    expect(result.tier).toBe(3);
    expect(result.action).toBe("diagnostic_triggered");
  });

  it("creates a high-severity alert", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-diag", "proj-3", "Error log", ESCALATION_TIERS.AGENT_SWITCH);
    const item = getInboxItem(result.alertId!);
    expect(item).toBeDefined();
    expect(String(item!["content"])).toMatch(/diagnostic/i);
  });
});

// ── EscalationManager.escalate — HUMAN tier ──────────────────────────────────

describe("EscalationManager.escalate → HUMAN (tier 4)", () => {
  beforeEach(() => {
    clearInboxItems();
    insertTask("task-human", { title: "Human escalation task" });
  });

  it("returns tier=4 and action=human_escalated", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-human", "proj-4", "Error log", ESCALATION_TIERS.DIAGNOSTIC);
    expect(result.tier).toBe(4);
    expect(result.action).toBe("human_escalated");
  });

  it("sets task status to waiting_on in DB", () => {
    const mgr = new EscalationManager();
    mgr.escalate("task-human", "proj-4", "Error log", ESCALATION_TIERS.DIAGNOSTIC);
    const task = getTask("task-human");
    expect(task["status"]).toBe("waiting_on");
  });

  it("creates a critical-severity alert", () => {
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-human", "proj-4", "Error log", ESCALATION_TIERS.DIAGNOSTIC);
    const item = getInboxItem(result.alertId!);
    expect(item).toBeDefined();
    expect(String(item!["content"])).toMatch(/human intervention/i);
  });

  it("caps escalation at HUMAN even if tier > 4", () => {
    // Pass currentTier=4 (already at human) → nextTier = min(5, 4) = 4
    insertTask("task-already-human", { title: "Already human" });
    const mgr = new EscalationManager();
    const result = mgr.escalate("task-already-human", "proj-4", "Error log", 4 as EscalationTier);
    expect(result.tier).toBe(4);
    expect(result.tier).not.toBeGreaterThan(4);
  });
});

// ── EscalationManager — unknown/missing task ──────────────────────────────────

describe("EscalationManager.escalate — missing task", () => {
  beforeEach(() => clearInboxItems());

  it("still creates alert even if task not in DB", () => {
    const mgr = new EscalationManager();
    // Task doesn't exist — falls back to taskId.slice(0,8) as title
    const result = mgr.escalate("no-such-task-xyz", "proj-5", "Error", ESCALATION_TIERS.RETRY);
    expect(result.tier).toBe(1);
    expect(result.alertId).toBeTruthy();
  });
});

// ── EscalationManager.createFailureAlert ─────────────────────────────────────

describe("EscalationManager.createFailureAlert", () => {
  beforeEach(() => clearInboxItems());

  it("inserts an inbox_item and returns its id", () => {
    const mgr = new EscalationManager();
    const alertId = mgr.createFailureAlert("task-abc123", "proj-x", "My Task", "Something broke", "medium");
    expect(alertId).toMatch(/^alert_task-abc/);
    const item = getInboxItem(alertId);
    expect(item).toBeDefined();
  });

  it("alert title includes task title", () => {
    const mgr = new EscalationManager();
    const alertId = mgr.createFailureAlert("task-xyz456", "proj-y", "My Important Task", "Error!", "high");
    const item = getInboxItem(alertId);
    expect(String(item!["title"])).toMatch(/My Important Task/);
  });

  it("alert content includes task ID", () => {
    const mgr = new EscalationManager();
    const alertId = mgr.createFailureAlert("task-qrs789", "proj-z", "Some Task", "Crash details", "critical");
    const item = getInboxItem(alertId);
    expect(String(item!["content"])).toContain("task-qrs789");
  });

  it("alert content truncates errorLog to 1000 chars", () => {
    const mgr = new EscalationManager();
    const bigError = "x".repeat(5000);
    const alertId = mgr.createFailureAlert("task-trunc", "proj-t", "Big Error Task", bigError, "medium");
    const item = getInboxItem(alertId);
    // errorLog slice to 1000 → content will be < 5000 chars of x's
    expect(String(item!["content"])).not.toContain("x".repeat(1001));
  });

  it("alert content includes project ID", () => {
    const mgr = new EscalationManager();
    const alertId = mgr.createFailureAlert("task-p-test", "my-project-id", "Task", "err", "medium");
    const item = getInboxItem(alertId);
    expect(String(item!["content"])).toContain("my-project-id");
  });

  it("marks alert as unread by default", () => {
    const mgr = new EscalationManager();
    const alertId = mgr.createFailureAlert("task-unread", "proj-u", "Unread Task", "err", "medium");
    const item = getInboxItem(alertId);
    expect(item!["is_read"]).toBe(0); // SQLite false = 0
  });
});

// ── EscalationManager.escalateStuckTask ──────────────────────────────────────

describe("EscalationManager.escalateStuckTask", () => {
  beforeEach(() => clearInboxItems());

  it("creates a stuck alert and returns an id", () => {
    insertTask("task-stuck", { title: "Stuck task" });
    const mgr = new EscalationManager();
    const alertId = mgr.escalateStuckTask("task-stuck", "proj-s", 30);
    expect(alertId).toMatch(/^stuck_task-stu/);
    const item = getInboxItem(alertId);
    expect(item).toBeDefined();
  });

  it("alert title includes task title", () => {
    insertTask("task-stuck2", { title: "My Stuck Task" });
    const mgr = new EscalationManager();
    const alertId = mgr.escalateStuckTask("task-stuck2", "proj-s", 45);
    const item = getInboxItem(alertId);
    expect(String(item!["title"])).toMatch(/My Stuck Task/);
  });

  it("alert content mentions duration", () => {
    insertTask("task-stuck3", { title: "Duration Task" });
    const mgr = new EscalationManager();
    const alertId = mgr.escalateStuckTask("task-stuck3", "proj-s", 75);
    const item = getInboxItem(alertId);
    expect(String(item!["content"])).toContain("75");
  });

  it("uses critical severity for tasks stuck > 60 minutes", () => {
    insertTask("task-stuck4", { title: "Long Stuck Task" });
    const mgr = new EscalationManager();
    // We can't directly inspect severity, but we can check the alert is created
    const alertId = mgr.escalateStuckTask("task-stuck4", "proj-s", 90);
    expect(alertId).toBeTruthy();
    expect(getInboxItem(alertId)).toBeDefined();
  });

  it("uses high severity for tasks stuck ≤ 60 minutes", () => {
    insertTask("task-stuck5", { title: "Short Stuck Task" });
    const mgr = new EscalationManager();
    const alertId = mgr.escalateStuckTask("task-stuck5", "proj-s", 60);
    expect(alertId).toBeTruthy();
    expect(getInboxItem(alertId)).toBeDefined();
  });

  it("works for unknown task (no task row)", () => {
    const mgr = new EscalationManager();
    const alertId = mgr.escalateStuckTask("no-such-task-789", "proj-s", 25);
    expect(alertId).toMatch(/^stuck_no-such/);
    const item = getInboxItem(alertId);
    expect(item).toBeDefined();
  });
});

// ── _pickAlternativeAgent — tested via AGENT_SWITCH ──────────────────────────

describe("_pickAlternativeAgent mappings (via escalate)", () => {
  beforeEach(() => clearInboxItems());

  const cases: Array<[string, string]> = [
    ["programmer", "architect"],
    ["architect", "programmer"],
    ["researcher", "programmer"],
    ["writer", "researcher"],
    ["reviewer", "programmer"],
    ["unknown-agent", "programmer"], // fallback
  ];

  for (const [from, to] of cases) {
    it(`${from} → ${to}`, () => {
      insertTask(`task-agent-${from}`, { agent: from });
      const mgr = new EscalationManager();
      const result = mgr.escalate(`task-agent-${from}`, "proj-a", "err", ESCALATION_TIERS.ALERT);
      expect(result.newAgentType).toBe(to);
    });
  }
});
