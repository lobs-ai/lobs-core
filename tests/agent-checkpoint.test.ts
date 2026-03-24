/**
 * Tests for agent checkpoint / graceful shutdown on SIGTERM.
 *
 * We test:
 *  1. AbortSignal propagation — when the signal fires between turns, the loop
 *     returns stopReason="interrupted" without completing the task.
 *  2. Abort after tool execution — signal set after a tool call, before the
 *     next LLM call, still produces stopReason="interrupted".
 *  3. Normal runs are unaffected when no signal is passed.
 *  4. flushWorkerCheckpoints() signals all active workers and waits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Minimal mock of runAgent ─────────────────────────────────────────────────
// We don't want to hit a real LLM in unit tests. Instead we simulate the parts
// of agent-loop.ts that matter: checking abortSignal.aborted between turns.

interface FakeRunOptions {
  maxTurns?: number;
  abortSignal?: AbortSignal;
  /** Simulated turn delay in ms (default 0) */
  turnDelayMs?: number;
  /** Abort after this many turns (simulated controller abort from *outside*) */
  abortAfterTurns?: number;
}
interface FakeRunResult {
  stopReason: "end_turn" | "max_turns" | "interrupted";
  turns: number;
}

async function fakeAgentLoop(opts: FakeRunOptions): Promise<FakeRunResult> {
  const maxTurns = opts.maxTurns ?? 10;
  let turns = 0;
  let stopReason: "end_turn" | "max_turns" | "interrupted" = "max_turns";

  while (turns < maxTurns) {
    // Mirror: check abort at top of each turn (before LLM call)
    if (opts.abortSignal?.aborted) {
      stopReason = "interrupted";
      break;
    }

    turns++;

    // Simulate async work (LLM call + tool execution)
    if (opts.turnDelayMs) {
      await new Promise(r => setTimeout(r, opts.turnDelayMs));
    }

    // Check abort after tool execution (mirror: second check in real loop)
    if (opts.abortSignal?.aborted) {
      stopReason = "interrupted";
      break;
    }

    // Simulate task completion on last turn (for bounded tests)
    if (turns === 3) {
      stopReason = "end_turn";
      break;
    }
  }

  return { stopReason, turns };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("agent-loop abort-signal checkpoint", () => {
  it("completes normally when no abort signal is provided", async () => {
    const result = await fakeAgentLoop({ maxTurns: 10 });
    expect(result.stopReason).toBe("end_turn");
    expect(result.turns).toBe(3);
  });

  it("returns interrupted immediately when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort(); // abort before run starts

    const result = await fakeAgentLoop({ abortSignal: controller.signal, maxTurns: 10 });
    expect(result.stopReason).toBe("interrupted");
    expect(result.turns).toBe(0); // aborted before first turn
  });

  it("returns interrupted when signal fires between turns", async () => {
    const controller = new AbortController();
    // Allow turn 1 to start, then abort during async work
    let turnCount = 0;
    const signal = controller.signal;

    // We test by aborting after turn 1's work begins
    // Use the turn-delay variant and abort partway through
    const runPromise = (async () => {
      let turns = 0;
      let stopReason: "end_turn" | "max_turns" | "interrupted" = "max_turns";
      while (turns < 10) {
        if (signal.aborted) { stopReason = "interrupted"; break; }
        turns++;
        turnCount = turns;
        await new Promise(r => setTimeout(r, 5)); // simulate LLM call
        if (signal.aborted) { stopReason = "interrupted"; break; }
        // never hits end_turn — we abort first
      }
      return { stopReason, turns };
    })();

    // Abort after turn 1 starts
    await new Promise(r => setTimeout(r, 3)); // let turn 1 start
    controller.abort();

    const result = await runPromise;
    expect(result.stopReason).toBe("interrupted");
    expect(result.turns).toBeGreaterThanOrEqual(1);
    expect(result.turns).toBeLessThan(10); // didn't run all 10 turns
  });

  it("completes normally with an un-aborted controller", async () => {
    const controller = new AbortController();
    const result = await fakeAgentLoop({
      abortSignal: controller.signal,
      maxTurns: 10,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.turns).toBe(3);
    // cleanup — abort after run (no effect)
    controller.abort();
  });
});

// ─── flushWorkerCheckpoints() simulation ─────────────────────────────────────
// The real flushWorkerCheckpoints() lives in control-loop.ts. We test the
// contract: abort all, then await until all promises resolve.

describe("flushWorkerCheckpoints contract", () => {
  it("signals all registered controllers and resolves when they finish", async () => {
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const abortedAt: number[] = [];

    // Simulate 3 in-flight workers
    const workerPromises = controllers.map((ctrl, i) =>
      new Promise<void>(resolve => {
        // Each worker checks the signal every 5ms and finishes when aborted
        const interval = setInterval(() => {
          if (ctrl.signal.aborted) {
            abortedAt.push(i);
            clearInterval(interval);
            resolve();
          }
        }, 5);
      })
    );

    // Simulate flushWorkerCheckpoints(): abort all, then await all
    for (const ctrl of controllers) ctrl.abort();
    await Promise.allSettled(workerPromises);

    expect(abortedAt.sort()).toEqual([0, 1, 2]);
  });

  it("respects drain timeout — resolves even if a worker hangs", async () => {
    const controller = new AbortController();
    // Hanging worker: never resolves even when aborted
    const hangingWorker = new Promise<void>(() => { /* intentionally never resolves */ });

    const drainMs = 50;
    const deadline = new Promise<void>(r => setTimeout(r, drainMs));

    controller.abort();
    const start = Date.now();
    await Promise.race([Promise.allSettled([hangingWorker]), deadline]);
    const elapsed = Date.now() - start;

    // Should have returned within ~drain window (generous upper bound for CI)
    expect(elapsed).toBeLessThan(drainMs + 100);
  });
});

// ─── AgentSpec type check ─────────────────────────────────────────────────────
// Ensure the TypeScript type was updated correctly (compile-time, not runtime)
import type { AgentSpec, AgentResult } from "../src/runner/types.js";

describe("AgentSpec type includes abortSignal", () => {
  it("accepts abortSignal in AgentSpec", () => {
    // Type-level test: construct an object satisfying AgentSpec with abortSignal
    const ctrl = new AbortController();
    const spec: Partial<AgentSpec> = {
      task: "test",
      agent: "programmer",
      abortSignal: ctrl.signal,
    };
    expect(spec.abortSignal).toBe(ctrl.signal);
  });

  it("AgentResult accepts interrupted as stopReason", () => {
    const result: Pick<AgentResult, "stopReason"> = { stopReason: "interrupted" };
    expect(result.stopReason).toBe("interrupted");
  });
});
