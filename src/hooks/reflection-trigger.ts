/**
 * Reflection trigger hook — fires runReflection() at the end of each agent session.
 *
 * Registered on `after_agent_end` with low priority (runs after the event recorder).
 * Fire-and-forget via setImmediate — never blocks the agent.
 */

import { getHookRegistry, type HookEvent, type HookHandler } from "../runner/hooks.js";
import { runReflection } from "../memory/reflection.js";
import { log } from "../util/logger.js";

export function registerReflectionTriggerHook(): void {
  const registry = getHookRegistry();

  const afterAgentEnd: HookHandler = async (event: HookEvent) => {
    // Fire-and-forget — don't block the agent
    setImmediate(() => {
      void (async () => {
        try {
          const result = await runReflection({
            trigger: "session_end",
            sessionId: event.taskId ?? undefined,
          });

          if (result.skipped) {
            log().debug?.(`[reflection-trigger] Skipped: ${result.skipReason}`);
          } else {
            log().info(
              `[reflection-trigger] Session ${event.taskId ?? "?"} — ` +
                `${result.memoriesCreated} new memories, ` +
                `${result.memoriesReinforced} reinforced, ` +
                `${result.conflictsDetected} conflicts`,
            );
          }
        } catch (err) {
          log().error(`[reflection-trigger] Failed: ${String(err)}`);
        }
      })();
    });

    return event;
  };

  // Priority -20 ensures we run after the event recorder (priority -10)
  registry.register("after_agent_end", afterAgentEnd, -20);
}
