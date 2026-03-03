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
import { startControlLoop, stopControlLoop } from "./orchestrator/control-loop.js";
import { setLogger, log } from "./util/logger.js";
import type { PawConfig } from "./util/types.js";

const DEFAULT_DB_PATH = "~/.openclaw/plugins/paw/paw.db";
const DEFAULT_SCAN_INTERVAL = 10_000;

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
    // Reset tasks stuck in "in_progress" from a previous lifecycle (e.g. restart killed workers)
    try {
      const raw = getRawDb();
      raw.exec(`UPDATE tasks SET work_state = 'not_started', updated_at = datetime('now') WHERE status = 'active' AND work_state = 'in_progress'`);
      raw.exec(`UPDATE workflow_runs SET status = 'cancelled' WHERE status IN ('running', 'pending')`);
      raw.exec(`UPDATE worker_runs SET ended_at = datetime('now'), succeeded = 0, timeout_reason = 'startup_recovery' WHERE ended_at IS NULL`);
      log().info("paw: startup recovery — reset stuck tasks, cancelled stale workflow runs, closed orphaned workers");
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
