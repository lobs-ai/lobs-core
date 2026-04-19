/**
 * Plugin-scoped logger wrapper.
 */

import type { PluginLogger } from "../types/lobs-plugin.js";

let _logger: PluginLogger | null = null;

export function setLogger(logger: PluginLogger): void {
  _logger = logger;
}

export interface RequiredLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

function fallbackLogger(): RequiredLogger {
  return {
    info: (msg) => console.log(`[paw] ${msg}`),
    warn: (msg) => console.warn(`[paw] ${msg}`),
    error: (msg) => console.error(`[paw] ${msg}`),
    debug: (msg) => console.debug(`[paw] ${msg}`),
  };
}

export function log(): RequiredLogger {
  if (_logger) {
    // Cast to RequiredLogger — caller should only use methods present in PluginLogger
    return _logger as unknown as RequiredLogger;
  }
  return fallbackLogger();
}
