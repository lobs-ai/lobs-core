/**
 * Circuit Breaker integration hooks.
 *
 * Hook 1: llm_input — record (sessionKey → model + startTime) in memory
 * Hook 2: llm_output — record success, detect empty output
 * Hook 3: agent_end (extended) — called from subagent_ended with duration/reason
 *
 * These hooks feed the circuit breaker with signal without touching the
 * compiled OpenClaw core. The model-chooser integration lives in
 * model-chooser.ts (chooseHealthyModel).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { onSuccess, onFailure, classifyOutcome } from "../services/circuit-breaker.js";
import { log } from "../util/logger.js";

// In-memory map: sessionKey → { model, taskType, startedAt, lastOutputLength }
const sessionMeta = new Map<string, {
  model: string;
  taskType: string;
  startedAt: number;
  lastOutputLength: number;
}>();

// Sessions explicitly excluded from circuit breaker tracking.
// Used for sessions whose empty/short response is expected by design
// (e.g. YouTube analysis agents that write output to files via the Write tool).
const excludedSessions = new Set<string>();

/**
 * Exclude a session from circuit breaker tracking.
 * Call immediately after spawning a session whose short response is expected
 * (e.g. YouTube analysis agents that write output to files).
 */
export function excludeSessionFromCircuitBreaker(sessionKey: string): void {
  excludedSessions.add(sessionKey);
  // Also remove from sessionMeta in case llm_input already registered it
  sessionMeta.delete(sessionKey);
}

/**
 * Register the session's model + task type so circuit breaker can track it.
 * Called externally by the orchestrator when spawning a worker.
 */
export function registerSessionForCircuitBreaker(
  sessionKey: string,
  model: string,
  taskType: string,
): void {
  sessionMeta.set(sessionKey, { model, taskType, startedAt: Date.now(), lastOutputLength: 0 });
}

export function unregisterSessionFromCircuitBreaker(sessionKey: string): void {
  sessionMeta.delete(sessionKey);
}

export function registerCircuitBreakerHooks(api: OpenClawPluginApi): void {

  // ── llm_input — track session start time ──────────────────────────────────
  api.on("llm_input", async (event: any, ctx: any) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey) return;
    if (excludedSessions.has(sessionKey)) return;
    const model = `${event.provider}/${event.model}`;
    if (!sessionMeta.has(sessionKey)) {
      // Auto-register with __global__ task type for non-PAW sessions
      sessionMeta.set(sessionKey, {
        model,
        taskType: "__global__",
        startedAt: Date.now(),
        lastOutputLength: 0,
      });
    } else {
      // Update model in case it changed (e.g. model override resolved late)
      const meta = sessionMeta.get(sessionKey)!;
      meta.model = model;
    }
  });

  // ── llm_output — track last output length + record success ───────────────
  api.on("llm_output", async (event: any, ctx: any) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey) return;
    if (excludedSessions.has(sessionKey)) return;
    const meta = sessionMeta.get(sessionKey);
    if (!meta) return;

    const model = `${event.provider}/${event.model}`;
    meta.model = model;

    const totalOutput = event.assistantTexts.join("").length;
    meta.lastOutputLength = totalOutput;

    // A non-empty llm_output is a success signal for the circuit breaker
    if (totalOutput > 10) {
      onSuccess(model, meta.taskType);
    }
  });

  // ── agent_end — record final success/failure ──────────────────────────────
  api.on("agent_end", async (event: any, ctx: any) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey) return;
    if (excludedSessions.has(sessionKey)) {
      excludedSessions.delete(sessionKey);
      sessionMeta.delete(sessionKey);
      return;
    }
    const meta = sessionMeta.get(sessionKey);
    if (!meta) return;

    const durationMs = event.durationMs ?? (Date.now() - meta.startedAt);
    const failureReason = classifyOutcome({
      succeeded: event.success,
      reason: event.error,
      durationMs,
      outputLength: meta.lastOutputLength,
    });

    if (failureReason) {
      log().warn(
        `[CB] agent_end failure: model=${meta.model} task=${meta.taskType} ` +
        `reason=${failureReason} durationMs=${durationMs}`,
      );
      onFailure(meta.model, meta.taskType, failureReason);
    } else {
      onSuccess(meta.model, meta.taskType);
    }

    sessionMeta.delete(sessionKey);
  });
}
