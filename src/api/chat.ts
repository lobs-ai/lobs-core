import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { chatSessions, chatMessages } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";
import { log } from "../util/logger.js";
import { randomUUID } from "node:crypto";

// ─── Simple DB-backed chat (no gateway dependency) ─────────────────────

/**
 * NOTE: This is a simplified chat implementation that stores messages in the DB.
 * It does NOT integrate with OpenClaw gateway or spawn subagents.
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

    // POST /api/chat/sessions/:key/messages — send a message (DB-backed only)
    if (sessionKey && action === "messages" && method === "POST") {
      const body = (await parseBody(req)) as { content?: string };
      const content = body?.content?.trim();
      if (!content) return error(res, "content is required", 400);

      const now = new Date().toISOString();
      
      // Store user message
      db.insert(chatMessages).values({
        id: randomUUID().replace(/-/g, ""),
        sessionKey,
        role: "user",
        content,
        createdAt: now,
      }).run();

      // Route to MainAgent for LLM processing
      const mainAgent = (globalThis as any).__lobsMainAgent;
      if (mainAgent) {
        // Collect reply via a promise
        let replyText = "";
        const replyPromise = new Promise<string>((resolve) => {
          const originalHandler = mainAgent.onReply;
          const sessionChannelId = `nexus-chat:${sessionKey}`;
          
          // Temporarily set reply handler to capture response
          mainAgent.setReplyHandler(async (channelId: string, content: string) => {
            if (channelId === sessionChannelId) {
              replyText += content;
            }
            // Also forward to Discord if original handler exists
            if (originalHandler) {
              await originalHandler(channelId, content);
            }
          });

          // Send message to agent
          mainAgent.handleMessage({
            id: randomUUID(),
            content,
            authorId: "nexus-user",
            authorName: "Rafe (Nexus)",
            channelId: sessionChannelId,
            timestamp: Date.now(),
          }).then(() => {
            // Wait a bit for processing to complete
            const checkReply = () => {
              if (!mainAgent.isProcessing()) {
                // Restore original handler
                mainAgent.setReplyHandler(originalHandler);
                resolve(replyText || "Processing complete.");
              } else {
                setTimeout(checkReply, 500);
              }
            };
            setTimeout(checkReply, 500);
          });
          
          // Timeout after 120s
          setTimeout(() => {
            mainAgent.setReplyHandler(originalHandler);
            resolve(replyText || "Response timed out.");
          }, 120000);
        });

        const reply = await replyPromise;
        const replyNow = new Date().toISOString();
        
        // Store assistant response
        db.insert(chatMessages).values({
          id: randomUUID().replace(/-/g, ""),
          sessionKey,
          role: "assistant",
          content: reply,
          createdAt: replyNow,
        }).run();

        db.update(chatSessions)
          .set({ lastMessageAt: replyNow })
          .where(eq(chatSessions.sessionKey, sessionKey))
          .run();

        return json(res, { reply, timestamp: replyNow });
      }
      
      // Fallback if no main agent
      const reply = "Main agent not initialized. Please check lobs-core configuration.";

      db.update(chatSessions)
        .set({ lastMessageAt: now })
        .where(eq(chatSessions.sessionKey, sessionKey))
        .run();

      return json(res, { reply, timestamp: now });
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
        }));

      return json(res, { messages });
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
    
    // Collect reply
    let replyText = "";
    const channelId = "nexus-chat";
    
    const replyPromise = new Promise<string>((resolve) => {
      const originalHandler = (mainAgent as any).onReply;
      
      mainAgent.setReplyHandler(async (ch: string, text: string) => {
        if (ch === channelId) {
          replyText += (replyText ? "\n" : "") + text;
        }
        if (originalHandler && ch !== channelId) {
          await originalHandler(ch, text);
        }
      });
      
      mainAgent.handleMessage({
        id: randomUUID(),
        content,
        authorId: "nexus-user",
        authorName: "Rafe",
        channelId,
        timestamp: Date.now(),
      }).then(() => {
        const check = () => {
          if (!mainAgent.isProcessing()) {
            mainAgent.setReplyHandler(originalHandler);
            resolve(replyText || "");
          } else {
            setTimeout(check, 500);
          }
        };
        setTimeout(check, 500);
      });
      
      setTimeout(() => {
        mainAgent.setReplyHandler(originalHandler);
        resolve(replyText || "(timed out)");
      }, 120000);
    });
    
    const reply = await replyPromise;
    return json(res, { reply, timestamp: new Date().toISOString() });
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
