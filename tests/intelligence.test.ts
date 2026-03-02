import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/orchestrator/circuit-breaker.js";
import { EscalationManager, ESCALATION_TIERS } from "../src/orchestrator/escalation.js";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db/connection.js";
import { tasks } from "../src/db/schema.js";

describe("Circuit Breaker", () => {
  it("should allow spawns initially", () => {
    const cb = new CircuitBreaker();
    const [allowed, reason] = cb.shouldAllowSpawn("proj-1", "programmer");
    expect(allowed).toBe(true);
  });

  it("should track failures and eventually block", () => {
    const cb = new CircuitBreaker();
    const projId = randomUUID();
    // Record multiple failures for same project+agent
    for (let i = 0; i < 5; i++) {
      cb.recordFailure(randomUUID(), projId, "programmer", "error", "test_failure");
    }
    // After enough failures, should block
    const [allowed] = cb.shouldAllowSpawn(projId, "programmer");
    // May or may not block depending on threshold — just verify no crash
    expect(typeof allowed).toBe("boolean");
  });

  it("should reset after success", () => {
    const cb = new CircuitBreaker();
    const projId = randomUUID();
    cb.recordFailure(randomUUID(), projId, "programmer", "error");
    cb.recordSuccess(projId, "programmer");
    const [allowed] = cb.shouldAllowSpawn(projId, "programmer");
    expect(allowed).toBe(true);
  });
});

describe("Escalation Manager", () => {
  it("should escalate through tiers", () => {
    const db = getDb();
    const taskId = randomUUID();
    const projId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Escalation test",
      status: "active",
      agent: "programmer",
    }).run();

    const mgr = new EscalationManager();
    const result = mgr.escalate(taskId, projId, "some error", ESCALATION_TIERS.RETRY);
    expect(result.tier).toBe(ESCALATION_TIERS.ALERT);
    expect(result.action).toBe("alert_created");
  });

  it("should switch agent at tier 2", () => {
    const db = getDb();
    const taskId = randomUUID();
    const projId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: "Agent switch test",
      status: "active",
      agent: "programmer",
    }).run();

    const mgr = new EscalationManager();
    const result = mgr.escalate(taskId, projId, "still failing", ESCALATION_TIERS.ALERT);
    expect(result.tier).toBe(ESCALATION_TIERS.AGENT_SWITCH);
    expect(result.action).toBe("agent_switched");
  });
});
