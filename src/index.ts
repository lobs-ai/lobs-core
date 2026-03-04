/**
 * PAW — Personal AI Workforce
 *
 * OpenClaw plugin that provides multi-agent orchestration, task management,
 * workflow engine, and intelligent model routing.
 *
 * Replaces: lobs-server (FastAPI + orchestrator daemon)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { initDb, closeDb, getRawDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { seedDefaultWorkflows } from "./workflow/seeds.js";
import { registerAllRoutes } from "./api/index.js";
import { registerModelResolveHook } from "./hooks/model-resolve.js";
import { registerPromptBuildHook } from "./hooks/prompt-build.js";
import { registerSubagentHooks } from "./hooks/subagent.js";
import { registerToolGateHook } from "./hooks/tool-gate.js";
import { registerAgentEndHook } from "./hooks/agent-end.js";
import { registerRestartContinuationHook } from "./hooks/restart-continuation.js";
import { startControlLoop, stopControlLoop } from "./orchestrator/control-loop.js";
import { setLogger, log } from "./util/logger.js";
import type { PawConfig } from "./util/types.js";

const DEFAULT_DB_PATH = "~/.openclaw/plugins/paw/paw.db";
const DEFAULT_SCAN_INTERVAL = 3_000;

const pawPlugin = {
  id: "paw",
  name: "PAW — Personal AI Workforce",
  description: "Multi-agent orchestration, task management, and workflow engine",
  version: "0.1.0",

  register(api: OpenClawPluginApi) {
    setLogger(api.logger);
    const cfg = (api.pluginConfig ?? {}) as PawConfig;

    // ── Database ──────────────────────────────────────────────────────
    const dbPath = api.resolvePath(cfg.dbPath ?? DEFAULT_DB_PATH);
    const db = initDb(dbPath);
    runMigrations(db);
    log().info(`paw: database initialized at ${dbPath}`);

    // ── Startup Recovery ─────────────────────────────────────────────
    // Resume in-flight workers from previous lifecycle, or reset if unreachable
    try {
      const raw = getRawDb();

      // Find in-progress tasks with associated worker sessions
      const stuckTasks = raw.prepare(
        `SELECT t.id as taskId, t.title, wr.worker_id as sessionKey
         FROM tasks t
         LEFT JOIN worker_runs wr ON wr.task_id = t.id AND wr.ended_at IS NULL
         WHERE t.status = 'active' AND t.work_state = 'in_progress'`
      ).all() as Array<{ taskId: string; title: string; sessionKey: string | null }>;

      if (stuckTasks.length > 0) {
        log().info(`paw: startup recovery — found ${stuckTasks.length} in-progress tasks, attempting to resume`);

        for (const task of stuckTasks) {
          if (task.sessionKey) {
            // Session exists — try to resume by sending a continue message
            scheduleResume(task.sessionKey, task.taskId, task.title);
            log().info(`paw: will resume session ${task.sessionKey.slice(0, 40)} for task ${task.taskId.slice(0, 8)} (${task.title.slice(0, 30)})`);
          } else {
            // No session — reset to not_started so it gets re-dispatched
            raw.prepare(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE id = ?`).run(task.taskId);
            log().info(`paw: reset orphaned task ${task.taskId.slice(0, 8)} (${task.title.slice(0, 30)}) — no worker session found`);
          }
        }
      }

      // Cancel stale workflow runs — only cancel runs older than 5 minutes to avoid killing active ones during hot-reload
      raw.exec(`UPDATE workflow_runs SET status = 'cancelled' WHERE status IN ('running', 'pending') AND updated_at < datetime('now', '-5 minutes')`);
    } catch (e) {
      log().warn(`paw: startup recovery error: ${e}`);
    }

    // ── Seed Workflows ────────────────────────────────────────────────
    const seeded = seedDefaultWorkflows();
    if (seeded > 0) {
      log().info(`paw: seeded ${seeded} default workflows`);
    }

    // ── API Routes ────────────────────────────────────────────────────
    registerAllRoutes(api);
    log().info("paw: API routes registered at /paw/api/*");

    // ── Lifecycle Hooks ───────────────────────────────────────────────
    registerModelResolveHook(api);
    registerPromptBuildHook(api);
    registerSubagentHooks(api);
    registerToolGateHook(api);
    registerAgentEndHook(api);
    registerRestartContinuationHook(api);

    // Clean stale subagent runs from disk registry to prevent children count buildup
    try {
      const registryPath = `${process.env.HOME}/.openclaw/subagents/runs.json`;
      const readFs = require("node:fs").readFileSync; const writeFs = require("node:fs").writeFileSync;
      const data = JSON.parse(readFs(registryPath, "utf8"));
      const runs = data?.runs ?? {};
      const now = Date.now();
      let cleaned = 0;
      for (const [id, entry] of Object.entries(runs)) {
        const e = entry as Record<string, unknown>;
        if (e.endedAt == null) {
          const started = (e.startedAt as number) ?? 0;
          if (now - started > 10 * 60 * 1000) { // 10 min old and still "active"
            e.endedAt = now;
            e.endReason = "stale-startup-cleanup";
            cleaned++;
          }
        }
      }
      if (cleaned > 0) {
        writeFs(registryPath, JSON.stringify({ ...data, runs }));
        log().info(`[PAW] Cleaned ${cleaned} stale subagent runs from registry`);
      }
    } catch (_) {}

    log().info("paw: lifecycle hooks registered");

    // ── Orchestrator Service ──────────────────────────────────────────
    const scanInterval = cfg.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL;

    api.registerService({
      id: "paw-orchestrator",
      start: () => {
        startControlLoop({} as any, scanInterval);
      },
      stop: () => {
        stopControlLoop();
        closeDb();
      },
    });

    // ── Slash Commands ────────────────────────────────────────────────
    api.registerCommand?.({
      name: "paw",
      description: "PAW status overview",
      handler: async () => {
        const { countActiveWorkers } = await import("./orchestrator/worker-manager.js");
        const { findReadyTasks } = await import("./orchestrator/scanner.js");
        const active = countActiveWorkers();
        const ready = findReadyTasks(100).length;
        return { text: `🐾 PAW orchestrator running.\nActive workers: ${active}\nReady tasks: ${ready}` };
      },
    });

    // ── CLI ───────────────────────────────────────────────────────────
    api.registerCli?.(
      ({ program }) => {
        const paw = program.command("paw").description("PAW orchestrator commands");

        paw.command("status").description("Show orchestrator status").action(async () => {
          const { countActiveWorkers } = await import("./orchestrator/worker-manager.js");
          const { findReadyTasks } = await import("./orchestrator/scanner.js");
          console.log(`Active workers: ${countActiveWorkers()}`);
          console.log(`Ready tasks: ${findReadyTasks(100).length}`);
        });

        paw.command("tasks").description("List open tasks").action(async () => {
          const { findReadyTasks } = await import("./orchestrator/scanner.js");
          const tasks = findReadyTasks(50);
          if (tasks.length === 0) {
            console.log("No ready tasks.");
            return;
          }
          for (const t of tasks) {
            console.log(`  ${t.id.slice(0, 8)} [${t.agent}] ${t.title}`);
          }
        });
      },
      { commands: ["paw"] },
    );

    log().info("paw: plugin fully registered ✓");
  },
};

export default pawPlugin;

// ── Session Resume Logic ─────────────────────────────────────────────────────

interface ResumeTarget {
  sessionKey: string;
  taskId: string;
  title: string;
}

const pendingResumes: ResumeTarget[] = [];

function scheduleResume(sessionKey: string, taskId: string, title: string): void {
  pendingResumes.push({ sessionKey, taskId, title });
}

/**
 * After the gateway is fully up, send resume messages to in-flight worker sessions.
 * Called from the first control-loop tick (delayed to ensure gateway is ready).
 */
export async function processPendingResumes(): Promise<void> {
  if (pendingResumes.length === 0) return;

  // Read gateway config
  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  let port = 18789;
  let token = "";
  try {
    const { readFileSync } = await import("node:fs");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    port = cfg?.gateway?.port ?? 18789;
    token = cfg?.gateway?.auth?.token ?? "";
  } catch {}

  if (!token) {
    log().warn("paw: cannot resume sessions — no gateway auth token");
    // Fall back: reset all pending resumes to not_started
    const { getRawDb } = await import("./db/connection.js");
    const raw = getRawDb();
    for (const r of pendingResumes) {
      raw.prepare(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE id = ?`).run(r.taskId);
    }
    pendingResumes.length = 0;
    return;
  }

  const SINK_SESSION_KEY = "agent:sink:paw-orchestrator-v2";

  for (const resume of pendingResumes) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tool: "sessions_send",
          sessionKey: SINK_SESSION_KEY,
          args: {
            sessionKey: resume.sessionKey,
            message: `[System] You were interrupted by a restart. Resume your task: "${resume.title}". Continue where you left off — check what files you've already created and pick up from there. Do NOT start over.`,
            timeoutSeconds: 0,
          },
        }),
      });

      const data = (await response.json()) as Record<string, unknown>;
      if (data.ok) {
        log().info(`paw: resumed session ${resume.sessionKey.slice(0, 40)} for task ${resume.taskId.slice(0, 8)}`);
      } else {
        // Session unreachable — reset task
        log().warn(`paw: could not resume ${resume.sessionKey.slice(0, 40)}: ${JSON.stringify(data.error)}`);
        const { getRawDb } = await import("./db/connection.js");
        const raw = getRawDb();
        raw.prepare(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE id = ?`).run(resume.taskId);
      }
    } catch (e) {
      log().warn(`paw: resume failed for ${resume.taskId.slice(0, 8)}: ${e}`);
      const { getRawDb } = await import("./db/connection.js");
      const raw = getRawDb();
      raw.prepare(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE id = ?`).run(resume.taskId);
    }
  }
  pendingResumes.length = 0;
}
