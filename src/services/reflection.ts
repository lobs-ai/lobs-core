/**
 * Reflection Service — strategic reflections and daily identity compression.
 * Port of lobs-server/app/orchestrator/reflection_cycle.py
 * All DB ops synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import { eq, and, inArray, gte, lte, desc, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { agentReflections, agentIdentityVersions, systemSweeps, inboxItems, workerRuns } from "../db/schema.js";
import { log } from "../util/logger.js";

const REFLECTION_AGENTS = ["programmer", "researcher", "writer", "architect", "reviewer"];
const QUALITY_MIN_LENGTH = 50;

export interface ReflectionResult {
  agentsProcessed: number;
  reflectionsCreated: number;
  sweepId?: string;
}

export class ReflectionService {
  /**
   * Create pending reflection records for all execution agents.
   */
  createReflectionBatch(windowHours = 6): ReflectionResult {
    const db = getDb();
    const now = new Date().toISOString();
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowHours * 3600 * 1000);

    let created = 0;
    for (const agent of REFLECTION_AGENTS) {
      const id = randomUUID();
      try {
        db.insert(agentReflections).values({
          id,
          agentType: agent,
          reflectionType: "strategic",
          status: "pending",
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          contextPacket: {},
          createdAt: now,
        }).run();
        created++;
      } catch (e) {
        log().warn(`[REFLECTION] Failed to create reflection for ${agent}: ${String(e)}`);
      }
    }

    const sweepId = randomUUID();
    try {
      db.insert(systemSweeps).values({
        id: sweepId,
        sweepType: "reflection_batch",
        status: "completed",
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        summary: { agents: REFLECTION_AGENTS.length, created },
        decisions: {},
        completedAt: now,
        createdAt: now,
      }).run();
    } catch (e) {
      log().warn(`[REFLECTION] Failed to create sweep record: ${String(e)}`);
    }

    log().info(`[REFLECTION] Created ${created} reflections for ${REFLECTION_AGENTS.length} agents`);
    return { agentsProcessed: REFLECTION_AGENTS.length, reflectionsCreated: created, sweepId };
  }

  /**
   * Pick the next agent that should reflect — least recently reflected.
   * Returns null if all agents reflected within the window.
   */
  pickNextAgent(windowHours = 6): { agentType: string; reflectionId: string } | null {
    const db = getDb();
    const windowStart = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

    for (const agent of REFLECTION_AGENTS) {
      const recent = db.select().from(agentReflections)
        .where(and(
          eq(agentReflections.agentType, agent),
          gte(agentReflections.createdAt, windowStart),
        ))
        .limit(1)
        .get();

      if (!recent) {
        const id = randomUUID();
        const now = new Date().toISOString();
        const windowEnd = new Date();
        const ws = new Date(windowEnd.getTime() - windowHours * 3600 * 1000);
        db.insert(agentReflections).values({
          id,
          agentType: agent,
          reflectionType: "strategic",
          status: "pending",
          windowStart: ws.toISOString(),
          windowEnd: windowEnd.toISOString(),
          contextPacket: {},
          createdAt: now,
        }).run();
        log().info(`[REFLECTION] Picked ${agent} for next reflection (id=${id.slice(0, 8)})`);
        return { agentType: agent, reflectionId: id };
      }
    }

    log().info(`[REFLECTION] All agents reflected within ${windowHours}h window`);
    return null;
  }

  /**
   * Build a reflection prompt for a specific agent.
   */
  buildReflectionPrompt(agentType: string, reflectionId: string): string {
    const db = getDb();

    const recentRuns = db.select().from(workerRuns)
      .where(eq(workerRuns.agentType, agentType))
      .orderBy(desc(workerRuns.startedAt))
      .limit(5)
      .all();

    const runSummary = recentRuns.length > 0
      ? recentRuns.map(r =>
          `- ${r.agentType} task (model=${r.model}, succeeded=${r.succeeded}, ${r.startedAt})`
        ).join("\n")
      : "No recent worker runs.";

    return `You are the ${agentType} agent reflecting on your recent work and the system state.

## Your Recent Work
${runSummary}

## Reflection Task
Analyze your recent work and the overall system. Produce a structured reflection:

1. **Inefficiencies**: What processes or patterns are wasteful? What could be streamlined?
2. **System Risks**: What could break? What's fragile? What needs attention?
3. **Missed Opportunities**: What work should be happening that isn't? What's being overlooked?
4. **Identity Adjustments**: Should your role, approach, or priorities shift based on recent experience?

Respond in this JSON format:
\`\`\`json
{
  "inefficiencies": ["..."],
  "systemRisks": ["..."],
  "missedOpportunities": ["..."],
  "identityAdjustments": ["..."],
  "summary": "One paragraph summary of key insights"
}
\`\`\`

Reflection ID: ${reflectionId}
Be honest and specific. Vague observations are worthless.`;
  }

  /**
   * Create a post-task mini-reflection record.
   */
  createMiniReflection(agentType: string, taskId: string, outcome: "success" | "failure", notes: string): string {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(agentReflections).values({
      id,
      agentType,
      reflectionType: "mini",
      status: "completed",
      windowStart: now,
      windowEnd: now,
      contextPacket: { taskId, outcome, notes },
      result: { outcome, notes },
      createdAt: now,
    }).run();
    return id;
  }

  /**
   * Parse and store completed reflection output from a worker.
   */
  storeReflectionOutput(reflectionId: string, rawOutput: string): void {
    const db = getDb();
    const parsed = this._parseReflectionOutput(rawOutput);
    db.update(agentReflections).set({
      status: "completed",
      result: { raw: rawOutput, ...parsed },
      inefficiencies: parsed.inefficiencies ?? null,
      systemRisks: parsed.systemRisks ?? null,
      missedOpportunities: parsed.missedOpportunities ?? null,
      identityAdjustments: parsed.identityAdjustments ?? null,
      completedAt: new Date().toISOString(),
    }).where(eq(agentReflections.id, reflectionId)).run();
    log().info(`[REFLECTION] Stored output for reflection ${reflectionId.slice(0, 8)}`);
  }

  /**
   * Sweep: quality-filter, dedup, route high-value reflections to inbox.
   */
  runSweep(sinceHours = 24): { processed: number; routed: number } {
    const db = getDb();
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const reflections = db.select().from(agentReflections)
      .where(and(
        eq(agentReflections.status, "completed"),
        gte(agentReflections.createdAt, since),
      ))
      .orderBy(desc(agentReflections.createdAt))
      .all();

    let routed = 0;
    for (const r of reflections) {
      const result = r.result as Record<string, unknown> | null;
      if (!result) continue;
      const raw = (result.raw as string) ?? "";
      if (raw.length < QUALITY_MIN_LENGTH) continue;

      const hasRisks = Array.isArray(result.systemRisks) && (result.systemRisks as unknown[]).length > 0;
      const hasAdjustments = Array.isArray(result.identityAdjustments) && (result.identityAdjustments as unknown[]).length > 0;
      const hasMissed = Array.isArray(result.missedOpportunities) && (result.missedOpportunities as unknown[]).length > 0;
      if (hasRisks || hasAdjustments || hasMissed) {
        this._routeToInbox(r.agentType, r.id, result);
        routed++;
      }
    }

    log().info(`[REFLECTION] Sweep: processed ${reflections.length}, routed ${routed} to inbox`);
    return { processed: reflections.length, routed };
  }

  /**
   * Daily compression: compress reflections into a new identity version.
   */
  runCompression(agentType: string): { agentType: string; newVersion?: number; validationPassed: boolean } {
    const db = getDb();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const reflections = db.select().from(agentReflections)
      .where(and(
        eq(agentReflections.agentType, agentType),
        gte(agentReflections.createdAt, since),
        inArray(agentReflections.reflectionType, ["strategic", "diagnostic"]),
      ))
      .orderBy(desc(agentReflections.createdAt))
      .limit(100)
      .all();

    if (!reflections.length) {
      log().info(`[REFLECTION] No reflections to compress for ${agentType}`);
      return { agentType, validationPassed: false };
    }

    const maxVer = db.select({ v: agentIdentityVersions.version })
      .from(agentIdentityVersions)
      .where(eq(agentIdentityVersions.agentType, agentType))
      .orderBy(desc(agentIdentityVersions.version))
      .limit(1)
      .get();
    const nextVersion = (maxVer?.v ?? 0) + 1;

    const compressed = this._compressReflections(agentType, reflections);
    const validationOk = compressed.identityText.length >= 100;

    const versionId = randomUUID();
    const now = new Date().toISOString();
    db.insert(agentIdentityVersions).values({
      id: versionId,
      agentType,
      version: nextVersion,
      identityText: compressed.identityText,
      summary: `Auto-compressed from ${reflections.length} reflections`,
      active: validationOk,
      windowStart: since,
      windowEnd: now,
      changedHeuristics: compressed.changedHeuristics,
      removedRules: compressed.removedRules,
      validationStatus: validationOk ? "passed" : "failed",
      validationReason: validationOk ? "ok" : "identity text too short",
      createdAt: now,
    }).run();

    log().info(`[REFLECTION] Compressed ${agentType} → v${nextVersion} (valid=${validationOk})`);
    return { agentType, newVersion: nextVersion, validationPassed: validationOk };
  }

  listAgents(): string[] {
    return REFLECTION_AGENTS;
  }

  checkComplete(windowStart: string): { total: number; completed: number; done: boolean } {
    const db = getDb();
    const all = db.select().from(agentReflections)
      .where(gte(agentReflections.windowStart, windowStart))
      .all();
    const completed = all.filter(r => r.status === "completed").length;
    return { total: all.length, completed, done: completed >= all.length };
  }

  private _parseReflectionOutput(raw: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return { ...parsed };
      } catch (_) {}
    }
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch (_) {}
    if (/inefficien/i.test(raw)) result.inefficiencies = [raw.slice(0, 200)];
    if (/risk/i.test(raw)) result.systemRisks = [raw.slice(0, 200)];
    if (/opportunit/i.test(raw)) result.missedOpportunities = [raw.slice(0, 200)];
    return result;
  }

  private _compressReflections(agentType: string, reflections: typeof agentReflections.$inferSelect[]): {
    identityText: string;
    changedHeuristics: string[];
    removedRules: string[];
  } {
    const insights = reflections
      .filter(r => r.result)
      .map(r => {
        const res = r.result as Record<string, unknown>;
        return (res?.raw as string) ?? JSON.stringify(res);
      })
      .join("\n\n---\n\n")
      .slice(0, 4000);

    const identityText = `# ${agentType} Identity (Auto-compressed)\n\nGenerated from ${reflections.length} reflections.\n\n## Key Insights\n\n${insights}`;
    return { identityText, changedHeuristics: [], removedRules: [] };
  }

  private _routeToInbox(agentType: string, reflectionId: string, result: Record<string, unknown>): void {
    const db = getDb();
    const now = new Date().toISOString();
    try {
      const parts: string[] = [];
      if (Array.isArray(result.inefficiencies) && result.inefficiencies.length) {
        parts.push(`**Inefficiencies:** ${(result.inefficiencies as string[]).join("; ")}`);
      }
      if (Array.isArray(result.systemRisks) && result.systemRisks.length) {
        parts.push(`**Risks:** ${(result.systemRisks as string[]).join("; ")}`);
      }
      if (Array.isArray(result.missedOpportunities) && result.missedOpportunities.length) {
        parts.push(`**Opportunities:** ${(result.missedOpportunities as string[]).join("; ")}`);
      }
      if (Array.isArray(result.identityAdjustments) && result.identityAdjustments.length) {
        parts.push(`**Adjustments:** ${(result.identityAdjustments as string[]).join("; ")}`);
      }
      const summary = (result.summary as string) ?? parts[0] ?? "Strategic reflection insight";

      db.insert(inboxItems).values({
        id: randomUUID(),
        title: `🔍 ${agentType} reflection: ${summary.slice(0, 80)}`,
        content: `**Agent:** ${agentType}\n**Reflection:** ${reflectionId.slice(0, 8)}\n\n${parts.join("\n\n")}`,
        summary,
        isRead: false,
        modifiedAt: now,
      }).run();
    } catch (e) {
      log().warn(`[REFLECTION] Failed to route to inbox: ${String(e)}`);
    }
  }
}
