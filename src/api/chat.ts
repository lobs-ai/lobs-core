import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { chatSessions, chatMessages } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";
import { log } from "../util/logger.js";
import { randomUUID } from "node:crypto";
import type { AgentStreamEvent } from "../services/main-agent.js";
import { getToolDefinitions } from "../runner/tools/index.js";
import { getToolsForSession } from "../runner/tools/tool-sets.js";

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
      }).run();

      return json(res, { id, key: sessionKey, title, createdAt: now, compliance_required: complianceRequired }, 201);
    }

    // POST /api/chat/sessions/:key/messages — send a message (async with polling)
    if (sessionKey && action === "messages" && method === "POST") {
      const body = (await parseBody(req)) as { content?: string };
      const content = body?.content?.trim();
      if (!content) return error(res, "content is required", 400);

      const mainAgent = (globalThis as any).__lobsMainAgent;
      if (!mainAgent) return error(res, "Agent not initialized", 503);

      const channelId = `nexus:${sessionKey}`;
      const messageId = randomUUID();
      const now = new Date().toISOString();
      log().info(`[chat] inbound nexus message session=${sessionKey} channel=${channelId} len=${content.length}`);

      // Store user message immediately
      db.insert(chatMessages).values({
        id: randomUUID().replace(/-/g, ""),
        sessionKey,
        role: "user",
        content,
        createdAt: now,
      }).run();

      // Listen for agent events and persist them as chat messages.
      // Crucially, assistant_reply is handled HERE so the message is in the DB
      // BEFORE the frontend's SSE-triggered reloadMessages() query hits.
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
            db.update(chatMessages)
              .set({
                messageMetadata: JSON.stringify({
                  toolName: event.toolName,
                  toolUseId: event.toolUseId,
                  result: event.result,
                  isError: event.isError,
                  status: "complete",
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
            db.insert(chatMessages).values({
              id: randomUUID().replace(/-/g, ""),
              sessionKey,
              role: "assistant",
              content: event.result,
              createdAt: new Date(event.timestamp).toISOString(),
            }).run();

            db.update(chatSessions)
              .set({ lastMessageAt: new Date(event.timestamp).toISOString() })
              .where(eq(chatSessions.sessionKey, sessionKey))
              .run();
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
          mainAgent.events.off("stream", toolListener);
        } else if (event.type === "done") {
          log().info(`[chat] completed session=${sessionKey} channel=${channelId}`);
          // Cleanup listener when done
          mainAgent.events.off("stream", toolListener);
        }
      };

      mainAgent.events.on("stream", toolListener);

      // Send to main agent (async, don't wait for completion).
      // The toolListener above handles persisting all messages (tools + assistant replies).
      mainAgent.handleMessage({
        id: messageId,
        content,
        authorId: "nexus-user",
        authorName: "Rafe",
        channelId,
        timestamp: Date.now(),
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

    // GET /api/chat/sessions — list sessions
    if (!sessionKey && method === "GET") {
      const sessions = db.select().from(chatSessions)
        .orderBy(desc(chatSessions.lastMessageAt))
        .all();
      
      return json(res, {
        sessions: sessions.map(s => ({
          id: s.id,
          key: s.sessionKey,
          title: s.label ?? "Chat",
          summary: s.summary ?? null,
          createdAt: s.createdAt,
          updatedAt: s.lastMessageAt ?? s.createdAt,
          isActive: s.isActive,
          compliance_required: s.complianceRequired ?? false,
          disabled_tools: s.disabledTools ? JSON.parse(s.disabledTools) : [],
        })),
      });
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

    // DELETE /api/chat/sessions/:key — delete a session
    if (sessionKey && method === "DELETE") {
      db.delete(chatMessages).where(eq(chatMessages.sessionKey, sessionKey)).run();
      db.delete(chatSessions).where(eq(chatSessions.sessionKey, sessionKey)).run();
      return json(res, { ok: true });
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
      authorName: "Rafe",
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
