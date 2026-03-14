/**
 * Main Agent — persistent conversational agent.
 *
 * Maintains a persistent conversation, receives messages (from Discord or API),
 * processes them through the LLM with tools, and replies.
 * This is NOT a one-shot worker — it's a persistent session like a chat assistant.
 */

import { randomUUID } from "node:crypto";
import { parseModelString, createClient } from "../runner/providers.js";
import type { LLMMessage, LLMClient } from "../runner/providers.js";
import { getToolDefinitions, executeTool } from "../runner/tools/index.js";
import type { ToolName } from "../runner/types.js";
import Database from "better-sqlite3";

const MAX_HISTORY = 50;
const MAX_CONTEXT_CHARS = 150_000; // Rough char budget for history
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";
const DEFAULT_CWD = process.env.HOME ?? "/tmp";

/** Tools available to the main agent */
const MAIN_AGENT_TOOLS: ToolName[] = [
  "exec",
  "read",
  "write",
  "edit",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_read",
  "memory_write",
];

interface PendingMessage {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  channelId: string;
  timestamp: number;
}

export class MainAgent {
  private db: Database.Database;
  private processing = false;
  private messageQueue: PendingMessage[] = [];
  private model: string;
  private systemPrompt = "";
  private workspaceContext = "";
  private cwd: string;
  private onReply: ((channelId: string, content: string) => Promise<void>) | null = null;
  private onTyping: ((channelId: string) => void) | null = null;

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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        token_estimate INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_main_messages_created
        ON main_agent_messages(created_at);
    `);
  }

  /* ── Configuration ─────────────────────────────────────────────── */

  setReplyHandler(handler: (channelId: string, content: string) => Promise<void>) {
    this.onReply = handler;
  }

  setTypingHandler(handler: (channelId: string) => void) {
    this.onTyping = handler;
  }

  setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
  }

  setWorkspaceContext(context: string) {
    this.workspaceContext = context;
  }

  /* ── Public API ────────────────────────────────────────────────── */

  /** Handle an incoming user message — queues if busy, processes if free */
  async handleMessage(msg: PendingMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO main_agent_messages
           (id, role, content, author_id, author_name, channel_id, token_estimate)
         VALUES (?, 'user', ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.content,
        msg.authorId,
        msg.authorName,
        msg.channelId,
        Math.ceil(msg.content.length / 4),
      );

    if (this.processing) {
      this.messageQueue.push(msg);
      console.log(
        `[main-agent] Queued message (${this.messageQueue.length} pending)`,
      );
      return;
    }

    await this.processConversation(msg.channelId);
  }

  /** Inject a system event (heartbeat, cron, etc.) */
  async handleSystemEvent(text: string, channelId?: string): Promise<void> {
    const id = randomUUID();
    const ch = channelId || "system";
    this.db
      .prepare(
        `INSERT INTO main_agent_messages
           (id, role, content, channel_id, token_estimate)
         VALUES (?, 'user', ?, ?, ?)`,
      )
      .run(id, `[System Event] ${text}`, ch, Math.ceil(text.length / 4));

    if (!this.processing) {
      await this.processConversation(ch);
    }
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getQueueDepth(): number {
    return this.messageQueue.length;
  }

  /* ── Core conversation loop ────────────────────────────────────── */

  private async processConversation(replyChannelId: string): Promise<void> {
    this.processing = true;

    try {
      if (this.onTyping) this.onTyping(replyChannelId);

      // Build context
      const history = this.getRecentHistory();
      const queuedText = this.drainQueue();

      const fullSystem = [
        this.systemPrompt,
        "",
        "## Workspace Context",
        this.workspaceContext,
        "",
        "## Current Time",
        new Date().toLocaleString("en-US", {
          timeZone: "America/New_York",
          dateStyle: "full",
          timeStyle: "long",
        }),
      ].join("\n");

      // Build messages
      const messages: LLMMessage[] = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      if (queuedText) {
        messages.push({
          role: "user",
          content: `[Queued messages while agent was busy]\n\n${queuedText}`,
        });
      }

      // Resolve tools & model
      const tools = getToolDefinitions(MAIN_AGENT_TOOLS);
      const config = parseModelString(this.model);
      const client: LLMClient = createClient(config);

      // Agent loop — LLM ↔ tool execution
      let maxTurns = 50;
      while (maxTurns-- > 0) {
        if (this.onTyping) this.onTyping(replyChannelId);

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
            const result = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              block.id,
              this.cwd,
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: result.tool_use_id,
              content:
                typeof result.content === "string"
                  ? result.content
                  : JSON.stringify(result.content),
              is_error: result.is_error,
            });
          }
        }

        // Append assistant turn
        messages.push({ role: "assistant", content: response.content });

        if (hasToolUse) {
          // Feed tool results back as a user turn and continue
          messages.push({ role: "user", content: toolResults });
          continue;
        }

        // Final text response
        if (
          textResponse &&
          textResponse.trim() !== "NO_REPLY" &&
          textResponse.trim() !== "HEARTBEAT_OK"
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
        }

        break; // Done
      }
    } catch (err) {
      console.error("[main-agent] Error in conversation loop:", err);
      if (this.onReply) {
        await this.onReply(
          replyChannelId,
          `❌ Error: ${String(err).substring(0, 200)}`,
        );
      }
    } finally {
      this.processing = false;

      // Process queued messages that arrived while we were busy
      if (this.messageQueue.length > 0) {
        const nextChannel = this.messageQueue[0].channelId;
        await this.processConversation(nextChannel);
      }
    }
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  private getRecentHistory(): Array<{ role: string; content: string }> {
    const rows = this.db
      .prepare(
        `SELECT role, content, token_estimate FROM main_agent_messages
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(MAX_HISTORY * 2) as Array<{
      role: string;
      content: string;
      token_estimate: number;
    }>;

    rows.reverse();

    let charSum = 0;
    const trimmed: typeof rows = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      charSum += rows[i].content.length;
      if (charSum > MAX_CONTEXT_CHARS) break;
      trimmed.unshift(rows[i]);
    }

    return trimmed;
  }

  private drainQueue(): string {
    if (this.messageQueue.length === 0) return "";
    const texts = this.messageQueue.map(
      (m, i) =>
        `---\nQueued #${i + 1} from ${m.authorName} (${new Date(m.timestamp).toLocaleTimeString()}):\n${m.content}`,
    );
    this.messageQueue = [];
    return texts.join("\n\n");
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
}
