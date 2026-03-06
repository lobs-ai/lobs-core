/**
 * Chat Summarizer — generates and updates chat session summaries using a micro-tier model.
 *
 * Triggers after new messages, debounced so we don't summarize on every single message.
 * Uses the micro tier (claude-haiku) for low cost summarization.
 */

import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { getDb } from "../db/connection.js";
import { chatSessions } from "../db/schema.js";
import { log } from "../util/logger.js";

// ── Config ──────────────────────────────────────────────────────────────

/** Minimum new messages before re-summarizing */
const MIN_NEW_MESSAGES = 3;

/** Minimum seconds between summary updates for the same session */
const MIN_INTERVAL_SECONDS = 60;

/** Model to use for summarization (micro tier) */
const SUMMARY_MODEL = "anthropic/claude-haiku-4-5";

// ── Gateway helpers ─────────────────────────────────────────────────────

function getGatewayConfig(): { port: number; token: string } {
  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    return {
      port: cfg?.gateway?.port ?? 18789,
      token: cfg?.gateway?.auth?.token ?? "",
    };
  } catch {
    return { port: 18789, token: "" };
  }
}

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

  // Trigger async summarization
  pendingSummarizations.add(sessionKey);
  generateSummaryFromMessages(sessionKey, messages, messageCount, session.summary ?? undefined)
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
        model: "anthropic/claude-sonnet-4-6",
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

    // Also update the label if it's still the default
    const session = db.select().from(chatSessions)
      .where(eq(chatSessions.sessionKey, sessionKey))
      .get();

    if (session && (session.label === "New Chat" || !session.label)) {
      const shortTitle = summary.split(/[.!?]/)[0]?.trim() || summary.slice(0, 80);
      db.update(chatSessions)
        .set({ label: shortTitle.length > 80 ? shortTitle.slice(0, 77) + "..." : shortTitle })
        .where(eq(chatSessions.sessionKey, sessionKey))
        .run();
    }

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
