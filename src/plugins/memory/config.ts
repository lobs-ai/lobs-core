/**
 * Per-agent configuration for the lobs-memory plugin.
 * Each agent instance has its own config pointing at its own data dirs.
 */

export interface MemoryPluginConfig {
  /** Absolute or relative paths to watch and index (default: ["memory/", "workspace/"]) */
  watchPaths?: string[];

  /** LM Studio URL for embeddings (default: http://localhost:7420) */
  embedderUrl?: string;

  /** Embedding model name in LM Studio (default: text-embedding-qwen3-embedding-4b) */
  embedderModel?: string;

  /** Local directory for SQLite index (default: ./memory-index/) */
  indexPath?: string;

  /** Local directory for backup rotation (default: ./backups/) */
  backupDir?: string;

  /** Backup rotation interval in ms (default: 5 min = 300_000 ms) */
  backupIntervalMs?: number;

  /** Periodic full-scan interval in ms (default: 1 hour = 3_600_000 ms) */
  scanIntervalMs?: number;

  /** Plugin version — Option A (pinned) per SPEC. Marcus controls update cadence. */
  version?: string;
}