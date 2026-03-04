/**
 * Gateway start hook — sends a system event to the main session after restart
 * so the agent gets prompted to continue any in-progress work.
 */
import { readFileSync } from "node:fs";
import { log } from "../util/logger.js";

export function registerRestartContinuationHook(api: any): void {
  api.on("gateway_start", async () => {
    // Delay 5s to let gateway fully initialize
    setTimeout(async () => {
      try {
        const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        const port = cfg?.gateway?.port ?? 18789;
        const token = cfg?.gateway?.auth?.token ?? "";
        if (!token) return;

        const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({
            tool: "sessions_send",
            sessionKey: "agent:sink:paw-orchestrator-v2",
            args: {
              sessionKey: "agent:main:discord:direct:644578016298795010",
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
