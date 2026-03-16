/**
 * Chat Summarizer — generates and updates chat session summaries using a micro-tier model.
 *
 * Triggers after new messages, debounced so we don't summarize on every single message.
 * Uses the micro tier (claude-haiku) for low cost summarization.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { chatSessions } from "../db/schema.js";
import { log } from "../util/logger.js";
import { getModelForTier } from "../config/models.js";
import { getGatewayConfig } from "../config/lobs.js";

// ── Config ──────────────────────────────────────────────────────────────

/** Minimum new messages before re-summarizing */
const MIN_NEW_MESSAGES = 3;

/** Minimum seconds between summary updates for the same session */
const MIN_INTERVAL_SECONDS = 60;

/** Model to use for summarization (micro tier) */
const SUMMARY_MODEL = getModelForTier("small");

// ── Gateway helpers ─────────────────────────────────────────────────────

const SINK_SESSION_KEY = "agent:sink:paw-orchestrator-v2";

async function gatewayInvoke(tool: string, args: Record<string, unknown>, sessionKey?: string): Promise<any> {
  const { port, token } = getGatewayConfig();
  if (!token) throw new Error("No gateway auth token configured");

  const body: Record<string, unknown> = { tool, args };
  if (sessionKey) body.sessionKey = sessionKey;

  const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway ${tool} failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as any;
  return data?.result?.details ?? data?.result ?? data;
}

// ── Noise filter (same as chat.ts) ──────────────────────────────────────

const NOISE_PATTERNS = [
  /^Agent-to-agent announce/i,
  /^ANNOUNCE_SKIP$/,
  /^HEARTBEAT_OK$/,
  /^REPLY_SKIP$/,
  /^NO_REPLY$/,
  /^\[System\]/,
  /^PAW plugin restarted/,
];

function isNoise(text: string): boolean {
  return NOISE_PATTERNS.some(p => p.test(text.trim()));
}

// ── Pending summarization tracking ──────────────────────────────────────

/** Set of session keys with pending summarization (debounce in-flight) */
const pendingSummarizations = new Set<string>();

// ── Core ────────────────────────────────────────────────────────────────

/**
 * Called after a message is sent/received in a chat session.
 * Decides whether to trigger a summary update based on message count delta and time.
 */
export async function maybeSummarizeChat(sessionKey: string): Promise<void> {
  if (pendingSummarizations.has(sessionKey)) return;

  const db = getDb();
  const session = db.select().from(chatSessions)
    .where(eq(chatSessions.sessionKey, sessionKey))
    .get();

  if (!session) return;

  // Check time threshold
  if (session.summaryUpdatedAt) {
    const lastUpdate = new Date(session.summaryUpdatedAt).getTime();
    const now = Date.now();
    if ((now - lastUpdate) / 1000 < MIN_INTERVAL_SECONDS) return;
  }

  // Fetch current message count
  let messageCount = 0;
  let messages: Array<{ role: string; content: string }> = [];
  try {
    const historyResult = await gatewayInvoke("sessions_history", {
      sessionKey,
      limit: 200,
      includeTools: false,
    });
    const rawMessages = historyResult?.messages ?? [];
    messages = rawMessages
      .filter((m: any) => {
        if (m.role !== "user" && m.role !== "assistant") return false;
        let text = "";
        if (typeof m.content === "string") text = m.content;
        else if (Array.isArray(m.content)) {
          text = m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        }
        return text.trim() !== "" && !isNoise(text);
      })
      .map((m: any) => {
        let text = "";
        if (typeof m.content === "string") text = m.content;
        else if (Array.isArray(m.content)) {
          text = m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        }
        return { role: m.role as string, content: text };
      });
    messageCount = messages.length;
  } catch (err) {
    log().warn(`[CHAT-SUMMARY] Failed to fetch history for ${sessionKey.slice(0, 20)}: ${err}`);
    return;
  }

  // Check if enough new messages since last summary
  const lastCount = session.messageCountAtSummary ?? 0;
  const newMessages = messageCount - lastCount;

  // First summary after 2 messages, subsequent updates after MIN_NEW_MESSAGES
  const threshold = lastCount === 0 ? 2 : MIN_NEW_MESSAGES;
  if (newMessages < threshold) return;

  // Trigger async summarization + title generation
  pendingSummarizations.add(sessionKey);
  const currentLabel = session.label;
  Promise.all([
    generateSummaryFromMessages(sessionKey, messages, messageCount, session.summary ?? undefined),
    generateTitle(sessionKey, messages, currentLabel ?? undefined),
  ])
    .catch(err => log().warn(`[CHAT-SUMMARY] Failed for ${sessionKey.slice(0, 20)}: ${err}`))
    .finally(() => pendingSummarizations.delete(sessionKey));
}

async function generateSummaryFromMessages(
  sessionKey: string,
  messages: Array<{ role: string; content: string }>,
  messageCount: number,
  previousSummary?: string,
): Promise<void> {
  log().info(`[CHAT-SUMMARY] Generating summary for ${sessionKey.slice(0, 20)}... (${messageCount} messages)`);

  if (messages.length < 2) return;

  // Build the conversation text (truncate to ~4k chars for micro model context)
  const conversationText = messages
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  const truncated = conversationText.length > 4000
    ? conversationText.slice(-4000)
    : conversationText;

  const previousContext = previousSummary
    ? `\nPrevious summary: "${previousSummary}"\nUpdate this summary to incorporate the new messages.`
    : "";

  const prompt = `Summarize this chat conversation in 1-2 concise sentences that capture the main topic(s) and what was discussed/accomplished. This will be used as a label for the chat session. Be specific about the subject matter, not generic.${previousContext}

Conversation:
${truncated}

Reply with ONLY the summary, nothing else.`;

  try {
    const result = await gatewayInvoke("sessions_spawn", {
      task: prompt,
      model: SUMMARY_MODEL,
      mode: "run",
      cleanup: "kill",
      runTimeoutSeconds: 60,
      maxTokens: 200,
      metadata: { pawChatSummary: true, chatSessionKey: sessionKey },
    }, SINK_SESSION_KEY);

    let summary = result?.reply ?? result?.response ?? result?.text ?? "";

    // Clean up: strip quotes, "Summary:" prefix, thinking tags, etc.
    summary = summary
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^["']|["']$/g, "")
      .replace(/^Summary:\s*/i, "")
      .trim();

    if (!summary || summary.length < 5) {
      log().info(`[CHAT-SUMMARY] Micro model returned empty, trying fallback`);
      const fallbackResult = await gatewayInvoke("sessions_spawn", {
        task: prompt,
        model: getModelForTier("standard"),
        mode: "run",
        cleanup: "kill",
        runTimeoutSeconds: 60,
        maxTokens: 200,
        metadata: { pawChatSummary: true, chatSessionKey: sessionKey },
      }, SINK_SESSION_KEY);

      summary = (fallbackResult?.reply ?? fallbackResult?.response ?? fallbackResult?.text ?? "")
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/^["']|["']$/g, "")
        .replace(/^Summary:\s*/i, "")
        .trim();
    }

    if (!summary || summary.length < 5) {
      log().warn(`[CHAT-SUMMARY] Could not generate summary for ${sessionKey.slice(0, 20)}`);
      return;
    }

    // Truncate if too long
    if (summary.length > 300) summary = summary.slice(0, 297) + "...";

    // Store in DB
    const db = getDb();
    db.update(chatSessions)
      .set({
        summary,
        summaryUpdatedAt: new Date().toISOString(),
        messageCountAtSummary: messageCount,
      })
      .where(eq(chatSessions.sessionKey, sessionKey))
      .run();

    log().info(`[CHAT-SUMMARY] Updated summary for ${sessionKey.slice(0, 20)}: "${summary.slice(0, 60)}..."`);
  } catch (err) {
    log().warn(`[CHAT-SUMMARY] Generation failed: ${err}`);
  }
}

/**
 * Force-generate a summary for a session (e.g., via API call).
 */
export async function forceSummarize(sessionKey: string): Promise<string | null> {
  const db = getDb();
  const session = db.select().from(chatSessions)
    .where(eq(chatSessions.sessionKey, sessionKey))
    .get();
  if (!session) return null;

  // Fetch messages
  let messages: Array<{ role: string; content: string }> = [];
  try {
    const historyResult = await gatewayInvoke("sessions_history", {
      sessionKey,
      limit: 200,
      includeTools: false,
    });
    const rawMessages = historyResult?.messages ?? [];
    messages = rawMessages
      .filter((m: any) => (m.role === "user" || m.role === "assistant"))
      .map((m: any) => {
        let text = "";
        if (typeof m.content === "string") text = m.content;
        else if (Array.isArray(m.content)) {
          text = m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        }
        return { role: m.role as string, content: text };
      })
      .filter((m: any) => m.content.trim() !== "" && !isNoise(m.content));
  } catch (err) {
    log().warn(`[CHAT-SUMMARY] Force summarize history fetch failed: ${err}`);
    return null;
  }

  await generateSummaryFromMessages(sessionKey, messages, messages.length, session.summary ?? undefined);

  const updated = db.select().from(chatSessions)
    .where(eq(chatSessions.sessionKey, sessionKey))
    .get();
  return updated?.summary ?? null;
}

/**
 * Generate a short, descriptive title for a chat session.
 * 
 * Uses a micro-tier model to produce a 2-5 word title based on the conversation.
 * Re-generates as the conversation evolves — early titles are based on the first
 * few messages, later titles capture the broader theme.
 */
async function generateTitle(
  sessionKey: string,
  messages: Array<{ role: string; content: string }>,
  currentLabel?: string,
): Promise<void> {
  if (messages.length < 2) return;

  // Skip if it already has a good title and not enough messages to warrant re-titling
  const isDefaultTitle = !currentLabel || currentLabel === "New Chat" || currentLabel.startsWith("Chat ");
  // Re-title: always on default titles, at 10+ messages for existing titles, then every 20 after
  const shouldRetitle = isDefaultTitle
    || (messages.length >= 10 && messages.length < 12)
    || (messages.length >= 30 && messages.length % 20 < 2);
  if (!shouldRetitle) return;

  try {
    // Use recent messages for context (truncate to ~2k chars)
    const recentMessages = messages.slice(-20);
    const conversationText = recentMessages
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 200)}`)
      .join("\n")
      .slice(0, 2000);

    const prompt = currentLabel && !isDefaultTitle
      ? `Here is a conversation that was previously titled "${currentLabel}". Based on the full conversation so far, generate an updated short title (2-5 words) that captures the main topic or theme. Be concise and natural — like how a person would name a chat thread.

Conversation:
${conversationText}

Reply with ONLY the title, nothing else. No quotes, no punctuation at the end.`
      : `Generate a short title (2-5 words) for this conversation. Capture the main topic or intent. Be concise and natural — like how a person would name a chat thread.

Conversation:
${conversationText}

Reply with ONLY the title, nothing else. No quotes, no punctuation at the end.`;

    const result = await gatewayInvoke("sessions_spawn", {
      task: prompt,
      model: SUMMARY_MODEL,
      mode: "run",
      cleanup: "kill",
      runTimeoutSeconds: 30,
      maxTokens: 30,
      metadata: { chatTitleGeneration: true, chatSessionKey: sessionKey },
    }, SINK_SESSION_KEY);

    let title = result?.reply ?? result?.response ?? result?.text ?? "";

    // Clean up: strip thinking tags, quotes, trailing punctuation
    title = title
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^["']|["']$/g, "")
      .replace(/^Title:\s*/i, "")
      .replace(/\.+$/, "")
      .trim();

    if (!title || title.length < 2 || title.length > 80) {
      log().warn(`[CHAT-TITLE] Bad title generated: "${title?.slice(0, 100)}"`);
      return;
    }

    const db = getDb();
    db.update(chatSessions)
      .set({ label: title })
      .where(eq(chatSessions.sessionKey, sessionKey))
      .run();

    log().info(`[CHAT-TITLE] Set title for ${sessionKey.slice(0, 20)}: "${title}"`);
  } catch (err) {
    log().warn(`[CHAT-TITLE] Title generation failed: ${err}`);
  }
}
