/**
 * Cross-encoder reranker via BGE Reranker v2 M3 ONNX sidecar.
 * 
 * The sidecar runs at localhost:7421 and takes (query, documents[]) pairs,
 * returning real relevance scores from a proper cross-encoder model.
 * 
 * Auto-starts the sidecar if configured and falls back gracefully if unavailable.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { MemoryConfig } from "./types.js";

const RERANKER_URL = "http://localhost:7421";
const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 500;

interface RerankerState {
  configured: boolean;
  healthy: boolean;
  lastCheck: number;
  process: ChildProcess | null;
  startAttempts: number;
}

const state: RerankerState = {
  configured: false,
  healthy: false,
  lastCheck: 0,
  process: null,
  startAttempts: 0,
};

export async function initReranker(config: MemoryConfig): Promise<void> {
  const mode = config.reranker?.mode ?? "none";
  state.configured = mode === "sidecar";

  if (!state.configured) {
    console.log("[memory] Reranker: disabled (mode=none)");
    return;
  }

  console.log("[memory] Reranker: sidecar mode — will auto-start");
  await startOrConnect();
}

async function startOrConnect(): Promise<void> {
  if (await checkHealth()) {
    console.log("[memory] Reranker: connected to existing sidecar");
    return;
  }
  await startSidecar();
}

async function startSidecar(): Promise<void> {
  state.startAttempts++;
  if (state.startAttempts > 3) {
    console.error("[memory] Reranker: too many start attempts, giving up");
    state.configured = false;
    return;
  }

  // The reranker script lives in lobs-memory/scripts/
  const scriptPath = join(process.env.HOME || "~", "lobs", "lobs-memory", "scripts", "reranker-server.py");
  console.log(`[memory] Reranker: starting sidecar (attempt ${state.startAttempts})...`);

  try {
    state.process = spawn("python3", [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    state.process.stdout?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.log(`[reranker] ${text}`);
    });

    state.process.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.error(`[reranker/err] ${text}`);
    });

    state.process.on("exit", (code) => {
      console.log(`[memory] Reranker: sidecar exited with code ${code}`);
      state.process = null;
      state.healthy = false;
    });

    // Wait for it to become healthy
    const start = Date.now();
    while (Date.now() - start < STARTUP_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
      if (await checkHealth()) {
        console.log(`[memory] Reranker: sidecar ready (${Date.now() - start}ms startup)`);
        state.startAttempts = 0;
        return;
      }
    }

    console.error("[memory] Reranker: sidecar startup timeout");
    killSidecar();
  } catch (err) {
    console.error("[memory] Reranker: failed to start sidecar:", err);
  }
}

function killSidecar(): void {
  if (state.process) {
    try {
      state.process.kill();
    } catch {
      // Already dead
    }
    state.process = null;
  }
}

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${RERANKER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const ok = res.ok;
    state.healthy = ok;
    state.lastCheck = Date.now();
    return ok;
  } catch {
    state.healthy = false;
    state.lastCheck = Date.now();
    return false;
  }
}

export function isRerankerAvailable(): boolean {
  return state.configured && state.healthy;
}

export interface RerankerResult {
  scores: number[];
  elapsed_ms: number;
}

export async function rerankDocuments(
  query: string,
  documents: string[]
): Promise<RerankerResult | null> {
  if (!state.configured || documents.length === 0) return null;

  if (Date.now() - state.lastCheck > 30_000) {
    await checkHealth();
  }

  if (!state.healthy) {
    if (state.process === null && state.startAttempts < 3) {
      console.log("[memory] Reranker: attempting restart...");
      await startSidecar();
    }
    if (!state.healthy) return null;
  }

  try {
    const res = await fetch(`${RERANKER_URL}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, documents }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`[memory] Reranker: HTTP ${res.status}`);
      return null;
    }

    return await res.json() as RerankerResult;
  } catch (err) {
    console.error("[memory] Reranker: request failed:", err);
    state.healthy = false;
    return null;
  }
}

export function shutdownReranker(): void {
  killSidecar();
  console.log("[memory] Reranker: shutdown");
}
