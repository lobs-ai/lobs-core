/**
 * lobs-memory plugin — per-agent semantic search index.
 *
 * Connects to local LM Studio for embeddings and maintains a per-agent
 * SQLite WAL-mode index with file watching, periodic fallback scan,
 * and 5-minute backup rotation.
 */

import type { LobsPluginApi } from "../../types/lobs-plugin.js";
import { createAgentMemory, type MemoryIndex } from "./memory-index.js";
import type { MemoryPluginConfig } from "./config.js";
import { log } from "../../util/logger.js";

const PLUGIN_ID = "lobs-memory";
const PLUGIN_VERSION = "0.1.0";

interface PluginState {
  index: MemoryIndex | null;
  backupTimer: ReturnType<typeof setInterval> | null;
  scanTimer: ReturnType<typeof setInterval> | null;
  started: boolean;
}

const state: PluginState = {
  index: null,
  backupTimer: null,
  scanTimer: null,
  started: false,
};

const memoryPlugin = {
  id: PLUGIN_ID,
  name: "lobs-memory",
  description: "Per-agent semantic search index with SQLite + LM Studio embeddings",
  version: PLUGIN_VERSION,

  async register(api: LobsPluginApi): Promise<void> {
    const cfg = (api.pluginConfig ?? {}) as Partial<MemoryPluginConfig>;
    const resolvedIndexDir = api.resolvePath(cfg.indexPath ?? "./memory-index");
    const resolvedBackupDir = api.resolvePath(cfg.backupDir ?? "./backups");

    log().info(`[${PLUGIN_ID}] registering — index dir: ${resolvedIndexDir}`);

    // ── Initialise the per-agent memory index ──────────────────────────
    try {
      state.index = await createAgentMemory({
        indexPath: resolvedIndexDir,
        backupDir: resolvedBackupDir,
        watchPaths: cfg.watchPaths ?? ["memory/", "workspace/"],
        embedder: {
          url: cfg.embedderUrl ?? "http://localhost:7420",
          model: cfg.embedderModel ?? "text-embedding-qwen3-embedding-4b",
        },
        backupIntervalMs: cfg.backupIntervalMs ?? 5 * 60 * 1000, // 5 min default
        scanIntervalMs: cfg.scanIntervalMs ?? 60 * 60 * 1000,   // 1 hour default
      });

      log().info(`[${PLUGIN_ID}] memory index initialised`);
    } catch (err) {
      log().error(`[${PLUGIN_ID}] failed to initialise memory index: ${err}`);
      // Plugin loads but index is unavailable — health will report degraded
    }

    // ── Register agent tools ───────────────────────────────────────────
    api.registerTool?.({
      name: "memory_search",
      description:
        "Search the agent's private memory index using semantic similarity. " +
        "Returns results with file paths, line ranges, and score.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 5)", default: 5 },
        },
        required: ["query"],
      },
      execute: async (toolCallId: string, params: unknown) => {
        const { query, limit = 5 } = params as { query: string; limit?: number };
        if (!state.index) {
          return { error: "memory index not available" };
        }
        return state.index.search(query, limit);
      },
    });

    api.registerTool?.({
      name: "memory_index",
      description:
        "Trigger re-indexing of specific files or all watched directories. " +
        "Call without paths to re-index everything.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Specific file paths to re-index (optional)",
          },
        },
      },
      execute: async (toolCallId: string, params: unknown) => {
        const { paths } = (params as { paths?: string[] }) ?? {};
        if (!state.index) {
          return { error: "memory index not available" };
        }
        const count = await state.index.indexPaths(paths);
        return { indexed: count };
      },
    });

    api.registerTool?.({
      name: "memory_health",
      description: "Check memory index health — queries DB and embedder to verify operational status.",
      parameters: { type: "object", properties: {} },
      execute: async (toolCallId: string, _params: unknown) => {
        if (!state.index) {
          return { status: "down", dbOk: false, embedderOk: false, lastIndex: null };
        }
        return state.index.health();
      },
    });

    // ── Register health HTTP endpoint ──────────────────────────────────
    api.registerHttpRoute({
      path: "/memory/health",
      match: "exact",
      auth: "gateway",
      handler: async (_req, _res) => {
        if (!state.index) {
          const msg = JSON.stringify({ status: "down", dbOk: false, embedderOk: false, lastIndex: null });
          _res.statusCode = 503;
          _res.end(msg);
          return true;
        }
        const status = await state.index.health();
        if (_res.writable) {
          _res.end(JSON.stringify(status));
        }
        return true;
      },
    });

    // ── Register status HTTP endpoint ─────────────────────────────────
    api.registerHttpRoute({
      path: "/memory/status",
      match: "exact",
      auth: "gateway",
      handler: async (_req, _res) => {
        if (!state.index) {
          _res.statusCode = 503;
          _res.end(JSON.stringify({ indexedDocs: 0, lastSync: null, collections: [] }));
          return true;
        }
        const status = await state.index.status();
        if (_res.writable) {
          _res.end(JSON.stringify(status));
        }
        return true;
      },
    });

    // ── Register search HTTP endpoint ─────────────────────────────────
    api.registerHttpRoute({
      path: "/memory/search",
      match: "exact",
      auth: "gateway",
      handler: async (_req, _res) => {
        if (!state.index) {
          return false;
        }
        const url = new URL(_req.url ?? "", "http://localhost");
        const query = url.searchParams.get("q") ?? "";
        const limit = parseInt(url.searchParams.get("limit") ?? "5", 10);
        const results = await state.index.search(query, limit);
        if (_res.writable) {
          _res.end(JSON.stringify(results));
          return true;
        }
        return false;
      },
    });

    log().info(`[${PLUGIN_ID}] plugin fully registered ✓`);
  },
};

export default memoryPlugin;
