/**
 * Workflow executor — advances workflow runs one step at a time.
 * Port of lobs-server/app/orchestrator/workflow_executor.py
 *
 * Synchronous (better-sqlite3 — no async/await for DB ops).
 */

import { randomUUID } from "node:crypto";
import { eq, and, inArray, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import {
  workflowDefinitions,
  workflowRuns,
  workflowEvents,
  workflowSubscriptions,
  tasks,
  projects,
} from "../db/schema.js";
import { NodeHandlers, type WorkflowRun } from "./nodes.js";
import { evaluateCondition } from "./functions.js";
import { queueReviewerFollowup } from "../hooks/subagent.js";
import { shouldTriggerReview } from "../orchestrator/review-triggers.js";
import { log } from "../util/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type WorkflowRunRow = typeof workflowRuns.$inferSelect;
type WorkflowDefRow = typeof workflowDefinitions.$inferSelect;

// ── Simple cron matcher (no dependency) ──────────────────────────────────────

function cronMatches(cronExpr: string, now: Date): boolean {
  // Format: "min hour dom mon dow"
  // Uses UTC accessors — caller must provide a Date whose UTC fields
  // represent the desired timezone's wall-clock time.
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minPat, hourPat, domPat, monPat, dowPat] = parts;

  const m = now.getUTCMinutes();
  const h = now.getUTCHours();
  const dom = now.getUTCDate();
  const mon = now.getUTCMonth() + 1;
  const dow = now.getUTCDay();

  return (
    matchCronField(minPat, m, 0, 59) &&
    matchCronField(hourPat, h, 0, 23) &&
    matchCronField(domPat, dom, 1, 31) &&
    matchCronField(monPat, mon, 1, 12) &&
    matchCronField(dowPat, dow, 0, 6)
  );
}

function matchCronField(pat: string, value: number, min: number, max: number): boolean {
  if (pat === "*") return true;
  // */n
  if (pat.startsWith("*/")) {
    const step = parseInt(pat.slice(2), 10);
    return value % step === 0;
  }
  // ranges: 1-5
  if (pat.includes("-")) {
    const [lo, hi] = pat.split("-").map(Number);
    return value >= lo && value <= hi;
  }
  // lists: 1,2,3
  if (pat.includes(",")) {
    return pat.split(",").map(Number).includes(value);
  }
  return parseInt(pat, 10) === value;
}

// ── WorkflowExecutor ──────────────────────────────────────────────────────────

export class WorkflowExecutor {
  private nodeHandlers: NodeHandlers;

  constructor() {
    this.nodeHandlers = new NodeHandlers();
  }

  private summarizeNodeState(nodeState: Record<string, unknown> | undefined): string {
    if (!nodeState) return "unknown";
    const status = String(nodeState["status"] ?? "unknown");
    const attempts = Number(nodeState["attempts"] ?? 0);
    const sessionKey = nodeState["session_key"] ?? nodeState["childSessionKey"];
    const error = nodeState["error"] as string | undefined;

    const parts = [status];
    if (attempts > 0) parts.push(`attempt=${attempts}`);
    if (sessionKey && typeof sessionKey === "string") parts.push(`session=${sessionKey.slice(0, 24)}`);
    if (error) parts.push(`error=${error.slice(0, 80)}`);
    return parts.join(" ");
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getActiveRuns(limit = 20): WorkflowRunRow[] {
    const db = getDb();
    return db.select()
      .from(workflowRuns)
      .where(inArray(workflowRuns.status, ["pending", "running"]))
      .orderBy(workflowRuns.createdAt)
      .limit(limit)
      .all();
  }

  /**
   * Advance a run by at most one step. Returns true if work was done.
   */
  async advance(run: WorkflowRunRow): Promise<boolean> {
    try {
      const db = getDb();
      const workflow = db.select().from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, run.workflowId))
        .get();

      if (!workflow) {
        this._finishRun(run, "failed", "Workflow definition not found");
        return true;
      }

      const nodes = (workflow.nodes as unknown[]) ?? [];
      const nodesById = new Map<string, Record<string, unknown>>(
        nodes.map(n => [(n as Record<string, unknown>)["id"] as string, n as Record<string, unknown>])
      );

      // Bootstrap pending → running
      if (run.status === "pending") {
        const entryId = this._findEntryNode(workflow);
        if (!entryId) {
          this._finishRun(run, "failed", "No entry node found");
          return true;
        }
        db.update(workflowRuns).set({
          status: "running",
          currentNode: entryId,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).where(eq(workflowRuns.id, run.id)).run();
        log().info(
          `[WORKFLOW] Run ${run.id.slice(0, 8)} entered workflow '${workflow.name}' at node '${entryId}' ` +
          `(task=${run.taskId?.slice(0, 8) ?? "none"})`
        );
        return true;
      }

      const nodeId = run.currentNode;
      if (!nodeId) {
        this._finishRun(run, "completed");
        return true;
      }

      const nodeDef = nodesById.get(nodeId);
      if (!nodeDef) {
        this._finishRun(run, "failed", `Node ${nodeId} not found in definition`);
        return true;
      }

      const nodeStates: Record<string, Record<string, unknown>> =
        (run.nodeStates as Record<string, Record<string, unknown>>) ?? {};
      const ns = nodeStates[nodeId] ?? {};
      const status = ns["status"] as string ?? "pending";

      if (status === "pending") return await this._startNode(run, nodeDef, nodeStates, workflow);
      if (status === "running") return this._checkNode(run, nodeDef, nodeStates, workflow);
      if (status === "completed") return this._transition(run, nodeDef, nodeStates, workflow);
      if (status === "failed") return this._handleFailure(run, nodeDef, nodeStates, workflow);

      this._finishRun(run, "failed", `Unknown node status: ${status}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log().error(`[WORKFLOW] Error advancing run ${run.id.slice(0, 8)}: ${msg}`);
      this._finishRun(run, "failed", msg);
      return true;
    }
  }

  startRun(
    workflow: WorkflowDefRow,
    opts: {
      task?: Record<string, unknown>;
      triggerType?: string;
      triggerPayload?: Record<string, unknown>;
      initialContext?: Record<string, unknown>;
    } = {},
  ): WorkflowRunRow {
    const db = getDb();
    const { task, triggerType = "manual", triggerPayload, initialContext } = opts;
    const context: Record<string, unknown> = { ...initialContext };
    let taskId: string | null = null;

    if (task) {
      taskId = task["id"] as string ?? null;

      // Dedup: skip if active run already exists for this task
      if (taskId) {
        const existing = db.select().from(workflowRuns)
          .where(and(
            eq(workflowRuns.taskId, taskId),
            inArray(workflowRuns.status, ["pending", "running"]),
          ))
          .get();

        if (existing) {
          log().debug?.(`[WORKFLOW] Skipping dup run for task ${taskId.slice(0, 8)}`);
          return existing;
        }
      }

      context["task"] = task;

      // Resolve project info
      const projectId = (task["project_id"] ?? task["projectId"]) as string | undefined;
      if (projectId) {
        const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (project) {
          context["project"] = {
            id: project.id,
            title: project.title,
            repo_path: project.repoPath ?? "",
          };
        }
      }
    }

    if (triggerPayload) context["trigger"] = triggerPayload;

    const runId = randomUUID();
    const now = new Date().toISOString();

    db.insert(workflowRuns).values({
      id: runId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      taskId,
      triggerType,
      triggerPayload: triggerPayload ?? null,
      status: "pending",
      nodeStates: {},
      context,
      createdAt: now,
      updatedAt: now,
    }).run();

    // Update task work_state if linked
    if (taskId) {
      db.update(tasks).set({
        workState: "in_progress",
        updatedAt: now,
      }).where(eq(tasks.id, taskId)).run();
    }

    const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!;
    log().info(`[WORKFLOW] Started run ${runId.slice(0, 8)} for '${workflow.name}' (trigger=${triggerType}, task=${taskId?.slice(0, 8) ?? "none"})`);
    return run;
  }

  matchWorkflow(task: Record<string, unknown>): WorkflowDefRow | null {
    const db = getDb();
    const workflows = db.select().from(workflowDefinitions)
      .where(eq(workflowDefinitions.isActive, true))
      .all();

    for (const wf of workflows) {
      const trigger = wf.trigger as Record<string, unknown> | null;
      if (!trigger) continue;
      if (trigger["type"] === "task_match") {
        const agentTypes = (trigger["agent_types"] as string[]) ?? [];
        if (agentTypes.includes(task["agent"] as string)) return wf;
      }
    }
    return null;
  }

  processEvents(limit = 10): number {
    const db = getDb();
    const events = db.select().from(workflowEvents)
      .where(eq(workflowEvents.processed, false))
      .orderBy(workflowEvents.createdAt)
      .limit(limit)
      .all();

    let started = 0;

    for (const event of events) {
      const subs = this._matchSubscriptions(event);
      for (const sub of subs) {
        const wf = db.select().from(workflowDefinitions)
          .where(eq(workflowDefinitions.id, sub.workflowId))
          .get();
        if (wf?.isActive) {
          this.startRun(wf, {
            triggerType: "event",
            triggerPayload: {
              event_id: event.id,
              event_type: event.eventType,
              ...(event.payload as Record<string, unknown> ?? {}),
            },
          });
          started++;
        }
      }
      db.update(workflowEvents)
        .set({ processed: true })
        .where(eq(workflowEvents.id, event.id))
        .run();
    }

    return started;
  }

  processSchedules(): number {
    const db = getDb();
    const workflows = db.select().from(workflowDefinitions)
      .where(eq(workflowDefinitions.isActive, true))
      .all();

    let started = 0;
    const now = new Date();

    for (const wf of workflows) {
      const trigger = wf.trigger as Record<string, unknown> | null;
      if (!trigger || trigger["type"] !== "schedule") continue;

      const cronExpr = trigger["cron"] as string | undefined;
      if (!cronExpr) continue;

      // Build a pseudo-Date whose UTC accessors reflect the target timezone
      const tzName = trigger["timezone"] as string ?? "UTC";
      let localNow: Date;
      try {
        // Extract wall-clock components in the target timezone
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: tzName,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
          hour12: false,
        }).formatToParts(now);
        const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? "0", 10);
        // Construct a Date whose getUTC* methods return the tz-local values
        localNow = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")));
      } catch {
        localNow = now;
      }

      // Check if already running
      const active = db.select().from(workflowRuns)
        .where(and(
          eq(workflowRuns.workflowId, wf.id),
          inArray(workflowRuns.status, ["pending", "running"]),
        ))
        .get();
      if (active) continue;

      // Check if cron fires now (within current minute)
      if (!cronMatches(cronExpr, localNow)) continue;

      // Check if already ran in this minute
      const recentCutoff = new Date(now.getTime() - 60_000).toISOString();
      const recentRun = db.select().from(workflowRuns)
        .where(and(
          eq(workflowRuns.workflowId, wf.id),
          // createdAt > recentCutoff
        ))
        .orderBy(desc(workflowRuns.createdAt))
        .get();

      if (recentRun && recentRun.createdAt > recentCutoff) continue;

      this.startRun(wf, {
        triggerType: "schedule",
        triggerPayload: { cron: cronExpr, fired_at: now.toISOString() },
      });
      started++;
      log().info(`[WORKFLOW] Schedule fired for '${wf.name}' (cron=${cronExpr})`);
    }

    return started;
  }

  emitEvent(eventType: string, payload: Record<string, unknown>, source = "internal"): string {
    const db = getDb();
    const id = randomUUID();
    db.insert(workflowEvents).values({
      id,
      eventType,
      payload,
      source,
      processed: false,
    }).run();
    return id;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async _startNode(
    run: WorkflowRunRow,
    nodeDef: Record<string, unknown>,
    nodeStates: Record<string, Record<string, unknown>>,
    _workflow: WorkflowDefRow,
  ): Promise<boolean> {
    const nodeId = nodeDef["id"] as string;
    const ns: Record<string, unknown> = nodeStates[nodeId] ?? {};
    ns["attempts"] = (ns["attempts"] as number ?? 0) + 1;
    ns["started_at"] = new Date().toISOString();

    // Build typed run object for handlers
    const runObj: WorkflowRun = {
      id: run.id,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      taskId: run.taskId,
      triggerType: run.triggerType,
      triggerPayload: run.triggerPayload as Record<string, unknown> | null,
      status: run.status,
      currentNode: run.currentNode,
      nodeStates: (run.nodeStates as Record<string, Record<string, unknown>>) ?? {},
      context: (run.context as Record<string, unknown>) ?? {},
      sessionKey: run.sessionKey,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };

    try {
      const result = await this.nodeHandlers.execute(nodeDef as any, runObj);
      ns["status"] = result.status;
      if (result.output) {
        ns["output"] = result.output;
      }
      if (result.error) {
        ns["error"] = result.error;
        ns["error_type"] = result.errorType;
      }
      if (result.sessionKey) {
        ns["session_key"] = result.sessionKey;
      }
    } catch (e) {
      ns["status"] = "failed";
      ns["error"] = e instanceof Error ? e.message : String(e);
    }

    nodeStates[nodeId] = ns;
    log().info(
      `[WORKFLOW] Run ${run.id.slice(0, 8)} node '${nodeId}' execute -> ${this.summarizeNodeState(ns)}`
    );

    // Build updated context (merge node output)
    const updatedContext = { ...(run.context as Record<string, unknown> ?? {}) };
    if (ns["output"]) updatedContext[nodeId] = ns["output"];

    const db = getDb();
    db.update(workflowRuns).set({
      nodeStates,
      context: updatedContext,
      updatedAt: new Date().toISOString(),
    }).where(eq(workflowRuns.id, run.id)).run();

    return true;
  }

  private _checkNode(
    run: WorkflowRunRow,
    nodeDef: Record<string, unknown>,
    nodeStates: Record<string, Record<string, unknown>>,
    workflow: WorkflowDefRow,
  ): boolean {
    const nodeId = nodeDef["id"] as string;
    const ns = nodeStates[nodeId] ?? {};

    // Warn if stuck
    const startedAt = ns["started_at"] as string | undefined;
    if (startedAt) {
      const ageSecs = (Date.now() - new Date(startedAt).getTime()) / 1000;
      if (ageSecs > 300 && Math.floor(ageSecs) % 300 < 15) {
        log().warn(`[WORKFLOW] Run ${run.id.slice(0, 8)} stuck at '${nodeId}' (${Math.floor(ageSecs / 60)}min)`);
      }
    }

    const runObj: WorkflowRun = {
      id: run.id,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      taskId: run.taskId,
      triggerType: run.triggerType,
      triggerPayload: run.triggerPayload as Record<string, unknown> | null,
      status: run.status,
      currentNode: run.currentNode,
      nodeStates: (run.nodeStates as Record<string, Record<string, unknown>>) ?? {},
      context: (run.context as Record<string, unknown>) ?? {},
      sessionKey: run.sessionKey,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };

    let result;
    try {
      result = this.nodeHandlers.check(nodeDef as any, runObj);
    } catch (e) {
      ns["status"] = "failed";
      ns["error"] = e instanceof Error ? e.message : String(e);
      nodeStates[nodeId] = ns;
      const db = getDb();
      db.update(workflowRuns).set({
        nodeStates,
        updatedAt: new Date().toISOString(),
      }).where(eq(workflowRuns.id, run.id)).run();
      return true;
    }

    if (result === null) return false; // Still running

    ns["status"] = result.status;
    if (result.output) {
      ns["output"] = result.output;
    }
    if (result.error) ns["error"] = result.error;
    ns["finished_at"] = new Date().toISOString();

    nodeStates[nodeId] = ns;
    log().info(
      `[WORKFLOW] Run ${run.id.slice(0, 8)} node '${nodeId}' check -> ${this.summarizeNodeState(ns)}`
    );
    const updatedContext = { ...(run.context as Record<string, unknown> ?? {}) };
    if (ns["output"]) updatedContext[nodeId] = ns["output"];

    const db = getDb();
    db.update(workflowRuns).set({
      nodeStates,
      context: updatedContext,
      updatedAt: new Date().toISOString(),
    }).where(eq(workflowRuns.id, run.id)).run();

    return true;
  }

  private _transition(
    run: WorkflowRunRow,
    nodeDef: Record<string, unknown>,
    nodeStates: Record<string, Record<string, unknown>>,
    workflow: WorkflowDefRow,
  ): boolean {
    const nodeId = nodeDef["id"] as string;
    const ns = nodeStates[nodeId] ?? {};
    const output = ns["output"] as Record<string, unknown> ?? {};
    const context = (run.context as Record<string, unknown>) ?? {};

    // Branch/expression/llm_route output can specify goto
    let goto = output["goto"] as string | undefined;

    if (!goto) goto = nodeDef["on_success"] as string | undefined;

    if (!goto) {
      // Check edges
      const edges = (workflow.edges as Array<Record<string, unknown>>) ?? [];
      for (const edge of edges) {
        if (edge["from"] !== nodeId) continue;
        const condition = edge["condition"] as string ?? edge["when"] as string;
        if (!condition) { goto = edge["to"] as string; break; }
        if (evaluateCondition(condition, context)) { goto = edge["to"] as string; break; }
      }
    }

    const db = getDb();
    if (goto) {
      log().info(
        `[WORKFLOW] Run ${run.id.slice(0, 8)} transition '${nodeId}' -> '${goto}'`
      );
      db.update(workflowRuns).set({
        currentNode: goto,
        updatedAt: new Date().toISOString(),
      }).where(eq(workflowRuns.id, run.id)).run();
      return true;
    }

    this._finishRun(run, "completed");
    return true;
  }

  private _handleFailure(
    run: WorkflowRunRow,
    nodeDef: Record<string, unknown>,
    nodeStates: Record<string, Record<string, unknown>>,
    _workflow: WorkflowDefRow,
  ): boolean {
    const nodeId = nodeDef["id"] as string;
    const ns = nodeStates[nodeId] ?? {};
    const attempts = ns["attempts"] as number ?? 1;
    const errorType = ns["error_type"] as string ?? "";

    const policy = nodeDef["on_failure"] as Record<string, unknown> ?? {};

    // Abort conditions
    const abortOn = policy["abort_on"] as string[] ?? [];
    if (abortOn.includes(errorType)) {
      log().warn(
        `[WORKFLOW] Run ${run.id.slice(0, 8)} node '${nodeId}' abort condition '${errorType}' ` +
        `(${this.summarizeNodeState(ns)})`
      );
      this._finishRun(run, "failed", ns["error"] as string ?? "Abort condition met");
      return true;
    }

    // Retry
    const maxRetries = policy["retry"] as number ?? 0;
    if (attempts <= maxRetries) {
      log().info(
        `[WORKFLOW] Run ${run.id.slice(0, 8)} retrying node '${nodeId}' ` +
        `(attempt ${attempts + 1}/${maxRetries + 1}, last_error=${String(ns["error"] ?? "").slice(0, 80)})`
      );
      ns["status"] = "pending";
      nodeStates[nodeId] = ns;
      const db = getDb();
      db.update(workflowRuns).set({
        nodeStates,
        updatedAt: new Date().toISOString(),
      }).where(eq(workflowRuns.id, run.id)).run();
      return true;
    }

    // Fallback
    const fallback = policy["fallback"] as string | undefined;
    const escalateAfter = policy["escalate_after"] as number ?? 999;
    if (fallback && attempts <= escalateAfter) {
      log().info(
        `[WORKFLOW] Run ${run.id.slice(0, 8)} fallback '${nodeId}' -> '${fallback}' ` +
        `(attempts=${attempts}, error=${String(ns["error"] ?? "").slice(0, 80)})`
      );
      const db = getDb();
      db.update(workflowRuns).set({
        currentNode: fallback,
        updatedAt: new Date().toISOString(),
      }).where(eq(workflowRuns.id, run.id)).run();
      return true;
    }

    log().warn(
      `[WORKFLOW] Run ${run.id.slice(0, 8)} node '${nodeId}' exhausted retries ` +
      `(${this.summarizeNodeState(ns)})`
    );
    this._finishRun(run, "failed", ns["error"] as string ?? "All retries exhausted");
    return true;
  }

  private _finishRun(run: WorkflowRunRow, status: string, error?: string): void {
    const db = getDb();
    const now = new Date().toISOString();

    db.update(workflowRuns).set({
      status,
      error: error ?? null,
      finishedAt: now,
      currentNode: null,
      updatedAt: now,
    }).where(eq(workflowRuns.id, run.id)).run();

    // Update linked task
    if (run.taskId) {
      if (status === "completed") {
        db.update(tasks).set({
          status: "completed",
          workState: "completed",
          finishedAt: now,
          updatedAt: now,
        }).where(eq(tasks.id, run.taskId)).run();

        // Selective reviewer followup for programmer tasks.
        // Checks trigger criteria (>500 lines, new API routes, DB schema changes, etc.)
        // before queuing — avoids spawning a reviewer on every minor change.
        const task = db.select().from(tasks).where(eq(tasks.id, run.taskId!)).get();
        if (task?.agent === "programmer") {
          const project = task.projectId
            ? db.select().from(projects).where(eq(projects.id, task.projectId)).get()
            : undefined;
          const repoPath = task.artifactPath ?? project?.repoPath ?? null;

          const triggerResult = shouldTriggerReview({
            repoPath,
            taskId: task.id,
            taskTitle: task.title,
          });

          if (triggerResult.shouldReview) {
            log().info(
              `[REVIEW-GATE] ✅ Triggering reviewer for task ${task.id.slice(0, 8)}` +
              ` (${task.title.slice(0, 60)})\n` +
              triggerResult.reason
            );
            queueReviewerFollowup(run.taskId!, triggerResult);
          } else {
            log().info(
              `[REVIEW-GATE] ⏭  Skipping reviewer for task ${task.id.slice(0, 8)}` +
              ` (${task.title.slice(0, 60)})\n` +
              triggerResult.reason
            );
          }
        }
      } else if (status === "failed") {
        db.update(tasks).set({
          workState: "blocked",
          failureReason: error ?? null,
          updatedAt: now,
        }).where(eq(tasks.id, run.taskId)).run();
      }
    }

    // Emit completion event
    db.insert(workflowEvents).values({
      id: randomUUID(),
      eventType: `workflow.${status}`,
      payload: {
        run_id: run.id,
        workflow_id: run.workflowId,
        task_id: run.taskId,
        error: error ?? null,
      },
      source: "workflow_executor",
      processed: false,
    }).run();

    log().info(
      `[WORKFLOW] Run ${run.id.slice(0, 8)} finished: ${status}` +
      `${run.taskId ? ` task=${run.taskId.slice(0, 8)}` : ""}` +
      `${error ? ` error=${error.slice(0, 80)}` : ""}`
    );
  }

  private _matchSubscriptions(
    event: typeof workflowEvents.$inferSelect,
  ): Array<typeof workflowSubscriptions.$inferSelect> {
    const db = getDb();
    const subs = db.select().from(workflowSubscriptions)
      .where(eq(workflowSubscriptions.isActive, true))
      .all();

    return subs.filter(sub => {
      if (!_patternMatches(sub.eventPattern, event.eventType)) return false;
      const conditions = sub.filterConditions as Record<string, unknown> | null;
      if (!conditions) return true;
      const payload = event.payload as Record<string, unknown> | null;
      if (!payload) return false;
      return Object.entries(conditions).every(([k, v]) => payload[k] === v);
    });
  }

  private _findEntryNode(workflow: WorkflowDefRow): string | null {
    const nodes = (workflow.nodes as Array<Record<string, unknown>>) ?? [];
    const edges = (workflow.edges as Array<Record<string, unknown>>) ?? [];
    if (!nodes.length) return null;
    const targets = new Set(edges.map(e => e["to"] as string));
    const entry = nodes.find(n => !targets.has(n["id"] as string));
    return (entry?.["id"] as string) ?? (nodes[0]?.["id"] as string) ?? null;
  }
}

function _patternMatches(pattern: string, eventType: string): boolean {
  const regex = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`).test(eventType);
}

function getTimezoneOffsetMinutes(tz: string, date: Date): number {
  // Get offset between UTC and the target timezone in minutes
  try {
    const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
    const tzStr = date.toLocaleString("en-US", { timeZone: tz });
    const utcDate = new Date(utcStr);
    const tzDate = new Date(tzStr);
    return (tzDate.getTime() - utcDate.getTime()) / 60_000;
  } catch {
    return 0;
  }
}
