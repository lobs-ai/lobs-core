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

      // Simple echo response (placeholder for actual LLM integration)
      const reply = "Message received. (This is a simple DB-backed chat - connect to gateway for AI responses)";
      
      db.insert(chatMessages).values({
        id: randomUUID().replace(/-/g, ""),
        sessionKey,
        role: "assistant",
        content: reply,
        createdAt: now,
      }).run();

      db.update(chatSessions)
        .set({ lastMessageAt: now })
        .where(eq(chatSessions.sessionKey, sessionKey))
        .run();

      return json(res, {
        reply,
        timestamp: now,
      });
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
