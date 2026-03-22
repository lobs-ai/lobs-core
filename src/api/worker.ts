import { isNull, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { workerRuns, chatSessions } from "../db/schema.js";
import { json, parseQuery } from "./index.js";

export async function handleWorkerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  _parts: string[] = [],
): Promise<void> {
  const db = getDb();

  if (id === "status") {
    const activeWorkers = db.select().from(workerRuns).where(isNull(workerRuns.endedAt)).all();

    // Include active chat sessions — these represent real work happening on the system
    const mainAgent = (globalThis as any).__lobsMainAgent;
    const processingChannels = new Set(mainAgent?.getProcessingChannels?.() ?? []);
    const allSessions = db.select().from(chatSessions).where(isNull(chatSessions.archivedAt)).all();
    const activeChatSessions = allSessions
      .filter(s => processingChannels.has(`nexus:${s.sessionKey}`))
      .map(s => ({
        type: 'chat' as const,
        sessionKey: s.sessionKey,
        label: s.label ?? 'Chat',
        startedAt: s.lastMessageAt ?? s.createdAt,
      }));

    return json(res, {
      active: activeWorkers.length > 0 || activeChatSessions.length > 0,
      workers: activeWorkers,
      chatSessions: activeChatSessions,
      timestamp: new Date().toISOString(),
    });
  }

  if (id === "history") {
    const q = parseQuery(req.url ?? "");
    const limit = parseInt(q.limit ?? "50", 10);
    const rows = db.select().from(workerRuns).orderBy(desc(workerRuns.startedAt)).limit(limit).all();
    return json(res, rows);
  }

  // Default: list all (backward compat)
  const q = parseQuery(req.url ?? "");
  const limit = parseInt(q.limit ?? "50", 10);
  const rows = db.select().from(workerRuns).orderBy(desc(workerRuns.startedAt)).limit(limit).all();
  return json(res, rows);
}
