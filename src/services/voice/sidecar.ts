/**
 * Voice sidecar lifecycle — manages STT + TTS process startup, shutdown, and health monitoring.
 *
 * The sidecar services (whisper.cpp for STT, Chatterbox for TTS) run as separate
 * processes. This module handles:
 * - Auto-starting them when lobs-core boots (if configured)
 * - Periodic health checks while voice sessions are active
 * - Logging warnings and attempting restart on failures
 * - Clean shutdown
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { VoiceConfig } from "./types.js";

const HOME = process.env.HOME ?? "";
const VOICE_DIR = resolve(HOME, "lobs/lobs-voice");

/** Health check result for a single service */
interface ServiceHealth {
  name: string;
  healthy: boolean;
  url: string;
  error?: string;
}

/** Check if a sidecar service is healthy */
async function checkHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const data = (await response.json()) as { status: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

/**
 * VoiceSidecar — manages the STT and TTS sidecar processes.
 */
export class VoiceSidecar {
  private config: VoiceConfig;
  private sttProcess: ChildProcess | null = null;
  private ttsProcess: ChildProcess | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private sttRestartAttempts = 0;
  private ttsRestartAttempts = 0;
  private static readonly MAX_RESTART_ATTEMPTS = 3;
  private onHealthChange: ((stt: boolean, tts: boolean) => void) | null = null;

  constructor(config: VoiceConfig) {
    this.config = config;
  }

  /** Register a callback for when health status changes */
  setHealthChangeHandler(handler: (stt: boolean, tts: boolean) => void): void {
    this.onHealthChange = handler;
  }

  /**
   * Start sidecar services if they're not already running.
   * Returns an object with the status of each service.
   */
  async start(): Promise<{ stt: ServiceHealth; tts: ServiceHealth }> {
    const results = {
      stt: { name: "STT", healthy: false, url: this.config.stt.url } as ServiceHealth,
      tts: { name: "TTS", healthy: false, url: this.config.tts.url } as ServiceHealth,
    };

    // Check if already running
    const [sttOk, ttsOk] = await Promise.all([
      checkHealth(this.config.stt.url),
      checkHealth(this.config.tts.url),
    ]);

    if (sttOk) {
      results.stt.healthy = true;
      console.log("[voice:sidecar] STT already running");
    } else {
      results.stt = await this.startSTT();
    }

    if (ttsOk) {
      results.tts.healthy = true;
      console.log("[voice:sidecar] TTS already running");
    } else {
      results.tts = await this.startTTS();
    }

    return results;
  }

  /** Start the STT (whisper.cpp) service */
  private async startSTT(): Promise<ServiceHealth> {
    const result: ServiceHealth = { name: "STT", healthy: false, url: this.config.stt.url };
    const script = resolve(VOICE_DIR, "stt/start-stt.sh");

    if (!existsSync(script)) {
      result.error = `STT start script not found: ${script}`;
      console.error(`[voice:sidecar] ${result.error}`);
      return result;
    }

    console.log("[voice:sidecar] Starting STT service...");
    try {
      this.sttProcess = spawn("bash", [script], {
        cwd: resolve(VOICE_DIR, "stt"),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // Run independently so lobs-core restart doesn't kill it
      });

      // Log output
      this.sttProcess.stdout?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.log(`[voice:stt] ${line}`);
      });
      this.sttProcess.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.error(`[voice:stt:err] ${line}`);
      });
      this.sttProcess.on("exit", (code) => {
        console.log(`[voice:sidecar] STT process exited with code ${code}`);
        this.sttProcess = null;
      });

      // Wait for it to become healthy (up to 30s)
      result.healthy = await this.waitForHealth(this.config.stt.url, 30_000);
      if (result.healthy) {
        console.log("[voice:sidecar] STT ready");
        this.sttRestartAttempts = 0;
      } else {
        result.error = "STT started but failed health check within 30s";
        console.error(`[voice:sidecar] ${result.error}`);
      }
    } catch (err) {
      result.error = `Failed to start STT: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[voice:sidecar] ${result.error}`);
    }

    return result;
  }

  /** Start the TTS (Chatterbox) service */
  private async startTTS(): Promise<ServiceHealth> {
    const result: ServiceHealth = { name: "TTS", healthy: false, url: this.config.tts.url };
    const script = resolve(VOICE_DIR, "tts/start-tts.sh");

    if (!existsSync(script)) {
      result.error = `TTS start script not found: ${script}`;
      console.error(`[voice:sidecar] ${result.error}`);
      return result;
    }

    console.log("[voice:sidecar] Starting TTS service...");
    try {
      this.ttsProcess = spawn("bash", [script], {
        cwd: resolve(VOICE_DIR, "tts"),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      this.ttsProcess.stdout?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.log(`[voice:tts] ${line}`);
      });
      this.ttsProcess.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.error(`[voice:tts:err] ${line}`);
      });
      this.ttsProcess.on("exit", (code) => {
        console.log(`[voice:sidecar] TTS process exited with code ${code}`);
        this.ttsProcess = null;
      });

      // TTS can take longer (model download on first run) — 120s timeout
      result.healthy = await this.waitForHealth(this.config.tts.url, 120_000);
      if (result.healthy) {
        console.log("[voice:sidecar] TTS ready");
        this.ttsRestartAttempts = 0;
      } else {
        result.error = "TTS started but failed health check within 120s";
        console.error(`[voice:sidecar] ${result.error}`);
      }
    } catch (err) {
      result.error = `Failed to start TTS: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[voice:sidecar] ${result.error}`);
    }

    return result;
  }

  /** Poll health endpoint until it responds or timeout */
  private async waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await checkHealth(url)) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /**
   * Start periodic health monitoring.
   * Runs every `healthCheckIntervalMs` while active.
   * Attempts to restart services that go down (up to MAX_RESTART_ATTEMPTS).
   */
  startHealthMonitor(): void {
    if (this.healthInterval) return; // Already running

    const intervalMs = this.config.healthCheckIntervalMs;
    console.log(`[voice:sidecar] Health monitor started (every ${intervalMs / 1000}s)`);

    this.healthInterval = setInterval(async () => {
      const [sttOk, ttsOk] = await Promise.all([
        checkHealth(this.config.stt.url),
        checkHealth(this.config.tts.url),
      ]);

      // Notify listener
      this.onHealthChange?.(sttOk, ttsOk);

      // Handle STT failure
      if (!sttOk) {
        this.sttRestartAttempts++;
        if (this.sttRestartAttempts <= VoiceSidecar.MAX_RESTART_ATTEMPTS) {
          console.warn(
            `[voice:sidecar] STT unhealthy — attempting restart (${this.sttRestartAttempts}/${VoiceSidecar.MAX_RESTART_ATTEMPTS})`,
          );
          await this.startSTT();
        } else if (this.sttRestartAttempts === VoiceSidecar.MAX_RESTART_ATTEMPTS + 1) {
          console.error("[voice:sidecar] STT restart attempts exhausted — manual intervention needed");
        }
        // After exhausted, stay quiet (don't spam logs)
      } else {
        if (this.sttRestartAttempts > 0) {
          console.log("[voice:sidecar] STT recovered");
          this.sttRestartAttempts = 0;
        }
      }

      // Handle TTS failure
      if (!ttsOk) {
        this.ttsRestartAttempts++;
        if (this.ttsRestartAttempts <= VoiceSidecar.MAX_RESTART_ATTEMPTS) {
          console.warn(
            `[voice:sidecar] TTS unhealthy — attempting restart (${this.ttsRestartAttempts}/${VoiceSidecar.MAX_RESTART_ATTEMPTS})`,
          );
          await this.startTTS();
        } else if (this.ttsRestartAttempts === VoiceSidecar.MAX_RESTART_ATTEMPTS + 1) {
          console.error("[voice:sidecar] TTS restart attempts exhausted — manual intervention needed");
        }
      } else {
        if (this.ttsRestartAttempts > 0) {
          console.log("[voice:sidecar] TTS recovered");
          this.ttsRestartAttempts = 0;
        }
      }
    }, intervalMs);
  }

  /** Stop the health monitor */
  stopHealthMonitor(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
      console.log("[voice:sidecar] Health monitor stopped");
    }
  }

  /** Check health of both services (one-shot) */
  async checkHealth(): Promise<{ stt: boolean; tts: boolean }> {
    const [stt, tts] = await Promise.all([
      checkHealth(this.config.stt.url),
      checkHealth(this.config.tts.url),
    ]);
    return { stt, tts };
  }

  /**
   * Shut down sidecar processes that we started.
   * Only kills processes we spawned — leaves externally-started services alone.
   */
  shutdown(): void {
    this.stopHealthMonitor();

    if (this.sttProcess && !this.sttProcess.killed) {
      console.log("[voice:sidecar] Stopping STT...");
      // Kill the process group (detached processes)
      try {
        if (this.sttProcess.pid) process.kill(-this.sttProcess.pid, "SIGTERM");
      } catch {
        this.sttProcess.kill("SIGTERM");
      }
      this.sttProcess = null;
    }

    if (this.ttsProcess && !this.ttsProcess.killed) {
      console.log("[voice:sidecar] Stopping TTS...");
      try {
        if (this.ttsProcess.pid) process.kill(-this.ttsProcess.pid, "SIGTERM");
      } catch {
        this.ttsProcess.kill("SIGTERM");
      }
      this.ttsProcess = null;
    }
  }
}
