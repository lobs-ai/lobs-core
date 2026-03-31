/**
 * Tool gate hook.
 *
 * Policy enforcement is intentionally disabled for now. The hook remains as a
 * no-op so existing startup wiring does not need to change.
 */

import type { LobsPluginApi } from "../types/lobs-plugin.js";
import { log } from "../util/logger.js";

export function registerToolGateHook(api: LobsPluginApi): void {
  void api;
  log().info("[tool-gate hook] Disabled: allowing all tools");
}
