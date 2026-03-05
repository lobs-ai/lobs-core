/**
 * Reflection Service — strategic reflections and daily identity compression.
 * Port of lobs-server/app/orchestrator/reflection_cycle.py
 * All DB ops synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import { eq, and, inArray, gte, lte, desc, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { agentReflections, agentIdentityVersions, systemSweeps, inboxItems, workerRuns, tasks as tasksTable, projects as projectsTable, orchestratorSettings } from "../db/schema.js";
import { inferProjectId } from "../util/project-inference.js";
import { buildTaskContext } from "../util/task-context.js";
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
  createReflectionBatch(windowHours = 3): ReflectionResult {
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
          status: "active",
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
  pickNextAgent(windowHours = 3): { agentType: string; reflectionId: string } | null {
    const db = getDb();
    const windowStart = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

    for (const agent of REFLECTION_AGENTS) {
      const recent = db.select().from(agentReflections)
        .where(and(
          eq(agentReflections.agentType, agent),
          inArray(agentReflections.status, ["completed", "active"]),
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
          status: "active",
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

    // Recent worker runs for this agent WITH task titles
    const recentRuns = db.select().from(workerRuns)
      .where(eq(workerRuns.agentType, agentType))
      .orderBy(desc(workerRuns.startedAt))
      .limit(10)
      .all();

    let runSummary: string;
    if (recentRuns.length > 0) {
      runSummary = recentRuns.map(r => {
        let taskTitle = "untitled";
        if (r.taskId) {
          const task = db.select().from(tasksTable).where(eq(tasksTable.id, r.taskId)).get();
          taskTitle = (task as Record<string, unknown>)?.title as string ?? "untitled";
        }
        const duration = r.startedAt && r.endedAt
          ? `${Math.round((new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)}s`
          : "?";
        let detail = `- "${taskTitle}" (model=${r.model ?? "unknown"}, succeeded=${r.succeeded}, duration=${duration}, ${r.startedAt})`;
        if (r.summary) detail += `\n  Summary: ${(r.summary as string).slice(0, 200)}`;
        if (r.succeeded === false || r.succeeded === null) {
          if (r.timeoutReason) detail += `\n  Timeout: ${r.timeoutReason}`;
          if (r.validityResult) detail += `\n  Validation: ${(r.validityResult as string).slice(0, 200)}`;
          if (r.taskLog) detail += `\n  Log: ${(r.taskLog as string).slice(0, 300)}`;
        }
        return detail;
      }).join("\n");
    } else {
      runSummary = "No recent worker runs for this agent.";
    }

    // All recent runs across ALL agents for system-wide awareness
    const allRecentRuns = db.select().from(workerRuns)
      .orderBy(desc(workerRuns.startedAt))
      .limit(15)
      .all();

    const systemActivity = allRecentRuns.length > 0
      ? allRecentRuns.map(r => {
          let title = "untitled";
          if (r.taskId) {
            const task = db.select().from(tasksTable).where(eq(tasksTable.id, r.taskId)).get();
            title = (task as Record<string, unknown>)?.title as string ?? "untitled";
          }
          let line = `- [${r.agentType}] "${title}" (succeeded=${r.succeeded}, ${r.startedAt})`;
          if (r.succeeded === false || r.succeeded === null) {
            if (r.timeoutReason) line += ` [TIMEOUT: ${r.timeoutReason}]`;
            if (r.validityResult) line += `\n    Validation: ${(r.validityResult as string).slice(0, 150)}`;
          }
          return line;
        }).join("\n")
      : "No recent system activity.";

    // Active and recent tasks
    const activeTasks = db.select().from(tasksTable)
      .where(inArray(tasksTable.status, ["active", "blocked"]))
      .limit(20)
      .all();
    const taskList = activeTasks.length > 0
      ? activeTasks.map((t: Record<string, unknown>) =>
          `- [${t.status}] "${t.title}" (agent=${t.agent ?? "unassigned"}, tier=${t.model_tier ?? "?"})${t.notes ? ` — ${(t.notes as string).slice(0, 100)}` : ""}`
        ).join("\n")
      : "No active tasks.";

    // Projects
    const activeProjects = db.select().from(projectsTable)
      .where(eq(projectsTable.archived, false))
      .limit(10)
      .all();
    const projectList = activeProjects.length > 0
      ? activeProjects.map((p: Record<string, unknown>) =>
          `- "${p.title}" (type=${p.type})${p.notes ? ` — ${(p.notes as string).slice(0, 100)}` : ""}`
        ).join("\n")
      : "No active projects.";

    return `You are the ${agentType} agent in a multi-agent system (PAW \u2014 Personal AI Workforce). Your role is to deeply reflect on your work, the system state, and suggest concrete improvements.

**IMPORTANT: Before writing your reflection, use your tools to investigate.** Read your own workspace files (SOUL.md, AGENTS.md, IDENTITY.md, memory/ files) to understand your identity and history. Look at relevant project directories, recent git logs, or any artifacts produced. The more grounded your observations, the more useful they are.

## Your Recent Work (${agentType})
${runSummary}

## System-Wide Activity (all agents, last 15 runs)
${systemActivity}

## Active Tasks
${taskList}

## Active Projects
${projectList}

## Your Workspace
Your workspace is at: ~/.openclaw/workspace-${agentType}/
Shared memory is at: ~/lobs-shared-memory/

## Recent Failures & Issues
${this._getFailureSummary(agentType)}

## Recent Suggestion Outcomes
${this._getSuggestionOutcomes()}

## Reflection Instructions
1. **First, investigate.** Read files in your workspace and shared memory. Check git history. Look at project state. Spend time understanding before opining.
2. **Then reflect.** Based on what you found AND the data above, write your structured reflection.
3. **Be concrete.** Reference specific files, tasks, projects, and patterns.

Output your reflection as a JSON block (this MUST appear in your final message):
${"```"}json
{
  "inefficiencies": ["specific observation grounded in evidence"],
  "systemRisks": ["specific risk with reasoning"],
  "missedOpportunities": ["specific opportunity with expected value"],
  "concreteSuggestions": ["actionable step that could be done this week"],
  "summary": "One paragraph synthesizing key insights"
}
${"```"}

Reflection ID: ${reflectionId}`;
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
  runSweep(sinceHours = 24): { processed: number; routed: number; tasksProposed: number } {
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
    let tasksCreated = 0;
    for (const r of reflections) {
      const result = r.result as Record<string, unknown> | null;
      if (!result) continue;
      const raw = (result.raw as string) ?? "";
      if (raw.length < QUALITY_MIN_LENGTH) continue;

      const hasRisks = Array.isArray(result.systemRisks) && (result.systemRisks as unknown[]).length > 0;
      const hasAdjustments = Array.isArray(result.identityAdjustments) && (result.identityAdjustments as unknown[]).length > 0;
      const hasMissed = Array.isArray(result.missedOpportunities) && (result.missedOpportunities as unknown[]).length > 0;
      const hasSuggestions = Array.isArray(result.concreteSuggestions) && (result.concreteSuggestions as unknown[]).length > 0;

      // Route non-actionable insights (risks, adjustments, opportunities) to inbox
      if ((hasRisks || hasAdjustments || hasMissed) && !hasSuggestions) {
        this._routeToInbox(r.agentType, r.id, result);
        routed++;
      }

      // Process each suggestion individually: size it, then route accordingly
      if (hasSuggestions) {
        const suggestions = result.concreteSuggestions as string[];
        for (const suggestion of suggestions) {
          const size = this._sizeSuggestion(suggestion);
          if (size === "large") {
            // Large items need explicit human approval
            this._routeSuggestionToInbox(r.agentType, r.id, suggestion, "approval");
            routed++;
          } else {
            // Small/medium items become proposed tasks + inbox suggestions for approval/reject
            const proposed = this._proposeTask(r.agentType, suggestion, size);
            if (proposed === "proposed") {
              tasksCreated++;
              this._routeSuggestionToInbox(r.agentType, r.id, suggestion, "suggestion");
              routed++;
            }
          }
        }
      }
    }

    log().info(`[REFLECTION] Sweep: processed ${reflections.length}, routed ${routed} to inbox, proposed ${tasksCreated} tasks for review`);
    return { processed: reflections.length, routed, tasksProposed: tasksCreated };
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

    // Try to extract JSON block (may be truncated)
    const jsonMatch = raw.match(/```json\s*\n([\s\S]*?)(?:\n```|$)/);
    let jsonStr = jsonMatch ? jsonMatch[1].trim() : "";

    // If no fenced block, try to find raw JSON object
    if (!jsonStr) {
      const braceStart = raw.indexOf('{');
      if (braceStart >= 0) jsonStr = raw.slice(braceStart);
    }

    if (jsonStr) {
      // Try parsing as-is first
      try {
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed === "object" && parsed !== null) return parsed;
      } catch (_) {}

      // Handle truncated JSON: extract individual array fields with regex
      const fields = ["inefficiencies", "systemRisks", "missedOpportunities", "concreteSuggestions", "identityAdjustments", "summary"];
      for (const field of fields) {
        if (field === "summary") {
          const m = jsonStr.match(new RegExp(`"summary"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s"));
          if (m) result.summary = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
          continue;
        }
        // Extract array items: "field": ["item1", "item2", ...]
        const fieldMatch = jsonStr.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)(?:\\]|$)`));
        if (fieldMatch) {
          const items: string[] = [];
          // Match quoted strings within the array
          const strRegex = /"((?:[^"\\]|\\.)*)"/g;
          let strMatch;
          while ((strMatch = strRegex.exec(fieldMatch[1])) !== null) {
            const item = strMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
            if (item.length > 20) items.push(item); // Skip short fragments
          }
          if (items.length > 0) result[field] = items;
        }
      }
      if (Object.keys(result).length > 0) return result;
    }

    // Fallback: keyword matching
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

  private _proposeTask(agentType: string, suggestion: string, size: "small" | "medium"): "proposed" | "skipped" {
    const db = getDb();
    try {
      const title = suggestion.split(/[.!?]/)[0].trim().slice(0, 100) || suggestion.slice(0, 100);

      if (title.length < 20) {
        log().info(`[REFLECTION] Skipped vague suggestion from ${agentType}: "${title}"`);
        return "skipped";
      }

      // Exact-title dedup only — agents get context about active/recent work to avoid semantic dupes
      const existing = db.select({ id: tasksTable.id })
        .from(tasksTable)
        .where(and(eq(tasksTable.title, title), inArray(tasksTable.status, ["active", "proposed"])))
        .get();
      if (existing) {
        log().info(`[REFLECTION] Dedup: exact title match — skipping "${title.slice(0, 60)}"`);
        return "skipped";
      }

      db.insert(tasksTable).values({
        id: randomUUID(),
        title,
        status: "proposed",
        agent: agentType,
        modelTier: "standard",
        projectId: inferProjectId(title, suggestion),
        notes: `[Proposed from ${agentType} reflection, size=${size}]\n\n${suggestion}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
      log().info(`[REFLECTION] Proposed task "${title.slice(0, 40)}" from ${agentType} (size=${size})`);
      return "proposed";
    } catch (e) {
      log().warn(`[REFLECTION] Failed to propose task: ${String(e)}`);
      return "skipped";
    }
  }

  private _getSuggestionOutcomes(): string {
    const db = getDb();
    // Recently activated tasks (accepted suggestions)
    const activated = db.select().from(tasksTable)
      .where(and(
        eq(tasksTable.status, "active"),
        sql`${tasksTable.notes} LIKE '%Proposed from%'`,
      ))
      .orderBy(desc(tasksTable.updatedAt))
      .limit(10)
      .all();

    // Recently completed tasks from reflections
    const completed = db.select().from(tasksTable)
      .where(and(
        eq(tasksTable.status, "completed"),
        sql`${tasksTable.notes} LIKE '%Proposed from%' OR ${tasksTable.notes} LIKE '%Auto-created from%'`,
      ))
      .orderBy(desc(tasksTable.updatedAt))
      .limit(10)
      .all();

    const lines: string[] = [];

    if (activated.length > 0) {
      lines.push("**Accepted (activated):**");
      for (const t of activated) {
        lines.push(`- "${t.title}" (agent=${t.agent ?? "unassigned"})`);
      }
    }

    if (completed.length > 0) {
      lines.push("\n**Completed (from past suggestions):**");
      for (const t of completed) {
        lines.push(`- "${t.title}" (agent=${t.agent ?? "unassigned"})`);
      }
    }

    // Rejected suggestions (stored in orchestrator_settings)
    const rejections = db.select().from(orchestratorSettings)
      .where(sql`${orchestratorSettings.key} LIKE 'rejected_suggestion:%'`)
      .all()
      .slice(-10);

    if (rejections.length > 0) {
      lines.push("\n**Rejected (not useful):**");
      for (const r of rejections) {
        try {
          const val = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
          const reason = val.reason ? ` — reason: ${val.reason}` : "";
          lines.push(`- "${val.title}" (agent=${val.agent})${reason}`);
        } catch (_) {}
      }
    }

    if (lines.length === 0) return "No suggestion history yet.";
    return lines.join("\n") + "\n\nUse this to calibrate: suggest things similar to what was accepted, avoid patterns similar to what was rejected.";
  }

  private _getFailureSummary(agentType: string): string {
    const db = getDb();
    // Get failed runs for this agent (last 30 days)
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const failed = db.select().from(workerRuns)
      .where(and(
        eq(workerRuns.agentType, agentType),
        gte(workerRuns.startedAt, since),
      ))
      .orderBy(desc(workerRuns.startedAt))
      .limit(30)
      .all()
      .filter(r => r.succeeded === false || r.succeeded === null);

    if (failed.length === 0) return "No recent failures for this agent.";

    const lines = failed.slice(0, 10).map(r => {
      let taskTitle = "untitled";
      if (r.taskId) {
        const task = db.select().from(tasksTable).where(eq(tasksTable.id, r.taskId)).get();
        taskTitle = (task as Record<string, unknown>)?.title as string ?? "untitled";
      }
      let line = `- FAILED: "${taskTitle}" (model=${r.model ?? "?"}, ${r.startedAt})`;
      if (r.timeoutReason) line += `\n  Reason: ${r.timeoutReason}`;
      if (r.validityResult) line += `\n  Validation: ${(r.validityResult as string).slice(0, 200)}`;
      if (r.summary) line += `\n  Summary: ${(r.summary as string).slice(0, 200)}`;
      if (r.taskLog) line += `\n  Log excerpt: ${(r.taskLog as string).slice(0, 300)}`;
      return line;
    });

    return `${failed.length} failures in last 30 days (showing up to 10):\n${lines.join("\n")}`;
  }

  /**
   * Size a suggestion as small, medium, or large based on scope signals.
   * - small: single file change, config tweak, rename, cleanup
   * - medium: multi-file change, new utility, refactor within one module
   * - large: new feature, architecture change, cross-cutting concern, new project
   */
  private _sizeSuggestion(suggestion: string): "small" | "medium" | "large" {
    const lower = suggestion.toLowerCase();

    // Large = building new systems, multi-component changes, or risky operations
    // Must match ACTION verbs for large work, not just topic mentions
    const largePatterns = [
      /\b(build|create|implement|design|develop) (a |an )?(new |full )?(system|service|api|pipeline|platform)/,
      /\b(redesign|overhaul|rewrite|rebuild) /,
      /\b(migrate|migration) (to|from|the)/,
      /\bmulti-tenant/,
      /\b(deploy|ci\/cd|infrastructure) (pipeline|system|setup)/,
      /\bcross-cutting (concern|change|refactor)/,
    ];
    if (largePatterns.some(p => p.test(lower))) return "large";

    // Small = single-file, cosmetic, config, or trivial changes
    const smallSignals = [
      "rename", "typo", "cleanup", "clean up", "remove unused",
      "update readme", "fix comment", "add comment", "log message",
      "env var", "constant", "default value", "single file",
    ];
    if (smallSignals.some(s => lower.includes(s))) return "small";

    // Default to medium — covers docs, validation checks, investigations, audits
    return "medium";
  }

  private _routeSuggestionToInbox(agentType: string, reflectionId: string, suggestion: string, type: "suggestion" | "approval"): void {
    const db = getDb();
    const now = new Date().toISOString();
    const title = suggestion.split(/[.!?]/)[0].trim().slice(0, 100) || suggestion.slice(0, 100);
    try {
      db.insert(inboxItems).values({
        id: randomUUID(),
        title: ` ${"\u{1F4CB}"} ${agentType}: ${title}`,
        content: `**Agent:** ${agentType}\n**Type:** ${type}\n\n${suggestion}`,
        summary: suggestion.slice(0, 200),
        isRead: false,
        modifiedAt: now,
        type,
        requiresAction: true,
        actionStatus: "pending",
        sourceAgent: agentType,
        sourceReflectionId: reflectionId,
      }).run();
    } catch (e) {
      log().warn(`[REFLECTION] Failed to route suggestion to inbox: ${String(e)}`);
    }
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
        type: "report",
        requiresAction: false,
        actionStatus: "pending",
        sourceAgent: agentType,
        sourceReflectionId: reflectionId,
      }).run();
    } catch (e) {
      log().warn(`[REFLECTION] Failed to route to inbox: ${String(e)}`);
    }
  }
}
