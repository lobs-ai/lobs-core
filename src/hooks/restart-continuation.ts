/**
 * Gateway start hook — sends a system event to the main session after restart
 * so the agent gets prompted to continue any in-progress work.
 */
import { readFileSync } from "node:fs";
import { log } from "../util/logger.js";
import { getGatewayConfig } from "../config/lobs.js";
import { loadDiscordConfig } from "../config/discord.js";
import { checkModelsBeforeSpawn } from "../diagnostics/lmstudio.js";
import { getModelConfig } from "../config/models.js";

export function registerRestartContinuationHook(api: any): void {
  api.on("gateway_start", async () => {
    // Clean up orphaned state from pre-restart
    setTimeout(() => {
      try {
        const Database = require("better-sqlite3");
        const { join } = require("node:path");
        const { homedir } = require("node:os");
        const { getLobsRoot } = require("../config/lobs.js");
        const dbPath = process.env.PAW_DB_PATH ?? join(getLobsRoot(), "lobs.db");
        const db = new Database(dbPath);
        
        // Collect task IDs for in-flight runs BEFORE closing them (so we can increment crash_count)
        const orphanedTaskRows = db.prepare(
          "SELECT DISTINCT task_id FROM worker_runs WHERE ended_at IS NULL AND task_id IS NOT NULL"
        ).all() as Array<{ task_id: string }>;

        // Fail orphaned worker runs (no ended_at) — these are crash-orphans, NOT agent quality failures.
        // failure_type = 'infra' ensures reliability metrics don't penalise agents for gateway restarts.
        const orphaned = db.prepare("UPDATE worker_runs SET ended_at = datetime('now'), succeeded = 0, timeout_reason = 'orphaned on restart', failure_type = 'infra' WHERE ended_at IS NULL").run();
        if (orphaned.changes > 0) {
          log().info(`[PAW] Restart cleanup: failed ${orphaned.changes} orphaned worker runs`);
          // Increment crash_count for each affected in-progress task.
          // This prevents the spawn guard from auto-blocking tasks that only
          // failed due to gateway crashes (effective_fail = spawn_count - crash_count).
          for (const row of orphanedTaskRows) {
            db.prepare(
              "UPDATE tasks SET crash_count = COALESCE(crash_count, 0) + 1, updated_at = datetime('now') WHERE id = ? AND work_state = 'in_progress'"
            ).run(row.task_id);
          }
          if (orphanedTaskRows.length > 0) {
            log().info(`[PAW] Restart cleanup: incremented crash_count for ${orphanedTaskRows.length} task(s) (crash-orphaned)`);
          }
        }
        
        // Reset busy agents to idle
        const agents = db.prepare("UPDATE agent_status SET status = 'idle', current_task_id = NULL WHERE status = 'busy'").run();
        if (agents.changes > 0) log().info(`[PAW] Restart cleanup: reset ${agents.changes} busy agents to idle`);
        
        // Reset tasks that were "running" back to active
        const tasks = db.prepare("UPDATE tasks SET status = 'active', updated_at = datetime('now') WHERE status = 'running'").run();
        if (tasks.changes > 0) log().info(`[PAW] Restart cleanup: reset ${tasks.changes} running tasks to active`);
        
        db.close();
      } catch (e) {
        log().warn(`[PAW] Restart cleanup error: ${e}`);
      }
    }, 2000);

    // Delay 5s to let gateway fully initialize
    setTimeout(async () => {
      try {
        // ── LM Studio preflight ──────────────────────────────────────────────
        // Before sending the resume prompt we verify LM Studio is reachable
        // and the configured local model is loaded. If the check fails we skip
        // the prompt: the agent would immediately error on a tool call anyway,
        // and the resume can be triggered manually or on the next gateway start.
        const cfg = getModelConfig();
        // Gather the model IDs we actually need for agent work (micro + local chat).
        const modelsToCheck = [
          cfg.tiers.micro,
          `lmstudio/${cfg.local.chatModel.replace(/^lmstudio\//, "")}`,
        ].filter((m): m is string => Boolean(m));

        const preflight = await checkModelsBeforeSpawn(modelsToCheck);
        if (!preflight.ok) {
          if (!preflight.reachable) {
            log().warn(
              "[PAW] Restart continuation: LM Studio is unreachable — skipping resume prompt. " +
              "Will retry on next gateway start."
            );
          } else {
            const missing = preflight.missingIds.join(", ");
            log().warn(
              `[PAW] Restart continuation: LM Studio reachable but model(s) not loaded: ${missing} — ` +
              "skipping resume prompt to avoid model-drift failures."
            );
          }
          return;
        }
        log().info("[PAW] Restart continuation: LM Studio preflight passed — sending resume prompt");

        const { port, token } = getGatewayConfig();
        if (!token) return;

        const res = await fetch(`http://127.0.0.1:${port}/v2/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({
            tool: "sessions/send",
            sessionKey: "agent:sink:paw-orchestrator-v2",
            args: {
              sessionKey: `agent:main:discord:direct:${loadDiscordConfig()?.ownerId ?? loadDiscordConfig()?.dmAllowFrom?.[0] ?? "unknown"}`,
              message: "[System] PAW plugin restarted. Continue any in-progress work.",
            },
          }),
        });

        if (res.ok) {
          log().info("[PAW] Restart continuation: sent resume prompt to main session");
        } else {
          log().warn(`[PAW] Restart continuation: failed to send (${res.status})`);
        }
      } catch (e) {
        log().warn(`[PAW] Restart continuation error: ${e}`);
      }
    }, 5000);
  });
}
