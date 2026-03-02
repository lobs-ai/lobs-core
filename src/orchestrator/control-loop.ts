/**
 * Orchestrator control loop — main scan/dispatch service.
 *
 * Runs as a plugin service (registerService). On each tick:
 * 1. Scan for ready tasks (status=active, work_state=not_started, no active worker)
 * 2. Check workflow events (event-triggered workflows)
 * 3. Check scheduled workflows (cron-triggered)
 * 4. Dispatch work (spawn workers via OpenClaw sessions)
 * 5. Health check active workers
 *
 * Replaces: lobs-server/app/orchestrator/control_loop.py
 */

import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { log } from "../util/logger.js";

let timer: ReturnType<typeof setInterval> | null = null;

export function startControlLoop(ctx: OpenClawPluginServiceContext, intervalMs: number): void {
  log().info(`orchestrator: starting control loop (interval=${intervalMs}ms)`);

  const tick = async () => {
    try {
      // Phase 2: implement scan → dispatch pipeline
      log().debug?.("orchestrator: tick");
    } catch (err) {
      log().error(`orchestrator: tick failed: ${String(err)}`);
    }
  };

  // Run first tick immediately
  void tick();
  timer = setInterval(tick, intervalMs);
}

export function stopControlLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log().info("orchestrator: control loop stopped");
  }
}
