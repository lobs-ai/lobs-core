/**
 * subagent_spawning / subagent_ended hooks — WorkerManager integration.
 */

import { eq, and, inArray, isNull, desc } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workerRuns, tasks, workflowRuns, agentReflections, projects, modelUsageEvents } from "../db/schema.js";
import { recordWorkerStart, recordWorkerEnd, hasCapacity, countActiveWorkers, DEFAULT_MAX_WORKERS } from "../orchestrator/worker-manager.js";
import { triageWorkerCompletion } from "../orchestrator/triage.js";
import { onSuccess, onFailure, classifyOutcome } from "../services/circuit-breaker.js";
import { log } from "../util/logger.js";
import { ReflectionService } from "../services/reflection.js";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { shouldTriggerReview, type ReviewTriggerResult } from "../orchestrator/review-triggers.js";
import { emitWorkerRunTrace } from "../services/langfuse.js";
import { cleanupTaskSidecar } from "./compaction.js";

const SINK_SESSION_KEY = "agent:sink:paw-orchestrator-v2";

export function registerSubagentHooks(api: OpenClawPluginApi): void {

  // ── Pre-spawn capacity gate ─────────────────────────────────────────────
  // Fires BEFORE the spawn happens. If PAW is at capacity, reject the spawn
  // at the gateway level so the session is never created.
  api.on("subagent_spawning", async (event, _ctx) => {
    const ev = event as Record<string, unknown>;
    // Only gate PAW-managed spawns (check label or agentId pattern)
    const label = ev.label as string | undefined;
    const agentId = ev.agentId as string | undefined;

    // PAW workers are spawned with labels like "paw-worker-..." or agent IDs for PAW agents
    const isPawSpawn = label?.startsWith("paw-") ||
      agentId?.match(/^(programmer|writer|researcher|reviewer|architect)$/);

    if (!isPawSpawn) return { status: "ok" as const };

    if (!hasCapacity()) {
      const active = countActiveWorkers();
      log().warn(
        `[PAW] subagent_spawning: REJECTED — at capacity (${active}/${DEFAULT_MAX_WORKERS}). ` +
        `agent=${agentId} label=${label}`,
      );
      return { status: "error" as const, error: `PAW worker capacity exceeded (${active}/${DEFAULT_MAX_WORKERS})` };
    }

    log().debug?.(`[PAW] subagent_spawning: ALLOWED — agent=${agentId} label=${label}`);
    return { status: "ok" as const };
  });

  // ── Completion delivery routing ─────────────────────────────────────────
  // Route PAW-managed worker completions to the sink session instead of the
  // default parent session. This prevents completion messages from polluting
  // user-facing chat sessions.
  api.on("subagent_delivery_target", async (event, _ctx) => {
    const ev = event as Record<string, unknown>;
    const childKey = ev.childSessionKey as string | undefined;
    const requesterKey = ev.requesterSessionKey as string | undefined;

    if (!childKey) return;

    // Check if this is a PAW-managed worker by looking up the worker_runs table
    const db = getDb();
    const run = db.select().from(workerRuns)
      .where(eq(workerRuns.workerId, childKey))
      .get();

    if (!run) return; // Not a PAW worker — let default routing handle it

    // Route to sink session — suppress delivery to the original requester
    // The sink session handles all PAW worker completions centrally
    log().debug?.(
      `[PAW] subagent_delivery_target: routing ${childKey.slice(0, 30)} completion to sink ` +
      `(original requester: ${requesterKey?.slice(0, 30) ?? "unknown"})`,
    );

    // Return empty origin to suppress delivery to the parent session.
    // The subagent_ended hook already handles result capture and triage.
    return { origin: { channel: undefined, to: undefined } };
  });

  api.on("subagent_spawned", async (event) => {
    const meta = (event as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
    if (!meta?.pawManaged) return;

    const sessionKey = (event as Record<string, unknown>).childSessionKey as string;
    const agentType = (meta.agentType as string) ?? "unknown";
    const taskId = meta.taskId as string | undefined;
    const projectId = meta.projectId as string | undefined;
    const model = meta.model as string | undefined;

    log().info(`[PAW] Worker spawned: session=${sessionKey} agent=${agentType} task=${taskId ?? "none"}`);
    recordWorkerStart({ workerId: sessionKey, agentType, taskId, projectId, model });
  });

  api.on("subagent_ended", async (event) => {
    const ev = event as Record<string, unknown>;
    const sessionKey = (ev.targetSessionKey ?? ev.childSessionKey) as string;
    if (!sessionKey) return;

    const reason = ev.reason as string | undefined;
    const succeeded = reason !== "error" && reason !== "timeout";

    log().info(`[PAW] subagent_ended: session=${sessionKey} reason=${reason} succeeded=${succeeded}`);

    // ── Reflection result collection ──────────────────────────────────────
    // Check if this was a reflection worker by looking at the session key pattern
    // and checking for pending reflections
    if (succeeded) {
      setTimeout(() => { try { collectReflectionResult(ev); } catch(e) { log().warn(`[PAW] collectReflectionResult error: ${e}`); } }, 2000);
    }

    const db = getDb();

    // Strategy 1: Match via worker_runs table
    const workerRun = db.select().from(workerRuns)
      .where(and(eq(workerRuns.workerId, sessionKey), isNull(workerRuns.endedAt)))
      .get();

    if (workerRun) {
      const startedAt = workerRun.startedAt ? new Date(workerRun.startedAt).getTime() : Date.now();
      const usage = await collectWorkerUsage(sessionKey);
      const durationSeconds = (Date.now() - startedAt) / 1000;
      recordWorkerEnd({
        workerId: sessionKey,
        agentType: workerRun.agentType ?? "unknown",
        succeeded,
        taskId: workerRun.taskId ?? undefined,
        durationSeconds,
        model: usage.model ?? (workerRun.model ?? undefined),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalCostUsd: usage.totalCostUsd,
      });

      insertModelUsageEvent({
        workerRun,
        sessionKey,
        succeeded,
        durationSeconds,
        usage,
      });

      // ── Langfuse real-time trace (fire-and-forget) ────────────────────────
      {
        const task = workerRun.taskId
          ? db.select().from(tasks).where(eq(tasks.id, workerRun.taskId)).get()
          : undefined;
        emitWorkerRunTrace({
          workerRunId: workerRun.id ?? sessionKey,
          taskId: workerRun.taskId,
          taskTitle: task?.title,
          agentType: workerRun.agentType ?? "unknown",
          model: usage.model ?? workerRun.model ?? "unknown",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalCostUsd: usage.totalCostUsd,
          durationSeconds,
          succeeded,
          summary: undefined,
          modelTier: task?.modelTier ?? undefined,
          promptVariant: workerRun.promptVariant ?? undefined,
          startedAt: workerRun.startedAt ?? undefined,
          endedAt: new Date().toISOString(),
        });
      }

      // ── Circuit breaker: record outcome ───────────────────────────────────
      const cbModel = usage.model ?? workerRun.model ?? "unknown";
      const cbTaskType = workerRun.agentType ?? "__global__";
      const cbFailure = classifyOutcome({
        succeeded,
        reason,
        durationMs: durationSeconds * 1000,
        outputLength: (usage.outputTokens ?? 0) * 4, // rough chars estimate
      });
      if (cbFailure) {
        onFailure(cbModel, cbTaskType, cbFailure);
      } else {
        onSuccess(cbModel, cbTaskType);
      }

      if (workerRun.taskId) {
        updateTaskFromEnd(workerRun.taskId, succeeded, reason, workerRun.agentType ?? undefined, sessionKey);
      }
    }

    // Always: update workflow run nodeStates so _checkSpawnAgent can advance
    updateWorkflowRunForSession(sessionKey, succeeded, reason);
  });
}

type WorkerUsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  model?: string;
  provider?: string;
};

async function collectWorkerUsage(sessionKey: string): Promise<WorkerUsageSnapshot> {
  try {
    const statusRaw = await invokeGatewayTool("session_status", { sessionKey });
    const statusParsed = extractUsageSnapshot(statusRaw);
    if (statusParsed.totalTokens > 0 || statusParsed.totalCostUsd > 0) return statusParsed;
  } catch (e) {
    log().debug?.(`[PAW] session_status usage unavailable for ${sessionKey}: ${e}`);
  }

  try {
    const historyRaw = await invokeGatewayTool("sessions_history", { sessionKey, limit: 150, includeTools: true });
    return extractUsageSnapshot(historyRaw);
  } catch (e) {
    log().warn(`[PAW] sessions_history usage fetch failed for ${sessionKey}: ${e}`);
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostUsd: 0 };
  }
}

function parseKNumber(s: string): number {
  const trimmed = s.trim().replace(/,/g, "");
  if (trimmed.endsWith("k") || trimmed.endsWith("K")) {
    return parseFloat(trimmed.slice(0, -1)) * 1000;
  }
  return parseFloat(trimmed) || 0;
}

function extractFromStatusText(statusText: string): WorkerUsageSnapshot | null {
  // Parse "Tokens: 10 in / 534 out" or "🧮 Tokens: 5.2k in / 46k out"
  const tokenMatch = statusText.match(/Tokens?:\s*([\d.,k]+)\s*in\s*\/\s*([\d.,k]+)\s*out/i);
  if (!tokenMatch) return null;
  const input = Math.round(parseKNumber(tokenMatch[1]));
  const output = Math.round(parseKNumber(tokenMatch[2]));
  if (input === 0 && output === 0) return null;

  // Parse cost: "$0.0123"
  let cost = 0;
  const costMatch = statusText.match(/\$\s*([\d.]+)/);
  if (costMatch) cost = parseFloat(costMatch[1]) || 0;

  // Parse model
  let model: string | undefined;
  const modelMatch = statusText.match(/Model:\s*([^\s·•\n]+)/);
  if (modelMatch) model = modelMatch[1];

  return { inputTokens: input, outputTokens: output, totalTokens: input + output, totalCostUsd: cost, model };
}

function extractUsageSnapshot(payload: unknown): WorkerUsageSnapshot {
  const candidates: WorkerUsageSnapshot[] = [];

  // Check for statusText from session_status (text format: "Tokens: X in / Y out")
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const statusText = typeof obj.statusText === "string" ? obj.statusText : undefined;
    if (statusText) {
      const fromText = extractFromStatusText(statusText);
      if (fromText) candidates.push(fromText);
    }
  }

  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;

    const input = toNum(obj.inputTokens ?? obj.input_tokens ?? obj.input ?? obj.promptTokens ?? obj.prompt_tokens);
    const output = toNum(obj.outputTokens ?? obj.output_tokens ?? obj.output ?? obj.completionTokens ?? obj.completion_tokens);
    const total = toNum(obj.totalTokens ?? obj.total_tokens ?? obj.total) || (input + output);
    const cost = toNum(obj.totalCostUsd ?? obj.total_cost_usd ?? obj.estimatedCostUsd ?? obj.estimated_cost_usd ?? obj.totalCost ?? obj.total_cost ?? obj.costUsd ?? obj.cost_usd);

    if (input > 0 || output > 0 || total > 0 || cost > 0) {
      candidates.push({
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        totalCostUsd: cost,
        model: asStr(obj.model ?? obj.modelName ?? obj.model_name),
        provider: asStr(obj.provider),
      });
    }

    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };

  walk(payload);
  if (candidates.length === 0) return { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostUsd: 0 };
  candidates.sort((a, b) => (b.totalTokens - a.totalTokens) || (b.totalCostUsd - a.totalCostUsd));
  return candidates[0];
}

function toNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function inferProvider(model?: string, provider?: string): string {
  if (provider && provider.trim()) return provider.trim();
  if (!model) return "unknown";
  const norm = model.toLowerCase();
  if (norm.includes("openai") || norm.includes("gpt") || norm.includes("codex")) return "openai";
  if (norm.includes("anthropic") || norm.includes("claude")) return "anthropic";
  if (norm.includes("gemini") || norm.includes("google")) return "google";
  if (norm.includes("mistral")) return "mistral";
  if (norm.includes("llama") || norm.includes("meta")) return "meta";
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "unknown";
}

function insertModelUsageEvent(opts: {
  workerRun: typeof workerRuns.$inferSelect;
  sessionKey: string;
  succeeded: boolean;
  durationSeconds: number;
  usage: WorkerUsageSnapshot;
}): void {
  const db = getDb();
  const model = opts.usage.model ?? opts.workerRun.model ?? "unknown";
  const provider = inferProvider(model, opts.usage.provider);
  try {
    db.insert(modelUsageEvents).values({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      provider,
      model,
      taskType: opts.workerRun.taskId ?? opts.workerRun.agentType ?? "worker",
      routeType: "worker",
      status: opts.succeeded ? "success" : "error",
      requests: 1,
      inputTokens: opts.usage.inputTokens,
      outputTokens: opts.usage.outputTokens,
      cachedTokens: 0,
      estimatedCostUsd: opts.usage.totalCostUsd,
      latencyMs: Math.max(0, Math.round((opts.durationSeconds || 0) * 1000)),
      budgetLane: null,
      source: `worker:${opts.sessionKey}`,
    }).run();
  } catch (e) {
    log().warn(`[PAW] Failed to insert model_usage_events for ${opts.sessionKey}: ${e}`);
  }
}

async function invokeGatewayTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  let gatewayPort = 18789;
  let gatewayToken = "";
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    gatewayPort = cfg?.gateway?.port ?? 18789;
    gatewayToken = cfg?.gateway?.auth?.token ?? "";
  } catch {}
  if (!gatewayToken) throw new Error("No gateway token configured");

  const resp = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify({
      tool,
      sessionKey: "agent:sink:paw-orchestrator-v2",
      args,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`${tool} failed (${resp.status})`);
  const data = (await resp.json()) as Record<string, unknown>;
  return (data.result as Record<string, unknown> | undefined)?.details ?? data.result ?? data;
}

/**
 * Find the workflow run that spawned this session and write spawn_result
 * so the engine's _checkSpawnAgent can advance the node.
 */
function updateWorkflowRunForSession(sessionKey: string, succeeded: boolean, reason?: string): void {
  const db = getDb();
  const runningRuns = db.select().from(workflowRuns)
    .where(eq(workflowRuns.status, "running"))
    .all();

  for (const run of runningRuns) {
    const nodeStates = (run.nodeStates as Record<string, Record<string, unknown>>) ?? {};
    for (const [nodeId, ns] of Object.entries(nodeStates)) {
      if (ns.childSessionKey === sessionKey && ns.status === "running") {
        log().info(`[PAW] Writing spawn_result for run ${run.id.slice(0, 8)} node=${nodeId} succeeded=${succeeded}`);

        ns.spawn_result = {
          status: succeeded ? "completed" : "failed",
          error: succeeded ? undefined : (reason ?? "Agent ended without success"),
        };
        nodeStates[nodeId] = ns;

        db.update(workflowRuns).set({
          nodeStates,
          updatedAt: new Date().toISOString(),
        }).where(eq(workflowRuns.id, run.id)).run();

        return;
      }
    }
  }

  log().debug?.(`[PAW] No running workflow run found for session=${sessionKey}`);
}

/**
 * If this subagent was a reflection worker, read its transcript and store the output.
 */
function collectReflectionResult(event: Record<string, unknown>): void {
  const sessionKey = (event.targetSessionKey ?? event.childSessionKey) as string;
  if (!sessionKey) return;

  const match = sessionKey.match(/^agent:(\w+):subagent:/);
  if (!match) return;
  const agentType = match[1];

  const reflectionSvc = new ReflectionService();
  if (!reflectionSvc.listAgents().includes(agentType)) return;

  const db = getDb();
  const pending = db.select().from(agentReflections)
    .where(and(
      eq(agentReflections.agentType, agentType),
      inArray(agentReflections.status, ["active", "pending"]),
    ))
    .orderBy(desc(agentReflections.createdAt))
    .limit(1)
    .get();

  if (!pending) return;
  log().info(`[PAW] collectReflectionResult: found pending ${pending.id.slice(0, 8)} for ${agentType}`);

  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  let gatewayPort = 18789;
  let gatewayToken = "";
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    gatewayPort = cfg?.gateway?.port ?? 18789;
    gatewayToken = cfg?.gateway?.auth?.token ?? "";
  } catch (_) {}

  if (!gatewayToken) return;

  // Use child_process.exec (non-blocking) to avoid event loop deadlock
  const { exec: execAsync } = require("node:child_process");
  const payload = JSON.stringify({
    tool: "sessions_history",
    sessionKey: "agent:sink:paw-orchestrator-v2",
    args: { sessionKey: sessionKey, limit: 20, includeTools: true },
  });
  const tmpFile = `/tmp/paw-hist-${pending.id.slice(0, 8)}.json`;
  writeFileSync(tmpFile, payload);
  log().info(`[PAW] collectReflectionResult: exec curl for ${agentType}...`);

  const cmd = `curl -s -m 10 -X POST "http://127.0.0.1:${gatewayPort}/tools/invoke" -H "Content-Type: application/json" -H "Authorization: Bearer ${gatewayToken}" -d @${tmpFile}`;

  execAsync(cmd, { encoding: "utf8", timeout: 15000 }, (error: Error | null, stdout: string, stderr: string) => {
    log().info(`[PAW] collectReflectionResult: curl callback for ${agentType}, stdout=${stdout?.length ?? 0}, stderr=${stderr?.length ?? 0}, error=${error?.message ?? "none"}`);
    try { unlinkSync(tmpFile); } catch (_) {}

    if (error) {
      log().warn(`[PAW] collectReflectionResult: exec failed for ${agentType}: ${error.message}`);
      return;
    }

    try {
      const historyData = JSON.parse(stdout);
      const resultObj = historyData?.result as Record<string, unknown> | undefined;
      const contentArr = resultObj?.content as Array<Record<string, unknown>> | undefined;
      let messages: Array<Record<string, unknown>> | undefined;
      if (contentArr?.[0]?.text) {
        try {
          const parsed = JSON.parse(contentArr[0].text as string);
          messages = parsed?.messages as Array<Record<string, unknown>>;
        } catch (_) {}
      }
      if (!messages) messages = (resultObj?.messages) as Array<Record<string, unknown>> | undefined;
      if (!messages || messages.length === 0) {
        log().warn(`[PAW] No messages for ${agentType} reflection ${pending.id.slice(0, 8)}`);
        return;
      }

      // Extract reflection output from assistant messages
      let output = "";
      const allText: string[] = [];

      for (const msg of messages) {
        if (msg.role !== "assistant") continue;
        const c = msg.content;
        const parts: string[] = [];
        if (typeof c === "string") parts.push(c);
        else if (Array.isArray(c)) {
          for (const p of (c as Array<Record<string, unknown>>)) {
            if (p.type === "text" && typeof p.text === "string") parts.push(p.text as string);
          }
        }
        allText.push(...parts);

        // Look for JSON reflection block
        for (const text of parts) {
          const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[1].trim());
              if (parsed.inefficiencies || parsed.concreteSuggestions || parsed.summary) {
                output = text;
                break;
              }
            } catch (_) {}
          }
          if (!output && text.includes('"inefficiencies"') && text.includes('"summary"')) {
            output = text;
            break;
          }
        }
        if (output) break;
      }

      // Fallback: longest text or concatenated
      if (!output) {
        const longest = allText.sort((a, b) => b.length - a.length)[0];
        if (longest && longest.length > 50) output = longest;
      }
      if (!output) {
        const combined = allText.join("\n\n");
        if (combined.length > 50) output = combined;
      }

      if (output && output.length > 50) {
        reflectionSvc.storeReflectionOutput(pending.id, output);
        log().info(`[PAW] Collected reflection for ${agentType} (${output.length} chars, id=${pending.id.slice(0, 8)})`);
      } else {
        log().warn(`[PAW] No usable output for ${agentType} (${allText.length} parts, ${allText.join("").length} chars)`);
      }
    } catch (e) {
      log().warn(`[PAW] collectReflectionResult parse error for ${agentType}: ${e}`);
    }
  });
}


function computeEvalMetrics(taskId: string, succeeded: boolean): Record<string, unknown> {
  const db = getDb();
  // Count how many worker runs were spawned for this task
  const allRuns = db.select().from(workerRuns)
    .where(eq(workerRuns.taskId, taskId))
    .all();
  const spawn_count = allRuns.length;

  // Sum cost across all runs for this task
  const cost_usd = allRuns.reduce((acc, r) => acc + (r.totalCostUsd ?? 0), 0);

  // Check if the most recent successful run has a summary (work_summary proxy)
  const lastRun = allRuns
    .filter(r => r.endedAt)
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
  const work_summary_present = !!(lastRun?.summary && lastRun.summary.trim().length > 0);

  return { spawn_count, cost_usd: Math.round(cost_usd * 1e6) / 1e6, work_summary_present, succeeded, logged_at: new Date().toISOString() };
}

function updateTaskFromEnd(taskId: string, succeeded: boolean, reason?: string, agentType?: string, sessionKey?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();

  const evalMetrics = computeEvalMetrics(taskId, succeeded);
  log().info(`[PAW] Task ${taskId.slice(0, 8)} eval_metrics=${JSON.stringify(evalMetrics)}`);

  // Clean up compaction sidecar file regardless of outcome
  cleanupTaskSidecar(taskId);

  if (succeeded) {
    const project = task?.projectId
      ? db.select().from(projects).where(eq(projects.id, task.projectId)).get()
      : undefined;
    const scopePath = task?.artifactPath ?? project?.repoPath ?? undefined;

    db.update(tasks).set({
      workState: "done",
      artifactPath: scopePath,
      evalMetrics,
      updatedAt: now,
    }).where(eq(tasks.id, taskId)).run();
    log().info(`[PAW] Task ${taskId.slice(0, 8)} work_state=done (workflow will finalize status)`);

    // Diff-based auto-review trigger (ADR-0013).
    // Analyze the git diff for security-sensitive patterns. If any trigger
    // fires, queue a mandatory reviewer task before considering this done.
    // Non-sensitive diffs pass through without spawning a reviewer.
    if (agentType === "programmer") {
      const triggerResult = shouldTriggerReview({
        repoPath: scopePath ?? null,
        taskId,
        taskTitle: task?.title ?? taskId,
      });

      if (triggerResult.shouldReview) {
        log().info(
          `[REVIEW-GATE] ✅ Diff triggers auto-review for task ${taskId.slice(0, 8)}` +
          ` (${(task?.title ?? "").slice(0, 60)})\n` +
          triggerResult.reason
        );
        queueReviewerFollowup(taskId, triggerResult);
      } else {
        log().info(
          `[REVIEW-GATE] ⏭  No review needed for task ${taskId.slice(0, 8)}` +
          ` (${(task?.title ?? "").slice(0, 60)})\n` +
          triggerResult.reason
        );
      }
    }

    // Route to triage session for follow-up decisions
    triageWorkerCompletion(taskId, sessionKey!, agentType ?? "unknown", true).catch(e => {
      log().warn(`[PAW] Triage spawn failed for task ${taskId.slice(0, 8)}: ${e}`);
    });
  } else {
    db.update(tasks).set({
      workState: "failed",
      failureReason: reason ?? "Worker ended without success",
      retryCount: (task?.retryCount ?? 0) + 1,
      evalMetrics,
      updatedAt: now,
    }).where(eq(tasks.id, taskId)).run();
    log().info(`[PAW] Task ${taskId.slice(0, 8)} marked failed: ${reason}`);
    // Also triage failures — might warrant a retry with different approach
    if (sessionKey) {
      triageWorkerCompletion(taskId, sessionKey, agentType ?? "unknown", false).catch(e => {
        log().warn(`[PAW] Triage spawn failed for failed task ${taskId.slice(0, 8)}: ${e}`);
      });
    }
  }
}

/**
 * Queue a mandatory reviewer task for a completed programmer task.
 *
 * When triggerResult is provided (diff-based trigger from ADR-0013), the reviewer
 * notes are enriched with which sensitivity categories fired so the reviewer
 * knows where to focus. Scope bounding is always included to prevent ghost sessions.
 *
 * Called from:
 *   - updateTaskFromEnd (subagent completion path) — with triggerResult
 *   - workflow/engine.ts (workflow completion path) — without triggerResult (legacy)
 */
export function queueReviewerFollowup(taskId: string, triggerResult?: ReviewTriggerResult): void {
  const db = getDb();
  const now = new Date().toISOString();
  const sourceTask = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!sourceTask) return;

  const existing = db.select().from(tasks)
    .where(and(
      eq(tasks.externalSource, "auto-review"),
      eq(tasks.externalId, taskId),
    ))
    .get();
  if (existing) return;

  const project = sourceTask.projectId
    ? db.select().from(projects).where(eq(projects.id, sourceTask.projectId)).get()
    : undefined;
  const scopePath = sourceTask.artifactPath ?? project?.repoPath ?? undefined;

  // Guard: skip auto-review if the target repo/artifact path doesn't exist on disk.
  // This prevents wasted reviewer spawns (and ~5–10min per failed run) when a task
  // references a repo that was never cloned locally or was removed.
  // TODO: extend this guard to writer tasks if/when auto-review is added for them.
  if (scopePath && !existsSync(scopePath)) {
    log().warn(`[PAW] Auto-review skipped for task ${taskId.slice(0, 8)}: scopePath does not exist on disk (${scopePath})`);
    return;
  }

  // Build focused review instructions based on which diff triggers fired.
  // Phased/scoped review: reviewer starts from the specific changed areas, not the whole repo.
  const triggerLines: string[] = [];
  if (triggerResult?.triggers?.length) {
    triggerLines.push(`Triggered by: ${triggerResult.triggers.join(", ")}`);
    triggerLines.push("Review focus (scope-bounded — do NOT audit the entire repo):");
    if (triggerResult.triggers.includes("security")) {
      triggerLines.push("  • Security: audit auth flows, token handling, encryption, and permission checks in the changed files only.");
    }
    if (triggerResult.triggers.includes("db_schema_change")) {
      triggerLines.push("  • DB schema: verify migrations are reversible, indexes exist, no data loss.");
    }
    if (triggerResult.triggers.includes("new_api_endpoint")) {
      triggerLines.push("  • New API: check input validation, auth guards, rate limiting, and response shapes.");
    }
    if (triggerResult.triggers.includes("large_refactor")) {
      const linesChanged = triggerResult.stats?.linesChanged ?? 0;
      triggerLines.push(`  • Large refactor (${linesChanged} lines): spot-check logic correctness and test coverage.`);
    }
    if (triggerResult.triggers.includes("test_suite")) {
      triggerLines.push("  • Test suite: verify tests are meaningful (not just coverage padding) and actually test the changed code.");
    }
  }

  const reviewNotes = [
    `Auto-review for completed programmer task ${taskId.slice(0, 8)}.`,
    `Original task: ${sourceTask.title}`,
    scopePath ? `Scope directory: ${scopePath}` : "Scope directory: project output directory not recorded; inspect changed files from the completed run.",
    ...(triggerLines.length > 0
      ? triggerLines
      : ["Focus on quick quality gate: missing tests, missing README/docs, and obvious bugs."]),
    "",
    "Phased review protocol: (1) bound scope to changed files only, (2) run targeted checks per category above, (3) mark done or create follow-up tasks.",
  ].join("\n");

  db.insert(tasks).values({
    id: randomUUID(),
    title: `Review: ${sourceTask.title}`,
    status: "active",
    owner: sourceTask.owner ?? "lobs",
    workState: "not_started",
    reviewState: "pending",
    projectId: sourceTask.projectId,
    notes: reviewNotes,
    artifactPath: scopePath,
    agent: "reviewer",
    externalSource: "auto-review",
    externalId: taskId,
    modelTier: sourceTask.modelTier ?? "standard",
    createdAt: now,
    updatedAt: now,
  }).run();

  db.update(tasks).set({
    reviewState: "queued",
    updatedAt: now,
  }).where(eq(tasks.id, taskId)).run();

  log().info(`[PAW] Auto-queued reviewer follow-up for programmer task ${taskId.slice(0, 8)}`);
}
