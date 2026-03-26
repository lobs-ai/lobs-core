/**
 * PAW — Personal AI Workforce
 *
 * Lobs plugin entry point for multi-agent orchestration, task management,
 * workflow engine, and intelligent model routing.
 *
 * Replaces: lobs-server (FastAPI + orchestrator daemon)
 */

import type { LobsPluginApi } from "./types/lobs-plugin.js";
import { initDb, closeDb, getRawDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { initMemoryDb } from "./memory/db.js";
import { seedDefaultWorkflows } from "./workflow/seeds.js";
import { registerAllRoutes } from "./api/index.js";
import { registerModelResolveHook } from "./hooks/model-resolve.js";
import { registerPromptBuildHook } from "./hooks/prompt-build.js";
import { registerSubagentHooks } from "./hooks/subagent.js";
import { registerToolGateHook } from "./hooks/tool-gate.js";
import { registerAgentEndHook } from "./hooks/agent-end.js";
import { registerRestartContinuationHook } from "./hooks/restart-continuation.js";
import { registerCircuitBreakerHooks } from "./hooks/circuit-breaker.js";
import { registerGroupMessageHook } from "./hooks/group-message.js";
import { registerCompactionHooks } from "./hooks/compaction.js";
import { registerEventRecorderHook } from "./hooks/event-recorder.js";
import { startControlLoop, stopControlLoop } from "./orchestrator/control-loop.js";
import { YouTubeService } from "./services/youtube.js";
import { ensureCompliantMemoryDirs } from "./api/memories-fs.js";
import { ensureScheduleSeeded } from "./services/schedule-seed.js";
import { startMemoryScanner, stopMemoryScanner } from "./services/memory-scanner.js";
import { setLogger, log } from "./util/logger.js";
import type { PawConfig } from "./util/types.js";
import { getGatewayConfig, getSubagentRunsPath } from "./config/lobs.js";

const DEFAULT_DB_PATH = "~/.lobs/lobs.db";
const DEFAULT_SCAN_INTERVAL = 3_000;

const pawPlugin = {
  id: "lobs",
  name: "PAW — Personal AI Workforce",
  description: "Multi-agent orchestration, task management, and workflow engine",
  version: "0.1.0",

  register(api: LobsPluginApi) {
    setLogger(api.logger);
    const cfg = (api.pluginConfig ?? {}) as PawConfig;

    // ── Database ──────────────────────────────────────────────────────
    const dbPath = api.resolvePath(cfg.dbPath ?? DEFAULT_DB_PATH);
    const db = initDb(dbPath);
    runMigrations(db);
    log().info(`paw: database initialized at ${dbPath}`);

    // ── Memory Database ───────────────────────────────────────────────
    // Separate SQLite DB for the new event-based memory system.
    // Must be initialised before hooks are registered so the DB is ready
    // when the first hook fires.
    initMemoryDb();

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
        log().info(`paw: startup recovery — found ${stuckTasks.length} in-progress tasks, scheduling resume checks`);

        for (const task of stuckTasks) {
          if (task.sessionKey) {
            // Schedule for resume — processPendingResumes() (called from the first
            // orchestrator tick) will verify whether each session is still alive via
            // the gateway API before sending a resume message. Dead sessions are reset
            // to not_started. This deferred check avoids the race where this synchronous
            // startup code fires before the gateway is ready to answer liveness queries.
            scheduleResume(task.sessionKey, task.taskId, task.title);
            log().info(`paw: queued resume check for session ${task.sessionKey.slice(0, 40)} (task ${task.taskId.slice(0, 8)}: ${task.title.slice(0, 30)})`);
          } else {
            // No session — reset to not_started so it gets re-dispatched
            raw.prepare(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE id = ?`).run(task.taskId);
            log().info(`paw: reset orphaned task ${task.taskId.slice(0, 8)} (${task.title.slice(0, 30)}) — no worker session found`);
          }
        }
      }

      // Cancel stale workflow runs — only cancel runs older than 5 minutes to avoid killing active ones during hot-reload
      raw.exec(`UPDATE workflow_runs SET status = 'cancelled' WHERE status IN ('running', 'pending') AND updated_at < datetime('now', '-5 minutes')`);

      // ── Meeting analysis recovery ────────────────────────────────────
      // Reset meetings stuck in 'processing' back to 'pending' so they get re-analyzed
      const stuckMeetings = raw.prepare(
        `UPDATE meetings SET analysis_status = 'pending', updated_at = datetime('now')
         WHERE analysis_status = 'processing'`
      ).run();
      if (stuckMeetings.changes > 0) {
        log().info(`paw: startup recovery — reset ${stuckMeetings.changes} stuck meeting(s) from processing → pending`);
      }
    } catch (e) {
      log().warn(`paw: startup recovery error: ${e}`);
    }

    // ── Ensure memory-compliant/ dirs exist ──────────────────────────
    // Idempotent — creates directories for all known agents if missing.
    ensureCompliantMemoryDirs().catch(e =>
      log().warn(`paw: ensureCompliantMemoryDirs error: ${e}`)
    );

    // ── Memory Compliance Scanner ─────────────────────────────────────
    // Background service: scans memory/ and memory-compliant/ dirs every 5 min,
    // maintains memory_compliance_index, and flags misplaced files as anomalies.
    startMemoryScanner();

    // ── Seed Workflows ────────────────────────────────────────────────
    const seeded = seedDefaultWorkflows();
    if (seeded > 0) {
      log().info(`paw: seeded ${seeded} default workflows`);
    }

    // ── Seed Recurring Schedule Blocks ───────────────────────────────
    // Idempotent — inserts Rafe's weekly schedule into scheduledEvents if not present.
    ensureScheduleSeeded().catch(e =>
      log().warn(`paw: ensureScheduleSeeded error: ${e}`)
    );

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
    registerCircuitBreakerHooks(api);
    registerGroupMessageHook(api);
    registerCompactionHooks(api);
    registerEventRecorderHook(api);

    // Clean stale subagent runs from disk registry to prevent children count buildup
    try {
      const registryPath = getSubagentRunsPath();
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
      id: "lobs-orchestrator",
      start: () => {
        startControlLoop({} as any, scanInterval);
        const ytSvc = new YouTubeService(); ytSvc.startRecoveryLoop(); (globalThis as any).__ytSvc = ytSvc;

        // ── Learning extraction pass ────────────────────────────────────
        // Run pattern extraction every hour so new feedback generates learnings
        // without requiring manual POST /api/learning/extract calls.
        // This is the "LessonExtractor" background runner.
        const EXTRACTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
        const runExtraction = async () => {
          try {
            const { LearningService } = await import("./services/learning.js");
            const svc = new LearningService();
            const count = svc.runExtractionPass();
            if (count > 0) {
              log().info(`[LEARNING] Scheduled extraction pass: ${count} learnings updated`);
            }
          } catch (e) {
            log().warn(`[LEARNING] Extraction pass error: ${e}`);
          }
        };
        // Run once shortly after startup (delay 30s to avoid init contention)
        const startupTimer = setTimeout(runExtraction, 30_000);
        const extractionTimer = setInterval(runExtraction, EXTRACTION_INTERVAL_MS);
        (globalThis as any).__learningExtractionTimers = { startupTimer, extractionTimer };
      },
      stop: () => {
        stopControlLoop();
        stopMemoryScanner();
        try { (globalThis as any).__ytSvc?.stopRecoveryLoop(); } catch {}
        // Clean up learning extraction timers
        try {
          const timers = (globalThis as any).__learningExtractionTimers;
          if (timers) {
            clearTimeout(timers.startupTimer);
            clearInterval(timers.extractionTimer);
          }
        } catch {}
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

/**
 * On restart: immediately fail workflow runs stuck at spawn_* nodes with no
 * corresponding active worker. These occur when the gateway drained mid-spawn —
 * the spawn call never completed, leaving the run at a spawn node forever and
 * consuming a capacity slot via countInFlightTaskRuns().
 */
async function failStaleSpawnRuns(): Promise<void> {
  try {
    const { getDb } = await import("./db/connection.js");
    const { workflowRuns } = await import("./db/schema.js");
    const { eq } = await import("drizzle-orm");
    const { readFileSync } = await import("node:fs");
    const db = getDb();

    // All running workflow runs currently at a spawn node
    const spawnStuck = db.select().from(workflowRuns)
      .where(eq(workflowRuns.status, "running"))
      .all()
      .filter((r: any) => r.currentNode?.startsWith("spawn_"));

    if (spawnStuck.length === 0) return;
    log().info(`paw: checking ${spawnStuck.length} run(s) stuck at spawn nodes on restart`);

    // Read gateway config for live session check
    let port = 18789;
    let token = "";
    try {
      const cfg = getGatewayConfig();
      port = cfg.port;
      token = cfg.token;
    } catch {}

    /**
     * Check if a session key is truly alive right now via the gateway API.
     * We cannot trust workerRuns DB rows alone because they persist across crashes
     * and may reflect sessions that died during a drain without being cleaned up.
     */
    async function isSessionAliveNow(sessionKey: string): Promise<boolean> {
      if (!token) return false; // can't verify without token — treat as dead on restart
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/v2/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({
            tool: "sessions/list",
            sessionKey: "agent:sink:paw-orchestrator-v2",
            args: { activeMinutes: 120, limit: 100 },
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return false;
        const data = (await resp.json()) as any;
        const content = data?.result?.content;
        let sessions: any[] = [];
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === "text" && c.text) {
              try { sessions = JSON.parse(c.text)?.sessions ?? []; } catch {}
            }
          }
        }
        return sessions.some((s: any) => s.key === sessionKey);
      } catch {
        return false;
      }
    }

    for (const run of spawnStuck) {
      const nodeStates = (run.nodeStates ?? {}) as Record<string, any>;
      const currentNs = nodeStates[run.currentNode ?? ""] ?? {};
      const childKey = currentNs["childSessionKey"] as string | undefined;

      let shouldFail = false;
      let reason = "";

      if (!childKey) {
        // No session key recorded — spawn never completed (dropped during drain)
        shouldFail = true;
        reason = "no session — spawn was dropped during drain";
      } else {
        // Session key exists but verify it's ACTUALLY alive via the gateway.
        // DB-based workerRuns rows persist across crashes, so we can't trust them alone.
        const alive = await isSessionAliveNow(childKey);
        if (!alive) {
          shouldFail = true;
          reason = `session ${childKey.slice(0, 30)} no longer alive after restart`;
          // Clean up the stale workerRuns row so it doesn't block capacity
          try {
            const { workerRuns } = await import("./db/schema.js");
            db.update(workerRuns)
              .set({ endedAt: new Date().toISOString(), succeeded: false, timeoutReason: "restart_cleanup" })
              .where(eq(workerRuns.workerId, childKey))
              .run();
          } catch {}
        }
      }

      if (shouldFail) {
        db.update(workflowRuns)
          .set({ status: "failed", updatedAt: new Date().toISOString() })
          .where(eq(workflowRuns.id, run.id))
          .run();
        log().warn(
          `paw: restart cleanup — failed stale spawn run ${run.id.slice(0, 8)} ` +
          `(node=${run.currentNode}) — ${reason}`
        );
      }
    }
  } catch (e) {
    log().warn(`paw: failStaleSpawnRuns error: ${e}`);
  }
}

export async function processPendingResumes(): Promise<void> {
  // Always clean up stale spawn runs on restart, regardless of pendingResumes
  await failStaleSpawnRuns();

  if (pendingResumes.length === 0) return;

  // Read gateway config
  let port = 18789;
  let token = "";
  try {
    const cfg = getGatewayConfig();
    port = cfg.port;
    token = cfg.token;
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

  // ── Liveness pre-check ────────────────────────────────────────────────────
  // Before sending any resume message, verify each session is actually alive
  // via the gateway. Sessions scheduled for resume at plugin startup (register())
  // were recorded SYNCHRONOUSLY without any liveness verification — they may have
  // died before/during the restart. Sending a resume to a dead session causes a
  // hung send that ultimately produces an 'orphaned on restart' timeout record.
  //
  // We fetch the full session list once (up to 200, 3h window) and compare.
  const aliveSessions = new Set<string>();
  let livenessCheckFailed = false;
  try {
    const listResp = await fetch(`http://127.0.0.1:${port}/v2/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        tool: "sessions/list",
        sessionKey: SINK_SESSION_KEY,
        args: { activeMinutes: 180, limit: 200 },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (listResp.ok) {
      const data = (await listResp.json()) as any;
      const content = data?.result?.content;
      let sessions: any[] = [];
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === "text" && c.text) {
            try { sessions = JSON.parse(c.text)?.sessions ?? []; } catch {}
          }
        }
      }
      for (const s of sessions) {
        if (s.key) aliveSessions.add(s.key);
      }
      log().info(`paw: processPendingResumes — gateway reports ${aliveSessions.size} live session(s); will verify ${pendingResumes.length} resume candidate(s)`);
    } else {
      livenessCheckFailed = true;
      log().warn(`paw: processPendingResumes — liveness list call failed (HTTP ${listResp.status}); resetting all candidates to not_started`);
    }
  } catch (e) {
    livenessCheckFailed = true;
    log().warn(`paw: processPendingResumes — liveness check error: ${e}; resetting all candidates to not_started`);
  }

  if (livenessCheckFailed) {
    // Cannot verify — safest option is to reset all candidates so the orchestrator
    // re-dispatches them cleanly rather than firing resumes at potentially dead sessions.
    const { getRawDb } = await import("./db/connection.js");
    const raw = getRawDb();
    for (const r of pendingResumes) {
      raw.prepare(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE id = ?`).run(r.taskId);
      log().info(`paw: reset task ${r.taskId.slice(0, 8)} to not_started — liveness check unavailable`);
    }
    pendingResumes.length = 0;
    return;
  }

  for (const resume of pendingResumes) {
    // Verify session is alive BEFORE attempting to send a resume message.
    if (!aliveSessions.has(resume.sessionKey)) {
      log().info(
        `paw: session ${resume.sessionKey.slice(0, 40)} not in live set — ` +
        `resetting task ${resume.taskId.slice(0, 8)} (${resume.title.slice(0, 30)}) to not_started`
      );
      const { getRawDb } = await import("./db/connection.js");
      const raw = getRawDb();
      raw.prepare(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE id = ?`).run(resume.taskId);
      // Also close the stale worker_run so it doesn't block capacity
      try {
        const { getDb } = await import("./db/connection.js");
        const { workerRuns } = await import("./db/schema.js");
        const { eq } = await import("drizzle-orm");
        getDb().update(workerRuns).set({
          endedAt: new Date().toISOString(),
          succeeded: false,
          timeoutReason: "orphaned on restart",
          failureType: "infra",
        }).where(eq(workerRuns.workerId, resume.sessionKey)).run();
      } catch {}
      continue;
    }

    try {
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
