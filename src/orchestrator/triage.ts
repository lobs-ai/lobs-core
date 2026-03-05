/**
 * Post-completion triage — routes worker output to a Lobs triage session
 * that decides whether to create follow-up tasks, dismiss, or escalate.
 */

import { getDb } from "../db/connection.js";
import { tasks, projects, workerRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { log } from "../util/logger.js";

const GATEWAY_PORT = process.env.OPENCLAW_PORT ?? "4152";
const GATEWAY_TOKEN = process.env.OPENCLAW_AUTH_TOKEN ?? process.env.AUTH_TOKEN ?? "";
const SINK_SESSION_KEY = "agent:sink:paw-orchestrator-v2";

interface TriagePayload {
  taskId: string;
  taskTitle: string;
  agentType: string;
  projectName: string | null;
  projectId: string | null;
  succeeded: boolean;
  summary: string;
  modelTier: string | null;
}

/**
 * Collect the worker's output summary from session history.
 */
async function collectWorkerOutput(sessionKey: string): Promise<string> {
  try {
    const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GATEWAY_TOKEN}`,
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
    if (!messages) return "(no output captured)";

    // Get the last few assistant messages
    const assistantTexts: string[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const c = msg.content;
      if (typeof c === "string") {
        assistantTexts.push(c);
      } else if (Array.isArray(c)) {
        for (const p of (c as Array<Record<string, unknown>>)) {
          if (p.type === "text" && typeof p.text === "string") assistantTexts.push(p.text as string);
        }
      }
    }

    // Return last ~2000 chars of assistant output
    const combined = assistantTexts.join("\n\n");
    return combined.length > 2000 ? combined.slice(-2000) : combined;
  } catch (e) {
    log().warn(`[TRIAGE] Failed to collect output for ${sessionKey}: ${e}`);
    return "(failed to collect output)";
  }
}

/**
 * Send a completed worker's output to the triage session for follow-up decisions.
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
    log().warn(`[TRIAGE] Task ${taskId.slice(0, 8)} not found — skipping triage`);
    return;
  }

  const project = task.projectId
    ? db.select().from(projects).where(eq(projects.id, task.projectId)).get()
    : undefined;

  const summary = await collectWorkerOutput(sessionKey);

  const payload: TriagePayload = {
    taskId,
    taskTitle: task.title,
    agentType,
    projectName: project?.title ?? null,
    projectId: task.projectId ?? null,
    succeeded,
    summary,
    modelTier: task.modelTier ?? null,
  };

  const triagePrompt = buildTriagePrompt(payload);

  try {
    const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        tool: "sessions_spawn",
        sessionKey: SINK_SESSION_KEY,
        args: {
          task: triagePrompt,
          agentId: "main",
          model: "lmstudio/qwen/qwen3.5-35b-a3b",
          mode: "run",
          cleanup: "keep",
          runTimeoutSeconds: 120,
        },
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;
    if (data.ok) {
      log().info(`[TRIAGE] Spawned triage for task ${taskId.slice(0, 8)} (${agentType})`);
    } else {
      log().warn(`[TRIAGE] Failed to spawn triage: ${JSON.stringify(data.error)}`);
    }
  } catch (e) {
    log().error(`[TRIAGE] Spawn error: ${e}`);
  }
}

function buildTriagePrompt(p: TriagePayload): string {
  return `You are Lobs, triaging the output of a completed worker agent. Based on the output, decide what follow-up actions are needed.

## Completed Task
- **Title:** ${p.taskTitle}
- **Agent:** ${p.agentType}
- **Project:** ${p.projectName ?? "none"} (${p.projectId ?? "no project"})
- **Succeeded:** ${p.succeeded}
- **Model tier:** ${p.modelTier ?? "unknown"}

## Worker Output
${p.summary}

## Your Job
Analyze the output and create follow-up tasks if appropriate. Use sqlite3 to insert tasks directly:

\`\`\`bash
sqlite3 ~/.openclaw/plugins/paw/paw.db "INSERT INTO tasks (id, title, status, agent, model_tier, project_id, notes, work_state, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 'TITLE', 'active', 'AGENT_TYPE', 'TIER', 'PROJECT_ID', 'NOTES', 'not_started', datetime('now'), datetime('now'));"
\`\`\`

### Decision Guide
- **programmer** completed → create a \`reviewer\` task (tier: small) to review the code changes
- **researcher** completed → if findings are actionable, create \`programmer\`/\`architect\`/\`writer\` tasks as appropriate
- **architect** completed → if design is ready for implementation, create \`programmer\` tasks to build it
- **writer** completed → usually no follow-up needed unless docs reference unimplemented features
- **reviewer** completed → if review found issues, create a \`programmer\` fix task; otherwise no follow-up
- **Failed tasks** → assess if retryable or needs different approach; create a new task if worth retrying with adjusted notes

### Rules
- Only create tasks that are clearly warranted by the output
- Use the same project_id as the source task
- Keep task titles concise and actionable
- For reviewer follow-ups after programmer, include the repo path and what to review in notes
- Don't create tasks for trivial/cosmetic issues unless they're quick wins
- If nothing needs follow-up, just say so and exit

### Available Agents & Tiers
- Agents: programmer, researcher, writer, architect, reviewer
- Tiers: micro (local/free), small, medium, standard, strong

Act now — analyze the output and create any needed tasks.`;
}
