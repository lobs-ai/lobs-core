/**
 * Callable Registry — maps ts_call callable strings to TypeScript functions.
 * Port of lobs-server/app/orchestrator/workflow_functions.py + workflow_integrations.py
 *
 * Each callable receives (args: Record<string, unknown>, context: CallableContext) and returns a result.
 * All DB operations are synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import { eq, and, lte, gte, desc, isNull } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import {
  tasks, projects, inboxItems, inboxThreads, scheduledEvents,
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

export interface CallableContext {
  workflowRunId?: string;
  nodeId?: string;
  taskId?: string;
  agentType?: string;
  [key: string]: unknown;
}

export type CallableFn = (args: Record<string, unknown>, ctx: CallableContext) => Record<string, unknown>;

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

function calendarSyncGoogle(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const svc = new GoogleCalendarService();
  if (!svc.isConfigured()) return { ok: false, skipped: true, reason: "not_configured" };
  const days = (args.days_ahead as number) ?? 14;
  const result = svc.syncToDb(days);
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
  const hours = (args.window_hours as number) ?? 6;
  const result = reflectionSvc.createReflectionBatch(hours);
  return { ok: true, ...result };
}

function reflectionCheckComplete(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const windowStart = (args.window_start as string) ?? new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const result = reflectionSvc.checkComplete(windowStart);
  return { ok: true, ...result };
}

function reflectionRunSweep(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const hours = (args.since_hours as number) ?? 24;
  const result = reflectionSvc.runSweep(hours);
  return { ok: true, ...result };
}

function reflectionRunCompression(args: Record<string, unknown>, _ctx: CallableContext): Record<string, unknown> {
  const agents = reflectionSvc.listAgents();
  const results = agents.map(a => reflectionSvc.runCompression(a));
  const passed = results.filter(r => r.validationPassed).length;
  return { ok: true, agents: agents.length, versions_created: passed, results };
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

  const issues: string[] = [];
  if (staleWorkers.length > 0) issues.push(`${staleWorkers.length} stale workers`);

  log().info(`[CALLABLE] diagnostics.run_once: ${issues.length === 0 ? "healthy" : issues.join(", ")}`);
  return { ok: true, stale_workers: staleWorkers.length, active_tasks: activeTasks.length, issues, healthy: issues.length === 0 };
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
  // Find unread inbox items and group into threads by title prefix
  const unread = db.select().from(inboxItems).where(eq(inboxItems.isRead, false)).all();
  // Simple grouping: find duplicate titles
  const seen = new Map<string, number>();
  for (const item of unread) {
    const key = (item.title ?? "").slice(0, 40);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).length;
  return { ok: true, unread_items: unread.length, potential_threads: duplicates };
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
