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
import { getModelForTier } from "../config/models.js";
import { getToolDefinitions, executeTool } from "../runner/tools/index.js";
import type { ToolName } from "../runner/types.js";
import { getToolsForSession, getSessionType } from "../runner/tools/tool-sets.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace-loader.js";
import { buildFallbackChain, resolveModelForTier, type ModelTier } from "../orchestrator/model-chooser.js";
import Database from "better-sqlite3";
import { compactMessages, pruneToolResults, findSafeSplitPoint, calculateContextSize } from "./compaction.js";
import { LoopDetector } from "../runner/loop-detector.js";

const MAX_HISTORY = 50;
const MAX_CONTEXT_CHARS = 150_000; // Rough char budget for history
const MAX_LIVE_TOOL_RESULT_CHARS = 6_000;
const DEFAULT_MODEL = "strong";  // Chat defaults to strong tier (opus)
const DEFAULT_CWD = process.env.HOME ?? "/tmp";
const MAX_CONCURRENT_CHANNELS = 10; // Max simultaneous channel conversations
const LLM_TURN_TIMEOUT_MS = 120_000; // 2 minutes per LLM turn (was 3min — too generous)
const QUEUE_RECOVERY_INTERVAL_MS = 5_000;

/** Tools that mutate state and must run sequentially (not parallelizable) */
const SEQUENTIAL_TOOLS = new Set(["exec", "process", "write", "edit", "memory_write", "spawn_agent"]);

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
  type: "tool_start" | "tool_result" | "text_delta" | "assistant_reply" | "thinking" | "error" | "done" | "queued" | "processing_start";
  channelId: string;
  queuePosition?: number; // For "queued" events — position in queue
  toolName?: string;
  toolInput?: string;    // JSON string preview of tool input
  toolUseId?: string;
  result?: string;       // tool result or final text
  isError?: boolean;
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
  
  /** EventEmitter for SSE streaming — Nexus subscribes to this */
  public readonly events = new EventEmitter();

  constructor(db: Database.Database, model?: string) {
    this.db = db;
    this.model = model || process.env.LOBS_MODEL || DEFAULT_MODEL;
    this.cwd = process.env.LOBS_CWD || DEFAULT_CWD;
    this.ensureTables();
    this.queueRecoveryTimer = setInterval(() => {
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
        model_override TEXT    -- per-channel model override
      );

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
    if (!this.onProgress) return;
    await this.onProgress(channelId, batch.join("\n"));
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
        this.updateChannelSession(channelId, "processing");
        // Don't await — let them run concurrently, but stagger starts
        // to avoid thundering herd on the API (especially after rate limits)
        const staggerDelay = 5000 + i * 5000; // 5s initial + 5s between each session
        setTimeout(() => {
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
        `[main-agent] Queued message for channel ${channelId.slice(0, 8)} (${queueDepth} pending, ${this.processingChannels.size}/${MAX_CONCURRENT_CHANNELS} active)`,
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

    await this.processConversation(msg.channelId);
  }

  /** Inject a system event (heartbeat, cron, subagent completion, etc.) */
  async handleSystemEvent(text: string, channelId?: string): Promise<void> {
    const id = randomUUID();
    const ch = channelId || "system";
    const content = `[System Event] ${text}`;

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
    // Mark this channel as being processed
    this.processingChannels.add(replyChannelId);
    console.log(
      `[main-agent] Processing started for ${replyChannelId.slice(0, 16)} ` +
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
      console.error(`[main-agent] Conversation timeout (${timeoutMinutes}min) for channel ${replyChannelId.slice(0, 12)} — force releasing`);
      this.processingChannels.delete(replyChannelId);
      this.channelQueues.delete(replyChannelId);  // Clear queued messages to prevent memory leak
      this.channelChatType.delete(replyChannelId);  // Clean up session metadata
      this.updateChannelSession(replyChannelId, "idle");
    }, timeoutMinutes * 60 * 1000);

    try {
      if (this.onTyping) this.onTyping(replyChannelId);

      // 1. Get history for this channel
      let history = this.getRecentHistory(replyChannelId);

      // 2. Prune old tool outputs
      history = this.pruneHistory(history);

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
      ].join("\n");

      // 3. Build LLM messages (with image content blocks when present)
      let messages: LLMMessage[] = history.map((m) => {
        const role = m.role as "user" | "assistant";

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
                contentBlocks.push({ type: "text", text: m.content });
              }
              return { role, content: contentBlocks };
            }
          } catch { /* invalid metadata, fall through */ }
        }

        return { role, content: m.content };
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
        if (this.onTyping) this.onTyping(replyChannelId);
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

        // Prune: keep last 3 turns' tool results intact, truncate older ones to 400 chars
        messages = pruneToolResults(messages, 3, 400);
        messages = await this.compactIfNeeded(messages, replyChannelId);
        const contextChars = messages.reduce((s, m) =>
          s + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0);
        const systemChars = fullSystem.length;
        console.debug(
          `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
          `calling_llm model=${config.modelId} msgs=${messages.length} ctx=${contextChars} sys=${systemChars} total_chars=${contextChars + systemChars}`,
        );

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
        }

        const response = await this.createMessageWithTimeout(client, {
          model: config.modelId,
          system: fullSystem,
          messages,
          tools,
          maxTokens: 16384,
        }, replyChannelId);
        console.debug(
          `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
          `llm_response blocks=${response.content.length} stop=${response.stopReason}`,
        );

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
        for (const block of response.content) {
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
            const { result, sideEffects } = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              block.id,
              this.cwd,
            );
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
              `result_len=${resultContent.length}`,
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
              result: resultContent.substring(0, 500),
              isError: result.is_error,
              timestamp: Date.now(),
            } satisfies AgentStreamEvent);
            return {
              type: "tool_result" as const,
              tool_use_id: result.tool_use_id,
              content: resultContent,
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
        messages.push({ role: "assistant", content: response.content });

        if (hasToolUse) {
          console.debug(
            `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
            `tool_roundtrip count=${toolResults.length} continuing=true`,
          );
          // Store tool call summary in DB for continuity across restarts
          const toolSummary = toolResults.map((tr) => {
            const toolBlock = response.content.find(
              (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
                b.type === "tool_use" && b.id === tr.tool_use_id,
            );
            const toolName = toolBlock?.name || "unknown";
            const resultPreview =
              tr.content.length > 500
                ? tr.content.slice(0, 500) + "..."
                : tr.content;
            return `[${toolName}] ${resultPreview}`;
          }).join("\n");

          this.db
            .prepare(
              `INSERT INTO main_agent_messages
                 (id, role, content, channel_id, token_estimate)
               VALUES (?, 'assistant', ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              `[Tool calls]\n${toolSummary}`,
              replyChannelId,
              Math.ceil(toolSummary.length / 4),
            );

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
          this.db
            .prepare(
              `INSERT INTO main_agent_messages
                 (id, role, content, channel_id, token_estimate)
               VALUES (?, 'user', ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              `[Tool results]\n${toolResultSummary}`,
              replyChannelId,
              Math.ceil(toolResultSummary.length / 4),
            );

          // Inject any queued messages that arrived while we were working
          // This lets the agent see new context mid-loop instead of waiting
          // until the entire conversation finishes — critical for group chats
          const midLoopQueued = this.drainQueue(replyChannelId);
          if (midLoopQueued) {
            // Store in DB for continuity
            const queuedContent = `[New messages received during processing]\n\n${midLoopQueued}`;
            this.db
              .prepare(
                `INSERT INTO main_agent_messages
                   (id, role, content, channel_id, token_estimate)
                 VALUES (?, 'user', ?, ?, ?)`,
              )
              .run(
                randomUUID(),
                queuedContent,
                replyChannelId,
                Math.ceil(queuedContent.length / 4),
              );

            const ackContent = "I see new messages arrived. Let me incorporate them.";
            // Persist the synthetic assistant ack so DB alternation is maintained
            this.db
              .prepare(
                `INSERT INTO main_agent_messages
                   (id, role, content, channel_id, token_estimate)
                 VALUES (?, 'assistant', ?, ?, ?)`,
              )
              .run(
                randomUUID(),
                ackContent,
                replyChannelId,
                Math.ceil(ackContent.length / 4),
              );

            messages.push({
              role: "assistant",
              content: ackContent,
            });
            messages.push({
              role: "user",
              content: queuedContent,
            });

            console.log(`[main-agent] Injected ${midLoopQueued.split("---").length - 1} queued message(s) mid-loop for channel ${replyChannelId.slice(0, 8)}`);
            console.debug(
              `[main-agent.loop] channel=${replyChannelId} iter=${loopIteration} ` +
              `midloop_queue_injected=true`,
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

          // Reply
          if (this.onReply) {
            for (const chunk of this.splitMessage(textResponse, 1900)) {
              await this.onReply(replyChannelId, chunk);
            }
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
          console.log(`[main-agent] Routine heartbeat logged but not sent to Discord: ${textResponse}`);
        }

        // Emit done event
        this.events.emit("stream", {
          type: "done",
          channelId: replyChannelId,
          timestamp: Date.now(),
        } satisfies AgentStreamEvent);
        console.log(
          `[main-agent] Processing completed for ${replyChannelId.slice(0, 16)} ` +
          `in ${Date.now() - conversationStartedAt}ms`,
        );
        this.conversationRetryCount.delete(replyChannelId);
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

      const currentRetries = this.conversationRetryCount.get(replyChannelId) ?? 0;

      // Mark for conversation-level retry (handled in finally block)
      if (isTransient && currentRetries < 2) {
        const retryNum = currentRetries + 1;
        this.conversationRetryCount.set(replyChannelId, retryNum);
        const retryDelay = (10 + Math.random() * 20) * 1000 * retryNum; // 10-30s * attempt
        console.log(`[main-agent] Transient error, scheduling retry in ${(retryDelay / 1000).toFixed(0)}s (retry ${retryNum}/2) for channel ${replyChannelId.slice(0, 12)}`);

        // Emit a temporary status so frontend knows we're retrying, not dead
        this.events.emit("stream", {
          type: "error",
          channelId: replyChannelId,
          result: `⏳ API error — retrying in ${Math.round(retryDelay / 1000)}s...`,
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
            await this.onReply(replyChannelId, friendlyMsg);
          }
        } catch (replyErr) {
          console.error("[main-agent] Failed to send error reply:", replyErr);
        }
      }
    } finally {
      clearTimeout(conversationTimeout);
      // Mark this channel as no longer processing
      this.processingChannels.delete(replyChannelId);
      console.log(
        `[main-agent] Processing released for ${replyChannelId.slice(0, 16)} ` +
        `(active=${this.processingChannels.size}/${MAX_CONCURRENT_CHANNELS}, queued=${this.getQueueDepth()})`,
      );

      // Check for pending retry (transient API errors)
      const pendingRetryDelay = (this as any).__pendingRetry?.[replyChannelId];
      if (pendingRetryDelay) {
        delete (this as any).__pendingRetry[replyChannelId];
        this.scheduleConversationRetry(replyChannelId, pendingRetryDelay);
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
      if (!pendingRetryDelay) {
        this.markQueueProcessed(replyChannelId);
      }

      // Process queued messages for this channel (skip if we have a pending retry)
      const channelQueue = !pendingRetryDelay ? this.channelQueues.get(replyChannelId) : undefined;
      if (channelQueue && channelQueue.length > 0) {
        const nextMsg = channelQueue.shift()!;
        if (channelQueue.length === 0) {
          this.channelQueues.delete(replyChannelId);
        }
        
        // Store and process the queued message
        this.db
          .prepare(
            `INSERT INTO main_agent_messages
               (id, role, content, author_id, author_name, channel_id, platform_message_id, token_estimate)
             VALUES (?, 'user', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            nextMsg.id,
            nextMsg.content,
            nextMsg.authorId,
            nextMsg.authorName,
            nextMsg.channelId,
            nextMsg.messageId || null,
            Math.ceil(nextMsg.content.length / 4),
          );
        
        this.updateChannelSession(replyChannelId, "processing", nextMsg.authorId, nextMsg.authorName);
        await this.processConversation(replyChannelId);
        return;
      }

      // No more queued messages — mark channel idle (skip if pending retry)
      if (!pendingRetryDelay) {
        this.updateChannelSession(replyChannelId, "idle");
      }

      // Fill all available concurrency slots from queued channels
      for (const [channelId, queue] of this.channelQueues.entries()) {
        if (this.processingChannels.size >= MAX_CONCURRENT_CHANNELS) break;
        if (queue.length > 0 && !this.processingChannels.has(channelId)) {
          const nextMsg = queue.shift()!;
          if (queue.length === 0) {
            this.channelQueues.delete(channelId);
          }
          
          this.db
            .prepare(
              `INSERT INTO main_agent_messages
                 (id, role, content, author_id, author_name, channel_id, platform_message_id, token_estimate)
               VALUES (?, 'user', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              nextMsg.id,
              nextMsg.content,
              nextMsg.authorId,
              nextMsg.authorName,
              nextMsg.channelId,
              nextMsg.messageId || null,
              Math.ceil(nextMsg.content.length / 4),
            );
          
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
    setTimeout(() => {
      if (this.processingChannels.has(channelId)) {
        return;
      }

      if (this.processingChannels.size >= MAX_CONCURRENT_CHANNELS) {
        console.log(`[main-agent] Retry deferred for ${channelId.slice(0, 12)} — at capacity`);
        this.updateChannelSession(channelId, "queued");
        this.scheduleConversationRetry(channelId, 5000);
        return;
      }

      this.updateChannelSession(channelId, "processing");
      this.processConversation(channelId).catch(err => {
        console.error(`[main-agent] Conversation retry failed for ${channelId.slice(0, 12)}:`, err);
        if ((this as any).__conversationRetryCount?.[channelId]) {
          delete (this as any).__conversationRetryCount[channelId];
        }
        this.processingChannels.delete(channelId);
        this.updateChannelSession(channelId, "idle");
      });
    }, delayMs);
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  private getRecentHistory(channelId: string): Array<{
    role: string;
    content: string;
    created_at: string;
    metadata?: string | null;
  }> {
    const MAX_CONTEXT_TOKENS = 80000;
    const CHARS_PER_TOKEN = 4;
    const MAX_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN;

    // Load more than we need, then trim — filter by channel
    const rows = this.db
      .prepare(
        `SELECT role, content, created_at, metadata FROM main_agent_messages
         WHERE channel_id = ?
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all(channelId) as Array<{ role: string; content: string; created_at: string; metadata: string | null }>;

    rows.reverse(); // chronological

    // Calculate system prompt size — reload fresh to match what processConversation() will inject
    const freshPrompt = buildSystemPrompt();
    const freshCtx = loadWorkspaceContext();
    const systemChars = freshPrompt.length + freshCtx.length;
    let budget = MAX_CHARS - systemChars;

    // Trim from oldest until we fit
    const trimmed: typeof rows = [];
    let totalChars = 0;

    for (let i = rows.length - 1; i >= 0; i--) {
      const msgChars = rows[i].content.length;
      if (totalChars + msgChars > budget) break;
      totalChars += msgChars;
      trimmed.unshift(rows[i]);
    }

    return trimmed;
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
      if (m.role === "user" && Array.isArray(m.content)) {
        const toolResults = (m.content as any[]).filter((b: any) => b.type === "tool_result");
        if (toolResults.length > 0 && i > 0) {
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

  private mergeConsecutiveRoles(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return messages;

    // Drop leading assistant messages — API requires first message to be user
    while (messages.length > 0 && messages[0].role === "assistant") {
      messages.shift();
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
        // Short run — just concatenate
        let content = "";
        for (const m of runMessages) {
          if (typeof m.content === "string") {
            content += (content ? "\n\n" : "") + m.content;
          }
        }
        merged.push({ role: run.role as "user" | "assistant", content });
        continue;
      }

      // Long run — keep last MAX_FULL_KEEP, truncate or drop older ones
      const oldMessages = runMessages.slice(0, -MAX_FULL_KEEP);
      const recentMessages = runMessages.slice(-MAX_FULL_KEEP);
      
      let content = `[${oldMessages.length} earlier ${run.role} messages merged — tool call summaries from before restart]\n`;
      // Add a brief excerpt from the old messages (just first 200 chars each, max 2000 total)
      let oldContent = "";
      for (const m of oldMessages) {
        if (typeof m.content === "string") {
          const excerpt = m.content.slice(0, 200);
          if (oldContent.length + excerpt.length < 2000) {
            oldContent += excerpt + "\n";
          }
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
    return merged;
  }

  private pruneHistory(
    messages: Array<{ role: string; content: string; created_at: string; metadata?: string | null }>,
  ): Array<{ role: string; content: string; created_at: string; metadata?: string | null }> {
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
      if (m.content.length > MAX_TOOL_OUTPUT * 3 && m.role === "user") {
        // This is probably a tool result
        return {
          role: m.role,
          content:
            m.content.substring(0, MAX_TOOL_OUTPUT) + "\n\n" + PLACEHOLDER,
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
    const totalChars = messages.reduce(
      (sum, m) =>
        sum +
        (typeof m.content === "string"
          ? m.content.length
          : JSON.stringify(m.content).length),
      0,
    );

    if (totalChars < COMPACT_THRESHOLD) return messages;

    console.log(`[main-agent] Context at ${totalChars} chars, compacting...`);

    // For very large contexts, summarize more aggressively
    const summarizeRatio = totalChars > 200000 ? 0.85 : totalChars > 150000 ? 0.75 : 0.6;

    // Take the first N% of messages and summarize them
    // Use safe split to avoid orphaning tool_result blocks
    const rawSplit = Math.floor(messages.length * summarizeRatio);
    const splitPoint = findSafeSplitPoint(messages, rawSplit);
    const toSummarize = messages.slice(0, splitPoint);
    const toKeep = messages.slice(splitPoint);

    // Build summary using a quick LLM call
    const summaryText = toSummarize
      .map(
        (m) =>
          `${m.role}: ${typeof m.content === "string" ? m.content.substring(0, 200) : "[tool content]"}`,
      )
      .join("\n");

    // Use a cheap model for summarization
    const compactModel = getModelForTier("small");
    const config = parseModelString(compactModel);
    const client = createResilientClient(compactModel, {
      sessionId: "main-agent:compaction",
      fallbackModels: buildFallbackChain(compactModel, "small", "main").slice(1),
      maxRetries: 3,
    });

    try {
      const response = await client.createMessage({
        model: config.modelId,
        system:
          "Summarize this conversation history concisely. Preserve: goals, decisions, constraints, key identifiers, and open questions. Output as bullet points.",
        messages: [
          { role: "user", content: summaryText.substring(0, 50000) },
        ],
        tools: [],
        maxTokens: 2000,
      });

      const summary = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");

      let compacted: LLMMessage[] = [
        {
          role: "user" as const,
          content: `[Conversation summary — earlier messages compacted]\n\n${summary}`,
        },
        {
          role: "assistant" as const,
          content: "Understood, I have the context from the summary. Continuing.",
        },
        ...toKeep,
      ];

      // Second pass: if still over budget, aggressively truncate tool results in kept portion
      let afterSize = calculateContextSize(compacted as LLMMessage[]);
      if (afterSize > COMPACT_THRESHOLD) {
        console.log(`[main-agent] Post-compaction still ${afterSize} chars, truncating tool results...`);
        compacted = pruneToolResults(compacted as LLMMessage[], 2, 200) as typeof compacted;
        afterSize = calculateContextSize(compacted as LLMMessage[]);
      }

      // Hard cap: if still over absolute limit, drop oldest messages until we fit
      if (afterSize > HARD_CAP) {
        console.warn(`[main-agent] Post-compaction STILL ${afterSize} chars (hard cap ${HARD_CAP}), dropping oldest messages...`);
        while (compacted.length > 4 && calculateContextSize(compacted as LLMMessage[]) > HARD_CAP) {
          compacted.shift();
        }
        // Ensure first message is user role (API requirement)
        if (compacted.length > 0 && compacted[0].role !== "user") {
          compacted.shift();
        }
        console.log(`[main-agent] After hard cap trim: ${calculateContextSize(compacted as LLMMessage[])} chars, ${compacted.length} messages`);
      }

      // Persist compaction to DB so old chats don't re-summarize every turn
      if (channelId && toSummarize.length > 0) {
        this.persistCompaction(channelId, toSummarize.length, summary);
      }

      return compacted;
    } catch (err) {
      console.error("[main-agent] Compaction failed:", err);
      // Fall back to simple truncation
      return toKeep;
    }
  }

  /**
   * Persist compaction to DB: delete the oldest N messages for a channel
   * and replace them with a single summary message.
   * This prevents old chats from re-compacting the same history every turn.
   */
  private persistCompaction(channelId: string, summarizedCount: number, summary: string): void {
    try {
      // Get the IDs of the oldest N messages for this channel
      const oldestRows = this.db.prepare(
        `SELECT id FROM main_agent_messages
         WHERE channel_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      ).all(channelId, summarizedCount) as Array<{ id: string }>;

      if (oldestRows.length === 0) return;

      const ids = oldestRows.map(r => r.id);

      // Use better-sqlite3's transaction() for safe atomic operation
      const doCompaction = this.db.transaction(() => {
        // Delete in batches (SQLite has a limit on placeholders)
        const BATCH_SIZE = 100;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const batch = ids.slice(i, i + BATCH_SIZE);
          const placeholders = batch.map(() => "?").join(",");
          this.db.prepare(
            `DELETE FROM main_agent_messages WHERE id IN (${placeholders})`
          ).run(...batch);
        }

        // Insert summary as a user message + assistant ack
        const summaryId = randomUUID();
        const ackId = randomUUID();
        // Use a very old timestamp so the summary sorts before remaining messages
        const summaryTime = "2000-01-01T00:00:00.000Z";

        this.db.prepare(
          `INSERT INTO main_agent_messages (id, role, content, channel_id, created_at, token_estimate)
           VALUES (?, 'user', ?, ?, ?, ?)`
        ).run(summaryId, `[Conversation summary — earlier messages compacted]\n\n${summary}`, channelId, summaryTime, Math.ceil(summary.length / 4));

        this.db.prepare(
          `INSERT INTO main_agent_messages (id, role, content, channel_id, created_at, token_estimate)
           VALUES (?, 'assistant', ?, ?, ?, ?)`
        ).run(ackId, "Understood, I have the context from the summary. Continuing.", channelId, summaryTime, 15);
      });

      doCompaction();
      console.log(`[main-agent] Persisted compaction for ${channelId.slice(0, 12)}: deleted ${ids.length} messages, inserted summary`);
    } catch (err) {
      console.error(`[main-agent] Failed to persist compaction for ${channelId.slice(0, 12)}:`, err);
      // Non-fatal — compaction still works in-memory for this turn
    }
  }

  private drainQueue(channelId: string): string {
    const queue = this.channelQueues.get(channelId);
    if (!queue || queue.length === 0) return "";
    
    const texts = queue.map(
      (m, i) =>
        `---\nQueued #${i + 1} from ${m.authorName} (${new Date(m.timestamp).toLocaleTimeString()}):\n${m.content}`,
    );
    
    // Store the queued block as a single DB entry
    const queuedBlock = texts.join("\n\n");
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

      console.warn(
        `[main-agent] Queue recovery starting ${channelId.slice(0, 16)} ` +
        `(${queue.length} pending, active=${this.processingChannels.size}/${MAX_CONCURRENT_CHANNELS})`,
      );

      const nextMsg = queue.shift()!;
      if (queue.length === 0) {
        this.channelQueues.delete(channelId);
      }

      this.db
        .prepare(
          `INSERT INTO main_agent_messages
             (id, role, content, author_id, author_name, channel_id, platform_message_id, token_estimate)
           VALUES (?, 'user', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nextMsg.id,
          nextMsg.content,
          nextMsg.authorId,
          nextMsg.authorName,
          nextMsg.channelId,
          nextMsg.messageId || null,
          Math.ceil(nextMsg.content.length / 4),
        );

      this.updateChannelSession(channelId, "processing", nextMsg.authorId, nextMsg.authorName);
      this.processConversation(channelId).catch((err) =>
        console.error(`[main-agent] Queue recovery failed for ${channelId.slice(0, 16)}:`, err),
      );
    }
  }
}
