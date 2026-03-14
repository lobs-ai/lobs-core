/**
 * Callable Registry — maps ts_call callable strings to TypeScript functions.
 * Port of lobs-server/app/orchestrator/workflow_functions.py + workflow_integrations.py
 *
 * Each callable receives (args: Record<string, unknown>, context: CallableContext) and returns a result.
 * All DB operations are synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import { eq, and, lte, gte, desc, isNull, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
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
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { getModelForTier } from "../config/models.js";

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

  // Build reflection summaries and persist each raw reflection into inbox (notice)
  let rawInboxCount = 0;
  const reflectionSummaries = reflections.map(r => {
    const result = r.result as Record<string, unknown> | null;

    // Persist full per-agent reflection so human can review all outputs, not just triage results.
    const existingInbox = db.select().from(inboxItems)
      .where(eq(inboxItems.sourceReflectionId, r.id))
      .limit(1)
      .get();

    if (!existingInbox) {
      const summaryText = (typeof result?.summary === "string" && result.summary.trim().length > 0)
        ? result.summary.trim()
        : `Reflection output from ${r.agentType}`;
      const payloadText = result
        ? JSON.stringify(result, null, 2)
        : "No structured reflection payload captured.";

      db.insert(inboxItems).values({
        id: randomUUID(),
        title: `Reflection result — ${r.agentType}`,
        content: payloadText.slice(0, 24000),
        summary: summaryText.slice(0, 500),
        type: "notice",
        requiresAction: false,
        actionStatus: "pending",
        sourceAgent: r.agentType,
        sourceReflectionId: r.id,
        modifiedAt: new Date().toISOString(),
      }).run();
      rawInboxCount += 1;
    }

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

  // Spawn a sub-agent to triage reflections autonomously
  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  let gwPort = 18789;
  let gwToken = "";
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    gwPort = cfg?.gateway?.port ?? 18789;
    gwToken = cfg?.gateway?.auth?.token ?? "";
  } catch (_) {}

  if (gwToken) {
    const triageInstructions = "\n\nYou have access to CLI tools for creating tasks and inbox items. Use these instead of raw SQL:\n\nTo create a task (medium/low impact — auto-assigned to agents):\npaw-task create --title \"TITLE\" --agent AGENT_TYPE --tier TIER --notes \"NOTES\"\n\nTo create an inbox item (high impact only — needs Rafe's review):\npaw-inbox create --title \"TITLE\" --content \"DETAILED CONTENT\" --summary \"ONE LINE SUMMARY\" --type suggestion --action --agent SOURCE_AGENT\n\nTo check existing tasks (avoid duplicates):\npaw-task list --status active\n\nAgent types: programmer, writer, researcher, reviewer, architect\nModel tiers: micro (trivial), small (simple), medium (moderate), standard (significant), strong (complex)\n\nAfter creating all items, print a summary of what you created.";
    fetch(`http://127.0.0.1:${gwPort}/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${gwToken}` },
      body: JSON.stringify({
        tool: "sessions_spawn",
        sessionKey: "agent:sink:paw-orchestrator-v2",
        args: {
          task: eventText + triageInstructions,
          agentId: "main",
          model: getModelForTier("standard"),
          mode: "run",
          cleanup: "keep",
          runTimeoutSeconds: 300,
        },
      }),
    }).then(r => r.json()).then(data => {
      log().info(`[REFLECTION] Triage agent spawned: ${JSON.stringify(data).slice(0, 200)}`);
    }).catch(e => {
      log().warn(`[REFLECTION] Failed to spawn triage agent: ${e}`);
    });
  } else {
    log().warn("[REFLECTION] No gateway token for triage agent");
  }

  // Mark reflections as swept so they don't get re-processed
  for (const r of reflections) {
    db.update(agentReflections).set({ status: "swept" }).where(eq(agentReflections.id, r.id)).run();
  }
  log().info(`[REFLECTION] Sweep: gathered ${reflections.length} reflections, wrote ${rawInboxCount} raw inbox notices, marked swept, sent to main for triage`);
  return { ok: true, processed: reflections.length, rawInboxNotices: rawInboxCount, sentToMain: true };
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

  // Read gateway config
  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  let gatewayPort = 18789;
  let gatewayToken = "";
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    gatewayPort = cfg?.gateway?.port ?? 18789;
    gatewayToken = cfg?.gateway?.auth?.token ?? "";
  } catch (_) {}

  if (!gatewayToken) {
    log().warn("[REFLECTION] No gateway token — cannot spawn reflection workers");
    return { ok: false, error: "no gateway token" };
  }

  const baseUrl = `http://127.0.0.1:${gatewayPort}`;

  // Pick agents that need reflection and spawn async
  const spawned: string[] = [];

  for (const _agent of reflectionSvc.listAgents()) {
    const pick = reflectionSvc.pickNextAgent(hours);
    if (!pick) continue;

    const prompt = reflectionSvc.buildReflectionPrompt(pick.agentType, pick.reflectionId);

    // Async spawn via fetch (fire-and-forget — result collection handled by subagent_ended hook)
    const payload = JSON.stringify({
      tool: "sessions_spawn",
      sessionKey: "agent:sink:paw-orchestrator-v2",
      args: {
        task: prompt,
        agentId: pick.agentType,
        model: getModelForTier("standard"),
        mode: "run",
        cleanup: "keep",
        runTimeoutSeconds: 300,
        maxTokens: 16384,
        metadata: { pawReflection: true, reflectionId: pick.reflectionId, agentType: pick.agentType },
      },
    });

    fetch(`${baseUrl}/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${gatewayToken}` },
      body: payload,
    }).then(r => r.json()).then(data => {
      log().info(`[REFLECTION] Spawned ${pick.agentType} (reflection=${pick.reflectionId.slice(0, 8)}): ${JSON.stringify(data).slice(0, 120)}`);
    }).catch(e => {
      log().warn(`[REFLECTION] Spawn ${pick.agentType} failed: ${e}`);
    });

    spawned.push(pick.agentType);
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

  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  let gwPort = 18789;
  let gwToken = "";
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    gwPort = cfg?.gateway?.port ?? 18789;
    gwToken = cfg?.gateway?.auth?.token ?? "";
  } catch (_) {}

  if (!gwToken) {
    return { ok: false, error: "no gateway token" };
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
    "These items were reviewed by Rafe. For approved items, process each one:",
    "- If it needs a task: use paw-task create",
    "- If it needs research: create a researcher task",
    "- If it needs architecture: create an architect task", 
    "- If Rafe left comments: read them and respond appropriately",
    "- Use your judgment on what each item needs",
    "",
    "After processing each item, mark it done:",
    "  paw-inbox approve <id>   (if not already approved)",
    "",
    "## Items",
    itemSummaries,
  ].join("\n");

  fetch("http://127.0.0.1:" + gwPort + "/tools/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + gwToken },
    body: JSON.stringify({
      tool: "sessions_spawn",
      sessionKey: "agent:sink:paw-orchestrator-v2",
      args: {
        task: prompt,
        agentId: "main",
        model: getModelForTier("standard"),
        mode: "run",
        cleanup: "keep",
        runTimeoutSeconds: 300,
      },
    }),
  }).catch(e => log().error("[INBOX] spawn failed: " + e));

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
};

export function getCallable(name: string): CallableFn | undefined {
  return REGISTRY[name];
}

export function listCallables(): string[] {
  return Object.keys(REGISTRY);
}

export function executeCallable(name: string, args: Record<string, unknown>, ctx: CallableContext): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (REGISTRY as any)[name] as ((...a: any[]) => Record<string, unknown>) | undefined;
  if (!fn) {
    log().warn(`[CALLABLE] Unknown callable: ${name}`);
    return { ok: false, error: `Unknown callable: ${name}` };
  }
  try {
    const result = fn(args, ctx);
    log().info(`[CALLABLE] ${name} → ok`);
    return result;
  } catch (e) {
    log().error(`[CALLABLE] ${name} threw: ${String(e)}`);
    return { ok: false, error: String(e) };
  }
}
