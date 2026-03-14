/**
 * Plugin-scoped logger wrapper.
 */

import type { PluginLogger } from "../types/lobs-plugin.js";

let _logger: PluginLogger | null = null;

export function setLogger(logger: PluginLogger): void {
  _logger = logger;
}

export function log(): PluginLogger {
  if (!_logger) {
    // Fallback to console if not yet initialized
    return {
      info: (msg) => console.log(`[paw] ${msg}`),
      warn: (msg) => console.warn(`[paw] ${msg}`),
      error: (msg) => console.error(`[paw] ${msg}`),
      debug: (msg) => console.debug(`[paw] ${msg}`),
    };
  }
  return _logger;
}
