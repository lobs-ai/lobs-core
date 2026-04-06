import { eq, desc, and, gt, isNull, isNotNull, lt, sql, count } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { chatSessions, chatMessages } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";
import { log } from "../util/logger.js";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentStreamEvent } from "../services/main-agent.js";
import { getToolDefinitions } from "../runner/tools/index.js";
import { getToolsForSession } from "../runner/tools/tool-sets.js";
import { onAssistantMessage, onUserMessage, forceSummarize } from "../services/chat-summarizer.js";
import { getDefaultChatModel, getChannelModelOverride, getModelCatalog, normalizeModelSelection, setChannelModelOverride } from "../services/model-catalog.js";
import { getOwnerName } from "../config/identity.js";
import { getLobsRoot } from "../config/lobs.js";

const MEDIA_DIR = join(getLobsRoot(), "media");

/**
 * Track which channelIds have an active per-request toolListener.
 * The global fallback listener (for subagent completions, system events, etc.)
 * only persists events for channels NOT in this set, avoiding double-writes.
 */
const activeRequestListeners = new Set<string>();

/**
 * Install a global event listener on the main agent that persists assistant_reply,
 * tool_start, tool_result, and error events for nexus channels that DON'T have
 * an active per-request listener. This catches system-event-triggered conversations
 * (e.g., subagent completion notifications) that fire after the original request's
 * toolListener has been cleaned up.
 */
let globalListenerInstalled = false;
function ensureGlobalNexusListener() {
  if (globalListenerInstalled) return;
  const mainAgent = (globalThis as any).__lobsMainAgent;
  if (!mainAgent) return;

  globalListenerInstalled = true;
  const db = getDb();

  mainAgent.events.on("stream", (event: AgentStreamEvent) => {
    // Only handle nexus channels
    if (!event.channelId?.startsWith("nexus:")) return;
    // Skip if a per-request listener is already handling this channel
    if (activeRequestListeners.has(event.channelId)) return;

    const sessionKey = event.channelId.replace("nexus:", "");

    // Verify session exists and is not archived
    const session = db.select({ id: chatSessions.id, archivedAt: chatSessions.archivedAt })
      .from(chatSessions)
      .where(eq(chatSessions.sessionKey, sessionKey))
      .get();
    if (!session || session.archivedAt) return;

    if (event.type === "tool_start") {
      db.insert(chatMessages).values({
        id: randomUUID().replace(/-/g, ""),
        sessionKey,
        role: "tool",
        content: `🔧 ${event.toolName}`,
        createdAt: new Date(event.timestamp).toISOString(),
        messageMetadata: JSON.stringify({
          toolName: event.toolName,
          toolInput: event.toolInput,
          toolUseId: event.toolUseId,
          status: "running",
        }),
      }).run();
    } else if (event.type === "tool_result") {
      const existing = db.select().from(chatMessages)
        .where(eq(chatMessages.sessionKey, sessionKey))
        .all()
        .filter((m: any) => {
          if (m.role !== "tool") return false;
          try {
            const meta = typeof m.messageMetadata === "string" ? JSON.parse(m.messageMetadata) : m.messageMetadata;
            return meta?.toolUseId === event.toolUseId;
          } catch { return false; }
        })
        .pop();
      if (existing) {
        const mediaPattern = /!\[[^\]]*\]\(\/api\/media\/([\w\-\.]+)\)/g;
        const mediaFiles: string[] = [];
        if (event.result) {
          let m;
          while ((m = mediaPattern.exec(event.result)) !== null) {
            mediaFiles.push(m[1]);
          }
        }
        db.update(chatMessages)
          .set({
            messageMetadata: JSON.stringify({
              toolName: event.toolName,
              toolUseId: event.toolUseId,
              result: event.result,
              isError: event.isError,
              status: "complete",
              ...(mediaFiles.length > 0 ? { mediaFiles } : {}),
            }),
          })
          .where(eq(chatMessages.id, existing.id))
          .run();
      }
    } else if (event.type === "assistant_reply" && event.result) {
      log().info(`[chat:global] system-event reply session=${sessionKey} len=${event.result.length}`);
      const mediaPattern = /!\[[^\]]*\]\(\/api\/media\/([\w\-\.]+)\)/g;
      const mediaFiles: string[] = [];
      let match;
      while ((match = mediaPattern.exec(event.result)) !== null) {
        mediaFiles.push(match[1]);
      }
      db.insert(chatMessages).values({
        id: randomUUID().replace(/-/g, ""),
        sessionKey,
        role: "assistant",
        content: event.result,
        createdAt: new Date(event.timestamp).toISOString(),
        ...(mediaFiles.length > 0 ? { messageMetadata: JSON.stringify({ mediaFiles }) } : {}),
      }).run();
      db.update(chatSessions)
        .set({ lastMessageAt: new Date(event.timestamp).toISOString() })
        .where(eq(chatSessions.sessionKey, sessionKey))
        .run();
      onAssistantMessage(sessionKey);
    } else if (event.type === "error" && event.result) {
      log().warn(`[chat:global] system-event error session=${sessionKey}: ${event.result.slice(0, 160)}`);
      db.insert(chatMessages).values({
        id: randomUUID().replace(/-/g, ""),
        sessionKey,
        role: "assistant",
        content: event.result,
        createdAt: new Date(event.timestamp).toISOString(),
        messageMetadata: JSON.stringify({ isError: true }),
      }).run();
    }
  });

  log().info("[chat] Global nexus event listener installed (catches subagent completions & system events)");
}

/** Delete media files referenced by messages in a session */
function cleanupSessionMedia(sessionKey: string) {
  const db = getDb();
  const messages = db.select({ messageMetadata: chatMessages.messageMetadata })
    .from(chatMessages)
    .where(eq(chatMessages.sessionKey, sessionKey))
    .all();

  let cleaned = 0;
  for (const msg of messages) {
    if (!msg.messageMetadata) continue;
    const meta = typeof msg.messageMetadata === "string"
      ? JSON.parse(msg.messageMetadata)
      : msg.messageMetadata;
    if (meta?.mediaFiles && Array.isArray(meta.mediaFiles)) {
      for (const file of meta.mediaFiles) {
        try {
          unlinkSync(join(MEDIA_DIR, file));
          cleaned++;
        } catch {
          // File already gone — fine
        }
      }
    }
  }
  if (cleaned > 0) {
    log().info(`[chat] cleaned up ${cleaned} media file(s) for session ${sessionKey}`);
  }
}

// ─── Auto-purge archived sessions older than 30 days ────────────────────
const ARCHIVE_RETENTION_DAYS = 30;

export function purgeOldArchivedSessions() {
  const db = getDb();
  const cutoff = new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  
  const old = db.select({ sessionKey: chatSessions.sessionKey })
    .from(chatSessions)
    .where(and(isNotNull(chatSessions.archivedAt), lt(chatSessions.archivedAt, cutoff)))
    .all();

  if (old.length > 0) {
    for (const s of old) {
      cleanupSessionMedia(s.sessionKey);
      db.delete(chatMessages).where(eq(chatMessages.sessionKey, s.sessionKey)).run();
      db.delete(chatSessions).where(eq(chatSessions.sessionKey, s.sessionKey)).run();
    }
    log().info(`[chat] purged ${old.length} archived session(s) older than ${ARCHIVE_RETENTION_DAYS} days`);
  }
}

// ─── Simple DB-backed chat (no gateway dependency) ─────────────────────

/**
 * NOTE: This is a simplified chat implementation that stores messages in the DB.
 * It does NOT integrate with the gateway host or spawn subagents.
 * For production chat, use the full gateway-backed implementation.
 */

// ─── Handlers ───────────────────────────────────────────────────────────

export async function handleChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();
  const method = req.method?.toUpperCase() ?? "GET";

  // Ensure the global nexus listener is installed (idempotent, runs once)
  ensureGlobalNexusListener();

  if (sub === "sessions") {
    const sessionKey = parts[2];
    const action = parts[3];

    // POST /api/chat/sessions — create a new chat session (DB-backed only)
    if (!sessionKey && method === "POST") {
      const body = (await parseBody(req)) as { title?: string; compliance_required?: boolean };
      const title = body?.title || "New Chat";
      const complianceRequired = Boolean(body?.compliance_required ?? false);

      const id = randomUUID().replace(/-/g, "");
      const sessionKey = `chat-${id}`;
      const now = new Date().toISOString();
      
      db.insert(chatSessions).values({
        id,
        sessionKey,
        label: title,
        complianceRequired,
        createdAt: now,
        isActive: true,
        lastMessageAt: now,
        lastReadAt: now,
      }).run();

      return json(res, {
        id,
        key: sessionKey,
        title,
        createdAt: now,
        compliance_required: complianceRequired,
        currentModel: getDefaultChatModel(),
        overrideModel: null,
      }, 201);
    }

    // POST /api/chat/sessions/:key/messages — send a message (async with polling)
    if (sessionKey && action === "messages" && method === "POST") {
      const body = (await parseBody(req)) as { content?: string; images?: Array<{ base64: string; mediaType: string }> };
      const content = body?.content?.trim();
      const images = body?.images?.length ? body.images : undefined;
      if (!content && !images?.length) return error(res, "content or images required", 400);

      const mainAgent = (globalThis as any).__lobsMainAgent;
      if (!mainAgent) return error(res, "Agent not initialized", 503);

      const channelId = `nexus:${sessionKey}`;
      const messageId = randomUUID();
      const now = new Date().toISOString();
      log().info(`[chat] inbound nexus message session=${sessionKey} channel=${channelId} len=${content?.length ?? 0}${images ? ` images=${images.length}` : ''}`);

      // Store user message immediately
      db.insert(chatMessages).values({
        id: randomUUID().replace(/-/g, ""),
        sessionKey,
        role: "user",
        content: content || "(image)",
        createdAt: now,
        ...(images ? { messageMetadata: JSON.stringify({ images: images.map(img => ({ mediaType: img.mediaType })) }) } : {}),
      }).run();

      // Fire title generation immediately from the first user message
      // (async, doesn't block — title appears while agent is still thinking)
      onUserMessage(sessionKey);

      // Listen for agent events and persist them as chat messages.
      // Crucially, assistant_reply is handled HERE so the message is in the DB
      // BEFORE the frontend's SSE-triggered reloadMessages() query hits.
      // Mark this channel as having an active per-request listener so the
      // global fallback listener doesn't double-persist events.
      activeRequestListeners.add(channelId);
      const toolListener = (event: AgentStreamEvent) => {
        if (event.channelId !== channelId) return;
        if (event.type === "tool_start") {
          db.insert(chatMessages).values({
            id: randomUUID().replace(/-/g, ""),
            sessionKey,
            role: "tool",
            content: `🔧 ${event.toolName}`,
            createdAt: new Date(event.timestamp).toISOString(),
            messageMetadata: JSON.stringify({
              toolName: event.toolName,
              toolInput: event.toolInput,
              toolUseId: event.toolUseId,
              status: "running",
            }),
          }).run();
        } else if (event.type === "tool_result") {
          // Update the tool message with the result
          const existing = db.select().from(chatMessages)
            .where(eq(chatMessages.sessionKey, sessionKey))
            .all()
            .filter((m: any) => {
              if (m.role !== "tool") return false;
              try {
                const meta = typeof m.messageMetadata === "string" ? JSON.parse(m.messageMetadata) : m.messageMetadata;
                return meta?.toolUseId === event.toolUseId;
              } catch { return false; }
            })
            .pop();
          if (existing) {
            // Extract media references from tool results
            const mediaPattern = /!\[[^\]]*\]\(\/api\/media\/([\w\-\.]+)\)/g;
            const mediaFiles: string[] = [];
            if (event.result) {
              let m;
              while ((m = mediaPattern.exec(event.result)) !== null) {
                mediaFiles.push(m[1]);
              }
            }

            db.update(chatMessages)
              .set({
                messageMetadata: JSON.stringify({
                  toolName: event.toolName,
                  toolUseId: event.toolUseId,
                  result: event.result,
                  isError: event.isError,
                  status: "complete",
                  ...(mediaFiles.length > 0 ? { mediaFiles } : {}),
                }),
              })
              .where(eq(chatMessages.id, existing.id))
              .run();
          }
        } else if (event.type === "assistant_reply") {
          // Persist assistant message SYNCHRONOUSLY so it's in the DB before
          // the frontend's SSE-triggered reloadMessages() fires.
          if (event.result) {
            log().info(`[chat] assistant reply session=${sessionKey} channel=${channelId} len=${event.result.length}`);

            // Detect media references (![alt](/api/media/uuid.ext)) in the reply
            const mediaPattern = /!\[[^\]]*\]\(\/api\/media\/([\w\-\.]+)\)/g;
            const mediaFiles: string[] = [];
            let match;
            while ((match = mediaPattern.exec(event.result)) !== null) {
              mediaFiles.push(match[1]);
            }

            db.insert(chatMessages).values({
              id: randomUUID().replace(/-/g, ""),
              sessionKey,
              role: "assistant",
              content: event.result,
              createdAt: new Date(event.timestamp).toISOString(),
              ...(mediaFiles.length > 0 ? { messageMetadata: JSON.stringify({ mediaFiles }) } : {}),
            }).run();

            db.update(chatSessions)
              .set({ lastMessageAt: new Date(event.timestamp).toISOString() })
              .where(eq(chatSessions.sessionKey, sessionKey))
              .run();

            // Trigger async title generation + summary (doesn't block response)
            onAssistantMessage(sessionKey);
          }
        } else if (event.type === "error") {
          // Persist error message so the frontend can display it
          if (event.result) {
            log().warn(`[chat] agent error session=${sessionKey} channel=${channelId}: ${event.result.slice(0, 160)}`);
            db.insert(chatMessages).values({
              id: randomUUID().replace(/-/g, ""),
              sessionKey,
              role: "assistant",
              content: event.result,
              createdAt: new Date(event.timestamp).toISOString(),
              messageMetadata: JSON.stringify({ isError: true }),
            }).run();
          }
          // Cleanup listener
          activeRequestListeners.delete(channelId);
          mainAgent.events.off("stream", toolListener);
        } else if (event.type === "done") {
          log().info(`[chat] completed session=${sessionKey} channel=${channelId}`);
          // Cleanup listener when done — global fallback takes over for system events
          activeRequestListeners.delete(channelId);
          mainAgent.events.off("stream", toolListener);
        }
      };

      mainAgent.events.on("stream", toolListener);

      // Send to main agent (async, don't wait for completion).
      // The toolListener above handles persisting all messages (tools + assistant replies).
      mainAgent.handleMessage({
        id: messageId,
        content: content || "(image)",
        authorId: "nexus-user",
        authorName: getOwnerName(),
        channelId,
        timestamp: Date.now(),
        chatType: "nexus" as const,
        isDm: true,
        ...(images ? { images: images.map(img => ({ data: img.base64, mediaType: img.mediaType })) } : {}),
      }).catch((err: unknown) => {
        log().error(`[chat] Message handling failed: ${err}`);
      });

      // Return immediately with acceptance
      return json(res, { accepted: true, messageId, timestamp: now });
    }

    // GET /api/chat/sessions/:key/poll — poll for new messages since timestamp
    if (sessionKey && action === "poll" && method === "GET") {
      const url = new URL(req.url ?? "", "http://localhost");
      const since = url.searchParams.get("since");
      
      let messages;
      if (since) {
        messages = db.select()
          .from(chatMessages)
          .where(eq(chatMessages.sessionKey, sessionKey))
          .orderBy(chatMessages.createdAt)
          .all()
          .filter(m => m.createdAt > since)
          .map(m => ({
            role: m.role,
            content: m.content,
            timestamp: m.createdAt,
            metadata: m.messageMetadata,
          }));
      } else {
        messages = db.select()
          .from(chatMessages)
          .where(eq(chatMessages.sessionKey, sessionKey))
          .orderBy(chatMessages.createdAt)
          .all()
          .map(m => ({
            role: m.role,
            content: m.content,
            timestamp: m.createdAt,
            metadata: m.messageMetadata,
          }));
      }

      return json(res, { messages });
    }

    // GET /api/chat/sessions/:key/messages — fetch message history (DB-backed)
    if (sessionKey && action === "messages" && method === "GET") {
      const messages = db.select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionKey, sessionKey))
        .orderBy(chatMessages.createdAt)
        .all()
        .map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.createdAt,
          metadata: m.messageMetadata,
        }));

      return json(res, { messages });
    }

    // GET /api/chat/sessions/:key/stream — SSE stream of agent events
    if (sessionKey && action === "stream" && method === "GET") {
      const mainAgent = (globalThis as any).__lobsMainAgent;
      if (!mainAgent) return error(res, "Agent not initialized", 503);

      const channelId = `nexus:${sessionKey}`;

      // Set up SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // Send initial connected event
      res.write(`data: ${JSON.stringify({ type: "connected", channelId, timestamp: Date.now() })}\n\n`);

      // If agent is currently processing, send a thinking event immediately
      if (mainAgent.isChannelProcessing?.(channelId)) {
        res.write(`data: ${JSON.stringify({ type: "thinking", channelId, timestamp: Date.now() })}\n\n`);
      } else if (mainAgent.getChannelQueueDepth?.(channelId) > 0) {
        // Channel has queued messages — let client know
        res.write(`data: ${JSON.stringify({ type: "queued", channelId, queuePosition: mainAgent.getChannelQueueDepth(channelId), timestamp: Date.now() })}\n\n`);
      }

      // Listen for stream events from the main agent
      const listener = (event: AgentStreamEvent) => {
        if (event.channelId !== channelId) return;
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Client disconnected
        }
      };

      mainAgent.events.on("stream", listener);

      // Keep alive every 15s
      const keepAlive = setInterval(() => {
        try {
          res.write(`: keepalive\n\n`);
        } catch {
          cleanup();
        }
      }, 15_000);

      const cleanup = () => {
        mainAgent.events.off("stream", listener);
        clearInterval(keepAlive);
        try { res.end(); } catch { /* already closed */ }
      };

      req.on("close", cleanup);
      req.on("error", cleanup);

      return; // Don't close the response — SSE stays open
    }

    // GET /api/chat/sessions/:key/status — check processing status
    if (sessionKey && action === "status" && method === "GET") {
      const mainAgent = (globalThis as any).__lobsMainAgent;
      const channelId = `nexus:${sessionKey}`;
      
      const status = {
        processing: mainAgent?.isChannelProcessing?.(channelId) ?? false,
        queueDepth: mainAgent?.getChannelQueueDepth?.(channelId) ?? 0,
        activeChannels: mainAgent?.getActiveChannelCount?.() ?? 0,
        maxConcurrent: mainAgent?.getMaxConcurrent?.() ?? 10,
      };
      
      return json(res, status);
    }

    // GET /api/chat/sessions — list sessions (excludes archived by default)
    // ?archived=true — list only archived sessions
    if (!sessionKey && method === "GET") {
      const url = new URL(req.url ?? "", "http://localhost");
      const showArchived = url.searchParams.get("archived") === "true";

      const sessions = db.select().from(chatSessions)
        .where(showArchived ? isNotNull(chatSessions.archivedAt) : isNull(chatSessions.archivedAt))
        .orderBy(desc(chatSessions.lastMessageAt))
        .all();
      
      // Get processing channels from main agent for status indicators
      const mainAgent = (globalThis as any).__lobsMainAgent;
      const processingChannels = new Set(mainAgent?.getProcessingChannels?.() ?? []);

      return json(res, {
        sessions: sessions.map(s => {
          // Count unread assistant text messages since lastReadAt
          // Only count assistant messages (not tool calls or user messages)
          let unreadCount = 0;
          const conditions = [
            eq(chatMessages.sessionKey, s.sessionKey),
            eq(chatMessages.role, "assistant"),
          ];
          if (s.lastReadAt) {
            conditions.push(gt(chatMessages.createdAt, s.lastReadAt));
          }
          const result = db.select({ count: sql<number>`count(*)` })
            .from(chatMessages)
            .where(and(...conditions))
            .get();
          unreadCount = s.lastReadAt ? (result?.count ?? 0) : 0;

          const channelId = `nexus:${s.sessionKey}`;

          return {
            id: s.id,
            key: s.sessionKey,
            title: s.label ?? "Chat",
            summary: s.summary ?? null,
            createdAt: s.createdAt,
            updatedAt: s.lastMessageAt ?? s.createdAt,
            isActive: s.isActive,
            compliance_required: s.complianceRequired ?? false,
            disabled_tools: s.disabledTools ? JSON.parse(s.disabledTools) : [],
            unreadCount,
            processing: processingChannels.has(channelId),
            currentModel: getChannelModelOverride(channelId) ?? getDefaultChatModel(),
            overrideModel: getChannelModelOverride(channelId),
            archivedAt: s.archivedAt ?? null,
          };
        }),
      });
    }

    // POST /api/chat/sessions/:key/read — mark session as read
    if (sessionKey && action === "read" && method === "POST") {
      const session = db.select().from(chatSessions)
        .where(eq(chatSessions.sessionKey, sessionKey))
        .get();
      if (!session) return error(res, "Session not found", 404);

      const now = new Date().toISOString();
      db.update(chatSessions)
        .set({ lastReadAt: now })
        .where(eq(chatSessions.sessionKey, sessionKey))
        .run();

      return json(res, { key: sessionKey, lastReadAt: now });
    }

    // PATCH /api/chat/sessions/:key/compliance — toggle compliance mode for a session
    // Body: { compliance_required: boolean }
    // When compliance_required=true, the session is flagged so that the UI and any
    // future classification/routing can enforce local-model-only processing.
    if (sessionKey && action === "compliance" && method === "PATCH") {
      const body = (await parseBody(req)) as { compliance_required?: boolean };
      if (typeof body.compliance_required !== "boolean") {
        return error(res, "compliance_required (boolean) is required", 400);
      }
      const session = db.select().from(chatSessions)
        .where(eq(chatSessions.sessionKey, sessionKey))
        .get();
      if (!session) return error(res, "Session not found", 404);

      db.update(chatSessions)
        .set({ complianceRequired: body.compliance_required })
        .where(eq(chatSessions.sessionKey, sessionKey))
        .run();

      log().info(
        `[COMPLIANCE] Chat session ${sessionKey.slice(0, 30)} compliance_required set to ${body.compliance_required}`
      );
      return json(res, {
        key: sessionKey,
        compliance_required: body.compliance_required,
      });
    }

    // POST /api/chat/sessions/:key/summarize — force re-generate title + summary
    if (sessionKey && action === "summarize" && method === "POST") {
      const session = db.select().from(chatSessions)
        .where(eq(chatSessions.sessionKey, sessionKey))
        .get();
      if (!session) return error(res, "Session not found", 404);

      try {
        const result = await forceSummarize(sessionKey);
        return json(res, {
          key: sessionKey,
          title: result.title,
          summary: result.summary,
        });
      } catch (err) {
        log().error(`[chat] Force summarize failed: ${err}`);
        return error(res, "Summarization failed", 500);
      }
    }

    // GET /api/chat/sessions/:key/tools — list available tools with enabled/disabled status
    if (sessionKey && action === "tools" && method === "GET") {
      const sessionRow = db.select()
        .from(chatSessions)
        .where(eq(chatSessions.sessionKey, sessionKey))
        .get();
      if (!sessionRow) return error(res, "Session not found", 404);

      let disabledList: string[] = [];
      if (sessionRow.disabledTools) {
        try { disabledList = JSON.parse(sessionRow.disabledTools); } catch { /* ignore bad JSON */ }
      }

      const toolNames = getToolsForSession("nexus");
      const definitions = getToolDefinitions(toolNames);
      const tools = definitions.map(def => ({
        name: def.name,
        description: def.description,
        enabled: !disabledList.includes(def.name),
      }));

      return json(res, { tools });
    }

    // GET /api/chat/sessions/:key/model — current model + available options
    if (sessionKey && action === "model" && method === "GET") {
      const sessionRow = db.select()
        .from(chatSessions)
        .where(eq(chatSessions.sessionKey, sessionKey))
        .get();
      if (!sessionRow) return error(res, "Session not found", 404);

      const channelId = `nexus:${sessionKey}`;
      const catalog = await getModelCatalog();
      const overrideModel = getChannelModelOverride(channelId);
      return json(res, {
        key: sessionKey,
        currentModel: overrideModel ?? catalog.defaultModel,
        overrideModel,
        options: catalog.options,
        lmstudio: catalog.lmstudio,
      });
    }

    // PATCH /api/chat/sessions/:key/model — set/clear model override
    if (sessionKey && action === "model" && method === "PATCH") {
      const body = (await parseBody(req)) as { model?: string | null };
      const sessionRow = db.select()
        .from(chatSessions)
        .where(eq(chatSessions.sessionKey, sessionKey))
        .get();
      if (!sessionRow) return error(res, "Session not found", 404);

      const channelId = `nexus:${sessionKey}`;
      const normalized = typeof body.model === "string" && body.model.trim()
        ? await normalizeModelSelection(body.model)
        : null;

      setChannelModelOverride(channelId, normalized);
      log().info(`[chat] session ${sessionKey} model override set to ${normalized ?? "default"}`);

      return json(res, {
        key: sessionKey,
        currentModel: normalized ?? getDefaultChatModel(),
        overrideModel: normalized,
      });
    }

    // PATCH /api/chat/sessions/:key/tools — update disabled tools list
    if (sessionKey && action === "tools" && method === "PATCH") {
      const body = (await parseBody(req)) as { disabled_tools?: string[] };
      if (!Array.isArray(body?.disabled_tools)) {
        return error(res, "disabled_tools must be an array", 400);
      }

      const sessionRow = db.select()
        .from(chatSessions)
        .where(eq(chatSessions.sessionKey, sessionKey))
        .get();
      if (!sessionRow) return error(res, "Session not found", 404);

      const disabledJson = JSON.stringify(body.disabled_tools);
      db.update(chatSessions)
        .set({ disabledTools: disabledJson })
        .where(eq(chatSessions.sessionKey, sessionKey))
        .run();

      return json(res, { key: sessionKey, disabled_tools: body.disabled_tools });
    }

    // DELETE /api/chat/sessions/:key — archive a session (soft-delete)
    // Pass ?permanent=true to hard-delete immediately
    // Empty sessions (no messages) are always hard-deleted immediately.
    if (sessionKey && method === "DELETE") {
      const url = new URL(req.url ?? "", "http://localhost");
      const permanent = url.searchParams.get("permanent") === "true";

      // Check if the session has any messages
      const msgCount = db.select({ count: count() }).from(chatMessages)
        .where(eq(chatMessages.sessionKey, sessionKey))
        .get();
      const isEmpty = !msgCount || msgCount.count === 0;

      if (permanent || isEmpty) {
        cleanupSessionMedia(sessionKey);
        db.delete(chatMessages).where(eq(chatMessages.sessionKey, sessionKey)).run();
        db.delete(chatSessions).where(eq(chatSessions.sessionKey, sessionKey)).run();
        log().info(`[chat] permanently deleted session ${sessionKey}${isEmpty ? " (empty)" : ""}`);
      } else {
        const now = new Date().toISOString();
        db.update(chatSessions)
          .set({ archivedAt: now })
          .where(eq(chatSessions.sessionKey, sessionKey))
          .run();
        log().info(`[chat] archived session ${sessionKey}`);
      }
      return json(res, { ok: true });
    }

    // POST /api/chat/sessions/:key/unarchive — restore an archived session
    if (sessionKey && action === "unarchive" && method === "POST") {
      const session = db.select().from(chatSessions)
        .where(eq(chatSessions.sessionKey, sessionKey))
        .get();
      if (!session) return error(res, "Session not found", 404);

      db.update(chatSessions)
        .set({ archivedAt: null })
        .where(eq(chatSessions.sessionKey, sessionKey))
        .run();
      log().info(`[chat] unarchived session ${sessionKey}`);

      return json(res, { ok: true, key: sessionKey });
    }
  }

  return error(res, "Unknown chat endpoint", 404);
}

// ─── Main Agent Direct Chat ────────────────────────────────────────────

export async function handleMainAgentChat(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";
  const mainAgent = (globalThis as any).__lobsMainAgent;
  
  // GET /api/agent/messages — get main agent conversation history
  if (sub === "messages" && method === "GET") {
    if (!mainAgent) return json(res, { messages: [] });
    
    const db = getDb();
    // Read from main_agent_messages table directly
    const rawDb = (globalThis as any).__lobsMainAgent?.db;
    if (!rawDb) return json(res, { messages: [] });
    
    const messages = rawDb.prepare(`
      SELECT role, content, author_name, channel_id, created_at 
      FROM main_agent_messages 
      ORDER BY created_at DESC LIMIT 100
    `).all().reverse();
    
    return json(res, { messages });
  }
  
  // POST /api/agent/send — send message to main agent
  if (sub === "send" && method === "POST") {
    if (!mainAgent) return error(res, "Main agent not initialized", 503);
    
    const body = (await parseBody(req)) as { content?: string };
    const content = body?.content?.trim();
    if (!content) return error(res, "content is required", 400);
    
    const channelId = "nexus:main";  // Direct Nexus agent chat
    
    await mainAgent.handleMessage({
      id: randomUUID(),
      content,
      authorId: "nexus-user",
      authorName: getOwnerName(),
      channelId,
      timestamp: Date.now(),
    });
    
    // Wait for processing to complete
    try {
      await mainAgent.waitForChannelIdle(channelId, 120_000);
    } catch (err) {
      log().warn(`[agent] Timeout waiting for channel ${channelId}: ${err}`);
    }
    
    const reply = mainAgent.getLastAssistantMessage(channelId);
    return json(res, { reply: reply || "", timestamp: new Date().toISOString() });
  }
  
  // GET /api/agent/status — main agent status
  if (sub === "status" && method === "GET") {
    return json(res, {
      ready: !!mainAgent,
      processing: mainAgent?.isProcessing() ?? false,
      queueDepth: mainAgent?.getQueueDepth() ?? 0,
    });
  }
  
  return error(res, "Unknown agent endpoint", 404);
}

// Helper: get recent agent activity (for polling during processing)
function getAgentActivity(): { processing: boolean; lastTool?: string; queueDepth: number } {
  const mainAgent = (globalThis as any).__lobsMainAgent;
  return {
    processing: mainAgent?.isProcessing() ?? false,
    queueDepth: mainAgent?.getQueueDepth() ?? 0,
  };
}
