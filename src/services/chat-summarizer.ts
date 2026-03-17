/**
 * Chat Summarizer & Namer — uses local LM Studio model for free, fast chat intelligence.
 *
 * Two jobs:
 * 1. Generate a short descriptive name for the chat (after first exchange)
 * 2. Generate/update a running summary (after enough new messages)
 *
 * All inputs and outputs are saved as training data so we can later
 * generate correct outputs with a larger model for fine-tuning.
 *
 * Uses qwen/qwen3.5-9b via LM Studio (non-fine-tuned).
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { chatSessions, chatMessages } from "../db/schema.js";
import { log } from "../util/logger.js";
import { getModelConfig } from "../config/models.js";
import { logTrainingExample } from "./training-data.js";

// ── Config ──────────────────────────────────────────────────────────────

/** Minimum new messages before re-summarizing */
const SUMMARY_THRESHOLD = 6;

/** Max chars of conversation to feed the model */
const MAX_CONTEXT_CHARS = 12_000;

/** Timeout for local model calls */
const TIMEOUT_MS = 60_000;

// ── Prompts ─────────────────────────────────────────────────────────────

const TITLE_SYSTEM_PROMPT = `You are a chat title generator. Given a conversation between a user and an AI assistant, generate a short, descriptive title (3-7 words). The title should capture the main topic or intent of the conversation.

Rules:
- Output ONLY the title, nothing else
- No quotes, no punctuation at the end
- Be specific and descriptive, not generic
- Use title case

Examples of good titles: "Debug PostgreSQL Connection Timeout", "Setting Up Docker Compose", "Weekly Schedule Planning", "Rust Lifetime Errors in Parser"
Examples of bad titles: "Chat", "Help", "Question", "New Conversation", "AI Assistant Chat"`;

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Given a chat between a user and an AI assistant, write a concise summary that captures:
1. What the user wanted
2. Key decisions or actions taken
3. Current status / what's unresolved

Rules:
- 2-4 sentences max
- Be specific — mention technologies, file names, concrete details
- Focus on what matters for context if someone picks up this conversation later
- Output ONLY the summary, nothing else`;

const UPDATE_SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. You're given the previous summary and new messages from a conversation. Update the summary to incorporate the new content.

Rules:
- 2-4 sentences max
- Keep important details from the previous summary
- Add new developments
- Focus on what matters for context if someone picks up this conversation later
- Output ONLY the updated summary, nothing else`;

// ── Core Functions ──────────────────────────────────────────────────────

/**
 * Call the local LM Studio model directly.
 */
async function callLocalModel(
  systemPrompt: string,
  userPrompt: string,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const config = getModelConfig();
  const baseUrl = config.local?.baseUrl ?? "http://localhost:1234/v1";
  const model = config.local?.chatModel ?? "qwen/qwen3.5-9b";
  const maxTokens = opts?.maxTokens ?? 256;
  const temperature = opts?.temperature ?? 0.3;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
          // Prefill with empty think block to skip Qwen3.5's reasoning tokens.
          // This forces the model to jump straight to the answer.
          { role: "assistant", content: "<think>\n\n</think>\n\n" },
        ],
        max_tokens: maxTokens,
        temperature,
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
    let content = data.choices?.[0]?.message?.content?.trim() ?? "";

    // Strip any remaining think blocks if the model still produces them
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    return content;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Local model timed out after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format messages into a readable conversation transcript.
 */
function formatMessages(messages: Array<{ role: string; content: string }>): string {
  return messages
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

/**
 * Truncate a transcript to fit within the context window.
 */
function truncateTranscript(transcript: string): string {
  if (transcript.length <= MAX_CONTEXT_CHARS) return transcript;
  // Keep the end (most recent) and note truncation
  return "... [earlier messages truncated]\n\n" + transcript.slice(-MAX_CONTEXT_CHARS);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Generate a title for a chat session. Called after the first assistant response.
 * Returns the generated title, or null if it fails.
 */
export async function generateChatTitle(sessionKey: string): Promise<string | null> {
  const db = getDb();

  try {
    // Get the session
    const session = db.select().from(chatSessions)
      .where(eq(chatSessions.sessionKey, sessionKey))
      .get();

    if (!session) {
      log().warn(`[chat-summarizer] Session not found: ${sessionKey}`);
      return null;
    }

    // If already titled (not default), skip
    if (session.label && session.label !== "New Chat") {
      return session.label;
    }

    // Get messages
    const messages = db.select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, sessionKey))
      .orderBy(chatMessages.createdAt)
      .all();

    if (messages.length < 2) return null; // Need at least one exchange

    const transcript = truncateTranscript(formatMessages(messages));
    const userPrompt = `Generate a title for this conversation:\n\n${transcript}`;

    const config = getModelConfig();
    const model = config.local?.chatModel ?? "qwen/qwen3.5-9b";

    // Call local model
    const rawTitle = await callLocalModel(TITLE_SYSTEM_PROMPT, userPrompt, {
      maxTokens: 32,
      temperature: 0.3,
    });

    // Clean up: remove quotes, trailing punctuation
    let title = rawTitle
      .replace(/^["']|["']$/g, "")
      .replace(/[.!?]+$/, "")
      .trim();

    // Sanity check
    if (!title || title.length < 3 || title.length > 80) {
      log().warn(`[chat-summarizer] Bad title generated: "${rawTitle}"`);
      title = rawTitle.slice(0, 80).trim() || "New Chat";
    }

    // Save to DB
    db.update(chatSessions)
      .set({ label: title })
      .where(eq(chatSessions.sessionKey, sessionKey))
      .run();

    // Log training data for later fine-tuning
    logTrainingExample({
      taskType: "chat_title",
      systemPrompt: TITLE_SYSTEM_PROMPT,
      userPrompt,
      context: { sessionKey, messageCount: messages.length },
      modelOutput: rawTitle,
      modelUsed: model,
    });

    log().info(`[chat-summarizer] Named session ${sessionKey}: "${title}"`);
    return title;
  } catch (err) {
    log().error(`[chat-summarizer] Title generation failed for ${sessionKey}: ${err}`);
    return null;
  }
}

/**
 * Maybe generate/update a summary for a chat session.
 * Only runs if enough new messages have accumulated since last summary.
 * Returns the summary, or null if skipped/failed.
 */
export async function maybeSummarizeChat(sessionKey: string): Promise<string | null> {
  const db = getDb();

  try {
    const session = db.select().from(chatSessions)
      .where(eq(chatSessions.sessionKey, sessionKey))
      .get();

    if (!session) return null;

    // Count current messages
    const countResult = db.select({ count: sql<number>`count(*)` })
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, sessionKey))
      .get();

    const messageCount = countResult?.count ?? 0;
    const lastSummarizedAt = session.messageCountAtSummary ?? 0;
    const newMessages = messageCount - lastSummarizedAt;

    // Not enough new messages to bother
    if (newMessages < SUMMARY_THRESHOLD) return session.summary ?? null;

    // Get all messages
    const messages = db.select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, sessionKey))
      .orderBy(chatMessages.createdAt)
      .all();

    const config = getModelConfig();
    const model = config.local?.chatModel ?? "qwen/qwen3.5-9b";

    let systemPrompt: string;
    let userPrompt: string;

    if (session.summary) {
      // Update existing summary
      systemPrompt = UPDATE_SUMMARY_SYSTEM_PROMPT;
      // Only feed new messages + previous summary
      const recentMessages = messages.slice(lastSummarizedAt);
      const transcript = truncateTranscript(formatMessages(recentMessages));
      userPrompt = `Previous summary:\n${session.summary}\n\nNew messages:\n${transcript}`;
    } else {
      // First summary
      systemPrompt = SUMMARY_SYSTEM_PROMPT;
      const transcript = truncateTranscript(formatMessages(messages));
      userPrompt = `Summarize this conversation:\n\n${transcript}`;
    }

    const summary = await callLocalModel(systemPrompt, userPrompt, {
      maxTokens: 256,
      temperature: 0.3,
    });

    if (!summary || summary.length < 10) {
      log().warn(`[chat-summarizer] Bad summary generated for ${sessionKey}: "${summary}"`);
      return session.summary ?? null;
    }

    // Save to DB
    const now = new Date().toISOString();
    db.update(chatSessions)
      .set({
        summary,
        summaryUpdatedAt: now,
        messageCountAtSummary: messageCount,
      })
      .where(eq(chatSessions.sessionKey, sessionKey))
      .run();

    // Log training data
    logTrainingExample({
      taskType: "chat_summary",
      systemPrompt,
      userPrompt,
      context: {
        sessionKey,
        messageCount,
        hadPreviousSummary: !!session.summary,
        previousSummary: session.summary ?? null,
      },
      modelOutput: summary,
      modelUsed: model,
    });

    log().info(`[chat-summarizer] Summarized session ${sessionKey} (${messageCount} msgs)`);
    return summary;
  } catch (err) {
    log().error(`[chat-summarizer] Summary failed for ${sessionKey}: ${err}`);
    return null;
  }
}

/**
 * Force-generate both title and summary for a session.
 * Used for manual triggers or backfilling.
 */
export async function forceSummarize(sessionKey: string): Promise<{ title: string | null; summary: string | null }> {
  const db = getDb();

  // Store original label so we can restore it if title generation fails
  const existing = db.select({ label: chatSessions.label })
    .from(chatSessions)
    .where(eq(chatSessions.sessionKey, sessionKey))
    .get();
  const originalLabel = existing?.label;

  // Reset label to allow title regeneration, reset message count for summary
  db.update(chatSessions)
    .set({ label: "New Chat", messageCountAtSummary: 0 })
    .where(eq(chatSessions.sessionKey, sessionKey))
    .run();

  let title: string | null = null;
  try {
    title = await generateChatTitle(sessionKey);
  } catch (err) {
    // If title generation fails, restore original label
    if (originalLabel && originalLabel !== "New Chat") {
      db.update(chatSessions)
        .set({ label: originalLabel })
        .where(eq(chatSessions.sessionKey, sessionKey))
        .run();
    }
    log().error(`[chat-summarizer] Title generation failed for ${sessionKey}: ${err}`);
  }
  const summary = await maybeSummarizeChat(sessionKey);
  return { title, summary };
}

/**
 * Hook to call after an assistant message is saved.
 * Handles both title generation (first exchange) and summary updates.
 * Runs async — doesn't block the chat response.
 */
export function onAssistantMessage(sessionKey: string): void {
  // Fire and forget — don't block the response
  (async () => {
    try {
      // Always try title (it's a no-op if already titled)
      await generateChatTitle(sessionKey);

      // Try summary (it checks the threshold internally)
      await maybeSummarizeChat(sessionKey);
    } catch (err) {
      log().error(`[chat-summarizer] onAssistantMessage hook failed: ${err}`);
    }
  })();
}
