/**
 * Callable Registry — maps ts_call callable strings to TypeScript functions.
 * Port of lobs-server/app/orchestrator/workflow_functions.py + workflow_integrations.py
 *
 * Each callable receives (args: Record<string, unknown>, context: CallableContext) and returns a result.
 * All DB operations are synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import { eq, and, lte, gte, desc, isNull, inArray } from "drizzle-orm";
import { getDb, getRawDb } from "../db/connection.js";
import {
  tasks, projects, inboxItems, inboxThreads, inboxMessages, scheduledEvents,
  agentProfiles, agentStatus, workerRuns, modelUsageEvents,
  orchestratorSettings, routineRegistry, routineAuditEvents,
  systemSweeps, agentReflections, outcomeLearnings, learningPlans,
} from "../db/schema.js";
import { log } from "../util/logger.js";
import { GoogleCalendarService } from "../integrations/google-calendar.js";
import { GmailService } from "../integrations/gmail.js";
import { GitHubSyncService } from "../integrations/github.js";
import { ReflectionService } from "../services/reflection.js";
import { LearningService } from "../services/learning.js";
import { runHarvest, getHarvestStats, bulkApprove, exportTrainingJSONL } from "../services/training-harvester.js";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { getModelForTier } from "../config/models.js";
import { getGatewayConfig } from "../config/lobs.js";
import { executeSpawnAgent } from "../runner/tools/agent-control.js";

export interface CallableContext {
  workflowRunId?: string;
  nodeId?: string;
  taskId?: string;
  agentType?: string;
  [key: string]: unknown;
}

export type CallableFn = (args: Record<string, unknown>, ctx: CallableContext) => Record<string, unknown> | Promise<Record<string, unknown>>;

// ─── Assignment ───────────────────────────────────────────────────────────────

function assignmentAssignAgent(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const taskId = args.task_id as string | undefined;
  if (!taskId) return { ok: false, error: "task_id required" };
  const db = getDb();
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return { ok: false, error: "task not found" };
  if (task.agent) return { ok: true, agent: task.agent, already_assigned: true };

  // Simple heuristic: assign based on project or task notes keywords
  const text = `${task.title} ${task.notes ?? ""}`.toLowerCase();
  let agent = "programmer";
  if (/research|analyz|compar|investigat/i.test(text)) agent = "researcher";
  else if (/write|doc|readme|blog|report/i.test(text)) agent = "writer";
  else if (/review|audit|check|qa/i.test(text)) agent = "reviewer";
  else if (/architect|design|plan|system/i.test(text)) agent = "architect";

  db.update(tasks).set({ agent, updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId)).run();
  log().info(`[CALLABLE] assignment.assign_agent: ${taskId.slice(0, 8)} → ${agent}`);
  return { ok: true, task_id: taskId, agent };
}

function assignmentScanUnassigned(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const db = getDb();
  const unassigned = db.select().from(tasks)
    .where(and(eq(tasks.status, "active"), isNull(tasks.agent)))
    .limit(50)
    .all();

  let assigned = 0;
  for (const task of unassigned) {
    const text = `${task.title} ${task.notes ?? ""}`.toLowerCase();
    let agent = "programmer";
    if (/research|analyz|compar/i.test(text)) agent = "researcher";
    else if (/write|doc|readme/i.test(text)) agent = "writer";
    else if (/review|audit|check/i.test(text)) agent = "reviewer";
    else if (/architect|design|plan/i.test(text)) agent = "architect";
    db.update(tasks).set({ agent, updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id)).run();
    assigned++;
  }
  return { ok: true, scanned: unassigned.length, assigned };
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

async function calendarSyncGoogle(args: Record<string, unknown>, _ctx: CallableContext): Promise<Record<string, unknown>> {
  const svc = new GoogleCalendarService();
  if (!svc.isConfigured()) return { ok: false, skipped: true, reason: "not_configured" };
  const days = (args.days_ahead as number) ?? 14;
  const result = await svc.syncToDb(days);
  return { ok: true, ...result };
}

function calendarCheckUpcoming(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const svc = new GoogleCalendarService();
  const hours = (args.within_hours as number) ?? 24;
  const events = svc.getUpcomingFromDb(hours);
  return { ok: true, events: events.map(e => ({ id: e.id, title: e.title, scheduledAt: e.scheduledAt })), count: events.length };
}

// ─── Email ────────────────────────────────────────────────────────────────────

function emailCheckInbox(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const svc = new GmailService();
  if (!svc.isConfigured()) return { ok: false, skipped: true, reason: "not_configured" };
  const result = svc.processInbox();
  return { ok: true, ...result };
}

// ─── Tracker ─────────────────────────────────────────────────────────────────

function trackerCheckDeadlines(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const db = getDb();
  const now = new Date().toISOString();
  const soonThreshold = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  // Tasks with a scheduled event approaching
  const upcoming = db.select().from(scheduledEvents)
    .where(and(eq(scheduledEvents.status, "pending"), lte(scheduledEvents.scheduledAt, soonThreshold)))
    .all()
    .filter(e => e.scheduledAt >= now);
  return { ok: true, deadlines: upcoming.length, events: upcoming.map(e => ({ id: e.id, title: e.title, scheduledAt: e.scheduledAt })) };
}

function trackerDailySummary(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const db = getDb();
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const todayStr = todayStart.toISOString();
  const completedToday = db.select().from(tasks)
    .where(and(eq(tasks.status, "completed"), gte(tasks.updatedAt, todayStr)))
    .all();
  const activeTasks = db.select().from(tasks).where(eq(tasks.status, "active")).all();
  const inboxTasks = db.select().from(tasks).where(eq(tasks.status, "inbox")).all();
  return {
    ok: true,
    completed_today: completedToday.length,
    active: activeTasks.length,
    inbox: inboxTasks.length,
    summary: `${completedToday.length} completed, ${activeTasks.length} active, ${inboxTasks.length} in inbox`,
  };
}

// ─── Reflection ───────────────────────────────────────────────────────────────

const reflectionSvc = new ReflectionService();

function reflectionListAgents(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  return { ok: true, agents: reflectionSvc.listAgents() };
}

function reflectionBuildContexts(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  // Contexts are built inline in createReflectionBatch
  return { ok: true, message: "contexts built per-agent during reflection batch creation" };
}

function reflectionSpawnAgents(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const hours = (args.window_hours as number) ?? 3;
  const result = reflectionSvc.createReflectionBatch(hours);
  return { ok: true, ...result };
}

function reflectionCheckComplete(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const windowStart = (args.window_start as string) ?? new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const result = reflectionSvc.checkComplete(windowStart);
  return { ok: true, ...result };
}

function reflectionRunSweep(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const hours = (args.since_hours as number) ?? 48;
  const db = getDb();
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // Gather completed reflections
  const reflections = db.select().from(agentReflections)
    .where(and(
      eq(agentReflections.status, "completed"),
      gte(agentReflections.createdAt, since),
    ))
    .orderBy(desc(agentReflections.createdAt))
    .all();

  if (reflections.length === 0) {
    log().info("[REFLECTION] Sweep: no completed reflections to process");
    return { ok: true, processed: 0, note: "no reflections" };
  }

  // Gather existing active/proposed tasks for dedup context
  const existingTasks = db.select().from(tasks)
    .where(inArray(tasks.status, ["active", "proposed"]))
    .orderBy(desc(tasks.updatedAt))
    .limit(30)
    .all();

  // Build reflection summaries for triage (no longer persist raw reflection blobs to inbox —
  // they were flooding Rafe's inbox with low-value "Reflection result — X" notices)
  const reflectionSummaries = reflections.map(r => {
    const result = r.result as Record<string, unknown> | null;

    if (!result) return null;
    const parts: string[] = [`### ${r.agentType} (${r.createdAt})`];
    if (result.summary) parts.push(`Summary: ${result.summary}`);
    if (Array.isArray(result.inefficiencies) && result.inefficiencies.length)
      parts.push("Inefficiencies:\n" + (result.inefficiencies as string[]).map(s => `- ${s}`).join("\n"));
    if (Array.isArray(result.systemRisks) && result.systemRisks.length)
      parts.push("Risks:\n" + (result.systemRisks as string[]).map(s => `- ${s}`).join("\n"));
    if (Array.isArray(result.missedOpportunities) && result.missedOpportunities.length)
      parts.push("Missed Opportunities:\n" + (result.missedOpportunities as string[]).map(s => `- ${s}`).join("\n"));
    if (Array.isArray(result.concreteSuggestions) && result.concreteSuggestions.length)
      parts.push("Suggestions:\n" + (result.concreteSuggestions as string[]).map(s => `- ${s}`).join("\n"));
    return parts.join("\n");
  }).filter(Boolean).join("\n\n---\n\n");

  const existingTaskList = existingTasks.map(t =>
    `- [${(t as any).status}] ${(t as any).title} (agent: ${(t as any).agent || "?"})`
  ).join("\n") || "(none)";

  // Send as system event to main session for LLM triage

  const eventText = `[Reflection Sweep] ${reflections.length} agent reflections need triage.

You have ${reflections.length} agent reflections to process. Each agent spent real compute thinking about our system — extract maximum value from their work.

## Your Job
For EACH reflection that contains substantive ideas:
1. Create an **inbox item** (suggestion) summarizing that agent's key insight(s) so Rafe can review/approve/reject them.
2. If a reflection contains **obvious small fixes** (typos, minor config, doc updates) that don't need approval, create tasks directly.

## Classification
- **Needs Rafe's review** (most things): Strategic decisions, new features, architecture changes, process changes, anything non-trivial → **inbox item** (suggestion, requires_action=true)
- **Auto-approve** (only obvious small wins): Config fixes, doc typos, minor cleanup that can't break anything → **task** directly
- **Skip**: Pure noise, vague platitudes with no concrete action, exact duplicates of existing tasks

## Rules
- Create at least one inbox item per agent that produced useful output — don't over-compress.
- Rewrite into clear, actionable titles — not verbatim reflection text.
- Include the agent's reasoning/context in the inbox item content so Rafe has enough info to decide.
- Merge only when two agents said the exact same thing.
- Check existing tasks to avoid duplicates.

## Existing Tasks
${existingTaskList}

## Reflections
${reflectionSummaries}`;

  // Spawn a writer sub-agent to triage reflections — creates inbox items and tasks
  const triageTask = eventText + `

IMPORTANT: After analyzing all reflections above, output a structured JSON summary of what should be created:

\`\`\`json
{
  "suggestions": [
    {
      "title": "Clear actionable title",
      "content": "Detailed description with reasoning from the reflection",
      "summary": "One-line summary",
      "type": "suggestion",
      "requiresAction": true,
      "sourceAgent": "agent_type",
      "priority": "medium"
    }
  ],
  "autoTasks": [
    {
      "title": "Small obvious fix title",
      "agent": "programmer",
      "tier": "micro",
      "notes": "Brief description"
    }
  ],
  "skipped": ["reason for each skipped item"]
}
\`\`\``;

  executeSpawnAgent(
    {
      agent_type: "writer",
      task: triageTask,
      model_tier: "small",
      timeout: 300,
    },
    undefined,
    undefined,
    // onComplete: parse the triage output and create inbox items + tasks
    (result) => {
      try {
        const output = result.output || "";
        const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
          const triage = JSON.parse(jsonMatch[1]);
          const db = getDb();

          // Create inbox suggestion items (with dedup against existing pending items)
          let suggestionsCreated = 0;
          for (const s of (triage.suggestions ?? [])) {
            const title = (s.title || "").slice(0, 200);
            // Dedup: skip if a pending item with the same first 50 chars of title already exists
            const rawDb = getRawDb();
            const existing = rawDb.prepare(
              `SELECT COUNT(*) as cnt FROM inbox_items WHERE substr(title, 1, 50) = substr(?, 1, 50) AND action_status IN ('pending', 'done', 'approved')`
            ).get(title) as { cnt: number } | undefined;
            if (existing && existing.cnt > 0) {
              log().debug?.(`[REFLECTION] Triage skipping duplicate suggestion: "${title.slice(0, 60)}"`);
              continue;
            }
            db.insert(inboxItems).values({
              id: randomUUID(),
              title,
              content: (s.content || "").slice(0, 24000),
              summary: (s.summary || s.title).slice(0, 500),
              type: "suggestion",
              requiresAction: true,
              actionStatus: "pending",
              sourceAgent: s.sourceAgent || "reflection",
              modifiedAt: new Date().toISOString(),
            }).run();
            suggestionsCreated++;
          }
          log().info(`[REFLECTION] Triage created ${suggestionsCreated}/${(triage.suggestions ?? []).length} suggestions (deduped), ${(triage.autoTasks ?? []).length} auto-tasks`);

          // Create auto-approve tasks for obvious small fixes
          for (const t of (triage.autoTasks ?? [])) {
            db.insert(tasks).values({
              id: randomUUID(),
              title: t.title,
              status: "active",
              agent: t.agent || "programmer",
              modelTier: t.tier || "micro",
              notes: t.notes || "",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }).run();
          }
        }
      } catch (e) {
        log().error(`[REFLECTION] Triage result parsing failed: ${e}`);
      }
    }
  );

  // Mark reflections as swept so they don't get re-processed
  for (const r of reflections) {
    db.update(agentReflections).set({ status: "swept" }).where(eq(agentReflections.id, r.id)).run();
  }
  log().info(`[REFLECTION] Sweep: gathered ${reflections.length} reflections, marked swept, sent to main for triage`);
  return { ok: true, processed: reflections.length, sentToMain: true };
}

function reflectionRunCompression(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const agents = reflectionSvc.listAgents();
  const results = agents.map(a => reflectionSvc.runCompression(a));
  const passed = results.filter(r => r.validationPassed).length;
  return { ok: true, agents: agents.length, versions_created: passed, results };
}


function reflectionPickNext(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const hours = (args.window_hours as number) ?? 3;
  const result = reflectionSvc.pickNextAgent(hours);
  if (!result) return { ok: true, picked: false, all_reflected: true };
  return { ok: true, picked: true, agent_type: result.agentType, reflection_id: result.reflectionId };
}

function reflectionBuildPrompt(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const agentType = args.agent_type as string;
  const reflectionId = args.reflection_id as string;
  if (!agentType || !reflectionId) return { ok: false, error: "agent_type and reflection_id required" };
  const prompt = reflectionSvc.buildReflectionPrompt(agentType, reflectionId);
  return { ok: true, prompt, agent_type: agentType, reflection_id: reflectionId };
}

function reflectionStoreOutput(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const reflectionId = args.reflection_id as string;
  let output = args.output as string ?? "";
  if (!reflectionId) return { ok: false, error: "reflection_id required" };

  // If output is empty/placeholder, try to get from context or mark as no-output
  if (!output || output === "undefined" || output === "null" || output.trim() === "") {
    output = "No structured output captured from reflection worker. The worker may have completed without producing parseable results.";
    log().warn(`[REFLECTION] No output for reflection ${reflectionId.slice(0, 8)}, storing placeholder`);
  }

  reflectionSvc.storeReflectionOutput(reflectionId, output);
  return { ok: true, stored: true, reflection_id: reflectionId };
}

function reflectionSpawnAll(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const hours = (args.window_hours as number) ?? 3;

  const spawned: string[] = [];
  const pickedAgents = new Set<string>();

  for (const _agent of reflectionSvc.listAgents()) {
    const pick = reflectionSvc.pickNextAgent(hours, pickedAgents);
    if (!pick) continue;
    pickedAgents.add(pick.agentType);

    const prompt = reflectionSvc.buildReflectionPrompt(pick.agentType, pick.reflectionId);
    const reflectionId = pick.reflectionId;
    const agentType = pick.agentType;

    // Spawn via lobs-core's own runner with a completion callback
    // Reflections need no tools and should complete in 1-3 turns
    executeSpawnAgent(
      {
        agent_type: agentType,
        task: prompt,
        model_tier: "small",
        timeout: 300,
        max_turns: 5,
        extra_tools: [],  // no tools needed — data is in the prompt
        no_default_tools: true,  // override default tool set — reflections are pure text
      },
      undefined, // cwd
      undefined, // channelId — no need to announce to Discord
      // onComplete: capture the reflection result and store in DB
      (result) => {
        const db = getDb();
        try {
          const output = result.output || "";
          // Try to parse structured JSON from the output
          let parsed: Record<string, unknown> = {};
          const jsonMatch = output.match(/```json\s*([\s\S]*?)```/) ?? output.match(/\{[\s\S]*"inefficiencies"[\s\S]*\}/);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
            } catch { /* ignore parse errors */ }
          }

          const reflectionResult: Record<string, unknown> = {
            raw: output.slice(0, 16000),
            inefficiencies: parsed.inefficiencies ?? [],
            systemRisks: parsed.systemRisks ?? parsed.system_risks ?? [],
            missedOpportunities: parsed.missedOpportunities ?? parsed.missed_opportunities ?? [],
            identityAdjustments: parsed.identityAdjustments ?? parsed.identity_adjustments ?? [],
            suggestions: parsed.suggestions ?? [],
          };

          db.update(agentReflections)
            .set({
              status: result.succeeded ? "completed" : "failed",
              result: reflectionResult,
              completedAt: new Date().toISOString(),
            })
            .where(eq(agentReflections.id, reflectionId))
            .run();

          log().info(`[REFLECTION] ${agentType} reflection ${reflectionId.slice(0, 8)} ${result.succeeded ? "completed" : "failed"} (output: ${output.length} chars)`);
        } catch (e) {
          log().error(`[REFLECTION] Failed to store result for ${reflectionId}: ${e}`);
        }
      }
    );

    spawned.push(agentType);
  }

  if (spawned.length === 0) {
    log().info("[REFLECTION] All agents reflected within window, nothing to spawn");
  } else {
    log().info(`[REFLECTION] Spawned ${spawned.length} reflection workers: ${spawned.join(", ")}`);
  }

  return { ok: true, spawned: spawned.length, agents: spawned };
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

function diagnosticsRunOnce(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const db = getDb();
  const now = new Date().toISOString();
  // Check for stale workers (started > 2h ago, no endedAt)
  const staleThreshold = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const staleWorkers = db.select().from(workerRuns)
    .where(and(isNull(workerRuns.endedAt), lte(workerRuns.startedAt, staleThreshold)))
    .all();

  // Check for stuck tasks (active but no worker for > 30min)
  const stuckThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const activeTasks = db.select().from(tasks).where(eq(tasks.status, "active")).all();

  // Expire stale reflections (active for > 30 min — workers have 5min timeout)
  const reflectionStaleThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const staleReflections = db.select().from(agentReflections)
    .where(and(
      eq(agentReflections.status, "active"),
      lte(agentReflections.createdAt, reflectionStaleThreshold),
    ))
    .all();
  if (staleReflections.length > 0) {
    for (const r of staleReflections) {
      db.update(agentReflections)
        .set({ status: "expired", completedAt: now })
        .where(eq(agentReflections.id, r.id))
        .run();
    }
    log().info(`[DIAGNOSTICS] Expired ${staleReflections.length} stale reflections`);
  }

  const issues: string[] = [];
  if (staleWorkers.length > 0) issues.push(`${staleWorkers.length} stale workers`);
  if (staleReflections.length > 0) issues.push(`${staleReflections.length} stale reflections expired`);

  log().info(`[CALLABLE] diagnostics.run_once: ${issues.length === 0 ? "healthy" : issues.join(", ")}`);
  return { ok: true, stale_workers: staleWorkers.length, active_tasks: activeTasks.length, stale_reflections_expired: staleReflections.length, issues, healthy: issues.length === 0 };
}

// ─── Learning ─────────────────────────────────────────────────────────────────

const learningSvc = new LearningService();

function learningCheckDue(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const due = learningSvc.checkDuePlans();
  return { ok: true, due_plans: due.length, plans: due };
}

function learningCreatePlan(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const topic = args.topic as string;
  if (!topic) return { ok: false, error: "topic required" };
  const planId = learningSvc.createPlan({
    topic,
    goal: (args.goal as string) ?? undefined,
    totalDays: (args.total_days as number) ?? undefined,
    scheduleCron: (args.schedule_cron as string) ?? undefined,
    deliveryChannel: (args.delivery_channel as string) ?? undefined,
  });
  return { ok: true, plan_id: planId, topic };
}

// ─── Upkeep ───────────────────────────────────────────────────────────────────

function upkeepReviewSweep(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const db = getDb();
  // Find inbox items older than 7 days that are unread
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const old = db.select().from(inboxItems)
    .where(and(eq(inboxItems.isRead, false), lte(inboxItems.modifiedAt, cutoff)))
    .all();
  return { ok: true, stale_inbox_items: old.length, items: old.map(i => ({ id: i.id, title: i.title, modifiedAt: i.modifiedAt })) };
}

function upkeepDocScan(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  // Scan for tasks with artifact paths that might need documentation
  const db = getDb();
  const completed = db.select().from(tasks)
    .where(and(eq(tasks.status, "completed"), isNull(tasks.artifactPath)))
    .limit(20)
    .all();
  return { ok: true, undocumented_tasks: completed.length };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

function schedulerFireDueEvents(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const db = getDb();
  const now = new Date().toISOString();
  const due = db.select().from(scheduledEvents)
    .where(and(eq(scheduledEvents.status, "pending"), lte(scheduledEvents.nextFireAt, now)))
    .all();
  let fired = 0;
  for (const evt of due) {
    db.update(scheduledEvents).set({
      lastFiredAt: now,
      fireCount: (evt.fireCount ?? 0) + 1,
      status: evt.recurrenceRule ? "pending" : "fired",
      updatedAt: now,
    }).where(eq(scheduledEvents.id, evt.id)).run();
    fired++;
  }
  return { ok: true, fired };
}

// ─── GitHub Sync ──────────────────────────────────────────────────────────────

function githubSyncAll(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const svc = new GitHubSyncService();
  try {
    const result = svc.syncAll();
    return { ok: true, ...result };
  } catch (e) {
    log().warn(`[CALLABLE] github_sync.sync_all failed: ${String(e)}`);
    return { ok: false, error: String(e) };
  }
}

// ─── Memory Sync ─────────────────────────────────────────────────────────────

function memorySyncAll(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  // Memory sync: ensure agent status records are current
  const db = getDb();
  const profiles = db.select().from(agentProfiles).where(eq(agentProfiles.active, true)).all();
  const now = new Date().toISOString();
  let ensured = 0;
  for (const profile of profiles) {
    const existing = db.select().from(agentStatus).where(eq(agentStatus.agentType, profile.agentType)).get();
    if (!existing) {
      db.insert(agentStatus).values({ agentType: profile.agentType, status: "idle", activity: null }).run();
      ensured++;
    }
  }
  return { ok: true, profiles: profiles.length, ensured };
}

// ─── System ───────────────────────────────────────────────────────────────────

function systemCleanup(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const db = getDb();
  const now = new Date().toISOString();
  // Clean up old workflow events (> 30 days)
  const cutoff30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  // We don't delete, just summarize for now (safe)
  const oldWorkerRuns = db.select().from(workerRuns)
    .where(lte(workerRuns.startedAt, cutoff30))
    .all();
  log().info(`[CALLABLE] system.cleanup: ${oldWorkerRuns.length} old worker runs found (not purged)`);
  return { ok: true, old_worker_runs: oldWorkerRuns.length, cleaned: 0 };
}

// ─── Inbox ────────────────────────────────────────────────────────────────────

function inboxProcessThreads(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const db = getDb();

  // Find approved items that haven't been processed yet
  const approved = db.select().from(inboxItems)
    .where(and(
      eq(inboxItems.actionStatus, "approved"),
      eq(inboxItems.requiresAction, true),
    ))
    .all();

  // Also find items with unprocessed user comments (from threads)
  const withComments = db.select().from(inboxItems)
    .where(and(
      eq(inboxItems.requiresAction, true),
      eq(inboxItems.actionStatus, "pending"),
    ))
    .all()
    .filter(item => {
      const thread = db.select().from(inboxThreads).where(eq(inboxThreads.docId, item.id)).get();
      if (!thread) return false;
      const msgs = db.select().from(inboxMessages).where(eq(inboxMessages.threadId, (thread as any).id)).all();
      return msgs.some((m: any) => m.role === "user");
    });

  const toProcess = [...approved, ...withComments];
  if (toProcess.length === 0) {
    return { ok: true, processed: 0, note: "no items to process" };
  }

  const itemSummaries = toProcess.map(item => {
    const typ = (item as any).type ?? "suggestion";
    const src = (item as any).sourceAgent ?? "unknown";
    const detail = item.content ?? item.summary ?? "no details";
    return "- " + item.title + " (id: " + item.id + ")\n  Type: " + typ + "\n  Content: " + detail + "\n  Source: " + src + "\n  Status: " + (item as any).actionStatus;
  }).join("\n\n");

  const prompt = [
    "[Inbox Processing] " + toProcess.length + " inbox item(s) need processing.",
    "",
    "These items were reviewed by Rafe. For approved items, process each one.",
    "For each item, output a structured JSON with the actions to take:",
    "",
    "```json",
    "{",
    '  "actions": [',
    '    { "itemId": "UUID", "action": "create_task", "title": "...", "agent": "programmer", "tier": "small", "notes": "..." },',
    '    { "itemId": "UUID", "action": "dismiss", "reason": "already done" }',
    "  ]",
    "}",
    "```",
    "",
    "## Items",
    itemSummaries,
  ].join("\n");

  const itemIds = toProcess.map(i => i.id);
  executeSpawnAgent(
    {
      agent_type: "writer",
      task: prompt,
      model_tier: "small",
      timeout: 300,
    },
    undefined,
    undefined,
    (result) => {
      try {
        const output = result.output || "";
        const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1]);
          const db = getDb();
          for (const action of (parsed.actions ?? [])) {
            if (action.action === "create_task") {
              db.insert(tasks).values({
                id: randomUUID(),
                title: action.title,
                status: "active",
                agent: action.agent || "programmer",
                modelTier: action.tier || "small",
                notes: action.notes || "",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }).run();
            }
            // Mark inbox item as done
            if (action.itemId) {
              db.update(inboxItems)
                .set({ actionStatus: "done" })
                .where(eq(inboxItems.id, action.itemId))
                .run();
            }
          }
          log().info(`[INBOX] Processed ${(parsed.actions ?? []).length} inbox actions`);
        }
      } catch (e) {
        log().error(`[INBOX] Processing result parse failed: ${e}`);
      }
    }
  );

  // Mark items as processing to prevent re-spawn on next cycle
  for (const item of toProcess) {
    db.update(inboxItems).set({ actionStatus: "processing" }).where(eq(inboxItems.id, item.id)).run();
  }

  log().info("[INBOX] Processing agent spawned for " + toProcess.length + " items");
  return { ok: true, processed: toProcess.length, items: toProcess.map(i => i.id) };
}

// ─── Compliance ───────────────────────────────────────────────────────────────

/**
 * compliance.weekly_report
 *
 * Computes a weekly compliance summary (last 7 days) using model_usage_events.
 * Classifies each call as "compliant" (on-device/local) or "non-compliant" (cloud).
 * Returns stats + a human-readable summary string for the notify node.
 */
function complianceWeeklyReport(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const db = getDb();
  const now = new Date();
  const cutoff = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();

  // Known cloud providers (matches isCompliantCall logic in usage.ts)
  const CLOUD_PROVIDERS = new Set([
    "anthropic", "openai", "google", "mistral", "cohere", "ai21",
    "huggingface", "together", "replicate", "perplexity", "groq",
    "anyscale", "fireworks", "deepinfra", "lepton", "azure",
  ]);

  function isCompliant(provider: string, routeType: string): boolean {
    if (routeType === "local") return true;
    return !CLOUD_PROVIDERS.has(provider.toLowerCase());
  }

  const events = db.select().from(modelUsageEvents)
    .where(gte(modelUsageEvents.timestamp, cutoff))
    .all();

  let compliantCount = 0;
  let nonCompliantCount = 0;
  let compliantTokens = 0;
  let nonCompliantTokens = 0;
  const byProvider: Record<string, { compliant: boolean; calls: number; tokens: number }> = {};

  for (const e of events) {
    const provider = e.provider ?? "unknown";
    const routeType = e.routeType ?? "api";
    const compliant = isCompliant(provider, routeType);
    const calls = e.requests ?? 1;
    const tokens = (e.inputTokens ?? 0) + (e.outputTokens ?? 0);

    if (compliant) { compliantCount += calls; compliantTokens += tokens; }
    else { nonCompliantCount += calls; nonCompliantTokens += tokens; }

    const key = `${provider}::${String(compliant)}`;
    const b = byProvider[key] ?? { compliant, calls: 0, tokens: 0 };
    b.calls += calls;
    b.tokens += tokens;
    byProvider[key] = b;
  }

  const totalCount = compliantCount + nonCompliantCount;
  const compliantPct = totalCount > 0 ? Math.round((compliantCount / totalCount) * 1000) / 10 : 0;
  const nonCompliantPct = totalCount > 0 ? Math.round((nonCompliantCount / totalCount) * 1000) / 10 : 0;

  // Determine status tone
  let tone = "🟢";
  let toneLabel = "Great — most AI work is staying private.";
  if (compliantPct < 40) { tone = "🔴"; toneLabel = "Most AI work is going to external services. Review sensitive tasks."; }
  else if (compliantPct < 80) { tone = "🟡"; toneLabel = "Some AI work is going to external services. Review sensitive tasks."; }

  // Format provider breakdown
  const breakdownLines = Object.entries(byProvider)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([key, b]) => {
      const [prov] = key.split("::");
      const icon = b.compliant ? "🔒" : "🌐";
      const label = b.compliant ? "Protected" : "External";
      return `  ${icon} ${prov} (${label}): ${b.calls.toLocaleString()} request${b.calls !== 1 ? "s" : ""}`;
    })
    .join("\n");

  const weekLabel = `${new Date(cutoff).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  const summary =
    `${tone} **Weekly AI Privacy Report** — ${weekLabel}\n\n` +
    `**${totalCount.toLocaleString()} total AI requests**\n` +
    `🔒 Protected (on-device): ${compliantCount.toLocaleString()} (${compliantPct}%)\n` +
    `🌐 External (cloud): ${nonCompliantCount.toLocaleString()} (${nonCompliantPct}%)\n\n` +
    (breakdownLines ? `**By provider:**\n${breakdownLines}\n\n` : "") +
    toneLabel;

  log().info(`[CALLABLE] compliance.weekly_report: total=${totalCount} compliant=${compliantCount} (${compliantPct}%)`);

  return {
    ok: true,
    period_start: cutoff,
    period_end: now.toISOString(),
    total_count: totalCount,
    compliant_count: compliantCount,
    non_compliant_count: nonCompliantCount,
    compliant_pct: compliantPct,
    non_compliant_pct: nonCompliantPct,
    compliant_tokens: compliantTokens,
    non_compliant_tokens: nonCompliantTokens,
    summary,
    has_data: totalCount > 0,
  };
}

// ─── Training Pipeline ──────────────────────────────────────────────────────────

async function trainingRunHarvest(_args: Record<string, unknown>, _ctx: CallableContext): Promise<Record<string, unknown>> {
  const results = await runHarvest();
  const total = results.reduce((sum, r) => sum + r.extracted, 0);
  const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
  return {
    ok: true,
    total_extracted: total,
    total_skipped: skipped,
    sources: results.map(r => ({ source: r.source, extracted: r.extracted, skipped: r.skipped })),
  };
}

function trainingGetStats(_args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const stats = getHarvestStats();
  return { ok: true, ...stats };
}

function trainingBulkApprove(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const minQuality = (args.min_quality as number) ?? 0.6;
  const count = bulkApprove(minQuality);
  return { ok: true, approved: count };
}

function trainingExport(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const minQuality = args.min_quality as number | undefined;
  const taskType = args.task_type as string | undefined;
  const jsonl = exportTrainingJSONL({ minQuality, taskType });
  const lines = jsonl ? jsonl.split("\n").filter(Boolean) : [];
  // Write to a temp file for downstream use
  const outPath = `/tmp/lobs-training-export-${Date.now()}.jsonl`;
  writeFileSync(outPath, jsonl);
  return { ok: true, path: outPath, count: lines.length };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<string, CallableFn | undefined> = {
  // Assignment
  "assignment.assign_agent": assignmentAssignAgent,
  "assignment.scan_unassigned": assignmentScanUnassigned,

  // Calendar
  "calendar.sync_google": calendarSyncGoogle,
  "calendar.check_upcoming": calendarCheckUpcoming,

  // Email
  "email.check_inbox": emailCheckInbox,

  // Tracker
  "tracker.check_deadlines": trackerCheckDeadlines,
  "tracker.daily_summary": trackerDailySummary,

  // Reflection
  "reflection.list_agents": reflectionListAgents,
  "reflection.build_contexts": reflectionBuildContexts,
  "reflection.spawn_agents": reflectionSpawnAgents,
  "reflection.check_complete": reflectionCheckComplete,
  "reflection.run_sweep": reflectionRunSweep,
  "reflection.run_compression": reflectionRunCompression,
  "reflection.pick_next": reflectionPickNext,
  "reflection.build_prompt": reflectionBuildPrompt,
  "reflection.store_output": reflectionStoreOutput,
  "reflection.spawn_all": reflectionSpawnAll,

  // Diagnostics
  "diagnostics.run_once": diagnosticsRunOnce,

  // Learning
  "learning.check_due": learningCheckDue,
  "learning.create_plan": learningCreatePlan,

  // Upkeep
  "upkeep.review_sweep": upkeepReviewSweep,
  "upkeep.doc_scan": upkeepDocScan,

  // Scheduler
  "scheduler.fire_due_events": schedulerFireDueEvents,

  // GitHub sync
  "github_sync.sync_all": githubSyncAll,

  // Memory sync
  "memory_sync.sync_all": memorySyncAll,

  // System
  "system.cleanup": systemCleanup,

  // Inbox
  "inbox.process_threads": inboxProcessThreads,

  // Compliance
  "compliance.weekly_report": complianceWeeklyReport,

  // Training pipeline
  "training.run_harvest": trainingRunHarvest,
  "training.get_stats": trainingGetStats,
  "training.bulk_approve": trainingBulkApprove,
  "training.export": trainingExport,
};

export function getCallable(name: string): CallableFn | undefined {
  return REGISTRY[name];
}

export function listCallables(): string[] {
  return Object.keys(REGISTRY);
}

export function executeCallable(name: string, args: Record<string, unknown>, ctx: CallableContext): Record<string, unknown> | Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (REGISTRY as any)[name] as ((...a: any[]) => Record<string, unknown> | Promise<Record<string, unknown>>) | undefined;
  if (!fn) {
    log().warn(`[CALLABLE] Unknown callable: ${name}`);
    return { ok: false, error: `Unknown callable: ${name}` };
  }
  try {
    const result = fn(args, ctx);
    // Handle async callables transparently
    if (result && typeof (result as any).then === "function") {
      return (result as Promise<Record<string, unknown>>).then(r => {
        log().info(`[CALLABLE] ${name} → ok (async)`);
        return r;
      }).catch(e => {
        log().error(`[CALLABLE] ${name} threw (async): ${String(e)}`);
        return { ok: false, error: String(e) };
      });
    }
    log().info(`[CALLABLE] ${name} → ok`);
    return result;
  } catch (e) {
    log().error(`[CALLABLE] ${name} threw: ${String(e)}`);
    return { ok: false, error: String(e) };
  }
}
