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
import { resolveModelForTier, type ModelTier } from "../orchestrator/model-chooser.js";
import Database from "better-sqlite3";
import { compactMessages, pruneToolResults } from "./compaction.js";
import { LoopDetector } from "../runner/loop-detector.js";

const MAX_HISTORY = 50;
const MAX_CONTEXT_CHARS = 150_000; // Rough char budget for history
const MAX_LIVE_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_MODEL = "strong";  // Chat defaults to strong tier (opus)
const DEFAULT_CWD = process.env.HOME ?? "/tmp";
const MAX_CONCURRENT_CHANNELS = 3; // Max simultaneous channel conversations

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
}

/** SSE event types emitted during agent processing */
export interface AgentStreamEvent {
  type: "tool_start" | "tool_result" | "text_delta" | "assistant_reply" | "thinking" | "error" | "done";
  channelId: string;
  toolName?: string;
  toolInput?: string;    // JSON string preview of tool input
  toolUseId?: string;
  result?: string;       // tool result or final text
  isError?: boolean;
  timestamp: number;
}

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
  
  /** EventEmitter for SSE streaming — Nexus subscribes to this */
  public readonly events = new EventEmitter();

  constructor(db: Database.Database, model?: string) {
    this.db = db;
    this.model = model || process.env.LOBS_MODEL || DEFAULT_MODEL;
    this.cwd = process.env.LOBS_CWD || DEFAULT_CWD;
    this.ensureTables();
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

    // Safe migrations
    try {
      this.db.exec(`ALTER TABLE main_agent_messages ADD COLUMN platform_message_id TEXT`);
    } catch { /* already exists */ }
    try {
      this.db.exec(`ALTER TABLE channel_sessions ADD COLUMN model_override TEXT`);
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

    console.log(`[main-agent] Resuming ${channelsToResume.size} session(s)...`);

    for (const channelId of channelsToResume) {
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
      const resumeText = [
        `[System] lobs-core restarted. This session was active at ${lastActivity}.`,
        session?.context_summary ? `Last context: ${session.context_summary}` : null,
        persistedMsgs.length > 0 ? `${persistedMsgs.length} queued message(s) waiting.` : null,
        `Review recent history and continue where you left off. If you were mid-task, resume it.`,
      ].filter(Boolean).join(" ");

      // Insert as a user message so it enters the conversation flow
      this.db.prepare(`
        INSERT INTO main_agent_messages (id, role, content, channel_id, token_estimate)
        VALUES (?, 'user', ?, ?, ?)
      `).run(randomUUID(), resumeText, channelId, Math.ceil(resumeText.length / 4));

      // Process — but respect concurrency limits
      if (this.processingChannels.size < MAX_CONCURRENT_CHANNELS) {
        this.updateChannelSession(channelId, "processing");
        // Don't await — let them run concurrently
        this.processConversation(channelId).catch(err => {
          console.error(`[main-agent] Resume failed for channel ${channelId.slice(0, 8)}:`, err);
        });
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

    // Save a context summary for each active channel
    for (const channelId of this.processingChannels) {
      // Get the last few messages to build a summary
      const recent = this.db.prepare(`
        SELECT content FROM main_agent_messages
        WHERE channel_id = ? ORDER BY created_at DESC LIMIT 3
      `).all(channelId) as Array<{ content: string }>;

      const summary = recent
        .reverse()
        .map(r => r.content.substring(0, 100))
        .join(" | ");

      this.updateChannelSession(channelId, "processing", null, null, summary);
    }

    console.log(`[main-agent] State persisted (${this.processingChannels.size} active, ${this.channelQueues.size} queued channels)`);
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
      console.log(
        `[main-agent] Queued message for channel ${channelId.slice(0, 8)} (${this.channelQueues.get(channelId)!.length} pending)`,
      );
      return;
    }

    // Store in DB message history
    this.db
      .prepare(
        `INSERT INTO main_agent_messages
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

    // Update channel session state
    this.updateChannelSession(channelId, "processing", msg.authorId, msg.authorName);

    await this.processConversation(msg.channelId);
  }

  /** Inject a system event (heartbeat, cron, etc.) */
  async handleSystemEvent(text: string, channelId?: string): Promise<void> {
    const id = randomUUID();
    const ch = channelId || "system";
    this.db
      .prepare(
        `INSERT INTO main_agent_messages
           (id, role, content, channel_id, platform_message_id, token_estimate)
         VALUES (?, 'user', ?, ?, ?, ?)`,
      )
      .run(id, `[System Event] ${text}`, ch, null, Math.ceil(text.length / 4));

    if (!this.processingChannels.has(ch) && this.processingChannels.size < MAX_CONCURRENT_CHANNELS) {
      await this.processConversation(ch);
    }
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

  /* ── Core conversation loop ────────────────────────────────────── */

  private async processConversation(replyChannelId: string): Promise<void> {
    // Mark this channel as being processed
    this.processingChannels.add(replyChannelId);

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

      // 3. Build LLM messages
      let messages: LLMMessage[] = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // 4. Add queued messages for this channel
      const queuedText = this.drainQueue(replyChannelId);
      if (queuedText) {
        messages.push({
          role: "user",
          content: `[Queued messages while agent was busy]\n\n${queuedText}`,
        });
      }

      // 5. Compact if needed
      messages = await this.compactIfNeeded(messages);

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
      const availableTools = getToolsForSession(sessionType);
      const tools = getToolDefinitions(availableTools);
      console.log(`[main-agent] Using model: ${effectiveModel} (raw: ${this.model}, override: ${sessionRow?.model_override ?? 'none'})`);
      const config = parseModelString(effectiveModel);
      const client: LLMClient = createResilientClient(effectiveModel, {
        sessionId: `main-agent:${replyChannelId}`,
        maxRetries: 3,
      });

      // Agent loop — LLM ↔ tool execution (no turn limit, timeout handles runaway)
      while (true) {
        if (this.onTyping) this.onTyping(replyChannelId);

        // Emit SSE event: thinking (about to call LLM)
        this.events.emit("stream", {
          type: "thinking",
          channelId: replyChannelId,
          timestamp: Date.now(),
        } satisfies AgentStreamEvent);

        messages = pruneToolResults(messages, 6, 400);
        messages = await this.compactIfNeeded(messages);

        const response = await client.createMessage({
          model: config.modelId,
          system: fullSystem,
          messages,
          tools,
          maxTokens: 16384,
        });

        let textResponse = "";
        let hasToolUse = false;
        const toolResults: Array<{
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }> = [];

        for (const block of response.content) {
          if (block.type === "text") {
            textResponse += block.text;
          } else if (block.type === "tool_use") {
            hasToolUse = true;

            const inputPreview = JSON.stringify(block.input).substring(0, 300);

            // Show tool step progress in DMs/Nexus (not group chats)
            if (this.shouldShowSteps(replyChannelId) && this.onProgress) {
              await this.onProgress(
                replyChannelId,
                `🔧 \`${block.name}\` ${inputPreview.substring(0, 150)}${inputPreview.length >= 150 ? "..." : ""}`,
              );
            }

            // Emit SSE event: tool starting
            this.events.emit("stream", {
              type: "tool_start",
              channelId: replyChannelId,
              toolName: block.name,
              toolInput: inputPreview,
              toolUseId: block.id,
              timestamp: Date.now(),
            } satisfies AgentStreamEvent);

            const result = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              block.id,
              this.cwd,
            );
            const resultContent = this.truncateLiveToolResult(
              typeof result.content === "string"
                ? result.content
                : JSON.stringify(result.content),
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: result.tool_use_id,
              content: resultContent,
              is_error: result.is_error,
            });

            // Emit SSE event: tool completed
            this.events.emit("stream", {
              type: "tool_result",
              channelId: replyChannelId,
              toolName: block.name,
              toolUseId: block.id,
              result: resultContent.substring(0, 500),
              isError: result.is_error,
              timestamp: Date.now(),
            } satisfies AgentStreamEvent);
          }
        }

        // Append assistant turn
        messages.push({ role: "assistant", content: response.content });

        if (hasToolUse) {
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

            messages.push({
              role: "assistant",
              content: "I see new messages arrived. Let me incorporate them.",
            });
            messages.push({
              role: "user",
              content: queuedContent,
            });

            console.log(`[main-agent] Injected ${midLoopQueued.split("---").length - 1} queued message(s) mid-loop for channel ${replyChannelId.slice(0, 8)}`);
          }

          continue;
        }

        // In DM/Nexus, never suppress a response — override NO_REPLY
        const isDirectChat = channelChatType !== "group";
        const isNoReply = textResponse?.trim() === "NO_REPLY";
        const isRoutineHeartbeat = this.isRoutineHeartbeat(textResponse?.trim() || "");
        
        if (isNoReply && isDirectChat) {
          textResponse = "I'm here — what can I help with?";
        }

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
        break; // Done
      }
    } catch (err) {
      console.error("[main-agent] Error in conversation loop:", err);
      // Emit error event
      this.events.emit("stream", {
        type: "error",
        channelId: replyChannelId,
        result: String(err).substring(0, 500),
        timestamp: Date.now(),
      } satisfies AgentStreamEvent);
      try {
        if (this.onReply) {
          await this.onReply(
            replyChannelId,
            `❌ Error: ${String(err).substring(0, 200)}`,
          );
        }
      } catch (replyErr) {
        console.error("[main-agent] Failed to send error reply:", replyErr);
      }
    } finally {
      clearTimeout(conversationTimeout);
      // Mark this channel as no longer processing
      this.processingChannels.delete(replyChannelId);
      
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

      // Mark persisted queue as processed for this channel
      this.markQueueProcessed(replyChannelId);

      // Process queued messages for this channel
      const channelQueue = this.channelQueues.get(replyChannelId);
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

      // No more queued messages — mark channel idle
      this.updateChannelSession(replyChannelId, "idle");

      // If under concurrency limit, try to start processing another queued channel
      if (this.processingChannels.size < MAX_CONCURRENT_CHANNELS) {
        for (const [channelId, queue] of this.channelQueues.entries()) {
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
            await this.processConversation(channelId);
            break;
          }
        }
      }
    }
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  private getRecentHistory(channelId: string): Array<{
    role: string;
    content: string;
    created_at: string;
  }> {
    const MAX_CONTEXT_TOKENS = 150000;
    const CHARS_PER_TOKEN = 4;
    const MAX_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN;

    // Load more than we need, then trim — filter by channel
    const rows = this.db
      .prepare(
        `SELECT role, content, created_at FROM main_agent_messages
         WHERE channel_id = ?
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all(channelId) as Array<{ role: string; content: string; created_at: string }>;

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

  private pruneHistory(
    messages: Array<{ role: string; content: string; created_at: string }>,
  ): Array<{ role: string; content: string; created_at: string }> {
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
        return { role: m.role, content: m.content, created_at: m.created_at };

      // For old messages, truncate large content (likely tool outputs)
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

  private async compactIfNeeded(messages: LLMMessage[]): Promise<LLMMessage[]> {
    const COMPACT_THRESHOLD = 120000; // chars
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

    // Take the first 60% of messages and summarize them
    const splitPoint = Math.floor(messages.length * 0.6);
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

      return [
        {
          role: "user",
          content: `[Conversation summary — earlier messages compacted]\n\n${summary}`,
        },
        {
          role: "assistant",
          content: "Understood, I have the context from the summary. Continuing.",
        },
        ...toKeep,
      ];
    } catch (err) {
      console.error("[main-agent] Compaction failed:", err);
      // Fall back to simple truncation
      return toKeep;
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
}
