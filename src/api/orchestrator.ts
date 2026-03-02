import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import {
  orchestratorSettings,
  agentReflections,
  agentInitiatives,
  initiativeDecisionRecords,
  systemSweeps,
  initiativeMessages,
} from "../db/schema.js";
import { json, error, parseBody } from "./index.js";

export async function handleOrchestratorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  subParts: string[],
): Promise<void> {
  const db = getDb();
  const [s0, s1, s2, s3, s4] = subParts;

  // /api/orchestrator/status
  if (!s0 || s0 === "status") {
    const paused = db.select().from(orchestratorSettings).where(eq(orchestratorSettings.key, "paused")).get();
    return json(res, {
      running: true,
      paused: paused?.value === true || paused?.value === "true",
      timestamp: new Date().toISOString(),
    });
  }

  // /api/orchestrator/pause
  if (s0 === "pause" && req.method === "POST") {
    db.insert(orchestratorSettings).values({ key: "paused", value: true, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: orchestratorSettings.key, set: { value: true, updatedAt: new Date().toISOString() } })
      .run();
    return json(res, { paused: true });
  }

  // /api/orchestrator/resume
  if (s0 === "resume" && req.method === "POST") {
    db.insert(orchestratorSettings).values({ key: "paused", value: false, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: orchestratorSettings.key, set: { value: false, updatedAt: new Date().toISOString() } })
      .run();
    return json(res, { paused: false });
  }

  // /api/orchestrator/intelligence/*
  if (s0 === "intelligence") {
    if (!s1 || s1 === "summary") {
      const reflections = db.select().from(agentReflections).orderBy(desc(agentReflections.createdAt)).limit(10).all();
      const initiatives = db.select().from(agentInitiatives).orderBy(desc(agentInitiatives.createdAt)).limit(10).all();
      const sweeps = db.select().from(systemSweeps).orderBy(desc(systemSweeps.createdAt)).limit(5).all();
      const decisions = db.select().from(initiativeDecisionRecords).orderBy(desc(initiativeDecisionRecords.createdAt)).limit(50).all();
      const pending = initiatives.filter(i => i.status === "proposed");
      const approved = decisions.filter(d => d.decision === "approve").length;
      const lastRefl = reflections[0];
      const lastSweepRow = sweeps[0];
      return json(res, {
        pendingReviews: pending.length,
        recentApprovalRate: decisions.length > 0 ? { approved, total: decisions.length, days: 30 } : null,
        lastReflection: lastRefl ? { timestamp: lastRefl.createdAt, agentCount: 1, initiativesProposed: pending.length } : null,
        lastSweep: lastSweepRow ? { timestamp: lastSweepRow.createdAt, decisionsMade: decisions.length } : null,
      });
    }

    if (s1 === "reflections") {
      const rows = db.select().from(agentReflections).orderBy(desc(agentReflections.createdAt)).limit(50).all();
      return json(res, rows);
    }

    if (s1 === "initiatives") {
      // POST batch-decide
      if (s2 === "batch-decide" && req.method === "POST") {
        const body = await parseBody(req) as Record<string, unknown>;
        const decisions = (body.decisions as Array<{ id: string; decision: string; summary?: string }>) ?? [];
        const now = new Date().toISOString();
        for (const d of decisions) {
          db.update(agentInitiatives)
            .set({ status: d.decision === "approve" ? "approved" : "rejected", updatedAt: now })
            .where(eq(agentInitiatives.id, d.id))
            .run();
          db.insert(initiativeDecisionRecords).values({
            id: randomUUID(),
            initiativeId: d.id,
            decision: d.decision,
            decisionSummary: d.summary ?? null,
            createdAt: now,
          }).run();
        }
        return json(res, { processed: decisions.length });
      }

      // GET /api/orchestrator/intelligence/initiatives/:id/thread
      if (s2 && s3 === "thread") {
        const msgs = db.select().from(initiativeMessages).where(eq(initiativeMessages.initiativeId, s2)).orderBy(initiativeMessages.createdAt).all();
        return json(res, { initiative_id: s2, messages: msgs });
      }

      // POST /api/orchestrator/intelligence/initiatives/:id/decide
      if (s2 && s3 === "decide" && req.method === "POST") {
        const body = await parseBody(req) as Record<string, unknown>;
        const decision = (body.decision as string) ?? "approve";
        const now = new Date().toISOString();
        db.update(agentInitiatives)
          .set({ status: decision === "approve" ? "approved" : "rejected", updatedAt: now })
          .where(eq(agentInitiatives.id, s2))
          .run();
        db.insert(initiativeDecisionRecords).values({
          id: randomUUID(),
          initiativeId: s2,
          decision,
          decisionSummary: (body.summary as string) ?? null,
          createdAt: now,
        }).run();
        return json(res, db.select().from(agentInitiatives).where(eq(agentInitiatives.id, s2)).get());
      }

      // GET list
      const rows = db.select().from(agentInitiatives).orderBy(desc(agentInitiatives.createdAt)).limit(50).all();
      return json(res, { items: rows });
    }

    if (s1 === "sweeps") {
      if (s2) {
        const row = db.select().from(systemSweeps).where(eq(systemSweeps.id, s2)).get();
        return row ? json(res, row) : error(res, "Not found", 404);
      }
      const rows = db.select().from(systemSweeps).orderBy(desc(systemSweeps.createdAt)).limit(50).all();
      return json(res, rows);
    }

    return error(res, "Unknown intelligence endpoint", 404);
  }

  return error(res, "Unknown orchestrator endpoint", 404);
}
