import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { chatSessions, chatMessages } from "../db/schema.js";
import { json, error } from "./index.js";

export async function handleChatRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();

  if (sub === "sessions") {
    const sessionKey = parts[2]; // /api/chat/sessions/:key/messages → parts[2]=key, parts[3]="messages"
    const action = parts[3];

    if (sessionKey && action === "messages") {
      const msgs = db.select().from(chatMessages)
        .where(eq(chatMessages.sessionKey, sessionKey))
        .orderBy(chatMessages.createdAt)
        .all();
      return json(res, msgs);
    }

    const sessions = db.select().from(chatSessions).orderBy(desc(chatSessions.lastMessageAt)).all();
    return json(res, sessions);
  }

  return error(res, "Unknown chat endpoint", 404);
}
