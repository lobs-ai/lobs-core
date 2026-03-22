/**
 * Main Agent — persistent conversational agent.
 *
 * Maintains a persistent conversation, receives messages (from Discord or API),
 * processes them through the LLM with tools, and replies.
 * This is NOT a one-shot worker — it's a persistent session like a chat assistant.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { parseModelString, createResilientClient } from "../runner/providers.js";
import type { LLMMessage, LLMClient } from "../runner/providers.js";
import { getModelConfig } from "../config/models.js";
import { getToolDefinitions, executeTool } from "../runner/tools/index.js";
import type { ToolName } from "../runner/types.js";
import { getToolsForSession, getSessionType } from "../runner/tools/tool-sets.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace-loader.js";
import { buildFallbackChain, resolveModelForTier, type ModelTier } from "../orchestrator/model-chooser.js";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import { compactMessages, findSafeSplitPoint, calculateContextSize } from "./compaction.js";
import { LoopDetector } from "../runner/loop-detector.js";

const MAX_HISTORY = 50;
const MAX_CONTEXT_CHARS = 150_000; // Rough char budget for history
const MAX_LIVE_TOOL_RESULT_CHARS = 200_000; // Safety valve only — compaction handles context budgets
const DEFAULT_MODEL = "strong";  // Chat defaults to strong tier (opus)
const DEFAULT_CWD = process.env.HOME ?? "/tmp";
const MAX_CONCURRENT_CHANNELS = 10; // Max simultaneous channel conversations
const LLM_TURN_TIMEOUT_MS = 600_000; // 10 minutes per LLM turn for long tool-heavy responses
const STALE_ON_NEW_MESSAGE_MS = 3 * 60_000; // Explicit user follow-up can break a run after 3 min of no progress
const STALE_AUTO_RECOVERY_MS = 10 * 60_000; // Background recovery should be much more conservative
const QUEUE_RECOVERY_INTERVAL_MS = 5_000;
const CHANNEL_PROGRESS_HEARTBEAT_MS = 15_000;
const REPLY_HANDLER_TIMEOUT_MS = 15_000;
const PROGRESS_HANDLER_TIMEOUT_MS = 15_000;
const TYPING_HANDLER_TIMEOUT_MS = 5_000;

/** Tools that mutate state and must run sequentially (not parallelizable) */
const SEQUENTIAL_TOOLS = new Set(["exec", "process", "write", "edit", "memory_write", "spawn_agent"]);

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeAssistantBlocks(
  blocks: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >,
): Array<
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
> {
  const sanitized: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  > = [];
  for (const block of blocks) {
    if (block.type !== "text") {
      sanitized.push(block);
      continue;
    }
    const text = stripThinkBlocks(block.text);
    if (text) sanitized.push({ ...block, text });
  }
  return sanitized;
}

/** Image attachment data (base64-encoded) */
export interface ImageAttachment {
  data: string;          // base64-encoded image data
  mediaType: string;     // e.g. "image/png", "image/jpeg", "image/gif", "image/webp"
  filename?: string;     // original filename
}

interface PendingMessage {
  id: string;
  messageId?: string;  // Platform message ID (Discord snowflake, etc.)
  content: string;
  authorId: string;
  authorName: string;
  channelId: string;
  timestamp: number;
  // Group chat metadata
  isDm?: boolean;         // true if DM, false if guild channel
  isMentioned?: boolean;  // true if bot was @mentioned
  chatType?: "dm" | "group" | "nexus" | "system";
  // Attachments
  images?: ImageAttachment[];  // Image attachments to include in the message
}

/** SSE event types emitted during agent processing */
export interface AgentStreamEvent {
  type: "tool_start" | "tool_result" | "text_delta" | "assistant_reply" | "thinking" | "error" | "done" | "queued" | "processing_start" | "title_update";
  channelId: string;
  queuePosition?: number; // For "queued" events — position in queue
  toolName?: string;
  toolInput?: string;    // JSON string preview of tool input
  toolUseId?: string;
  result?: string;       // tool result or final text
  isError?: boolean;
  title?: string;        // For "title_update" events
  timestamp: number;
}

/** Discord tool visibility preferences */
export type DiscordToolsMode = "on" | "off" | "compact";

export class MainAgent {
  private db: Database.Database;
  private processingChannels = new Set<string>(); // Channels currently being processed
  private channelQueues = new Map<string, PendingMessage[]>(); // Per-channel message queues
  private model: string;
  private systemPrompt = "";
  private workspaceContext = "";
  private cwd: string;
  private onReply: ((channelId: string, content: string) => Promise<void>) | null = null;
  private onTyping: ((channelId: string) => void) | null = null;
  private onProgress: ((channelId: string, content: string) => Promise<void>) | null = null;
  // Track chat type per channel for step visibility
  private channelChatType = new Map<string, string>();
  // Batched tool progress for Discord — accumulates until near 2000 chars or turn ends
  private discordToolBatches = new Map<string, string[]>();
  private queueRecoveryTimer: NodeJS.Timeout;
  // Retry state for transient errors (properly typed, no more `as any`)
  private conversationRetryCount = new Map<string, number>();
  private pendingRetryDelay = new Map<string, number>();
  private channelRunIds = new Map<string, number>();
  private channelLastProgressAt = new Map<string, number>();
  private channelLastSessionHeartbeatAt = new Map<string, number>();
  
  /** EventEmitter for SSE streaming — Nexus subscribes to this */
  public readonly events = new EventEmitter();
  
  /**
   * Per-channel project context (e.g. vim session README, AGENTS.md, pwd, etc.)
   * Injected into the system prompt when processing messages for that channel.
   */
  public channelProjectContext = new Map<string, string>();

  /**
   * Per-channel custom tool executors (e.g. vim-ws delegates file tools to client).
   * Returns a ToolExecutionResult if handled, or null to fall through to default.
   */
  public channelToolExecutors = new Map<string, (
    toolName: string,
    params: Record<string, unknown>,
    toolUseId: string,
  ) => Promise<import("../runner/types.js").ToolExecutionResult | null>>();

  constructor(db: Database.Database, model?: string) {
    this.db = db;
    this.model = model || process.env.LOBS_MODEL || DEFAULT_MODEL;
    this.cwd = process.env.LOBS_CWD || DEFAULT_CWD;
    this.ensureTables();
    this.queueRecoveryTimer = setInterval(() => {
      this.recoverStaleProcessingChannels();
      this.recoverQueuedChannels();
    }, QUEUE_RECOVERY_INTERVAL_MS);
  }

  private ensureTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS main_agent_messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        channel_id TEXT,
        platform_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        token_estimate INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_main_messages_created
        ON main_agent_messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_main_messages_channel
        ON main_agent_messages(channel_id, created_at);

      -- Track active channel sessions for restart continuation
      CREATE TABLE IF NOT EXISTS channel_sessions (
        channel_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',  -- idle | processing | queued
        last_activity TEXT NOT NULL DEFAULT (datetime('now')),
        last_author_id TEXT,
        last_author_name TEXT,
        context_summary TEXT,  -- brief summary of what was being worked on
        model_override TEXT,   -- per-channel model override
        title TEXT,            -- auto-generated session title
        message_count INTEGER NOT NULL DEFAULT 0  -- total user+assistant messages
      );

      -- Compaction summaries — summarize old messages without deleting them
      CREATE TABLE IF NOT EXISTS compaction_summaries (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        messages_summarized INTEGER NOT NULL,  -- count of messages covered
        up_to_rowid TEXT NOT NULL,              -- last message ID covered by this summary
        up_to_created_at TEXT NOT NULL,         -- timestamp of last message covered
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_channel
        ON compaction_summaries(channel_id, created_at);

      -- Persistent message queue — survives restarts
      CREATE TABLE IF NOT EXISTS message_queue (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT,           -- platform message ID
        content TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        queued_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_message_queue_channel
        ON message_queue(channel_id, processed, queued_at);
    `);

    // Discord tool visibility prefs (per-channel, separate from Nexus)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discord_tool_prefs (
        channel_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'compact',  -- on | off | compact
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Safe migrations
    try {
      this.db.exec(`ALTER TABLE main_agent_messages ADD COLUMN platform_message_id TEXT`);
    } catch { /* already exists */ }
    try {
      this.db.exec(`ALTER TABLE channel_sessions ADD COLUMN model_override TEXT`);
    } catch { /* already exists */ }
    try {
      this.db.exec(`ALTER TABLE main_agent_messages ADD COLUMN metadata TEXT`);
    } catch { /* already exists */ }
    try {
      this.db.exec(`ALTER TABLE channel_sessions ADD COLUMN title TEXT`);
    } catch { /* already exists */ }
    try {
      this.db.exec(`ALTER TABLE channel_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0`);
    } catch { /* already exists */ }
  }

  /* ── Configuration ─────────────────────────────────────────────── */

  setReplyHandler(handler: (channelId: string, content: string) => Promise<void>) {
    this.onReply = handler;
  }

  setTypingHandler(handler: (channelId: string) => void) {
    this.onTyping = handler;
  }

  setProgressHandler(handler: (channelId: string, content: string) => Promise<void>) {
    this.onProgress = handler;
  }

  private channelTag(channelId: string): string {
    return channelId.length > 16 ? `${channelId.slice(0, 16)}...` : channelId;
  }

  private extractRetryAfterMs(errorText: string): number | undefined {
    const match = errorText.match(/retry_after=(\d+)/i);
    if (!match) return undefined;
    const seconds = parseInt(match[1], 10);
    if (!Number.isFinite(seconds)) return undefined;
    return seconds * 1000;
  }

  private async runChannelHook<T>(
    channelId: string,
    hookName: string,
    timeoutMs: number,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const startedAt = Date.now();
    console.debug(
      `[main-agent.hook] channel=${this.channelTag(channelId)} hook=${hookName} start timeout_ms=${timeoutMs}`,
    );
    try {
      const result = await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${hookName} timeout after ${timeoutMs}ms for ${channelId}`)),
            timeoutMs,
          ),
        ),
      ]);
      console.debug(
        `[main-agent.hook] channel=${this.channelTag(channelId)} hook=${hookName} done duration_ms=${Date.now() - startedAt}`,
      );
      return result;
    } catch (err) {
      console.error(
        `[main-agent.hook] channel=${this.channelTag(channelId)} hook=${hookName} failed duration_ms=${Date.now() - startedAt}:`,
        err,
      );
      throw err;
    }
  }

  private async emitTyping(channelId: string): Promise<void> {
    if (!this.onTyping) return;
    await this.runChannelHook(channelId, "typing", TYPING_HANDLER_TIMEOUT_MS, () => this.onTyping!(channelId));
  }

  private async emitProgress(channelId: string, content: string): Promise<void> {
    if (!this.onProgress) return;
    await this.runChannelHook(channelId, "progress", PROGRESS_HANDLER_TIMEOUT_MS, () => this.onProgress!(channelId, content));
  }

  private async emitReply(channelId: string, content: string): Promise<void> {
    if (!this.onReply) return;
    const chunks = this.splitMessage(content, 1900);
    console.log(
      `[main-agent.reply] channel=${this.channelTag(channelId)} chunks=${chunks.length} total_chars=${content.length}`,
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      await this.runChannelHook(
        channelId,
        `reply_chunk_${i + 1}_of_${chunks.length}`,
        REPLY_HANDLER_TIMEOUT_MS,
        () => this.onReply!(channelId, chunk),
      );
    }
  }

  /** Check if a channel should see tool step progress (DMs + Nexus only, not group chats) */
  private shouldShowSteps(channelId: string): boolean {
    const chatType = this.channelChatType.get(channelId);
    // Show steps in DMs, Nexus, and system — NOT in group chats
    return chatType === "dm" || chatType === "nexus" || chatType === "system" || channelId.startsWith("nexus:");
  }

  /* ── Discord tool visibility preferences ──────────────────────── */

  getDiscordToolsMode(channelId: string): DiscordToolsMode {
    const row = this.db.prepare(
      `SELECT mode FROM discord_tool_prefs WHERE channel_id = ?`
    ).get(channelId) as { mode: string } | undefined;
    return (row?.mode as DiscordToolsMode) || "compact";
  }

  setDiscordToolsMode(channelId: string, mode: DiscordToolsMode): void {
    this.db.prepare(`
      INSERT INTO discord_tool_prefs (channel_id, mode, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(channel_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
    `).run(channelId, mode);
  }

  /** Accumulate a tool step line for a Discord channel, flush when near 2000 chars */
  private async batchDiscordToolStep(channelId: string, line: string): Promise<void> {
    if (!this.onProgress) return;
    const batch = this.discordToolBatches.get(channelId) || [];
    batch.push(line);
    this.discordToolBatches.set(channelId, batch);

    // Discord message limit is 2000 chars. Flush when we'd exceed ~1800 to leave room.
    const combined = batch.join("\n");
    if (combined.length >= 1800) {
      await this.flushDiscordToolBatch(channelId);
    }
  }

  /** Send accumulated tool steps as a single Discord message */
  private async flushDiscordToolBatch(channelId: string): Promise<void> {
    const batch = this.discordToolBatches.get(channelId);
    if (!batch || batch.length === 0) return;
    this.discordToolBatches.delete(channelId);
    await this.emitProgress(channelId, batch.join("\n"));
  }

  setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
  }

  setWorkspaceContext(context: string) {
    this.workspaceContext = context;
  }

  /* ── Persistence & Restart ───────────────────────────────────── */

  /** Persist a message to the durable queue (survives restarts) */
  private persistToQueue(msg: PendingMessage): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO message_queue (id, channel_id, message_id, content, author_id, author_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(msg.id, msg.channelId, msg.messageId || null, msg.content, msg.authorId, msg.authorName);
  }

  /** Mark queued messages as processed */
  private markQueueProcessed(channelId: string): void {
    this.db.prepare(`UPDATE message_queue SET processed = 1 WHERE channel_id = ? AND processed = 0`).run(channelId);
  }

  /**
   * Promote one queued message into main_agent_messages.
   * This must be idempotent because restart recovery and queue-drain paths can
   * see the same logical message after a crash/restart boundary.
   */
  private promoteQueuedMessage(msg: PendingMessage, source: string): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO main_agent_messages
           (id, role, content, author_id, author_name, channel_id, platform_message_id, token_estimate)
         VALUES (?, 'user', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.content,
        msg.authorId,
        msg.authorName,
        msg.channelId,
        msg.messageId || null,
        Math.ceil(msg.content.length / 4),
      );

    if (res.changes === 0) {
      console.warn(
        `[main-agent.queue] channel=${this.channelTag(msg.channelId)} source=${source} duplicate_msg_id=${msg.id.slice(0, 8)} skipped_history_insert=true`,
      );
      return false;
    }

    console.log(
      `[main-agent.queue] channel=${this.channelTag(msg.channelId)} source=${source} promoted_msg_id=${msg.id.slice(0, 8)}`,
    );
    return true;
  }

  /** Load unprocessed queued messages from DB (for restart recovery) */
  private loadPersistedQueue(channelId: string): PendingMessage[] {
    const rows = this.db.prepare(`
      SELECT id, channel_id, message_id, content, author_id, author_name, queued_at
      FROM message_queue WHERE channel_id = ? AND processed = 0 ORDER BY queued_at ASC
    `).all(channelId) as Array<{
      id: string; channel_id: string; message_id: string | null;
      content: string; author_id: string; author_name: string; queued_at: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      messageId: r.message_id || undefined,
      content: r.content,
      authorId: r.author_id,
      authorName: r.author_name,
      channelId: r.channel_id,
      timestamp: new Date(r.queued_at).getTime(),
    }));
  }

  /** Update channel session tracking */
  private updateChannelSession(
    channelId: string,
    status: "idle" | "processing" | "queued",
    authorId?: string | null,
    authorName?: string | null,
    contextSummary?: string | null,
  ): void {
    this.db.prepare(`
      INSERT INTO channel_sessions (channel_id, status, last_activity, last_author_id, last_author_name, context_summary)
      VALUES (?, ?, datetime('now'), ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        status = excluded.status,
        last_activity = excluded.last_activity,
        last_author_id = COALESCE(excluded.last_author_id, channel_sessions.last_author_id),
        last_author_name = COALESCE(excluded.last_author_name, channel_sessions.last_author_name),
        context_summary = COALESCE(excluded.context_summary, channel_sessions.context_summary)
    `).run(channelId, status, authorId || null, authorName || null, contextSummary || null);
  }

  /** Get session title for a channel */
  getSessionTitle(channelId: string): string | null {
    const row = this.db.prepare(
      `SELECT title FROM channel_sessions WHERE channel_id = ?`
    ).get(channelId) as { title: string | null } | undefined;
    return row?.title ?? null;
  }

  /** Update session title */
  setSessionTitle(channelId: string, title: string): void {
    this.db.prepare(
      `UPDATE channel_sessions SET title = ? WHERE channel_id = ?`
    ).run(title, channelId);
  }

  /**
   * Auto-generate or update a session title based on conversation content.
   * Uses local LM Studio model for free, fast title generation.
   * Only runs after the first reply and then every ~5 messages.
   */
  async maybeUpdateSessionTitle(channelId: string): Promise<void> {
    // Count user+assistant messages (skip tool_use/tool_result)
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM main_agent_messages
       WHERE channel_id = ? AND role IN ('user', 'assistant')`
    ).get(channelId) as { cnt: number } | undefined;
    const msgCount = countRow?.cnt ?? 0;

    // Generate title after first exchange (2 messages), then every 5 messages
    const existingTitle = this.getSessionTitle(channelId);
    const shouldGenerate = (!existingTitle && msgCount >= 2) || (msgCount > 0 && msgCount % 5 === 0);
    if (!shouldGenerate) return;

    // Grab the last few user+assistant messages for context
    const recentMessages = this.db.prepare(
      `SELECT role, content FROM main_agent_messages
       WHERE channel_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at DESC LIMIT 6`
    ).all(channelId) as { role: string; content: string }[];

    if (recentMessages.length === 0) return;

    // Build a summary of the conversation for title generation
    const conversationSnippet = recentMessages.reverse().map((m) => {
      // Extract text content, strip tool blocks
      let text = m.content;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          text = parsed
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
        }
      } catch {
        // already plain text
      }
      // Truncate long messages
      if (text.length > 300) text = text.slice(0, 300) + "...";
      return `${m.role}: ${text}`;
    }).join("\n");

    if (!conversationSnippet.trim()) return;

    try {
      const modelConfig = getModelConfig();
      const baseUrl = modelConfig.local?.baseUrl ?? "http://localhost:1234/v1";
      const rawModel = modelConfig.local?.chatModel ?? "qwen/qwen3.5-9b";
      const model = rawModel.replace(/^lmstudio\//, "");

      const systemPrompt = "Generate a very short title (3-6 words) for this conversation. Return ONLY the title, no quotes, no punctuation at the end. Be specific about the topic, not generic.";

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: conversationSnippet },
              { role: "assistant", content: "<think>\n\n</think>\n\n" },
            ],
            max_tokens: 32,
            temperature: 0.3,
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`LM Studio returned ${response.status}: ${await response.text()}`);
        }

        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        let rawTitle = data.choices?.[0]?.message?.content?.trim() ?? "";
        rawTitle = rawTitle.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

        const title = rawTitle.replace(/^["']|["']$/g, "").replace(/[.!?]+$/, "").slice(0, 60);
        if (!title) return;

        this.setSessionTitle(channelId, title);
        console.log(`[main-agent] Session title for ${this.channelTag(channelId)}: "${title}"`);

        // Emit title update event so frontends can display it
        this.events.emit("stream", {
          type: "title_update",
          channelId,
          title,
          timestamp: Date.now(),
        } satisfies AgentStreamEvent);
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      console.error(`[main-agent] Title generation error:`, e);
    }
  }

  /** Resume sessions that were active before a restart */
  async resumeAfterRestart(): Promise<void> {
    console.log("[main-agent] Checking for sessions to resume after restart...");

    // 1. Find channels that were processing when we shut down
    const activeSessions = this.db.prepare(`
      SELECT channel_id, last_author_id, last_author_name, context_summary, last_activity
      FROM channel_sessions WHERE status = 'processing'
    `).all() as Array<{
      channel_id: string; last_author_id: string | null;
      last_author_name: string | null; context_summary: string | null;
      last_activity: string;
    }>;

    // 2. Find channels with unprocessed queued messages
    const queuedChannels = this.db.prepare(`
      SELECT DISTINCT channel_id FROM message_queue WHERE processed = 0
    `).all() as Array<{ channel_id: string }>;

    // Collect all channels that need attention
    const channelsToResume = new Set<string>();
    for (const s of activeSessions) channelsToResume.add(s.channel_id);
    for (const q of queuedChannels) channelsToResume.add(q.channel_id);

    if (channelsToResume.size === 0) {
      console.log("[main-agent] No sessions to resume");
      // Reset any stale session states
      this.db.prepare(`UPDATE channel_sessions SET status = 'idle' WHERE status != 'idle'`).run();
      return;
    }

    // Don't resume the system channel — heartbeat cron will re-trigger it naturally
    if (channelsToResume.has("system")) {
      channelsToResume.delete("system");
      this.updateChannelSession("system", "idle");
    }

    // Skip sessions that are extremely stale (>30 minutes) — those are likely
    // leftover from a previous crash where shutdown didn't clean up properly.
    // Normal restarts (build, migration, etc.) take well under 30 minutes.
    const STALE_THRESHOLD_MS = 30 * 60 * 1000;
    const now = Date.now();
    for (const s of activeSessions) {
      if (channelsToResume.has(s.channel_id)) {
        const lastActive = new Date(s.last_activity).getTime();
        if (now - lastActive > STALE_THRESHOLD_MS) {
          console.log(`[main-agent] Skipping stale session ${s.channel_id.slice(0, 12)} (last active ${Math.round((now - lastActive) / 60000)}min ago)`);
          channelsToResume.delete(s.channel_id);
          this.updateChannelSession(s.channel_id, "idle");
        }
      }
    }

    // For sessions that were "processing" with no queued user messages,
    // they were mid-response when the process died. We still want to resume
    // these — the agent was actively doing work that got interrupted.
    // We'll inject a synthetic resume message so the agent can pick up where it left off.
    const queuedChannelSet = new Set(queuedChannels.map(q => q.channel_id));

    if (channelsToResume.size === 0) {
      console.log("[main-agent] No recent sessions to resume — all stale or system-only");
      this.db.prepare(`UPDATE channel_sessions SET status = 'idle' WHERE status != 'idle'`).run();
      return;
    }

    console.log(`[main-agent] Resuming ${channelsToResume.size} session(s) with staggered startup...`);

    const channelArray = [...channelsToResume];
    for (let i = 0; i < channelArray.length; i++) {
      const channelId = channelArray[i];
      // Load any persisted queue messages into memory
      const persistedMsgs = this.loadPersistedQueue(channelId);
      if (persistedMsgs.length > 0) {
        this.channelQueues.set(channelId, persistedMsgs);
        console.log(`[main-agent] Loaded ${persistedMsgs.length} queued message(s) for channel ${channelId.slice(0, 8)}`);
      }

      // Get the session info for context
      const session = activeSessions.find(s => s.channel_id === channelId);
      const lastActivity = session?.last_activity || "unknown";

      // Inject a system event so the agent knows it restarted and should continue
      const hasQueuedMessages = queuedChannelSet.has(channelId);
      const resumeText = [
        `[System] lobs-core restarted. This session was active at ${lastActivity}.`,
        session?.context_summary ? `Last context: ${session.context_summary}` : null,
        persistedMsgs.length > 0 ? `${persistedMsgs.length} queued message(s) waiting.` : null,
        !hasQueuedMessages ? `You were mid-response when the process died. Continue where you left off.` : null,
        `Orient fast: check state (git status/log, build status) before re-reading files. Act on what you find — don't re-investigate from scratch.`,
      ].filter(Boolean).join(" ");

      // Insert as a user message so it enters the conversation flow
      this.db.prepare(`
        INSERT INTO main_agent_messages (id, role, content, channel_id, token_estimate)
        VALUES (?, 'user', ?, ?, ?)
      `).run(randomUUID(), resumeText, channelId, Math.ceil(resumeText.length / 4));

      // Process — but respect concurrency limits
      if (this.processingChannels.size < MAX_CONCURRENT_CHANNELS) {
        this.updateChannelSession(channelId, "queued");
        // Don't await — let them run concurrently, but stagger starts
        // to avoid thundering herd on the API (especially after rate limits)
        const staggerDelay = 5000 + i * 5000; // 5s initial + 5s between each session
        setTimeout(() => {
          this.updateChannelSession(channelId, "processing");
          this.processConversation(channelId).catch(err => {
            console.error(`[main-agent] Resume failed for channel ${channelId.slice(0, 8)}:`, err);
            this.processingChannels.delete(channelId);
            this.updateChannelSession(channelId, "idle");
          });
        }, staggerDelay);
      } else {
        this.updateChannelSession(channelId, "queued");
        console.log(`[main-agent] Channel ${channelId.slice(0, 8)} queued for resume (concurrency limit)`);
      }
    }
  }

  /** Persist current state before shutdown */
  async prepareForShutdown(): Promise<void> {
    console.log("[main-agent] Persisting state before shutdown...");

    // Persist any in-memory queue messages that weren't already persisted
    for (const [channelId, queue] of this.channelQueues.entries()) {
      for (const msg of queue) {
        this.persistToQueue(msg);
      }
    }

    // Find ALL channels that are still "processing" in DB (includes retry-pending ones
    // that have been removed from the in-memory processingChannels set)
    const allProcessing = this.db.prepare(`
      SELECT channel_id FROM channel_sessions WHERE status = 'processing'
    `).all() as Array<{ channel_id: string }>;
    const allProcessingIds = new Set(allProcessing.map(s => s.channel_id));

    // Also include in-memory set (should overlap, but be safe)
    for (const channelId of this.processingChannels) {
      allProcessingIds.add(channelId);
    }

    // Save a context summary for each active channel
    for (const channelId of allProcessingIds) {
      // Get the last few messages — prioritize user messages and assistant text
      // (tool outputs are noise for restart context)
      const recent = this.db.prepare(`
        SELECT role, content FROM main_agent_messages
        WHERE channel_id = ? ORDER BY created_at DESC LIMIT 10
      `).all(channelId) as Array<{ role: string; content: string }>;

      // Find the last user message (the task) and last assistant text (progress)
      const lastUser = recent.find(r => r.role === "user" && !r.content.startsWith("[System]"));
      const lastAssistant = recent.find(r => r.role === "assistant" && !r.content.startsWith("["));

      const parts: string[] = [];
      if (lastUser) parts.push(`Task: ${lastUser.content.substring(0, 200)}`);
      if (lastAssistant) parts.push(`Last response: ${lastAssistant.content.substring(0, 200)}`);
      if (parts.length === 0) {
        // Fallback to raw recent content
        parts.push(recent.slice(0, 3).reverse().map(r => r.content.substring(0, 100)).join(" | "));
      }

      this.updateChannelSession(channelId, "processing", null, null, parts.join(" | "));
    }

    console.log(`[main-agent] State persisted (${allProcessingIds.size} active, ${this.channelQueues.size} queued channels)`);
  }

  /* ── Public API ────────────────────────────────────────────────── */

  /** Handle an incoming user message — queues if channel is busy or at concurrency limit */
  async handleMessage(msg: PendingMessage): Promise<void> {
    const channelId = msg.channelId;
    const staleReason = this.getStaleProcessingReason(channelId, STALE_ON_NEW_MESSAGE_MS);
    if (staleReason) {
      this.recoverStaleChannel(channelId, staleReason);
    }
    console.log(
      `[main-agent.inbound] channel=${this.channelTag(channelId)} msg=${msg.id.slice(0, 8)} ` +
      `author=${msg.authorName} len=${msg.content.length} active=${this.processingChannels.has(channelId)} ` +
      `global_active=${this.processingChannels.size}/${MAX_CONCURRENT_CHANNELS}`,
    );

    // Track chat type for step visibility
    // Default chat type: nexus channels → nexus, system → system, everything else → dm
    // Group chat must be explicitly set by the caller (e.g., Discord service for guild channels)
    const chatType = msg.chatType || (
      channelId.startsWith("nexus:") ? "nexus" :
      channelId === "system" ? "system" :
      "dm"  // Default to DM — group must be explicitly set
    );
    this.channelChatType.set(channelId, chatType);

    // Check if this specific channel is already being processed or at concurrency limit
    if (this.processingChannels.has(channelId) || this.processingChannels.size >= MAX_CONCURRENT_CHANNELS) {
      // Persist to DB queue (survives restarts)
      this.persistToQueue(msg);
      // Also keep in memory for fast mid-loop injection
      if (!this.channelQueues.has(channelId)) {
        this.channelQueues.set(channelId, []);
      }
      this.channelQueues.get(channelId)!.push(msg);
      const queueDepth = this.channelQueues.get(channelId)!.length;
      console.log(
        `[main-agent.queue] channel=${this.channelTag(channelId)} msg=${msg.id.slice(0, 8)} ` +
        `depth=${queueDepth} active=${this.processingChannels.size}/${MAX_CONCURRENT_CHANNELS}`,
      );
      // Emit queued event so frontends can show queue status
      this.events.emit("stream", {
        type: "queued",
        channelId,
        queuePosition: queueDepth,
        timestamp: Date.now(),
      } satisfies AgentStreamEvent);
      return;
    }

    // Store in DB message history (with image metadata if present)
    const metadata = msg.images?.length
      ? JSON.stringify({ images: msg.images })
      : null;
    this.db
      .prepare(
        `INSERT INTO main_agent_messages
           (id, role, content, author_id, author_name, channel_id, platform_message_id, token_estimate, metadata)
         VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.content,
        msg.authorId,
        msg.authorName,
        msg.channelId,
        msg.messageId || null,
        Math.ceil(msg.content.length / 4),
        metadata,
      );

    // Update channel session state
    this.updateChannelSession(channelId, "processing", msg.authorId, msg.authorName);
    console.log(
      `[main-agent.inbound] channel=${this.channelTag(channelId)} msg=${msg.id.slice(0, 8)} accepted_for_processing=true`,
    );

    await this.processConversation(msg.channelId);
  }

  /** Inject a system event (heartbeat, cron, subagent completion, etc.) */
  async handleSystemEvent(text: string, channelId?: string): Promise<void> {
    const id = randomUUID();
    const ch = channelId || "system";
    const content = `[System Event] ${text}`;
    console.log(
      `[main-agent.system] channel=${this.channelTag(ch)} event=${id.slice(0, 8)} len=${content.length} ` +
      `active=${this.processingChannels.has(ch)} global_active=${this.processingChannels.size}/${MAX_CONCURRENT_CHANNELS}`,
    );

    // If channel is idle and we have capacity, store + process immediately
    if (!this.processingChannels.has(ch) && this.processingChannels.size < MAX_CONCURRENT_CHANNELS) {
      this.db
        .prepare(
          `INSERT INTO main_agent_messages
             (id, role, content, channel_id, platform_message_id, token_estimate)
           VALUES (?, 'user', ?, ?, ?, ?)`,
        )
        .run(id, content, ch, null, Math.ceil(text.length / 4));
      await this.processConversation(ch);
      return;
    }

    // Channel is busy or at capacity — queue so it gets picked up when the channel finishes.
    // Don't insert into DB yet — the queue drain logic handles that.
    // This prevents system events (e.g. subagent completions) from being silently dropped.
    const pendingMsg: PendingMessage = {
      id,
      content,
      authorId: "system",
      authorName: "System",
      channelId: ch,
      timestamp: Date.now(),
    };
    if (!this.channelQueues.has(ch)) {
      this.channelQueues.set(ch, []);
    }
    this.channelQueues.get(ch)!.push(pendingMsg);
    console.log(
      `[main-agent] System event queued for busy channel ${ch.slice(0, 12)} (${this.channelQueues.get(ch)!.length} pending)`,
    );
  }

  isProcessing(): boolean {
    return this.processingChannels.size > 0;
  }

  getQueueDepth(): number {
    let total = 0;
    for (const queue of this.channelQueues.values()) {
      total += queue.length;
    }
    return total;
  }

  getProcessingChannels(): string[] {
    return Array.from(this.processingChannels);
  }

  /** Check if a specific channel is currently being processed */
  isChannelProcessing(channelId: string): boolean {
    return this.processingChannels.has(channelId);
  }

  /** Get number of queued messages for a specific channel */
  getChannelQueueDepth(channelId: string): number {
    return this.channelQueues.get(channelId)?.length ?? 0;
  }

  /** Get number of currently active channels */
  getActiveChannelCount(): number {
    return this.processingChannels.size;
  }

  /** Get max concurrent channel limit */
  getMaxConcurrent(): number {
    return MAX_CONCURRENT_CHANNELS;
  }

  /* ── Core conversation loop ────────────────────────────────────── */

  private async processConversation(replyChannelId: string): Promise<void> {
    const conversationStartedAt = Date.now();
    const sessionId = `main-agent:${replyChannelId}`;
    let conversationTimedOut = false;
    const runId = this.beginChannelRun(replyChannelId);
    // Mark this channel as being processed
    this.processingChannels.add(replyChannelId);
    this.noteChannelProgress(replyChannelId);
    console.log(
      `[main-agent] Processing started for ${this.channelTag(replyChannelId)} session=${sessionId} ` +
      `(active=${this.processingChannels.size}/${MAX_CONCURRENT_CHANNELS}, queued=${this.getQueueDepth()})`,
    );

    // Emit processing_start so frontends know a queued channel is now active
    this.events.emit("stream", {
      type: "processing_start",
      channelId: replyChannelId,
      timestamp: Date.now(),
    } satisfies AgentStreamEvent);

    // Total conversation timeout — prevents stuck channels
    // 30 minutes for all session types — allow big work between messages
    const timeoutMinutes = 30;
    const conversationTimeout = setTimeout(() => {
      conversationTimedOut = true;
      console.error(`[main-agent] Conversation timeout (${timeoutMinutes}min) for channel ${replyChannelId.slice(0, 12)} — force releasing`);
      const timeoutMessage = `⚠️ Conversation timed out after ${timeoutMinutes} minutes. This session was interrupted mid-run.`;

      this.db
        .prepare(
          `INSERT INTO main_agent_messages
             (id, role, content, channel_id, token_estimate)
           VALUES (?, 'assistant', ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          timeoutMessage,
          replyChannelId,
          Math.ceil(timeoutMessage.length / 4),
        );

      this.events.emit("stream", {
        type: "error",
        channelId: replyChannelId,
        result: timeoutMessage,
        timestamp: Date.now(),
      } satisfies AgentStreamEvent);

      this.processingChannels.delete(replyChannelId);
      this.channelLastProgressAt.delete(replyChannelId);
      this.channelLastSessionHeartbeatAt.delete(replyChannelId);
      this.updateChannelSession(replyChannelId, "idle");
    }, timeoutMinutes * 60 * 1000);

    try {
      await this.emitTyping(replyChannelId).catch(() => {});

      // 1. Get history for this channel
      let history = this.getRecentHistory(replyChannelId);

      // 2. Prune old tool outputs, repair orphaned tool_use blocks, and sanitize
      history = this.pruneHistory(history);
      history = this.repairOrphanedToolUse(history);
      history = this.sanitizeToolHistory(history);
      const historyChars = history.reduce((sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length), 0);
      console.log(
        `[main-agent.context] channel=${this.channelTag(replyChannelId)} session=${sessionId} ` +
        `history_messages=${history.length} history_chars=${historyChars} queued=${this.getChannelQueueDepth(replyChannelId)}`,
      );

      // Reload system prompt AND workspace context fresh each turn
      // This ensures edits to SYSTEM_PROMPT.md, SOUL.md, USER.md, MEMORY.md, TOOLS.md
      // take effect immediately without restarting lobs-core
      const freshSystemPrompt = buildSystemPrompt();
      const freshContext = loadWorkspaceContext();

      // Build system prompt — concise: identity + context + time
      // Tool descriptions come from the tool schemas (not hardcoded in prompt)
      const channelChatType = this.channelChatType.get(replyChannelId) || "unknown";
      let chatContextNote = "";
      if (channelChatType === "group") {
        chatContextNote = `\n\nYou are in a GROUP CHAT. Responding is OPTIONAL. Reply with just "NO_REPLY" (nothing else) if the message isn't directed at you or doesn't need your input. Only respond when mentioned, directly addressed, or when you have something genuinely useful to add. Don't respond just to acknowledge.`;
      } else {
        chatContextNote = `\n\nThis is a DIRECT conversation. You MUST always respond to every message. Never reply with "NO_REPLY" — the user is talking directly to you and expects a response.`;
      }

      // Per-channel project context (e.g. vim session README, AGENTS.md, etc.)
      const projectContext = this.channelProjectContext.get(replyChannelId);

      const fullSystem = [
        freshSystemPrompt,
        "",
        freshContext,
        "",
        `Current time: ${new Date().toLocaleString("en-US", {
          timeZone: "America/New_York",
          dateStyle: "full",
          timeStyle: "long",
        })}`,
        `Session type: ${channelChatType}`,
        chatContextNote,
        ...(projectContext ? ["", "## Project Context", projectContext] : []),
      ].join("\n");

      // 3. Build LLM messages (with image content blocks when present)
      let messages: LLMMessage[] = history.map((m) => {
        const role = m.role as "user" | "assistant";

        // If content is already structured (reconstructed from metadata), pass through
        if (Array.isArray(m.content)) {
          return { role, content: m.content };
        }

        // Check for image metadata on user messages
        if (role === "user" && m.metadata) {
          try {
            const meta = JSON.parse(m.metadata);
            if (meta.images?.length) {
              const contentBlocks: Array<Record<string, unknown>> = [];
              // Add images first
              for (const img of meta.images) {
                contentBlocks.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: img.mediaType,
                    data: img.data,
                  },
                });
              }
              // Add text content if any
              if (m.content) {
                contentBlocks.push({ type: "text", text: m.content as string });
              }
              return { role, content: contentBlocks };
            }
          } catch { /* invalid metadata, fall through */ }
        }

        return { role, content: m.content as string };
      });

      // 3b. Merge consecutive same-role messages (DB can have runs of
      //     assistant messages from multi-step tool use persisted separately).
      //     The Anthropic API requires strictly alternating user/assistant roles.
      messages = this.mergeConsecutiveRoles(messages);

      // 4. Add queued messages for this channel
      const queuedText = this.drainQueue(replyChannelId);
      if (queuedText) {
        messages.push({
          role: "user",
          content: `[Queued messages while agent was busy]\n\n${queuedText}`,
        });
      }

      // 5. Compact if needed (pass channelId to persist compaction to DB)
      messages = await this.compactIfNeeded(messages, replyChannelId);

      // Check for per-channel model override
      const sessionRow = this.db.prepare(
        `SELECT model_override FROM channel_sessions WHERE channel_id = ?`
      ).get(replyChannelId) as { model_override: string | null } | undefined;
      
      let effectiveModel = sessionRow?.model_override || this.model;
      
      // If the model is a tier name, resolve it to actual model
      if (["micro", "small", "medium", "standard", "strong"].includes(effectiveModel)) {
        const resolved = resolveModelForTier(effectiveModel as ModelTier, "main");
        if (resolved) {
          effectiveModel = resolved;
        }
      }
      
      // Resolve tools based on session type
      const sessionType = getSessionType(replyChannelId);
      let availableTools = getToolsForSession(sessionType);

      // Apply per-session tool overrides (nexus sessions store disabled tools in DB)
      if (replyChannelId.startsWith("nexus:")) {
        const sessionKey = replyChannelId.replace("nexus:", "");
        const sessionRow2 = this.db.prepare(
          `SELECT disabled_tools FROM chat_sessions WHERE session_key = ?`
        ).get(sessionKey) as { disabled_tools: string | null } | undefined;
        if (sessionRow2?.disabled_tools) {
          try {
            const disabled: string[] = JSON.parse(sessionRow2.disabled_tools);
            availableTools = availableTools.filter(t => !disabled.includes(t));
          } catch { /* ignore bad JSON */ }
        }
      }

      const tools = getToolDefinitions(availableTools);
      console.log(`[main-agent] Using model: ${effectiveModel} (raw: ${this.model}, override: ${sessionRow?.model_override ?? 'none'})`);
      const config = parseModelString(effectiveModel);
      const fallbackModels = ["micro", "small", "medium", "standard", "strong"].includes(this.model)
        ? buildFallbackChain(effectiveModel, this.model as ModelTier, "main").slice(1)
        : [];
      const client: LLMClient = createResilientClient(effectiveModel, {
        sessionId: `main-agent:${replyChannelId}`,
        fallbackModels,
        maxRetries: 3,
      });
      let loopIteration = 0;

      // Agent loop — LLM ↔ tool execution (no turn limit, timeout handles runaway)
      while (true) {
        loopIteration++;
        await this.emitTyping(replyChannelId).catch(() => {});
        console.debug(
          `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
          `history=${messages.length} queued=${this.getChannelQueueDepth(replyChannelId)} tools=${tools.length}`,
        );

        // Emit SSE event: thinking (about to call LLM)
        this.events.emit("stream", {
          type: "thinking",
          channelId: replyChannelId,
          timestamp: Date.now(),
        } satisfies AgentStreamEvent);

        // Compact if approaching context limit — no pre-pruning, let the compactor
        // see full tool results so it can produce high-quality summaries
        messages = await this.compactIfNeeded(messages, replyChannelId);
        const contextChars = messages.reduce((s, m) =>
          s + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0);
        const systemChars = fullSystem.length;
        console.debug(
          `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
          `calling_llm model=${config.modelId} msgs=${messages.length} ctx=${contextChars} sys=${systemChars} total_chars=${contextChars + systemChars}`,
        );

        // Ensure messages end with user role (models like Opus 4.6 reject assistant prefill)
        if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
          console.warn(`[main-agent] Messages end with assistant — appending synthetic user continue message`);
          messages.push({
            role: "user",
            content: "[System: continue from where you left off]",
          });
        }

        // Final preflight after compaction/merge/synthetic messages. These later
        // transformations can otherwise reintroduce invalid tool ordering.
        messages = this.normalizeToolProtocolMessages(messages);
        messages = this.mergeConsecutiveRoles(messages);
        messages = this.emergencyRepairToolPairs(messages);

        // Validate message structure before sending to API
        const validation = this.validateMessages(messages);
        if (validation) {
          console.error(`[main-agent] Message validation failed for ${replyChannelId.slice(0, 12)}: ${validation}`);
          // Log the roles sequence for debugging
          console.error(`[main-agent] Roles sequence: ${messages.map(m => m.role).join(', ')}`);
          // Log content types for tool_result detection
          for (let vi = 0; vi < messages.length; vi++) {
            const m = messages[vi];
            if (typeof m.content !== 'string') {
              console.error(`[main-agent] msg[${vi}] role=${m.role} content_type=array blocks=${Array.isArray(m.content) ? m.content.map((b: any) => b.type).join(',') : typeof m.content}`);
            }
          }

          // Emergency repair: strip any orphaned tool_result blocks to avoid 400 errors
          messages = this.emergencyRepairToolPairs(messages);
          const revalidation = this.validateMessages(messages);
          if (revalidation) {
            console.error(`[main-agent] Emergency repair failed, still invalid: ${revalidation}`);
          } else {
            console.warn(`[main-agent] Emergency repair succeeded for ${replyChannelId.slice(0, 12)}`);
          }
        }

        // Sanitize: Anthropic API rejects tool_result with is_error=true and empty content
        for (const m of messages) {
          if (m.role === "user" && Array.isArray(m.content)) {
            for (const block of m.content as Array<Record<string, unknown>>) {
              if (block.type === "tool_result" && block.is_error && !block.content) {
                block.content = "Tool error (no output)";
              }
            }
          }
        }

        const response = await this.createMessageWithTimeout(client, {
          model: config.modelId,
          system: fullSystem,
          messages,
          tools,
          maxTokens: 16384,
        }, replyChannelId);
        if (!this.isActiveChannelRun(replyChannelId, runId)) {
          console.warn(`[main-agent] Discarding stale LLM response for ${this.channelTag(replyChannelId)} run=${runId}`);
          return;
        }
        this.noteChannelProgress(replyChannelId);
        console.debug(
          `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
          `llm_response blocks=${response.content.length} stop=${response.stopReason}`,
        );

        const sanitizedContent = sanitizeAssistantBlocks(response.content as Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
        >);

        let textResponse = "";
        let hasToolUse = false;
        const toolResults: Array<{
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }> = [];

        // Separate text blocks from tool_use blocks
        const toolUseBlocks: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
        for (const block of sanitizedContent) {
          if (block.type === "text") {
            textResponse += block.text;
          } else if (block.type === "tool_use") {
            hasToolUse = true;
            toolUseBlocks.push(block as typeof toolUseBlocks[0]);
          }
        }

        // Execute tool calls — parallel when safe, sequential when side effects possible
        // Read-only tools (read, grep, glob, ls, web_search, web_fetch, memory_search, memory_read) can run in parallel
        const isNexusChannel = replyChannelId.startsWith("nexus:");

        if (toolUseBlocks.length > 0) {
          // Emit all tool_start events upfront
          for (const block of toolUseBlocks) {
            const inputPreview = JSON.stringify(block.input).substring(0, 300);
            console.debug(
              `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
              `tool_start name=${block.name} id=${block.id}`,
            );
            if (this.shouldShowSteps(replyChannelId) && !isNexusChannel) {
              const discordMode = this.getDiscordToolsMode(replyChannelId);
              if (discordMode === "on") {
                await this.batchDiscordToolStep(
                  replyChannelId,
                  `🔧 \`${block.name}\` ${inputPreview.substring(0, 150)}${inputPreview.length >= 150 ? "..." : ""}`,
                );
              } else if (discordMode === "compact") {
                await this.batchDiscordToolStep(
                  replyChannelId,
                  `\`${block.name}\``,
                );
              }
            }
            this.events.emit("stream", {
              type: "tool_start",
              channelId: replyChannelId,
              toolName: block.name,
              toolInput: inputPreview,
              toolUseId: block.id,
              timestamp: Date.now(),
            } satisfies AgentStreamEvent);
          }

          // Determine if we can parallelize: only if ALL tools in this batch are read-only
          const allReadOnly = toolUseBlocks.every(b => !SEQUENTIAL_TOOLS.has(b.name));

          const executeOneBlock = async (block: typeof toolUseBlocks[0]) => {
            const toolStartedAt = Date.now();
            
            // Check for channel-specific tool executor (e.g. vim-ws delegates file tools to client)
            let execResult: import("../runner/types.js").ToolExecutionResult;
            const channelExecutor = this.channelToolExecutors.get(replyChannelId);
            const overrideResult = channelExecutor 
              ? await channelExecutor(block.name, block.input as Record<string, unknown>, block.id)
              : null;
            
            if (overrideResult) {
              execResult = overrideResult;
            } else {
              execResult = await executeTool(
                block.name,
                block.input as Record<string, unknown>,
                block.id,
                this.cwd,
                { channelId: replyChannelId },
              );
            }
            const { result, sideEffects } = execResult;
            if (sideEffects?.newCwd) {
              this.cwd = sideEffects.newCwd;
              console.debug(`[main-agent.loop] cwd_changed to=${this.cwd}`);
            }
            const resultContent = this.truncateLiveToolResult(
              typeof result.content === "string"
                ? result.content
                : JSON.stringify(result.content),
            );
            console.debug(
              `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
              `tool_done name=${block.name} id=${block.id} error=${Boolean(result.is_error)} ` +
              `result_len=${resultContent.length} duration_ms=${Date.now() - toolStartedAt}`,
            );
            // Discord result line (on mode only)
            if (this.shouldShowSteps(replyChannelId) && !isNexusChannel) {
              const discordMode = this.getDiscordToolsMode(replyChannelId);
              if (discordMode === "on") {
                const shortResult = resultContent.substring(0, 120);
                await this.batchDiscordToolStep(
                  replyChannelId,
                  `  ${result.is_error ? "❌" : "✓"} ${shortResult}${resultContent.length > 120 ? "..." : ""}`,
                );
              }
            }
            this.events.emit("stream", {
              type: "tool_result",
              channelId: replyChannelId,
              toolName: block.name,
              toolUseId: block.id,
              result: resultContent.substring(0, 2000),
              isError: result.is_error,
              timestamp: Date.now(),
            } satisfies AgentStreamEvent);
            return {
              type: "tool_result" as const,
              tool_use_id: result.tool_use_id,
              content: (result.is_error && !resultContent) ? "Tool error (no output)" : resultContent,
              is_error: result.is_error,
            };
          };

          if (allReadOnly && toolUseBlocks.length > 1) {
            // Parallel execution for read-only tools
            console.debug(
              `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
              `parallel_tools count=${toolUseBlocks.length} tools=${toolUseBlocks.map(b => b.name).join(",")}`,
            );
            const results = await Promise.all(toolUseBlocks.map(executeOneBlock));
            toolResults.push(...results);
          } else {
            // Sequential execution when any tool has side effects
            for (const block of toolUseBlocks) {
              const result = await executeOneBlock(block);
              toolResults.push(result);
            }
          }
        }

        // Append assistant turn
        messages.push({ role: "assistant", content: sanitizedContent });

        if (hasToolUse) {
          console.debug(
            `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
            `tool_roundtrip count=${toolResults.length} continuing=true`,
          );
          // Store tool call summary in DB for continuity across restarts.
          // IMPORTANT: Store the tool CALL (name + input), not the tool RESULT.
          // Storing results here caused the model to see its own messages containing
          // tool output as plain text, which degraded tool-calling behavior in long
          // conversations — the model would start outputting tool calls as text instead
          // of using structured tool_use blocks.
          const toolSummary = toolUseBlocks.map((block) => {
            const inputStr = JSON.stringify(block.input);
            const inputPreview = inputStr.length > 300
              ? inputStr.slice(0, 300) + "..."
              : inputStr;
            return `[${block.name}] ${inputPreview}`;
          }).join("\n");

          // Also include any text the model said alongside the tool calls
          const assistantText = textResponse?.trim();
          const fullToolSummary = assistantText
            ? `${assistantText}\n\n[Tool calls]\n${toolSummary}`
            : `[Tool calls]\n${toolSummary}`;

          // Store structured tool_use blocks in metadata for faithful reconstruction
          const toolUseMetadata = JSON.stringify({
            toolUseBlocks: toolUseBlocks.map(b => ({
              id: b.id,
              name: b.name,
              input: b.input,
            })),
            // Preserve any text the model said alongside tool calls
            textContent: assistantText || null,
          });

          this.db
            .prepare(
              `INSERT INTO main_agent_messages
                 (id, role, content, channel_id, token_estimate, metadata)
               VALUES (?, 'assistant', ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              fullToolSummary,
              replyChannelId,
              Math.ceil(fullToolSummary.length / 4),
              toolUseMetadata,
            );
          this.noteChannelProgress(replyChannelId);

          // Feed tool results back as a user turn
          messages.push({ role: "user", content: toolResults });

          // Also persist the tool results as a user message so DB maintains alternation
          const toolResultSummary = toolResults.map((tr) => {
            const resultPreview =
              tr.content.length > 500
                ? tr.content.slice(0, 500) + "..."
                : tr.content;
            return `[${tr.tool_use_id}] ${tr.is_error ? "ERROR: " : ""}${resultPreview}`;
          }).join("\n");

          // Store structured tool_result blocks in metadata for faithful reconstruction
          const toolResultMetadata = JSON.stringify({
            toolResults: toolResults.map(tr => ({
              tool_use_id: tr.tool_use_id,
              content: tr.content,
              is_error: tr.is_error || false,
            })),
          });

          this.db
            .prepare(
              `INSERT INTO main_agent_messages
                 (id, role, content, channel_id, token_estimate, metadata)
               VALUES (?, 'user', ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              `[Tool results]\n${toolResultSummary}`,
              replyChannelId,
              Math.ceil(toolResultSummary.length / 4),
              toolResultMetadata,
            );
          this.noteChannelProgress(replyChannelId);

          // Inject any queued messages that arrived while we were working.
          // IMPORTANT: Append to the existing tool_results user message rather than
          // inserting a fake assistant message + new user message. The old approach
          // broke the tool-calling flow — the model saw a synthetic "I see new messages"
          // assistant turn after tool results, which disrupted its multi-step tool use
          // and caused it to output tool calls as text or stop using tools entirely.
          const midLoopQueued = this.drainQueue(replyChannelId, true); // skip DB persist — we persist below
          if (midLoopQueued) {
            const queuedNote = `\n\n[New messages received during processing]\n\n${midLoopQueued}`;
            
            // Append to the last user message (tool results) as a text block
            const lastUserMsg = messages[messages.length - 1];
            if (lastUserMsg && lastUserMsg.role === "user" && Array.isArray(lastUserMsg.content)) {
              // Tool results are an array of tool_result blocks — add a text block
              (lastUserMsg.content as Array<Record<string, unknown>>).push({
                type: "text",
                text: queuedNote,
              });
            } else if (lastUserMsg && lastUserMsg.role === "user") {
              // String content — just append
              lastUserMsg.content = (lastUserMsg.content as string) + queuedNote;
            }

            // Persist queued messages to DB for history continuity
            this.db
              .prepare(
                `INSERT INTO main_agent_messages
                   (id, role, content, channel_id, token_estimate)
                 VALUES (?, 'user', ?, ?, ?)`,
              )
              .run(
                randomUUID(),
                `[New messages received during processing]\n\n${midLoopQueued}`,
                replyChannelId,
                Math.ceil(midLoopQueued.length / 4),
              );
            this.noteChannelProgress(replyChannelId);

            console.log(`[main-agent] Appended ${midLoopQueued.split("---").length - 1} queued message(s) to tool results for channel ${replyChannelId.slice(0, 8)}`);
            console.debug(
              `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
              `midloop_queue_appended=true`,
            );
          }

          // Flush any accumulated Discord tool step batch before looping back
          await this.flushDiscordToolBatch(replyChannelId);

          continue;
        }

        // In DM/Nexus, never suppress a response — override NO_REPLY
        const isDirectChat = channelChatType !== "group";
        const isNoReply = textResponse?.trim() === "NO_REPLY";
        const isRoutineHeartbeat = this.isRoutineHeartbeat(textResponse?.trim() || "");
        
        if (isNoReply && isDirectChat) {
          textResponse = "I'm here — what can I help with?";
        }
        console.debug(
          `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
          `final_candidate len=${textResponse.length} direct=${isDirectChat} ` +
          `no_reply=${isNoReply} heartbeat=${isRoutineHeartbeat}`,
        );

        // Flush any remaining Discord tool batch before final reply
        await this.flushDiscordToolBatch(replyChannelId);

        // Final text response
        if (
          textResponse &&
          !isRoutineHeartbeat &&
          !(isNoReply && !isDirectChat)
        ) {
          // Persist
          this.db
            .prepare(
              `INSERT INTO main_agent_messages
                 (id, role, content, channel_id, token_estimate)
               VALUES (?, 'assistant', ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              textResponse,
              replyChannelId,
              Math.ceil(textResponse.length / 4),
            );
          this.noteChannelProgress(replyChannelId);

          // Reply
          if (this.onReply) {
            await this.emitReply(replyChannelId, textResponse);
          }

          // Emit SSE event: assistant reply
          this.events.emit("stream", {
            type: "assistant_reply",
            channelId: replyChannelId,
            result: textResponse,
            timestamp: Date.now(),
          } satisfies AgentStreamEvent);
        } else if (isRoutineHeartbeat) {
          // Still persist routine heartbeats to DB for debugging, but don't send to Discord
          this.db
            .prepare(
              `INSERT INTO main_agent_messages
                 (id, role, content, channel_id, token_estimate)
               VALUES (?, 'assistant', ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              `[ROUTINE_HEARTBEAT] ${textResponse}`,
              replyChannelId,
              Math.ceil(textResponse.length / 4),
            );
          this.noteChannelProgress(replyChannelId);
          console.log(`[main-agent] Routine heartbeat logged but not sent to Discord: ${textResponse}`);
        }

        // Emit done event
        this.events.emit("stream", {
          type: "done",
          channelId: replyChannelId,
          timestamp: Date.now(),
        } satisfies AgentStreamEvent);
        console.log(
          `[main-agent] Processing completed for ${this.channelTag(replyChannelId)} session=${sessionId} ` +
          `in ${Date.now() - conversationStartedAt}ms`,
        );
        this.conversationRetryCount.delete(replyChannelId);

        // Auto-generate/update session title in the background
        this.maybeUpdateSessionTitle(replyChannelId).catch((e) =>
          console.error(`[main-agent] Title generation failed for ${replyChannelId}:`, e)
        );
        console.debug(
          `[main-agent.loop] channel=${replyChannelId} completed iter=${loopIteration} ` +
          `duration_ms=${Date.now() - conversationStartedAt}`,
        );
        break; // Done
      }
    } catch (err) {
      console.error("[main-agent] Error in conversation loop:", err);
      // Flush any remaining Discord tool batch
      await this.flushDiscordToolBatch(replyChannelId).catch(() => {});

      const errStr = String(err);
      const isTransient = errStr.includes("500") || errStr.includes("api_error") ||
        errStr.includes("overloaded") || errStr.includes("rate_limit") || errStr.includes("429") ||
        errStr.includes("529");
      const retryAfterMs = this.extractRetryAfterMs(errStr);
      const isRateLimit = errStr.includes("rate_limit") || errStr.includes("429");

      const currentRetries = this.conversationRetryCount.get(replyChannelId) ?? 0;

      // Mark for conversation-level retry (handled in finally block)
      if (isTransient && currentRetries < 2) {
        const retryNum = currentRetries + 1;
        this.conversationRetryCount.set(replyChannelId, retryNum);
        const retryDelay = isRateLimit && retryAfterMs
          ? retryAfterMs
          : (10 + Math.random() * 20) * 1000 * retryNum; // 10-30s * attempt
        console.log(`[main-agent] Transient error, scheduling retry in ${(retryDelay / 1000).toFixed(0)}s (retry ${retryNum}/2) for channel ${replyChannelId.slice(0, 12)}`);

        // Emit a temporary status so frontend knows we're retrying, not dead
        const isOverloaded = errStr.includes("overloaded");
        this.events.emit("stream", {
          type: "error",
          channelId: replyChannelId,
          result: isRateLimit
            ? `⏳ Rate limited — retrying in ${Math.round(retryDelay / 1000)}s...`
            : isOverloaded
            ? `⏳ API overloaded — retrying in ${Math.round(retryDelay / 1000)}s...`
            : `⏳ API error — retrying in ${Math.round(retryDelay / 1000)}s...`,
          timestamp: Date.now(),
        } satisfies AgentStreamEvent);

        // Schedule retry — runs after finally block releases the channel
        this.pendingRetryDelay.set(replyChannelId, retryDelay);
      } else {
        if (isTransient) {
          console.warn(
            `[main-agent] Transient error will not be retried for ${replyChannelId.slice(0, 12)} ` +
            `(retry budget exhausted: ${currentRetries}/2)`,
          );
        }
        // Clear retry counter — either not transient or retries exhausted
        this.conversationRetryCount.delete(replyChannelId);

        // Emit error event
        this.events.emit("stream", {
          type: "error",
          channelId: replyChannelId,
          result: errStr.substring(0, 500),
          timestamp: Date.now(),
        } satisfies AgentStreamEvent);
        try {
          if (this.onReply) {
            let friendlyMsg: string;
            if (errStr.includes("500") && errStr.includes("api_error")) {
              friendlyMsg = "⚠️ The AI provider (Anthropic) is having issues — try again in a minute.";
            } else if (errStr.includes("overloaded")) {
              friendlyMsg = "⚠️ The AI provider is overloaded — try again in a minute.";
            } else if (errStr.includes("rate_limit") || errStr.includes("429")) {
              friendlyMsg = "⚠️ Rate limited — try again shortly.";
            } else {
              friendlyMsg = `❌ Error: ${errStr.substring(0, 200)}`;
            }
            await this.emitReply(replyChannelId, friendlyMsg);
          }
        } catch (replyErr) {
          console.error("[main-agent] Failed to send error reply:", replyErr);
        }
      }
    } finally {
      clearTimeout(conversationTimeout);
      if (!this.isActiveChannelRun(replyChannelId, runId)) {
        return;
      }
      // Mark this channel as no longer processing
      this.processingChannels.delete(replyChannelId);
      this.channelLastProgressAt.delete(replyChannelId);
      this.channelLastSessionHeartbeatAt.delete(replyChannelId);
      console.log(
        `[main-agent] Processing released for ${this.channelTag(replyChannelId)} session=${sessionId} ` +
        `(active=${this.processingChannels.size}/${MAX_CONCURRENT_CHANNELS}, queued=${this.getQueueDepth()})`,
      );

      // Check for pending retry (transient API errors)
      const pendingDelay = this.pendingRetryDelay.get(replyChannelId);
      if (pendingDelay) {
        this.pendingRetryDelay.delete(replyChannelId);
        this.scheduleConversationRetry(replyChannelId, pendingDelay);
        // Still do queue draining below so other channels can start
      }
      
      // Cleanup idle channel metadata periodically (prevent memory leak of old channel info)
      if (this.channelChatType.size > 100) {
        // Keep only channels that still have queued messages or are in DB as active
        const activeChannelIds = new Set(this.channelQueues.keys());
        for (const [chId, _] of this.channelChatType) {
          if (!activeChannelIds.has(chId)) {
            this.channelChatType.delete(chId);
          }
        }
      }

      // Mark persisted queue as processed for this channel (skip if retrying)
      if (!pendingDelay && !conversationTimedOut) {
        this.markQueueProcessed(replyChannelId);
      }

      // Process queued messages for this channel (skip if we have a pending retry
      // or if the current run was force-released on timeout).
      const channelQueue = !pendingDelay && !conversationTimedOut
        ? this.channelQueues.get(replyChannelId)
        : undefined;
      if (channelQueue && channelQueue.length > 0) {
        console.log(
          `[main-agent.queue] channel=${this.channelTag(replyChannelId)} draining_next=true depth=${channelQueue.length}`,
        );
        const nextMsg = channelQueue.shift()!;
        if (channelQueue.length === 0) {
          this.channelQueues.delete(replyChannelId);
        }
        
        this.promoteQueuedMessage(nextMsg, "same-channel-drain");
        
        this.updateChannelSession(replyChannelId, "processing", nextMsg.authorId, nextMsg.authorName);
        await this.processConversation(replyChannelId);
        return;
      }

      // No more queued messages — mark channel idle (skip if pending retry)
      if (!pendingDelay && !conversationTimedOut) {
        this.updateChannelSession(replyChannelId, "idle");
      }

      // Fill all available concurrency slots from queued channels
      for (const [channelId, queue] of this.channelQueues.entries()) {
        if (this.processingChannels.size >= MAX_CONCURRENT_CHANNELS) break;
        if (queue.length > 0 && !this.processingChannels.has(channelId)) {
          console.log(
            `[main-agent.queue] channel=${this.channelTag(channelId)} cross_channel_dispatch depth=${queue.length}`,
          );
          const nextMsg = queue.shift()!;
          if (queue.length === 0) {
            this.channelQueues.delete(channelId);
          }
          
          this.promoteQueuedMessage(nextMsg, "cross-channel-dispatch");
          
          this.updateChannelSession(channelId, "processing", nextMsg.authorId, nextMsg.authorName);
          // Don't await — fire concurrently so we fill all slots
          this.processConversation(channelId).catch((err) =>
            console.error(`[main-agent] Error processing queued channel ${channelId}:`, err),
          );
        }
      }
    }
  }

  private scheduleConversationRetry(channelId: string, delayMs: number): void {
    console.log(
      `[main-agent.retry] channel=${this.channelTag(channelId)} scheduled delay_ms=${Math.round(delayMs)}`,
    );
    setTimeout(() => {
      if (this.processingChannels.has(channelId)) {
        console.warn(`[main-agent.retry] channel=${this.channelTag(channelId)} skipped_already_processing=true`);
        return;
      }

      if (this.processingChannels.size >= MAX_CONCURRENT_CHANNELS) {
        console.log(`[main-agent] Retry deferred for ${channelId.slice(0, 12)} — at capacity`);
        this.updateChannelSession(channelId, "queued");
        this.scheduleConversationRetry(channelId, 5000);
        return;
      }

      this.updateChannelSession(channelId, "processing");
      console.log(`[main-agent.retry] channel=${this.channelTag(channelId)} retry_start=true`);
      this.processConversation(channelId).catch(err => {
        console.error(`[main-agent] Conversation retry failed for ${channelId.slice(0, 12)}:`, err);
        this.conversationRetryCount.delete(channelId);
        this.processingChannels.delete(channelId);
        this.updateChannelSession(channelId, "idle");
      });
    }, delayMs);
  }

  private beginChannelRun(channelId: string): number {
    const runId = (this.channelRunIds.get(channelId) ?? 0) + 1;
    this.channelRunIds.set(channelId, runId);
    return runId;
  }

  private isActiveChannelRun(channelId: string, runId: number): boolean {
    return this.channelRunIds.get(channelId) === runId;
  }

  private noteChannelProgress(channelId: string): void {
    const now = Date.now();
    this.channelLastProgressAt.set(channelId, now);
    const lastHeartbeatAt = this.channelLastSessionHeartbeatAt.get(channelId) ?? 0;
    if (now - lastHeartbeatAt >= CHANNEL_PROGRESS_HEARTBEAT_MS) {
      this.channelLastSessionHeartbeatAt.set(channelId, now);
      this.updateChannelSession(channelId, "processing");
    }
  }

  private getStaleProcessingReason(channelId: string, thresholdMs: number): string | null {
    if (!this.processingChannels.has(channelId)) return null;

    const lastProgressAt = this.channelLastProgressAt.get(channelId);
    if (!lastProgressAt) return null;

    const stalledForMs = Date.now() - lastProgressAt;
    if (stalledForMs < thresholdMs) return null;

    return `no progress for ${Math.round(stalledForMs / 1000)}s`;
  }

  private recoverStaleChannel(channelId: string, reason: string): void {
    console.warn(`[main-agent] Recovering stale channel ${this.channelTag(channelId)}: ${reason}`);
    this.channelRunIds.set(channelId, (this.channelRunIds.get(channelId) ?? 0) + 1);
    this.processingChannels.delete(channelId);
    this.pendingRetryDelay.delete(channelId);
    this.conversationRetryCount.delete(channelId);
    this.channelLastProgressAt.delete(channelId);
    this.channelLastSessionHeartbeatAt.delete(channelId);

    const recoveryMessage = `⚠️ Previous run was interrupted after ${reason}. Starting a fresh turn with your latest message.`;
    this.db
      .prepare(
        `INSERT INTO main_agent_messages
           (id, role, content, channel_id, token_estimate)
         VALUES (?, 'assistant', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        recoveryMessage,
        channelId,
        Math.ceil(recoveryMessage.length / 4),
      );

    this.events.emit("stream", {
      type: "error",
      channelId,
      result: recoveryMessage,
      timestamp: Date.now(),
    } satisfies AgentStreamEvent);

    this.updateChannelSession(channelId, "idle");
  }

  private recoverStaleProcessingChannels(): void {
    for (const channelId of this.processingChannels) {
      const staleReason = this.getStaleProcessingReason(channelId, STALE_AUTO_RECOVERY_MS);
      if (!staleReason) continue;
      this.recoverStaleChannel(channelId, staleReason);
    }
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  private getRecentHistory(channelId: string): Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
    created_at: string;
    metadata?: string | null;
  }> {
    // Check for existing compaction summary
    const compaction = this.db.prepare(
      `SELECT id, summary, up_to_created_at FROM compaction_summaries
       WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(channelId) as { id: string; summary: string; up_to_created_at: string } | undefined;

    let rows: Array<{ role: string; content: string; created_at: string; metadata: string | null }>;

    if (compaction) {
      // Load only messages AFTER the compaction boundary
      rows = this.db
        .prepare(
          `SELECT role, content, created_at, metadata FROM main_agent_messages
           WHERE channel_id = ? AND created_at > ?
           ORDER BY created_at ASC LIMIT 200`,
        )
        .all(channelId, compaction.up_to_created_at) as typeof rows;
    } else {
      // No compaction — load all (up to 200)
      rows = this.db
        .prepare(
          `SELECT role, content, created_at, metadata FROM main_agent_messages
           WHERE channel_id = ?
           ORDER BY created_at DESC LIMIT 200`,
        )
        .all(channelId) as typeof rows;

      rows.reverse(); // chronological
    }

    // Reconstruct structured content blocks from metadata when available
    const reconstructed = rows.map(row => {
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);

          // Reconstruct assistant tool_use blocks
          if (meta.toolUseBlocks && row.role === 'assistant') {
            const contentBlocks: Array<Record<string, unknown>> = [];
            if (meta.textContent) {
              contentBlocks.push({ type: 'text', text: meta.textContent });
            }
            for (const block of meta.toolUseBlocks) {
              contentBlocks.push({
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input,
              });
            }
            return { ...row, content: contentBlocks as string | Array<Record<string, unknown>> };
          }

          // Reconstruct user tool_result blocks
          if (meta.toolResults && row.role === 'user') {
            const contentBlocks: Array<Record<string, unknown>> = meta.toolResults.map((tr: any) => ({
              type: 'tool_result',
              tool_use_id: tr.tool_use_id,
              content: tr.content,
              is_error: tr.is_error || false,
            }));
            return { ...row, content: contentBlocks as string | Array<Record<string, unknown>> };
          }
        } catch { /* invalid metadata, fall through to text */ }
      }
      return row as { role: string; content: string | Array<Record<string, unknown>>; created_at: string; metadata: string | null };
    });

    // Prepend compaction summary if we have one
    if (compaction) {
      const summaryMessages: Array<{
        role: string;
        content: string | Array<Record<string, unknown>>;
        created_at: string;
        metadata?: string | null;
      }> = [
        {
          role: "user",
          content: `[Conversation summary — earlier messages compacted]\n\n${compaction.summary}`,
          created_at: compaction.up_to_created_at,
          metadata: null,
        },
      ];
      // Add assistant ack if the first real message isn't assistant (avoid consecutive same-role)
      if (reconstructed.length === 0 || reconstructed[0].role !== "assistant") {
        summaryMessages.push({
          role: "assistant",
          content: "Understood, I have the context from the summary. Continuing.",
          created_at: compaction.up_to_created_at,
          metadata: null,
        });
      }
      return [...summaryMessages, ...reconstructed];
    }

    return reconstructed;
  }

  /**
   * Merge consecutive messages with the same role into a single message.
   * The Anthropic API requires strictly alternating user/assistant roles.
   * Multi-step tool use gets persisted as separate assistant rows in the DB,
   * which creates invalid runs of same-role messages when loaded back.
   *
   * Also ensures the first message is always a user message (drops leading
   * assistant messages if any, since they'd be orphaned tool call summaries).
   */
  /**
   * Validate message array for Anthropic API requirements.
   * Returns null if valid, or a string describing the problem.
   */
  private validateMessages(messages: LLMMessage[]): string | null {
    if (messages.length === 0) return "empty message array";
    
    // First message must be user
    if (messages[0].role !== "user") {
      return `first message is ${messages[0].role}, must be user`;
    }

    // Last message must be user (models like Opus 4.6 reject assistant prefill)
    if (messages[messages.length - 1].role !== "user") {
      return `last message is ${messages[messages.length - 1].role}, must be user (no assistant prefill)`;
    }
    
    // Must alternate roles (no consecutive same-role)
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === messages[i - 1].role) {
        return `consecutive ${messages[i].role} at index ${i - 1} and ${i}`;
      }
    }

    // Check for tool_result blocks that reference tool_use IDs
    // A user message with tool_result must follow an assistant message with matching tool_use
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const toolUses = (m.content as any[]).filter((b: any) => b.type === "tool_use");
        if (toolUses.length > 0) {
          const next = messages[i + 1];
          if (!next) {
            return `assistant tool_use at index ${i} has no following user tool_result message`;
          }
          if (next.role !== "user") {
            return `assistant tool_use at index ${i} followed by ${next.role} instead of user tool_result message`;
          }
          if (!Array.isArray(next.content)) {
            return `assistant tool_use at index ${i} followed by plain-text user message instead of tool_result blocks`;
          }

          const nextBlocks = next.content as any[];
          const toolResults = nextBlocks.filter((b: any) => b.type === "tool_result");
          if (toolResults.length === 0) {
            return `assistant tool_use at index ${i} not followed by tool_result blocks`;
          }

          const firstNonToolResult = nextBlocks.findIndex((b: any) => b.type !== "tool_result");
          if (firstNonToolResult !== -1) {
            const laterToolResult = nextBlocks
              .slice(firstNonToolResult + 1)
              .some((b: any) => b.type === "tool_result");
            if (firstNonToolResult === 0 || laterToolResult) {
              return `tool_result blocks at index ${i + 1} must come before any other user content`;
            }
          }

          const toolUseIds = new Set(toolUses.map((b: any) => b.id));
          for (const tr of toolResults) {
            if (!toolUseIds.has(tr.tool_use_id)) {
              return `tool_result references tool_use_id=${tr.tool_use_id} not found in preceding assistant message at index ${i}`;
            }
          }
        }
      }

      if (m.role === "user" && Array.isArray(m.content)) {
        const toolResults = (m.content as any[]).filter((b: any) => b.type === "tool_result");
        if (toolResults.length > 0) {
          if (i === 0) {
            return "tool_result at index 0 cannot be first message";
          }

          const prev = messages[i - 1];
          if (prev.role !== "assistant") {
            return `tool_result at index ${i} not preceded by assistant`;
          }
          // Check if the preceding assistant had matching tool_use blocks
          if (Array.isArray(prev.content)) {
            const toolUseIds = new Set((prev.content as any[]).filter((b: any) => b.type === "tool_use").map((b: any) => b.id));
            for (const tr of toolResults) {
              if (!toolUseIds.has(tr.tool_use_id)) {
                return `tool_result references tool_use_id=${tr.tool_use_id} not found in preceding assistant message at index ${i - 1}`;
              }
            }
          } else {
            // assistant content is a string but user has tool_result — that's broken
            return `tool_result at index ${i} but preceding assistant message is plain text`;
          }
        }
      }
    }

    return null;
  }

  /**
   * Emergency repair: strip orphaned tool_use and tool_result blocks
   * that would cause 400 errors from the API. This is a last-resort
   * safety net — the upstream pipeline should ideally prevent this.
   */
  private emergencyRepairToolPairs(messages: LLMMessage[]): LLMMessage[] {
    const result: LLMMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Fix orphaned tool_use: assistant has tool_use but next user has no matching tool_result
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const toolUseBlocks = (msg.content as any[]).filter((b: any) => b.type === "tool_use");
        if (toolUseBlocks.length > 0) {
          const next = messages[i + 1];
          const nextToolResultIds = new Set<string>();
          if (next?.role === "user" && Array.isArray(next.content)) {
            for (const b of next.content as any[]) {
              if ((b as any).type === "tool_result") nextToolResultIds.add((b as any).tool_use_id);
            }
          }
          const orphaned = toolUseBlocks.filter((b: any) => !nextToolResultIds.has(b.id));
          if (orphaned.length > 0) {
            const orphanedIds = new Set(orphaned.map((b: any) => b.id));
            const kept = (msg.content as any[]).filter((b: any) => b.type !== "tool_use" || !orphanedIds.has(b.id));
            if (kept.length > 0) {
              result.push({ ...msg, content: this.normalizeUserContentBlocks(kept as any) as any });
            } else {
              result.push({ ...msg, content: "[Tool calls were interrupted and results are unavailable]" });
            }
            continue;
          }
        }
      }

      // Fix orphaned tool_result: user has tool_result but prev assistant has no matching tool_use
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const toolResultBlocks = (msg.content as any[]).filter((b: any) => b.type === "tool_result");
        if (toolResultBlocks.length > 0) {
          const prev = result[result.length - 1];
          const prevToolUseIds = new Set<string>();
          if (prev?.role === "assistant" && Array.isArray(prev.content)) {
            for (const b of prev.content as any[]) {
              if ((b as any).type === "tool_use") prevToolUseIds.add((b as any).id);
            }
          }
          const orphaned = toolResultBlocks.filter((b: any) => !prevToolUseIds.has(b.tool_use_id));
          if (orphaned.length > 0) {
            const orphanedIds = new Set(orphaned.map((b: any) => b.tool_use_id));
            const kept = (msg.content as any[]).filter((b: any) => b.type !== "tool_result" || !orphanedIds.has(b.tool_use_id));
            if (kept.length > 0) {
              result.push({ ...msg, content: this.normalizeUserContentBlocks(kept as any) as any });
            } else {
              result.push({ ...msg, content: "[Earlier tool results — matching tool calls were compacted]" });
            }
            continue;
          }
        }
      }

      result.push(msg);
    }

    return this.normalizeToolProtocolMessages(result);
  }

  private normalizeUserContentBlocks(
    content: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const toolResults = content.filter((b: any) => b.type === "tool_result");
    if (toolResults.length === 0) return content;

    const otherBlocks = content.filter((b: any) => b.type !== "tool_result");
    return [...toolResults, ...otherBlocks];
  }

  private normalizeToolProtocolMessages(messages: LLMMessage[]): LLMMessage[] {
    return messages.map((message) => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return message;
      }

      const normalized = this.normalizeUserContentBlocks(
        message.content as Array<Record<string, unknown>>,
      );
      if (normalized === message.content) {
        return message;
      }
      return { ...message, content: normalized };
    });
  }

  private mergeConsecutiveRoles(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return messages;

    // Drop leading assistant messages — API requires first message to be user
    while (messages.length > 0 && messages[0].role === "assistant") {
      messages.shift();
    }

    // Drop trailing assistant messages — models like Opus 4.6 reject assistant prefill
    while (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      messages.pop();
    }

    if (messages.length <= 1) return messages;

    // First pass: identify runs of consecutive same-role messages
    const runs: Array<{ role: string; indices: number[] }> = [];
    for (let i = 0; i < messages.length; i++) {
      const lastRun = runs[runs.length - 1];
      if (lastRun && messages[i].role === lastRun.role) {
        lastRun.indices.push(i);
      } else {
        runs.push({ role: messages[i].role, indices: [i] });
      }
    }

    // Log if we find long runs (indicates DB alternation issue)
    for (const run of runs) {
      if (run.indices.length > 3) {
        console.warn(
          `[main-agent] Found ${run.indices.length} consecutive ${run.role} messages ` +
          `(indices ${run.indices[0]}-${run.indices[run.indices.length - 1]}). ` +
          `This indicates broken DB alternation — tool results weren't persisted as user messages.`
        );
      }
    }

    // Second pass: merge runs, but truncate aggressively for long runs
    const merged: LLMMessage[] = [];
    for (const run of runs) {
      if (run.indices.length === 1) {
        merged.push({ ...messages[run.indices[0]] });
        continue;
      }

      // For long runs (>5 messages), keep only the last 3 fully and summarize the rest
      const MAX_FULL_KEEP = 3;
      const MAX_MERGED_CHARS = 8000; // Cap total merged content at 8K chars

      const runMessages = run.indices.map(i => messages[i]);
      
      if (runMessages.length <= MAX_FULL_KEEP) {
        // Short run — concatenate, handling both string and array content
        const hasArrayContent = runMessages.some(m => Array.isArray(m.content));
        if (hasArrayContent) {
          // Flatten all content into a single array of content blocks
          const blocks: Array<Record<string, unknown>> = [];
          for (const m of runMessages) {
            if (Array.isArray(m.content)) {
              blocks.push(...(m.content as Array<Record<string, unknown>>));
            } else if (typeof m.content === "string" && m.content) {
              blocks.push({ type: "text", text: m.content });
            }
          }
          const normalizedBlocks = run.role === "user"
            ? this.normalizeUserContentBlocks(blocks)
            : blocks;
          merged.push({ role: run.role as "user" | "assistant", content: normalizedBlocks });
        } else {
          let content = "";
          for (const m of runMessages) {
            if (typeof m.content === "string") {
              content += (content ? "\n\n" : "") + m.content;
            }
          }
          merged.push({ role: run.role as "user" | "assistant", content });
        }
        continue;
      }

      // Long run — keep last MAX_FULL_KEEP, truncate or drop older ones
      const oldMessages = runMessages.slice(0, -MAX_FULL_KEEP);
      const recentMessages = runMessages.slice(-MAX_FULL_KEEP);

      if (run.role === "user") {
        const toolProtocolMessages = runMessages.filter(
          (m) => Array.isArray(m.content) && (m.content as any[]).some((b: any) => b.type === "tool_result"),
        );

        if (toolProtocolMessages.length > 0) {
          const protocolSet = new Set(toolProtocolMessages);
          const recentNonProtocol = runMessages
            .filter((m) => !protocolSet.has(m))
            .slice(-MAX_FULL_KEEP);
          const summarizedCount = runMessages.length - toolProtocolMessages.length - recentNonProtocol.length;
          const blocks: Array<Record<string, unknown>> = [];

          for (const message of toolProtocolMessages) {
            if (Array.isArray(message.content)) {
              blocks.push(...this.normalizeUserContentBlocks(message.content as Array<Record<string, unknown>>));
            }
          }

          if (summarizedCount > 0) {
            blocks.push({
              type: "text",
              text: `[${summarizedCount} earlier user messages merged — tool call summaries from before restart]`,
            });
          }

          for (const message of recentNonProtocol) {
            if (Array.isArray(message.content)) {
              blocks.push(...this.normalizeUserContentBlocks(message.content as Array<Record<string, unknown>>));
            } else if (typeof message.content === "string" && message.content) {
              blocks.push({ type: "text", text: message.content });
            }
          }

          merged.push({
            role: "user",
            content: this.normalizeUserContentBlocks(blocks),
          });
          continue;
        }
      }

      // Check if recent messages have structured content blocks
      const recentHasArrayContent = recentMessages.some(m => Array.isArray(m.content));

      if (recentHasArrayContent) {
        // Preserve structured content: build summary text for old + flatten recent as blocks
        const summaryText = `[${oldMessages.length} earlier ${run.role} messages merged — tool call summaries from before restart]`;
        const blocks: Array<Record<string, unknown>> = [];
        for (const m of recentMessages) {
          if (Array.isArray(m.content)) {
            blocks.push(...(m.content as Array<Record<string, unknown>>));
          } else if (typeof m.content === "string" && m.content) {
            blocks.push({ type: "text", text: m.content });
          }
        }
        if (run.role === "user") {
          blocks.push({ type: "text", text: summaryText });
          merged.push({
            role: run.role as "user" | "assistant",
            content: this.normalizeUserContentBlocks(blocks),
          });
        } else {
          blocks.unshift({ type: "text", text: summaryText });
          merged.push({ role: run.role as "user" | "assistant", content: blocks });
        }
      } else {
        let content = `[${oldMessages.length} earlier ${run.role} messages merged — tool call summaries from before restart]\n`;
        // Add a brief excerpt from the old messages (just first 200 chars each, max 2000 total)
        let oldContent = "";
        for (const m of oldMessages) {
          const mText = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          const excerpt = mText.slice(0, 200);
          if (oldContent.length + excerpt.length < 2000) {
            oldContent += excerpt + "\n";
          }
        }
        if (oldContent) {
          content += oldContent;
        }
        
        // Add recent messages fully
        for (const m of recentMessages) {
          if (typeof m.content === "string") {
            content += "\n\n" + m.content;
          }
        }

        // Hard cap on total merged content
        if (content.length > MAX_MERGED_CHARS) {
          content = content.slice(-MAX_MERGED_CHARS);
        }

        merged.push({ role: run.role as "user" | "assistant", content });
      }
    }
    return this.normalizeToolProtocolMessages(merged);
  }

  /**
   * Sanitize tool call/result text in DB history so the model doesn't confuse
   * persisted text-format tool records with actual structured tool_use blocks.
   *
   * Problem: During the agent loop, tool calls use structured tool_use/tool_result
   * blocks (the Claude API's native format). But when persisted to DB, they're stored
   * as plain text like "[Tool calls]\n[exec] {\"command\": \"ls\"}". When loaded back
   * in subsequent turns, the model sees its own prior tool usage as TEXT output, which
   * teaches it to emit tool calls as text instead of using the structured API. After a
   * few turns of this, the agent loop breaks — the model outputs tool call text instead
   * of tool_use blocks, so no tools get executed.
   *
   * Fix: Rewrite these patterns into natural language summaries that the model won't
   * try to imitate as a tool-calling format.
   */

  /**
   * Repair orphaned tool_use blocks that don't have matching tool_result blocks.
   * This happens when the agent crashes or restarts mid-tool-loop — tool_use gets
   * persisted but tool_result never does. The Anthropic API rejects these with:
   * "tool_use ids were found without tool_result blocks immediately after"
   *
   * Strategy: For each assistant message with tool_use blocks, check if the next
   * message is a user message with matching tool_result blocks. If not, either:
   * - Strip the tool_use blocks (keeping any text content)
   * - Or if the message would be empty, inject a synthetic tool_result
   */
  private repairOrphanedToolUse(
    messages: Array<{ role: string; content: string | Array<Record<string, unknown>>; created_at: string; metadata?: string | null }>,
  ): Array<{ role: string; content: string | Array<Record<string, unknown>>; created_at: string; metadata?: string | null }> {
    const result: typeof messages = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Only check assistant messages with structured content containing tool_use
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const toolUseBlocks = (msg.content as any[]).filter((b: any) => b.type === "tool_use");

        if (toolUseBlocks.length > 0) {
          // Check if the next message has matching tool_results
          const next = messages[i + 1];
          const nextToolResultIds = new Set<string>();

          if (next?.role === "user" && Array.isArray(next.content)) {
            for (const b of next.content as any[]) {
              if (b.type === "tool_result") {
                nextToolResultIds.add(b.tool_use_id);
              }
            }
          } else if (next?.role === "user" && typeof next.content === "string" && next.content.startsWith("[Tool results]")) {
            // Text-format tool results — extract tool_use_ids from [toolu_xxx] lines
            const lines = next.content.split("\n");
            for (const line of lines) {
              const match = line.match(/^\[(toolu_\w+)\]/);
              if (match) nextToolResultIds.add(match[1]);
            }
          }

          // Find orphaned tool_use blocks (no matching tool_result)
          const orphanedIds = toolUseBlocks
            .filter((b: any) => !nextToolResultIds.has(b.id))
            .map((b: any) => b.id);

          if (orphanedIds.length > 0) {
            const orphanedSet = new Set(orphanedIds);
            const orphanedBlocks = toolUseBlocks.filter((b: any) => orphanedSet.has(b.id));
            console.warn(
              `[main-agent.repair] Fixing ${orphanedIds.length} orphaned tool_use block(s) at message ${i}: ` +
              orphanedBlocks.map((b: any) => `${b.name}(${b.id})`).join(", ")
            );

            // Keep non-tool_use content (text blocks)
            const nonToolContent = (msg.content as any[]).filter(
              (b: any) => b.type !== "tool_use" || !orphanedSet.has(b.id)
            );

            if (nonToolContent.length > 0) {
              // Strip orphaned tool_use blocks, keep the rest
              result.push({ ...msg, content: nonToolContent });
            } else {
              // Entire message was tool_use blocks — replace with a text note
              result.push({
                ...msg,
                content: "[Tool calls were interrupted by a restart and their results are unavailable]",
              });
            }

            // If ALL tool_use blocks are orphaned, we also need to handle the case
            // where the next message is a partial tool_result (some matched, some didn't)
            // That case is handled naturally since we only strip orphaned ones.
            continue;
          }
        }
      }

      // Also handle text-format tool calls in assistant messages
      if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.includes("[Tool calls]")) {
        const next = messages[i + 1];
        const hasToolResults = next?.role === "user" && (
          (typeof next.content === "string" && next.content.startsWith("[Tool results]")) ||
          (Array.isArray(next.content) && (next.content as any[]).some((b: any) => b.type === "tool_result"))
        );

        if (!hasToolResults) {
          // Text-format tool calls with no results — strip the tool call section
          const lines = msg.content.split("\n");
          const textLines: string[] = [];
          let inToolSection = false;
          for (const line of lines) {
            if (line.trim() === "[Tool calls]") {
              inToolSection = true;
              continue;
            }
            if (inToolSection && line.match(/^\[[\w]+\]/)) continue;
            if (inToolSection && !line.match(/^\[[\w]+\]/)) inToolSection = false;
            if (!inToolSection) textLines.push(line);
          }
          const remaining = textLines.join("\n").trim();
          console.warn(`[main-agent.repair] Stripping orphaned text-format tool calls at message ${i}`);
          result.push({
            ...msg,
            content: remaining || "[Tool calls were interrupted by a restart and their results are unavailable]",
          });
          continue;
        }
      }

      result.push(msg);
    }

    // Second pass: fix orphaned tool_result blocks (user message has tool_results
    // but the preceding assistant message has no matching tool_use blocks).
    // This can happen when budget trimming drops the assistant but keeps the user,
    // or when the assistant's metadata was lost/corrupted.
    const finalResult: typeof result = [];
    for (let i = 0; i < result.length; i++) {
      const msg = result[i];

      if (msg.role === "user" && Array.isArray(msg.content)) {
        const toolResultBlocks = (msg.content as any[]).filter((b: any) => b.type === "tool_result");

        if (toolResultBlocks.length > 0) {
          const prev = finalResult[finalResult.length - 1];
          const prevToolUseIds = new Set<string>();

          if (prev?.role === "assistant" && Array.isArray(prev.content)) {
            for (const b of prev.content as any[]) {
              if (b.type === "tool_use") prevToolUseIds.add(b.id);
            }
          }

          // Find tool_results that have no matching tool_use
          const orphanedResults = toolResultBlocks.filter(
            (b: any) => !prevToolUseIds.has(b.tool_use_id)
          );

          if (orphanedResults.length > 0) {
            console.warn(
              `[main-agent.repair] Fixing ${orphanedResults.length} orphaned tool_result block(s) at message ${i}: ` +
              orphanedResults.map((b: any) => b.tool_use_id).join(", ")
            );

            const orphanedIds = new Set(orphanedResults.map((b: any) => b.tool_use_id));
            const keptContent = (msg.content as any[]).filter(
              (b: any) => b.type !== "tool_result" || !orphanedIds.has(b.tool_use_id)
            );

            if (keptContent.length > 0) {
              finalResult.push({ ...msg, content: keptContent });
            } else {
              // All content was orphaned tool_results — convert to a text summary
              const summary = orphanedResults.map((b: any) => {
                const preview = typeof b.content === "string"
                  ? b.content.substring(0, 200)
                  : "[tool output]";
                return `${b.is_error ? "Error: " : ""}${preview}`;
              }).join("\n");
              finalResult.push({
                ...msg,
                content: `[Earlier tool results — matching tool calls were compacted]\n${summary}`,
              });
            }
            continue;
          }
        }
      }

      finalResult.push(msg);
    }

    return finalResult;
  }

  private sanitizeToolHistory(
    messages: Array<{ role: string; content: string | Array<Record<string, unknown>>; created_at: string; metadata?: string | null }>,
  ): Array<{ role: string; content: string | Array<Record<string, unknown>>; created_at: string; metadata?: string | null }> {
    return messages.map((m) => {
      // Skip non-string content (already structured tool blocks reconstructed from metadata)
      if (typeof m.content !== 'string') return m;

      let content = m.content;

      if (m.role === "assistant" && content.includes("[Tool calls]")) {
        // Rewrite "[Tool calls]\n[tool_name] {input}" → natural language summary
        // Extract tool names from lines like "[exec] {\"command\": ...}"
        const lines = content.split("\n");
        const toolCallLines: string[] = [];
        const textLines: string[] = [];
        let inToolSection = false;

        for (const line of lines) {
          if (line.trim() === "[Tool calls]") {
            inToolSection = true;
            continue;
          }
          if (inToolSection) {
            const toolMatch = line.match(/^\[(\w+)\]\s*(.*)/);
            if (toolMatch) {
              const toolName = toolMatch[1];
              // Extract just the key parameter for context
              let paramHint = "";
              try {
                const inputStr = toolMatch[2];
                const parsed = JSON.parse(inputStr.replace(/\.\.\.$/,""));
                // Pick the most informative param
                if (parsed.command) paramHint = `: ${parsed.command.substring(0, 80)}`;
                else if (parsed.path) paramHint = `: ${parsed.path}`;
                else if (parsed.pattern) paramHint = `: pattern "${parsed.pattern}"`;
                else if (parsed.query) paramHint = `: "${parsed.query.substring(0, 60)}"`;
                else if (parsed.url) paramHint = `: ${parsed.url.substring(0, 80)}`;
                else if (parsed.content) paramHint = ` (writing content)`;
              } catch {
                // Can't parse — just use tool name
              }
              toolCallLines.push(`${toolName}${paramHint}`);
            }
          } else {
            textLines.push(line);
          }
        }

        // Reconstruct: keep the text the model said, then summarize tool usage
        const textPart = textLines.join("\n").trim();
        const toolSummary = toolCallLines.length > 0
          ? `[Used tools: ${toolCallLines.join(", ")}]`
          : "";
        content = [textPart, toolSummary].filter(Boolean).join("\n\n");
      }

      if (m.role === "user" && content.startsWith("[Tool results]")) {
        // Rewrite tool result messages into a brief summary
        // These are the text-format persisted versions of tool_result blocks
        const lines = content.split("\n").slice(1); // skip the "[Tool results]" header
        const resultSummaries: string[] = [];

        for (const line of lines) {
          // Lines look like: [toolu_xxx] result text... or [toolu_xxx] ERROR: ...
          const resultMatch = line.match(/^\[toolu_\w+\]\s*(ERROR:\s*)?(.*)/);
          if (resultMatch) {
            const isError = Boolean(resultMatch[1]);
            const preview = resultMatch[2].substring(0, 150);
            resultSummaries.push(isError ? `Error: ${preview}` : preview);
          }
        }

        content = resultSummaries.length > 0
          ? `[Tool outputs: ${resultSummaries.join(" | ")}]`
          : "[Tool execution completed]";
      }

      if (content === m.content) return m;
      return { ...m, content };
    });
  }

  private pruneHistory(
    messages: Array<{ role: string; content: string | Array<Record<string, unknown>>; created_at: string; metadata?: string | null }>,
  ): Array<{ role: string; content: string | Array<Record<string, unknown>>; created_at: string; metadata?: string | null }> {
    const KEEP_RECENT = 8; // Keep last 8 assistant turns fully intact
    const MAX_TOOL_OUTPUT = 500; // Truncate old tool outputs to this many chars
    const PLACEHOLDER =
      "[Earlier tool output removed to save context. Re-run the tool if needed.]";

    // Count assistant turns from the end
    let assistantCount = 0;
    let keepFullFrom = 0; // index from which we keep full

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        assistantCount++;
        if (assistantCount >= KEEP_RECENT) {
          // Everything before this index gets pruned
          keepFullFrom = i;
          break;
        }
      }
    }

    return messages.map((m, i) => {
      if (i >= keepFullFrom || assistantCount < KEEP_RECENT)
        return { role: m.role, content: m.content, created_at: m.created_at, metadata: m.metadata };

      // For old messages, strip image metadata (don't resend multi-MB base64 for old turns)
      // and truncate large content (likely tool outputs)
      const contentSize = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
      if (contentSize > MAX_TOOL_OUTPUT * 3 && m.role === "user") {
        // If content has structured tool_result blocks, truncate the output
        // WITHIN each block rather than destroying the block structure
        if (Array.isArray(m.content)) {
          const hasToolResults = (m.content as any[]).some((b: any) => b.type === "tool_result");
          if (hasToolResults) {
            const truncatedBlocks = (m.content as any[]).map((block: any) => {
              if (block.type === "tool_result") {
                const outputText = typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content);
                return {
                  ...block,
                  content: outputText.length > MAX_TOOL_OUTPUT
                    ? outputText.substring(0, MAX_TOOL_OUTPUT) + "\n" + PLACEHOLDER
                    : block.content,
                };
              }
              return block;
            });
            return {
              role: m.role,
              content: truncatedBlocks,
              created_at: m.created_at,
            };
          }
        }

        // Plain text content — safe to truncate directly
        const textContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return {
          role: m.role,
          content:
            textContent.substring(0, MAX_TOOL_OUTPUT) + "\n\n" + PLACEHOLDER,
          created_at: m.created_at,
        };
      }
      return { role: m.role, content: m.content, created_at: m.created_at };
    });
  }

  /**
   * Compact context if it exceeds threshold.
   * When channelId is provided, compaction is **persisted to the DB** — the
   * summarized messages are deleted and replaced with a single summary row.
   * This prevents old chats from re-compacting the same messages every turn.
   */
  private async compactIfNeeded(messages: LLMMessage[], channelId?: string): Promise<LLMMessage[]> {
    const COMPACT_THRESHOLD = 120000; // chars
    const HARD_CAP = 250000; // absolute maximum chars to send to API
    const totalChars = calculateContextSize(messages);

    if (totalChars < COMPACT_THRESHOLD) return messages;

    console.log(`[main-agent] Context at ${totalChars} chars, compacting...`);

    // For very large contexts, summarize more aggressively
    const summarizeRatio = totalChars > 200000 ? 0.85 : totalChars > 150000 ? 0.75 : 0.6;

    try {
      // Use the shared compactMessages which has structured summaries,
      // better content extraction, and preserves key findings from tool results
      const result = await compactMessages(messages, {
        summarizeRatio,
        maxSummaryTokens: 3000,
        preserveIdentifiers: true,
      });

      let compacted = result.messages;

      // Persist compaction summary to DB
      if (channelId && result.compacted) {
        const summary = typeof compacted[0]?.content === "string"
          ? compacted[0].content.replace("[Conversation summary — earlier messages compacted]\n\n", "")
          : "";
        if (summary) {
          // Count how many synthetic messages (compaction summary + ack) were at the start
          // of the input — these aren't real DB rows and shouldn't be counted
          let syntheticPrefix = 0;
          for (const m of messages) {
            const txt = typeof m.content === "string" ? m.content : "";
            if (txt.startsWith("[Conversation summary") || txt === "Understood, I have the context from the summary. Continuing.") {
              syntheticPrefix++;
            } else {
              break;
            }
          }
          const realMessagesSummarized = (result.originalCount - result.newCount) - syntheticPrefix;
          if (realMessagesSummarized > 0) {
            this.persistCompaction(channelId, realMessagesSummarized, summary);
          }
        }
      }

      const afterSize = calculateContextSize(compacted);

      // Hard cap: if still over absolute limit, drop oldest messages until we fit
      if (afterSize > HARD_CAP) {
        console.warn(`[main-agent] Post-compaction STILL ${afterSize} chars (hard cap ${HARD_CAP}), dropping oldest messages...`);
        while (compacted.length > 4 && calculateContextSize(compacted) > HARD_CAP) {
          compacted.shift();
        }
        if (compacted.length > 0 && compacted[0].role !== "user") {
          compacted.shift();
        }
        console.log(`[main-agent] After hard cap trim: ${calculateContextSize(compacted)} chars, ${compacted.length} messages`);
      }

      // Ensure proper role alternation after compaction — compaction can
      // produce consecutive same-role messages when the kept portion starts
      // with the same role as the synthetic ack message.
      compacted = this.mergeConsecutiveRoles(compacted);

      return compacted;
    } catch (err) {
      console.error("[main-agent] Compaction failed:", err);
      // Fall back: keep recent messages only
      const rawSplit = Math.floor(messages.length * summarizeRatio);
      const splitPoint = findSafeSplitPoint(messages, rawSplit);
      return messages.slice(splitPoint);
    }
  }

  /**
   * Persist compaction to DB: store a summary in compaction_summaries table
   * and record which messages it covers. Messages are NOT deleted — Nexus
   * and other consumers still need the full history. getRecentHistory() uses
   * the compaction boundary to skip old messages when loading for the LLM.
   */
  private persistCompaction(channelId: string, summarizedCount: number, summary: string): void {
    try {
      // Check if there's an existing compaction boundary to start counting from
      const existingCompaction = this.db.prepare(
        `SELECT up_to_created_at, messages_summarized FROM compaction_summaries
         WHERE channel_id = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(channelId) as { up_to_created_at: string; messages_summarized: number } | undefined;

      let lastSummarized: { id: string; created_at: string } | undefined;

      if (existingCompaction) {
        // Count from after the old compaction boundary
        lastSummarized = this.db.prepare(
          `SELECT id, created_at FROM main_agent_messages
           WHERE channel_id = ? AND created_at > ?
           ORDER BY created_at ASC
           LIMIT 1 OFFSET ?`
        ).get(channelId, existingCompaction.up_to_created_at, summarizedCount - 1) as typeof lastSummarized;
      } else {
        // Count from the beginning
        lastSummarized = this.db.prepare(
          `SELECT id, created_at FROM main_agent_messages
           WHERE channel_id = ?
           ORDER BY created_at ASC
           LIMIT 1 OFFSET ?`
        ).get(channelId, summarizedCount - 1) as typeof lastSummarized;
      }

      if (!lastSummarized) return;

      // Total messages now covered by compaction
      const totalSummarized = (existingCompaction?.messages_summarized ?? 0) + summarizedCount;

      // Delete old compaction — new one supersedes it
      if (existingCompaction) {
        this.db.prepare(
          `DELETE FROM compaction_summaries WHERE channel_id = ?`
        ).run(channelId);
      }

      this.db.prepare(
        `INSERT INTO compaction_summaries (id, channel_id, summary, messages_summarized, up_to_rowid, up_to_created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        channelId,
        summary,
        totalSummarized,
        lastSummarized.id,
        lastSummarized.created_at,
      );

      console.log(`[main-agent] Persisted compaction for ${channelId.slice(0, 12)}: ${summarizedCount} new messages summarized (${totalSummarized} total), boundary at ${lastSummarized.created_at}`);
    } catch (err) {
      console.error(`[main-agent] Failed to persist compaction for ${channelId.slice(0, 12)}:`, err);
      // Non-fatal — compaction still works in-memory for this turn
    }
  }

  private drainQueue(channelId: string, skipDbPersist = false): string {
    const queue = this.channelQueues.get(channelId);
    if (!queue || queue.length === 0) return "";
    console.log(
      `[main-agent.queue] channel=${this.channelTag(channelId)} drain_all count=${queue.length}`,
    );
    
    const texts = queue.map(
      (m, i) =>
        `---\nQueued #${i + 1} from ${m.authorName} (${new Date(m.timestamp).toLocaleTimeString()}):\n${m.content}`,
    );
    
    const queuedBlock = texts.join("\n\n");
    
    // Store the queued block as a single DB entry (caller can skip if they persist separately)
    if (!skipDbPersist) {
      this.db.prepare(`
        INSERT INTO main_agent_messages (id, role, content, channel_id, platform_message_id, token_estimate)
        VALUES (?, 'user', ?, ?, ?, ?)
      `).run(
        randomUUID(),
        `[Queued messages while agent was busy]\n\n${queuedBlock}`,
        channelId,
        null,
        Math.ceil(queuedBlock.length / 4),
      );
    }
    
    // Clear this channel's in-memory queue and mark DB queue processed
    this.channelQueues.delete(channelId);
    this.markQueueProcessed(channelId);
    return queuedBlock;
  }

  private truncateLiveToolResult(content: string): string {
    if (content.length <= MAX_LIVE_TOOL_RESULT_CHARS) return content;

    return (
      content.slice(0, MAX_LIVE_TOOL_RESULT_CHARS) +
      "\n\n[Tool output truncated before model call. Re-run the tool with narrower scope if needed.]"
    );
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt < maxLen * 0.5) splitAt = maxLen;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }
    return chunks;
  }

  /* ── Nexus API Support ────────────────────────────────────────── */

  /** Get the last assistant message for a channel (for Nexus chat API) */
  getLastAssistantMessage(channelId: string): string | null {
    const row = this.db.prepare(`
      SELECT content FROM main_agent_messages
      WHERE channel_id = ? AND role = 'assistant'
      ORDER BY created_at DESC LIMIT 1
    `).get(channelId) as { content: string } | undefined;
    return row?.content ?? null;
  }

  /** Get the count of assistant messages for a channel (for tracking new responses) */
  getAssistantMessageCount(channelId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM main_agent_messages
      WHERE channel_id = ? AND role = 'assistant'
    `).get(channelId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Get the latest assistant message added after a known count (for detecting new responses) */
  getAssistantMessageSince(channelId: string, previousCount: number): string | null {
    const currentCount = this.getAssistantMessageCount(channelId);
    if (currentCount <= previousCount) return null;
    return this.getLastAssistantMessage(channelId);
  }

  /** Wait for a channel to finish processing */
  async waitForChannelIdle(channelId: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.processingChannels.has(channelId)) return;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Channel ${channelId.slice(0, 8)} did not become idle within ${timeoutMs}ms`);
  }

  /** Get message history for a channel (for session resume) */
  getChannelMessages(channelId: string, limit = 100): Array<{ role: string; content: string; created_at: number | string }> {
    return this.db.prepare(
      `SELECT role, content, created_at FROM main_agent_messages WHERE channel_id = ? ORDER BY created_at ASC LIMIT ?`
    ).all(channelId, limit) as Array<{ role: string; content: string; created_at: number | string }>;
  }

  /** Set model override for a specific channel */
  setChannelModel(channelId: string, model: string | null): void {
    this.db.prepare(`
      INSERT INTO channel_sessions (channel_id, status, last_activity, model_override)
      VALUES (?, 'idle', datetime('now'), ?)
      ON CONFLICT(channel_id) DO UPDATE SET model_override = excluded.model_override
    `).run(channelId, model);
  }

  /** 
   * Smart heartbeat detection - suppress routine "all good" responses,
   * but allow important findings/actions/problems through to Discord
   */
  private isRoutineHeartbeat(response: string): boolean {
    if (!response) return false;
    
    // Exact "HEARTBEAT_OK" is routine - suppress
    if (response === "HEARTBEAT_OK") return true;
    
    // Short responses with only routine indicators are likely routine
    const routinePatterns = [
      /^all systems? (are )?operational?$/i,
      /^everything looks? good$/i,
      /^no issues? (found|detected)$/i,
      /^status: (ok|good|healthy)$/i,
      /^lobs-core: running,? all good$/i,
      /^nothing to report$/i,
      /^all clear$/i,
    ];
    
    // If it matches routine patterns and is short (< 100 chars), suppress
    if (response.length < 100) {
      for (const pattern of routinePatterns) {
        if (pattern.test(response.trim())) {
          console.log(`[main-agent] Suppressing routine heartbeat: "${response.slice(0, 50)}..."`);
          return true;
        }
      }
    }
    
    // Anything else (problems found, actions taken, longer explanations) - send to Discord
    return false;
  }

  private async createMessageWithTimeout(
    client: LLMClient,
    params: {
      model: string;
      system: string;
      messages: LLMMessage[];
      tools: ReturnType<typeof getToolDefinitions>;
      maxTokens: number;
    },
    channelId: string,
  ) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        client.createMessage(params),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`LLM turn timeout after ${Math.round(LLM_TURN_TIMEOUT_MS / 1000)}s for ${channelId}`));
          }, LLM_TURN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private recoverQueuedChannels(): void {
    if (this.processingChannels.size >= MAX_CONCURRENT_CHANNELS) return;

    for (const [channelId, queue] of this.channelQueues.entries()) {
      if (this.processingChannels.size >= MAX_CONCURRENT_CHANNELS) break;
      if (queue.length === 0 || this.processingChannels.has(channelId)) continue;

      try {
        console.warn(
          `[main-agent] Queue recovery starting ${this.channelTag(channelId)} ` +
          `(${queue.length} pending, active=${this.processingChannels.size}/${MAX_CONCURRENT_CHANNELS})`,
        );

        const nextMsg = queue.shift()!;
        if (queue.length === 0) {
          this.channelQueues.delete(channelId);
        }

        this.promoteQueuedMessage(nextMsg, "timer-recovery");
        this.updateChannelSession(channelId, "processing", nextMsg.authorId, nextMsg.authorName);
        this.processConversation(channelId).catch((err) =>
          console.error(`[main-agent] Queue recovery failed for ${channelId.slice(0, 16)}:`, err),
        );
      } catch (err) {
        console.error(`[main-agent] Queue recovery crashed for ${this.channelTag(channelId)}:`, err);
      }
    }
  }
}
