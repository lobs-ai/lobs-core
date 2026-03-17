/**
 * Post-completion triage — queues completed worker results for batch review by Lobs.
 * 
 * Flow:
 * 1. Worker completes → triageWorkerCompletion() queues result in triage_queue
 * 2. flushTriageQueue() runs periodically (called from control loop)
 * 3. Sends batch summary to Lobs via sessions_send on main session
 * 4. Lobs reviews and creates follow-up tasks
 */

import { getDb, getRawDb } from "../db/connection.js";
import { tasks, projects } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { log } from "../util/logger.js";
import { randomUUID } from "crypto";
import { getGatewayConfig } from "./control-loop.js";

const SINK_SESSION_KEY = "agent:sink:paw-orchestrator-v2";
const MAIN_SESSION_KEY = "agent:main";
const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FLUSH_THRESHOLD = 3; // flush if this many items queued

let lastFlushTime = Date.now();

/**
 * Ensure triage_queue table exists.
 */
function ensureTable(): void {
  try {
    const db = getRawDb();
    db.prepare(`CREATE TABLE IF NOT EXISTS triage_queue (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_title TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      project_id TEXT,
      project_name TEXT,
      succeeded INTEGER NOT NULL DEFAULT 1,
      worker_output TEXT,
      repo_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      triaged_at TEXT
    )`).run();
  } catch (e) {
    log().warn(`[TRIAGE] ensureTable error: ${e}`);
  }
}

/**
 * Collect worker output from session history.
 */
async function collectWorkerOutput(sessionKey: string): Promise<string> {
  try {
    const { port, token } = getGatewayConfig();
    const response = await fetch(`http://127.0.0.1:${port}/v2/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        tool: "sessions/history",
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
    return combined.length > 1500 ? combined.slice(-1500) : combined;
  } catch (e) {
    log().warn(`[TRIAGE] Failed to collect output for ${sessionKey}: ${e}`);
    return "";
  }
}

/**
 * Queue a completed worker for batch triage.
 */
export async function triageWorkerCompletion(
  taskId: string,
  sessionKey: string,
  agentType: string,
  succeeded: boolean,
): Promise<void> {
  try {
    const drizzleDb = getDb();
    ensureTable();

    const task = drizzleDb.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return;

    const project = task.projectId
      ? drizzleDb.select().from(projects).where(eq(projects.id, task.projectId)).get()
      : undefined;

    const output = await collectWorkerOutput(sessionKey);

    const rawDb = getRawDb();
    rawDb.prepare(`INSERT INTO triage_queue (id, task_id, task_title, agent_type, project_id, project_name, succeeded, worker_output, repo_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      randomUUID(),
      taskId,
      task.title,
      agentType,
      task.projectId ?? null,
      project?.title ?? null,
      succeeded ? 1 : 0,
      output || null,
      project?.repoPath ?? task.artifactPath ?? null,
    );

    log().info(`[TRIAGE] Queued ${agentType} task ${taskId.slice(0, 8)}: "${task.title.slice(0, 50)}" (succeeded=${succeeded})`);
  } catch (e) {
    log().warn(`[TRIAGE] triageWorkerCompletion error: ${e}`);
  }
}

/**
 * Check if it's time to flush the triage queue, and send to Lobs if so.
 * Called from the control loop every tick.
 */
export async function maybeFlushTriageQueue(): Promise<void> {
  try {
    ensureTable();
    const rawDb = getRawDb();

    const pending = rawDb.prepare(
      `SELECT * FROM triage_queue WHERE triaged_at IS NULL ORDER BY created_at ASC`
    ).all() as Array<{
      id: string;
      task_id: string;
      task_title: string;
      agent_type: string;
      project_id: string | null;
      project_name: string | null;
      succeeded: number;
      worker_output: string | null;
      repo_path: string | null;
      created_at: string;
      triaged_at: string | null;
    }>;

    if (pending.length === 0) return;

    const timeSinceFlush = Date.now() - lastFlushTime;
    if (pending.length < FLUSH_THRESHOLD && timeSinceFlush < FLUSH_INTERVAL_MS) return;

    // Build the batch message
    let message = `**🔍 Triage Queue — ${pending.length} completed tasks need review**\n\n`;
    message += `Review each and decide: create follow-up tasks, mark as done, or dismiss.\n`;
    message += `Use sqlite3 to create tasks (project_id is REQUIRED — tasks without it are skipped by the control loop):\n`;
    message += `\`\`\`\nsqlite3 ~/.lobs/lobs.db "INSERT INTO tasks (id, title, status, agent, model_tier, notes, project_id, created_at, updated_at) VALUES (lower(hex(randomblob(16))), '<title>', 'active', '<agent>', '<tier>', '<notes>', '<project_id>', datetime('now'), datetime('now'));"\n\`\`\`\n`;
    message += `Available project_ids: proj-paw, paw-lite, paw-portal, paw-dashboard, proj-shared-mem, proj-flock. Choose the most relevant.\n\n`;

    for (const item of pending) {
      const status = item.succeeded ? "✅" : "❌";
      message += `---\n`;
      message += `${status} **${item.task_title}**\n`;
      message += `Agent: ${item.agent_type} | Project: ${item.project_name ?? "none"}\n`;
      if (item.repo_path) message += `Repo: ${item.repo_path}\n`;
      if (item.worker_output) {
        const preview = item.worker_output.length > 500 
          ? item.worker_output.slice(-500) + "..."
          : item.worker_output;
        message += `Output:\n\`\`\`\n${preview}\n\`\`\`\n`;
      }
      message += `\n`;
    }

    message += `---\n`;
    message += `For each: create reviewer/programmer/writer tasks as needed, or dismiss if no follow-up required.\n`;
    message += `After triaging, the queue will auto-clear.`;

    const { port, token } = getGatewayConfig();
    const response = await fetch(`http://127.0.0.1:${port}/v2/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        tool: "sessions/send",
        sessionKey: SINK_SESSION_KEY,
        args: {
          sessionKey: MAIN_SESSION_KEY,
          message: `[System Message] Triage batch ready:\n\n${message}`,
        },
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;
    if (data.ok) {
      // Mark as triaged
      rawDb.prepare(
        `UPDATE triage_queue SET triaged_at = datetime('now') WHERE triaged_at IS NULL`
      ).run();
      lastFlushTime = Date.now();
      log().info(`[TRIAGE] Flushed ${pending.length} items to Lobs for review`);
    } else {
      log().warn(`[TRIAGE] Failed to send triage batch: ${JSON.stringify(data.error)}`);
    }
  } catch (e) {
    log().error(`[TRIAGE] Flush error: ${e}`);
  }
}
