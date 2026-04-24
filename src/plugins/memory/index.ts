/**
 * lobs-memory plugin entry point.
 * Registers per-agent memory index services with lobs-core.
 */

export { default as memoryPlugin } from "./plugin.js";
export type { MemoryPluginConfig } from "./config.js";
export type { MemoryIndex, SearchResult, HealthStatus, IndexStatus } from "./memory-index.js";