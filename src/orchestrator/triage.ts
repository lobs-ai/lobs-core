/**
 * Post-completion triage — creates follow-up tasks based on simple rules.
 * Lightweight inline approach instead of spawning a full triage session.
 */

import { getDb } from "../db/connection.js";
import { tasks, projects } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { log } from "../util/logger.js";
import { inferProjectId } from "../util/project-inference.js";
import { randomUUID } from "crypto";
import { getGatewayConfig } from "./control-loop.js";

const SINK_SESSION_KEY = "agent:sink:paw-orchestrator-v2";

/**
 * Collect the worker's output summary from session history.
 */
async function collectWorkerOutput(sessionKey: string): Promise<string> {
  try {
    const { port, token } = getGatewayConfig();
    const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        tool: "sessions_history",
        sessionKey: SINK_SESSION_KEY,
        args: { sessionKey, limit: 10, includeTools: false },
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;
    const result = data.result as Record<string, unknown> | undefined;
    const content = result?.content as Array<Record<string, unknown>> | undefined;
    
    let messages: Array<Record<string, unknown>> | undefined;
    if (content?.[0]?.text) {
      try {
        const parsed = JSON.parse(content[0].text as string);
        messages = parsed?.messages as Array<Record<string, unknown>>;
      } catch { /* ignore */ }
    }
    if (!messages) messages = result?.messages as Array<Record<string, unknown>> | undefined;
    if (!messages) return "";

    const assistantTexts: string[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const c = msg.content;
      if (typeof c === "string") assistantTexts.push(c);
      else if (Array.isArray(c)) {
        for (const p of (c as Array<Record<string, unknown>>)) {
          if (p.type === "text" && typeof p.text === "string") assistantTexts.push(p.text as string);
        }
      }
    }

    const combined = assistantTexts.join("\n\n");
    return combined.length > 3000 ? combined.slice(-3000) : combined;
  } catch (e) {
    log().warn(`[TRIAGE] Failed to collect output for ${sessionKey}: ${e}`);
    return "";
  }
}

function createFollowUpTask(opts: {
  title: string;
  agent: string;
  modelTier: string;
  projectId: string | null;
  notes: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();

  // Dedup: check if similar task already exists
  const existing = db.select().from(tasks)
    .where(and(
      eq(tasks.title, opts.title),
      eq(tasks.status, "active"),
    ))
    .get();
  if (existing) {
    log().debug?.(`[TRIAGE] Skipping duplicate task: ${opts.title.slice(0, 40)}`);
    return;
  }

  db.insert(tasks).values({
    id,
    title: opts.title,
    status: "active",
    agent: opts.agent,
    modelTier: opts.modelTier,
    projectId: opts.projectId ?? inferProjectId(opts.title, opts.notes) ?? null,
    notes: opts.notes,
    workState: "not_started",
    createdAt: now,
    updatedAt: now,
  } as any).run();

  log().info(`[TRIAGE] Created follow-up: "${opts.title.slice(0, 50)}" (${opts.agent}, ${opts.modelTier})`);
}

/**
 * Rule-based triage for completed workers.
 */
export async function triageWorkerCompletion(
  taskId: string,
  sessionKey: string,
  agentType: string,
  succeeded: boolean,
): Promise<void> {
  const db = getDb();

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) {
    log().warn(`[TRIAGE] Task ${taskId.slice(0, 8)} not found`);
    return;
  }

  const project = task.projectId
    ? db.select().from(projects).where(eq(projects.id, task.projectId)).get()
    : undefined;

  const repoPath = project?.repoPath ?? task.artifactPath ?? "";

  log().info(`[TRIAGE] Triaging ${agentType} task ${taskId.slice(0, 8)}: "${task.title.slice(0, 50)}" (succeeded=${succeeded})`);

  if (!succeeded) {
    // Failed tasks: don't auto-create follow-ups, let spawn guard handle retries
    log().info(`[TRIAGE] Task ${taskId.slice(0, 8)} failed — no automatic follow-up (spawn guard handles retries)`);
    return;
  }

  switch (agentType) {
    case "programmer": {
      // Programmer → create reviewer task
      createFollowUpTask({
        title: `Review: ${task.title}`,
        agent: "reviewer",
        modelTier: "small",
        projectId: task.projectId,
        notes: `Review the programmer output for this task.\n\nTask: ${task.title}\n\nNotes:\n${task.notes ?? ""}\n\nRepo: ${repoPath}\n\nCheck for: missing tests, obvious bugs, correctness. Be direct and actionable.`,
      });
      break;
    }

    case "architect": {
      // Architect → collect output and create programmer task if design is implementation-ready
      const output = await collectWorkerOutput(sessionKey);
      if (output && (output.includes("implement") || output.includes("build") || output.includes("create") || output.includes("should be"))) {
        createFollowUpTask({
          title: `Implement: ${task.title}`,
          agent: "programmer",
          modelTier: "standard",
          projectId: task.projectId,
          notes: `Implement the design from the architect.\n\nOriginal task: ${task.title}\n\nArchitect output:\n${output.slice(0, 2000)}\n\nRepo: ${repoPath}`,
        });
      }
      break;
    }

    case "researcher": {
      // Researcher → collect output and create tasks if findings are actionable
      const output = await collectWorkerOutput(sessionKey);
      if (output && output.length > 200) {
        // Create a writer task to document findings
        createFollowUpTask({
          title: `Document research: ${task.title}`,
          agent: "writer",
          modelTier: "small",
          projectId: task.projectId,
          notes: `Document the research findings.\n\nOriginal task: ${task.title}\n\nResearch output:\n${output.slice(0, 2000)}`,
        });
      }
      break;
    }

    case "reviewer": {
      // Reviewer → check if issues were found
      const output = await collectWorkerOutput(sessionKey);
      if (output && (output.includes("NEEDS FIX") || output.includes("must fix") || output.includes("critical"))) {
        createFollowUpTask({
          title: `Fix review issues: ${task.title.replace("Review: ", "")}`,
          agent: "programmer",
          modelTier: "standard",
          projectId: task.projectId,
          notes: `Fix the issues found in code review.\n\nReview output:\n${output.slice(0, 2000)}\n\nRepo: ${repoPath}`,
        });
      }
      break;
    }

    default:
      log().debug?.(`[TRIAGE] No follow-up rules for agent type: ${agentType}`);
  }
}
