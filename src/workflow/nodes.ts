/**
 * Workflow node type handlers.
 * Port of lobs-server/app/orchestrator/workflow_nodes.py
 *
 * Each node type has execute() and optionally check() logic.
 * execute() starts the node; check() polls for completion.
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, inboxItems, workflowEvents, workflowRuns, workerRuns } from "../db/schema.js";
import { evaluateCondition, evaluateExpression, interpolate } from "./functions.js";
import { log } from "../util/logger.js";
import { executeCallable } from "./callables.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NodeResult {
  status: "running" | "completed" | "failed";
  output?: Record<string, unknown>;
  error?: string;
  errorType?: string;
  sessionKey?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersion: number;
  taskId: string | null;
  triggerType: string;
  triggerPayload: Record<string, unknown> | null;
  status: string;
  currentNode: string | null;
  nodeStates: Record<string, Record<string, unknown>>;
  context: Record<string, unknown>;
  sessionKey: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NodeDef {
  id: string;
  type: string;
  config: Record<string, unknown>;
  on_success?: string;
  on_failure?: Record<string, unknown>;
}

// ── Pending spawn requests (processed by control loop) ───────────────────────

export interface SpawnRequest {
  runId: string;
  nodeId: string;
  agentType: string;
  modelTier?: string;
  promptTemplate?: string;
  taskId?: string;
  context: Record<string, unknown>;
  requestedAt: string;
}

const _pendingSpawns: SpawnRequest[] = [];

export function popPendingSpawns(): SpawnRequest[] {
  return _pendingSpawns.splice(0, _pendingSpawns.length);
}

// ── Main NodeHandlers class ────────────────────────────────────────────────────

export class NodeHandlers {
  execute(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const { type } = nodeDef;
    log().debug?.(`[WORKFLOW] execute node ${nodeDef.id} (type=${type})`);

    try {
      switch (type) {
        case "spawn_agent":     return this._executeSpawnAgent(nodeDef, run);
        case "tool_call":       return this._executeToolCall(nodeDef, run);
        case "branch":          return this._executeBranch(nodeDef, run);
        case "gate":            return this._executeGate(nodeDef, run);
        case "notify":          return this._executeNotify(nodeDef, run);
        case "cleanup":         return this._executeCleanup(nodeDef, run);
        case "expression":      return this._executeExpression(nodeDef, run);
        case "delay":           return this._executeDelay(nodeDef, run);
        case "llm_route":       return this._executeLlmRoute(nodeDef, run);
        case "send_to_session": return this._executeSendToSession(nodeDef, run);
        case "ts_call":         return this._executeTsCall(nodeDef, run);
        case "python_call":     return this._executeTsCall(nodeDef, run);
        default:
          log().warn(`[WORKFLOW] Unknown node type: ${type}`);
          return { status: "completed", output: { skipped: true, reason: `unknown type: ${type}` } };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log().error(`[WORKFLOW] Node ${nodeDef.id} execute error: ${msg}`);
      return { status: "failed", error: msg };
    }
  }

  /**
   * Poll a running node. Returns null if still running, NodeResult when done.
   */
  check(nodeDef: NodeDef, run: WorkflowRun): NodeResult | null {
    const { type } = nodeDef;
    const ns = run.nodeStates[nodeDef.id] ?? {};

    switch (type) {
      case "spawn_agent":
        return this._checkSpawnAgent(nodeDef, run);
      case "gate":
        return this._checkGate(nodeDef, run);
      case "delay":
        return this._checkDelay(nodeDef, run);
      default:
        // Most node types complete synchronously in execute()
        return { status: (ns["status"] as ("completed" | "failed")) ?? "completed" };
    }
  }

  // ── spawn_agent ─────────────────────────────────────────────────────────────

  private _executeSpawnAgent(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as {
      agent_type: string;
      model_tier?: string;
      prompt_template?: string;
    };

    const agentType = config.agent_type;
    if (!agentType) {
      return { status: "failed", error: "spawn_agent: missing agent_type", errorType: "config_error" };
    }

    const prompt = config.prompt_template
      ? interpolate(config.prompt_template, run.context)
      : undefined;

    _pendingSpawns.push({
      runId: run.id,
      nodeId: nodeDef.id,
      agentType,
      modelTier: (run.context?.task as any)?.modelTier ?? (run.context?.task as any)?.model_tier ?? config.model_tier,
      promptTemplate: prompt,
      taskId: run.taskId ?? undefined,
      context: run.context,
      requestedAt: new Date().toISOString(),
    });

    log().info(`[WORKFLOW] Queued spawn request: ${agentType} for run ${run.id.slice(0, 8)}`);
    return { status: "running" };
  }

  private _checkSpawnAgent(nodeDef: NodeDef, run: WorkflowRun): NodeResult | null {
    const ns = run.nodeStates[nodeDef.id] ?? {};
    const childSessionKey = ns["childSessionKey"] as string | undefined;
    const spawnResult = ns["spawn_result"] as Record<string, unknown> | undefined;

    if (spawnResult) {
      if (spawnResult["status"] === "completed") {
        return { status: "completed", output: spawnResult, sessionKey: childSessionKey };
      }
      if (spawnResult["status"] === "failed") {
        return { status: "failed", error: spawnResult["error"] as string, errorType: "spawn_error" };
      }
    }

    // Check task status if linked
    if (run.taskId) {
      const db = getDb();
      const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
      if (task?.workState === "completed") {
        return { status: "completed", output: { task_completed: true, childSessionKey } };
      }
      if (task?.workState === "blocked") {
        return { status: "failed", error: task.failureReason ?? "Task blocked", errorType: "task_blocked" };
      }
    }

    // For non-task spawns (e.g. reflections), check worker_runs by session key
    if (!run.taskId && childSessionKey) {
      const db = getDb();
      const workerRun = db.select().from(workerRuns)
        .where(eq(workerRuns.childSessionKey, childSessionKey))
        .get();
      if (workerRun?.endedAt) {
        const summary = workerRun.summary ?? "";
        return {
          status: workerRun.succeeded ? "completed" : "failed",
          output: { worker_completed: true, childSessionKey, summary },
          sessionKey: childSessionKey,
        };
      }
    }

    return null; // Still running
  }

  // ── tool_call ────────────────────────────────────────────────────────────────

  private _executeToolCall(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as {
      command: string;
      timeout_seconds?: number;
    };

    const command = interpolate(config.command, run.context);
    const timeoutMs = (config.timeout_seconds ?? 300) * 1000;

    try {
      const stdout = execSync(command, {
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        status: "completed",
        output: { returncode: 0, stdout: stdout ?? "", stderr: "" },
      };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string; signal?: string };
      const isTimeout = err.signal === "SIGTERM" || err.signal === "SIGKILL";
      return {
        status: "failed",
        output: {
          returncode: err.status ?? 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? String(e),
        },
        error: isTimeout ? "Command timed out" : (err.stderr ?? String(e)).slice(0, 500),
        errorType: isTimeout ? "timeout" : undefined,
      };
    }
  }

  // ── branch ────────────────────────────────────────────────────────────────

  private _executeBranch(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as {
      conditions: Array<{ match: string; goto: string }>;
      default?: string;
    };

    for (const cond of config.conditions ?? []) {
      if (evaluateCondition(cond.match, run.context)) {
        return { status: "completed", output: { goto: cond.goto } };
      }
    }

    const defaultGoto = config.default;
    if (defaultGoto) {
      return { status: "completed", output: { goto: defaultGoto } };
    }

    return { status: "completed", output: {} };
  }

  // ── gate ─────────────────────────────────────────────────────────────────

  private _executeGate(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as { prompt?: string; timeout_hours?: number };

    const db = getDb();
    const inboxId = randomUUID();
    const prompt = config.prompt
      ? interpolate(config.prompt, run.context)
      : `Workflow run ${run.id.slice(0, 8)} requires approval`;

    db.insert(inboxItems).values({
      id: inboxId,
      title: `[Gate] ${prompt.slice(0, 100)}`,
      content: JSON.stringify({
        type: "workflow_gate",
        run_id: run.id,
        node_id: nodeDef.id,
        prompt,
        task_id: run.taskId,
      }),
      isRead: false,
    }).run();

    log().info(`[WORKFLOW] Gate created inbox item ${inboxId} for run ${run.id.slice(0, 8)}`);

    return {
      status: "running",
      output: { inbox_id: inboxId, prompt },
    };
  }

  private _checkGate(nodeDef: NodeDef, run: WorkflowRun): NodeResult | null {
    const config = nodeDef.config as { timeout_hours?: number };
    const ns = run.nodeStates[nodeDef.id] ?? {};
    const output = ns["output"] as Record<string, unknown> | undefined;
    const inboxId = output?.["inbox_id"] as string | undefined;
    const startedAt = ns["started_at"] as string | undefined;

    if (startedAt && config.timeout_hours) {
      const elapsed = (Date.now() - new Date(startedAt).getTime()) / 3_600_000;
      if (elapsed > config.timeout_hours) {
        return { status: "failed", error: "Gate timeout", errorType: "timeout" };
      }
    }

    if (inboxId) {
      const db = getDb();
      const item = db.select().from(inboxItems).where(eq(inboxItems.id, inboxId)).get();
      if (item?.isRead) {
        return { status: "completed", output: { approved: true, inbox_id: inboxId } };
      }
    }

    return null;
  }

  // ── notify ────────────────────────────────────────────────────────────────

  private _executeNotify(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as {
      channel: string;
      message_template: string;
    };

    const message = interpolate(config.message_template ?? "", run.context);
    const channel = config.channel ?? "internal";

    const db = getDb();
    db.insert(workflowEvents).values({
      id: randomUUID(),
      eventType: "workflow.notify",
      payload: { channel, message, run_id: run.id, task_id: run.taskId },
      source: "workflow_engine",
      processed: false,
    }).run();

    log().info(`[WORKFLOW] Notify (${channel}): ${message.slice(0, 80)}`);
    return { status: "completed", output: { channel, message } };
  }

  // ── cleanup ───────────────────────────────────────────────────────────────

  private _executeCleanup(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as {
      session_refs?: string[];
      delete_session?: boolean;
    };

    for (const ref of config.session_refs ?? []) {
      const sessionKey = this._resolveContextPath(ref, run.context);
      if (sessionKey && typeof sessionKey === "string") {
        log().debug?.(`[WORKFLOW] Cleanup session ref: ${ref}`);
      }
    }

    return { status: "completed", output: { cleaned: true } };
  }

  // ── expression ────────────────────────────────────────────────────────────

  private _executeExpression(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as {
      expressions?: Record<string, string>;
      goto_if?: Array<{ match: string; goto: string }>;
      default?: string;
    };

    const output: Record<string, unknown> = {};
    const mergedCtx = { ...run.context };

    for (const [key, expr] of Object.entries(config.expressions ?? {})) {
      output[key] = evaluateExpression(expr, { ...mergedCtx, ...output });
      mergedCtx[key] = output[key];
    }

    for (const rule of config.goto_if ?? []) {
      if (evaluateCondition(rule.match, { ...mergedCtx, ...output })) {
        output["goto"] = rule.goto;
        return { status: "completed", output };
      }
    }

    if (config.default) {
      output["goto"] = config.default;
    }

    return { status: "completed", output };
  }

  // ── delay ─────────────────────────────────────────────────────────────────

  private _executeDelay(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as { seconds: number };
    const dueAt = Date.now() + (config.seconds ?? 30) * 1000;
    return {
      status: "running",
      output: { due_at: dueAt },
    };
  }

  private _checkDelay(nodeDef: NodeDef, run: WorkflowRun): NodeResult | null {
    const ns = run.nodeStates[nodeDef.id] ?? {};
    const output = ns["output"] as Record<string, unknown> | undefined;
    const dueAt = output?.["due_at"] as number | undefined;
    if (dueAt && Date.now() >= dueAt) {
      return { status: "completed", output: { elapsed: true } };
    }
    return null;
  }

  // ── llm_route ────────────────────────────────────────────────────────────

  private _executeLlmRoute(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as {
      candidates: Array<{ id: string; description: string }>;
    };

    const first = config.candidates?.[0];
    if (first) {
      log().warn(`[WORKFLOW] llm_route: falling back to first candidate '${first.id}'`);
      return { status: "completed", output: { goto: first.id } };
    }

    return { status: "failed", error: "llm_route: no candidates", errorType: "config_error" };
  }

  // ── send_to_session ───────────────────────────────────────────────────────

  private _executeSendToSession(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as {
      session_ref: string;
      message_template: string;
    };

    const sessionKey = this._resolveContextPath(config.session_ref, run.context) as string | null;
    const message = interpolate(config.message_template ?? "", run.context);

    if (!sessionKey) {
      log().warn(`[WORKFLOW] send_to_session: no session key at ${config.session_ref}`);
      return { status: "completed", output: { sent: false, reason: "no_session" } };
    }

    const db = getDb();
    db.insert(workflowEvents).values({
      id: randomUUID(),
      eventType: "workflow.send_to_session",
      payload: { session_key: sessionKey, message, run_id: run.id },
      source: "workflow_engine",
      processed: false,
    }).run();

    log().info(`[WORKFLOW] Queued send_to_session → ${sessionKey.slice(0, 12)}`);
    return { status: "completed", output: { sent: true, session_key: sessionKey } };
  }

  // ── ts_call ───────────────────────────────────────────────────────────────

  private _executeTsCall(nodeDef: NodeDef, run: WorkflowRun): NodeResult {
    const config = nodeDef.config as Record<string, unknown> & { callable?: string };
    const callable = config.callable ?? "";
    const rawArgs = (config.args as Record<string, unknown>) ?? {};

    // Interpolate args from run context — replace {node.field} patterns
    const args: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(rawArgs)) {
      if (typeof val === "string" && val.includes("{")) {
        args[key] = interpolate(val, run.context);
      } else {
        args[key] = val;
      }
    }

    const ctx = {
      workflowRunId: run.id,
      nodeId: nodeDef.id,
      taskId: (run as unknown as Record<string, unknown>).taskId as string | undefined,
      agentType: (run as unknown as Record<string, unknown>).agentType as string | undefined,
      runContext: run.context, // Pass full context so callables can access it
    };
    log().info(`[WORKFLOW] ts_call: ${callable}`);
    const result = executeCallable(callable, args, ctx);
    return { status: "completed", output: result };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _resolveContextPath(path: string, context: Record<string, unknown>): unknown {
    const parts = path.split(".");
    let val: unknown = context;
    for (const part of parts) {
      if (val && typeof val === "object") {
        val = (val as Record<string, unknown>)[part];
      } else {
        return null;
      }
    }
    return val;
  }
}

/**
 * Evaluate a simple condition expression for edge conditions.
 */
export function _evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
  return evaluateCondition(condition, context);
}
