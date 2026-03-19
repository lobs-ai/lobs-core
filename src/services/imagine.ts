/**
 * imagine — Manages the lobs-imagine Python service lifecycle.
 *
 * Starts the imagine server as a background process on lobs-core startup.
 * Non-blocking: if the service fails to start, lobs-core continues normally.
 * The imagine tool itself handles the case where the service is unavailable.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const HOME = process.env.HOME ?? "";
const IMAGINE_DIR = resolve(HOME, "lobs/lobs-imagine");
const VENV_PYTHON = resolve(IMAGINE_DIR, ".venv/bin/python");
const SERVER_SCRIPT = resolve(IMAGINE_DIR, "server.py");
const HEALTH_URL = "http://localhost:7421/health";

class ImagineService {
  private process: ChildProcess | null = null;
  private started = false;

  /** Start the imagine service if not already running. Non-blocking. */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Check if already running externally
    this.isRunning().then((running) => {
      if (running) {
        console.log("[imagine] Service already running");
        return;
      }

      // Verify the service exists
      if (!existsSync(SERVER_SCRIPT) || !existsSync(VENV_PYTHON)) {
        console.warn("[imagine] Service not installed — skipping autostart");
        return;
      }

      console.log("[imagine] Starting service...");

      this.process = spawn(VENV_PYTHON, [SERVER_SCRIPT], {
        cwd: IMAGINE_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: { ...process.env },
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.log(`[imagine] ${line}`);
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.log(`[imagine] ${line}`);
      });

      this.process.on("error", (err) => {
        console.error(`[imagine] Failed to start: ${err.message}`);
        this.process = null;
      });

      this.process.on("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          console.warn(`[imagine] Exited with code ${code}`);
        } else if (signal) {
          console.log(`[imagine] Killed by signal ${signal}`);
        }
        this.process = null;
      });
    });
  }

  /** Stop the imagine service. */
  stop(): void {
    if (this.process) {
      console.log("[imagine] Stopping service...");
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  /** Check if the service is responding to health checks. */
  private async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(HEALTH_URL, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const imagineService = new ImagineService();
