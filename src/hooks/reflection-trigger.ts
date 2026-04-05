/**
 * Reflection trigger hook — fires runReflection() at the end of each agent session
 * and whenever the context window is compacted.
 *
 * Registered on `after_agent_end` and `session_compacted` with low priority
 * (runs after the event recorder). Fire-and-forget via setImmediate — never blocks the agent.
 */

import { getHookRegistry, type HookEvent, type HookHandler } from "../runner/hooks.js";
import { runReflection } from "../memory/reflection.js";
import { log } from "../util/logger.js";

/** Minimum event count that makes reflection worthwhile.
 *  Mirrors MIN_EVENTS_TO_REFLECT in reflection.ts — used here for a fast-path
 *  skip before we even spin up setImmediate.
 */
const MIN_EVENTS_FAST_PATH = 5;

export function registerReflectionTriggerHook(): void {
  const registry = getHookRegistry();

  const afterAgentEnd: HookHandler = async (event: HookEvent) => {
    const sessionId = event.taskId ?? undefined;

    // Fast-path skip: if the runner already knows the event count and it's too
    // low, skip without even entering setImmediate (avoids the async overhead).
    const eventCount =
      typeof event.data.eventCount === "number" ? event.data.eventCount : null;
    if (eventCount !== null && eventCount < MIN_EVENTS_FAST_PATH) {
      log().debug?.(
        `[reflection-trigger] Skipping session ${sessionId ?? "?"} — ` +
          `only ${eventCount} events (fast-path)`,
      );
      return event;
    }

    log().debug?.(
      `[reflection-trigger] Scheduling reflection for session ${sessionId ?? "?"}`,
    );

    // Fire-and-forget — setImmediate so we never block the agent runner
    setImmediate(() => {
      void (async () => {
        try {
          const result = await runReflection({
            trigger: "session_end",
            sessionId,
          });

          if (result.skipped) {
            log().debug?.(
              `[reflection-trigger] Session ${sessionId ?? "?"} skipped: ${result.skipReason}`,
            );
          } else {
            log().info(
              `[reflection-trigger] Session ${sessionId ?? "?"} — ` +
                `${result.eventsProcessed} events, ` +
                `${result.memoriesCreated} new memories, ` +
                `${result.memoriesReinforced} reinforced, ` +
                `${result.conflictsDetected} conflicts, ` +
                `${result.tokensUsed} tokens`,
            );
          }
        } catch (err) {
          // Never let reflection errors escape — they must not crash the runner
          log().error(`[reflection-trigger] Failed: ${String(err)}`);
        }
      })();
    });

    return event;
  };

  // Priority -20 ensures we run after the event recorder (priority -10)
  registry.register("after_agent_end", afterAgentEnd, -20);

  const sessionCompacted: HookHandler = async (event: HookEvent) => {
    const sessionId = event.taskId ?? undefined;

    // Fast-path skip: compaction with very few events isn't worth reflecting on.
    // event.data contains { beforeCount, afterCount, inputTokens } from the agent loop.
    const beforeCount =
      typeof event.data.beforeCount === "number" ? event.data.beforeCount : null;
    if (beforeCount !== null && beforeCount < MIN_EVENTS_FAST_PATH) {
      log().debug?.(
        `[reflection-trigger] Skipping compaction for session ${sessionId ?? "?"} — ` +
          `only ${beforeCount} messages before compaction (fast-path)`,
      );
      return event;
    }

    log().debug?.(
      `[reflection-trigger] Scheduling compaction reflection for session ${sessionId ?? "?"}`,
    );

    // Fire-and-forget — setImmediate so we never block the agent runner
    setImmediate(() => {
      void (async () => {
        try {
          const result = await runReflection({
            trigger: "compaction",
            sessionId,
          });

          if (result.skipped) {
            log().debug?.(
              `[reflection-trigger] Compaction ${sessionId ?? "?"} skipped: ${result.skipReason}`,
            );
          } else {
            log().info(
              `[reflection-trigger] Compaction ${sessionId ?? "?"} — ` +
                `${result.eventsProcessed} events, ` +
                `${result.memoriesCreated} new memories, ` +
                `${result.memoriesReinforced} reinforced, ` +
                `${result.conflictsDetected} conflicts, ` +
                `${result.tokensUsed} tokens`,
            );
          }
        } catch (err) {
          // Never let reflection errors escape — they must not crash the runner
          log().error(`[reflection-trigger] Compaction reflection failed: ${String(err)}`);
        }
      })();
    });

    return event;
  };

  // Priority -20 ensures we run after the event recorder (priority -10)
  registry.register("session_compacted", sessionCompacted, -20);
}
