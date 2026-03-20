/**
 * Memory server supervisor — manages the lobs-memory bun process as a child.
 *
 * Starts the memory server (bun run server/index.ts) as a supervised child process.
 * Restarts automatically on crash with exponential backoff.
 * Health checks via HTTP to detect silent failures.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { checkMemorySupervisorHealth } from "./restart-telemetry.js";

const HOME = process.env.HOME ?? "";
const MEMORY_DIR = resolve(HOME, "lobs/lobs-core/memory");
const MEMORY_PORT = 7420;
const HEALTH_URL = `http://localhost:${MEMORY_PORT}/status`;
const BUN_PATH = resolve(HOME, ".bun/bin/bun");

// Restart policy
const RESTART_DELAY_BASE_MS = 1000;   // 1s initial
const RESTART_DELAY_MAX_MS = 60_000;  // 60s max
const RESTART_BACKOFF_FACTOR = 2;
const HEALTH_CHECK_INTERVAL_MS = 30_000; // check every 30s
const STARTUP_GRACE_MS = 10_000; // wait before first health check
const MIN_FREE_DISK_BYTES = 512 * 1024 * 1024; // 512MB

class MemoryServerSupervisor {
  private child: ChildProcess | null = null;
  private running = false;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private lastHealthy = 0;
  private shutdownRequested = false;
  private suppressedIndexLines = 0;
  private suppressedEmbedErrors = 0;
  private lastSuppressedLogAt = 0;
  private suppressingDiskIoTrace = false;
  private consecutiveHealthFailures = 0;
  private inBackoffMode = false;

  /** Start the memory server and begin supervision */
  async start(): Promise<void> {
    if (this.running) return;

    // Verify memory server exists
    const entrypoint = resolve(MEMORY_DIR, "server/index.ts");
    if (!existsSync(entrypoint)) {
      console.error(`[memory-supervisor] Entry point not found: ${entrypoint}`);
      return;
    }

    // Verify bun is available
    const bunPath = existsSync(BUN_PATH) ? BUN_PATH : "bun";

    this.running = true;
    this.shutdownRequested = false;
    console.log("[memory-supervisor] Starting memory server supervision");

    // Kill any orphaned bun memory processes first
    await this.killOrphans();

    // Start the process
    this.spawnChild(bunPath);

    // Start health checks after grace period
    setTimeout(() => {
      if (this.running && !this.shutdownRequested) {
        this.startHealthChecks();
      }
    }, STARTUP_GRACE_MS);
  }

  /** Stop the memory server and supervision */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.running = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    if (this.child) {
      console.log("[memory-supervisor] Stopping memory server...");
      this.child.kill("SIGTERM");

      // Give it 3s to exit gracefully, then force
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => {
          if (this.child) {
            console.warn("[memory-supervisor] Force killing memory server");
            this.child.kill("SIGKILL");
          }
          resolve();
        }, 3000);

        if (this.child) {
          this.child.once("exit", () => {
            clearTimeout(forceTimer);
            resolve();
          });
        } else {
          clearTimeout(forceTimer);
          resolve();
        }
      });

      this.child = null;
      console.log("[memory-supervisor] Memory server stopped");
    }
  }

  /** Check if the memory server is healthy */
  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        this.lastHealthy = Date.now();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Get supervisor status */
  getStatus(): {
    running: boolean;
    pid: number | null;
    restartCount: number;
    lastHealthy: number;
    uptime: number | null;
  } {
    return {
      running: this.running && this.child !== null,
      pid: this.child?.pid ?? null,
      restartCount: this.restartCount,
      lastHealthy: this.lastHealthy,
      uptime: this.child?.pid ? Date.now() - (this.lastHealthy || Date.now()) : null,
    };
  }

  /* ── Private ─────────────────────────────────────────────── */

  private spawnChild(bunPath: string): void {
    if (this.shutdownRequested) return;

    const freeBytes = this.getFreeDiskBytes();
    if (freeBytes !== null && freeBytes < MIN_FREE_DISK_BYTES) {
      console.error(
        `[memory-supervisor] Low disk space (${Math.round(freeBytes / 1024 / 1024)}MB free) ` +
        `— skipping memory server start until space is recovered`,
      );
      if (!this.shutdownRequested && this.running) {
        this.scheduleRestart(bunPath);
      }
      return;
    }

    console.log(`[memory-supervisor] Spawning: ${bunPath} run server/index.ts (cwd: ${MEMORY_DIR})`);

    this.child = spawn(bunPath, ["run", "server/index.ts"], {
      cwd: MEMORY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure bun doesn't interfere with Node's port
        PORT: String(MEMORY_PORT),
      },
    });

    // Pipe stdout/stderr with prefix
    this.child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        this.handleChildLine(line, false);
      }
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        this.handleChildLine(line, true);
      }
    });

    this.child.on("exit", (code, signal) => {
      console.warn(`[memory-supervisor] Memory server exited (code=${code}, signal=${signal})`);
      this.child = null;

      if (!this.shutdownRequested && this.running) {
        this.scheduleRestart(bunPath);
      }
    });

    this.child.on("error", (err) => {
      console.error(`[memory-supervisor] Failed to spawn memory server:`, err);
      this.child = null;

      if (!this.shutdownRequested && this.running) {
        this.scheduleRestart(bunPath);
      }
    });
  }

  private handleChildLine(rawLine: string, isError: boolean): void {
    const line = rawLine.trim();
    if (!line) return;

    if (line.includes("SQLiteError: disk I/O error")) {
      this.suppressingDiskIoTrace = true;
      const freeBytes = this.getFreeDiskBytes();
      const freeMb = freeBytes === null ? "unknown" : String(Math.round(freeBytes / 1024 / 1024));
      console.error(`[memory] SQLite disk I/O error during startup (free space: ${freeMb}MB)`);
      return;
    }

    if (this.suppressingDiskIoTrace) {
      if (
        line.startsWith("at ") ||
        /^\d+\s+\|/.test(line) ||
        line === "^" ||
        line.startsWith("byteOffset:")
      ) {
        return;
      }
      this.suppressingDiskIoTrace = false;
    }

    if (line.startsWith("Indexing:") || line.startsWith("→") || line.startsWith("  →")) {
      this.suppressedIndexLines++;
      this.maybeLogSuppressedSummary();
      return;
    }

    if (
      line.startsWith("path:") ||
      line.startsWith("errno:") ||
      line.startsWith("code:") ||
      line.includes("HEALTH check") ||
      line.includes("HEALTHZ check")
    ) {
      return;
    }

    if (
      line.includes("Error indexing") &&
      (line.includes("ConnectionRefused") ||
       line.includes("Unable to connect") ||
       line.includes("Could not connect to LM Studio"))
    ) {
      this.suppressedEmbedErrors++;
      this.maybeLogSuppressedSummary();
      return;
    }

    this.maybeLogSuppressedSummary(true);
    if (isError) console.error(`[memory] ${line}`);
    else console.log(`[memory] ${line}`);
  }

  private maybeLogSuppressedSummary(force = false): void {
    const totalSuppressed = this.suppressedIndexLines + this.suppressedEmbedErrors;
    if (totalSuppressed === 0) return;

    const now = Date.now();
    if (!force && now - this.lastSuppressedLogAt < 15_000) {
      return;
    }

    const parts: string[] = [];
    if (this.suppressedIndexLines > 0) {
      parts.push(`${this.suppressedIndexLines} per-file index line(s)`);
    }
    if (this.suppressedEmbedErrors > 0) {
      parts.push(`${this.suppressedEmbedErrors} LM Studio embed error(s)`);
    }

    this.lastSuppressedLogAt = now;
    console.warn(`[memory] Suppressed noisy logs: ${parts.join(", ")}`);
    this.suppressedIndexLines = 0;
    this.suppressedEmbedErrors = 0;
  }

  private scheduleRestart(bunPath: string): void {
    this.restartCount++;
    const delay = Math.min(
      RESTART_DELAY_BASE_MS * Math.pow(RESTART_BACKOFF_FACTOR, Math.min(this.restartCount - 1, 6)),
      RESTART_DELAY_MAX_MS,
    );

    console.log(`[memory-supervisor] Scheduling restart #${this.restartCount} in ${delay}ms`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.shutdownRequested && this.running) {
        this.spawnChild(bunPath);
      }
    }, delay);
  }

  private getFreeDiskBytes(): number | null {
    try {
      const output = execFileSync("df", ["-k", MEMORY_DIR], { encoding: "utf-8", timeout: 3000 }).trim();
      const lines = output.split("\n");
      const fields = lines[lines.length - 1]?.trim().split(/\s+/) ?? [];
      const availableKb = Number(fields[3]);
      if (!Number.isFinite(availableKb)) return null;
      return availableKb * 1024;
    } catch {
      return null;
    }
  }

  private startHealthChecks(): void {
    this.healthTimer = setInterval(async () => {
      if (!this.running || this.shutdownRequested) return;

      // If we're in extended backoff mode, skip fast-poll restarts
      if (this.inBackoffMode) return;

      const healthy = await this.isHealthy();
      if (!healthy && this.child) {
        this.consecutiveHealthFailures++;

        // After 10 consecutive failures, switch to 5-min backoff mode
        const crossedThreshold = checkMemorySupervisorHealth(this.consecutiveHealthFailures);
        if (crossedThreshold) {
          this.inBackoffMode = true;
          setTimeout(() => {
            this.inBackoffMode = false;
            this.consecutiveHealthFailures = 0;
            console.log("[memory-supervisor] Resuming health checks after extended backoff");
          }, 5 * 60 * 1000);
          return;
        }

        console.warn(
          `[memory-supervisor] Health check failed (${this.consecutiveHealthFailures} consecutive) — restarting memory server`,
        );
        this.child.kill("SIGTERM");
        // The 'exit' handler will trigger scheduleRestart
      } else if (healthy) {
        // Reset counters on successful health check
        this.restartCount = 0;
        this.consecutiveHealthFailures = 0;
        this.inBackoffMode = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /** Kill any orphaned bun processes running the memory server */
  private async killOrphans(): Promise<void> {
    try {
      const { execSync } = await import("node:child_process");
      const output = execSync("ps -axo pid=,ppid=,command=", { encoding: "utf-8", timeout: 3000 }).trim();
      if (!output) return;

      let killedAny = false;
      const rows = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("bun") && line.includes("server/index.ts") && line.includes(MEMORY_DIR));

      for (const row of rows) {
        const match = row.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) continue;
        const pid = parseInt(match[1], 10);
        const ppid = parseInt(match[2], 10);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid === process.pid) continue;
        if (ppid > 1) {
          console.log(`[memory-supervisor] Leaving non-orphan memory server alone (PID ${pid}, PPID ${ppid})`);
          continue;
        }
        try {
          process.kill(pid, "SIGTERM");
          killedAny = true;
          console.log(`[memory-supervisor] Killed orphaned memory server (PID ${pid}, PPID ${ppid})`);
        } catch {
          // Already dead
        }
      }

      if (killedAny) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch {
      // Ignore lookup failures during startup.
    }
  }
}

export const memoryServer = new MemoryServerSupervisor();
