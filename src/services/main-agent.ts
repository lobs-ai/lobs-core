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
import { loadWorkspaceContext } from "./workspace-loader.js";
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
  "cron",
  "message",
  "spawn_agent",
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
    if (this.processing) {
      // Don't store in DB yet — will be stored as part of the queued block
      this.messageQueue.push(msg);
      console.log(
        `[main-agent] Queued message (${this.messageQueue.length} pending)`,
      );
      return;
    }

    // Store in DB (only for non-queued messages)
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

      // 1. Get history
      let history = this.getRecentHistory();

      // 2. Prune old tool outputs
      history = this.pruneHistory(history);

      // Reload workspace context fresh each turn (memory files change during the day)
      const isHeartbeat = history.some(m => 
        m.role === "user" && m.content.includes("heartbeat") && m.content.includes("HEARTBEAT")
      );
      const freshContext = loadWorkspaceContext(isHeartbeat);

      // Build system prompt — concise: identity + context + time
      // Tool descriptions come from the tool schemas (not hardcoded in prompt)
      const fullSystem = [
        this.systemPrompt,
        "",
        freshContext,
        "",
        `Current time: ${new Date().toLocaleString("en-US", {
          timeZone: "America/New_York",
          dateStyle: "full",
          timeStyle: "long",
        })}`,
      ].join("\n");

      // 3. Build LLM messages
      let messages: LLMMessage[] = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // 4. Add queued messages
      const queuedText = this.drainQueue();
      if (queuedText) {
        messages.push({
          role: "user",
          content: `[Queued messages while agent was busy]\n\n${queuedText}`,
        });
      }

      // 5. Compact if needed
      messages = await this.compactIfNeeded(messages);

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

  private getRecentHistory(): Array<{
    role: string;
    content: string;
    created_at: string;
  }> {
    const MAX_CONTEXT_TOKENS = 150000;
    const CHARS_PER_TOKEN = 4;
    const MAX_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN;

    // Load more than we need, then trim
    const rows = this.db
      .prepare(
        `SELECT role, content, created_at FROM main_agent_messages
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all() as Array<{ role: string; content: string; created_at: string }>;

    rows.reverse(); // chronological

    // Calculate system prompt size (it's constant overhead)
    const systemSize =
      (this.systemPrompt.length + this.workspaceContext.length) /
      CHARS_PER_TOKEN;
    let budget = MAX_CHARS - systemSize * CHARS_PER_TOKEN;

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
    const config = parseModelString("anthropic/claude-haiku-4-5");
    const client = createClient(config);

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

  private drainQueue(): string {
    if (this.messageQueue.length === 0) return "";
    const texts = this.messageQueue.map(
      (m, i) =>
        `---\nQueued #${i + 1} from ${m.authorName} (${new Date(m.timestamp).toLocaleTimeString()}):\n${m.content}`,
    );
    
    // Store the queued block as a single DB entry
    const queuedBlock = texts.join("\n\n");
    this.db.prepare(`
      INSERT INTO main_agent_messages (id, role, content, channel_id, token_estimate)
      VALUES (?, 'user', ?, ?, ?)
    `).run(
      randomUUID(),
      `[Queued messages while agent was busy]\n\n${queuedBlock}`,
      this.messageQueue[0]?.channelId || "system",
      Math.ceil(queuedBlock.length / 4),
    );
    
    this.messageQueue = [];
    return queuedBlock;
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
