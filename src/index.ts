/**
 * PAW — Personal AI Workforce
 *
 * OpenClaw plugin that provides multi-agent orchestration, task management,
 * workflow engine, and intelligent model routing.
 *
 * Replaces: lobs-server (FastAPI + orchestrator daemon)
 */

import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk";
import { initDb, closeDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
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

const pawPlugin: OpenClawPluginDefinition = {
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
        startControlLoop(
          { config: api.config, stateDir: "", logger: api.logger },
          scanInterval,
        );
      },
      stop: () => {
        stopControlLoop();
        closeDb();
      },
    });

    // ── Slash Commands ────────────────────────────────────────────────
    api.registerCommand({
      name: "paw",
      description: "PAW status overview",
      handler: async () => {
        // Phase 5: implement real status
        return { text: "🐾 PAW orchestrator running." };
      },
    });

    // ── CLI ───────────────────────────────────────────────────────────
    api.registerCli(
      ({ program }) => {
        const paw = program.command("paw").description("PAW orchestrator commands");

        paw.command("status").description("Show orchestrator status").action(async () => {
          console.log("PAW orchestrator status: running");
          // Phase 5: real status output
        });

        paw.command("tasks").description("List open tasks").action(async () => {
          console.log("Open tasks: (not yet implemented)");
        });
      },
      { commands: ["paw"] },
    );

    log().info("paw: plugin fully registered ✓");
  },
};

export default pawPlugin;
