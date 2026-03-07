import { eq, desc } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { getDb } from "../db/connection.js";
import { chatSessions } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";
import { log } from "../util/logger.js";
import { maybeSummarizeChat, forceSummarize } from "../services/chat-summarizer.js";

// ─── Gateway helpers ────────────────────────────────────────────────────

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

// Messages to filter from history (system/orchestrator noise)
const NOISE_PATTERNS = [
  /^Agent-to-agent announce/i,
  /^ANNOUNCE_SKIP$/,
  /^HEARTBEAT_OK$/,
  /^REPLY_SKIP$/,
  /^NO_REPLY$/,
  /^\[System\]/,
  /^PAW plugin restarted/,
  // Inter-agent / orchestrator messages
  /^\[orchestrator\]/i,
  /^\[sink\]/i,
  /^orchestrator:/i,
  /^Task assigned:/i,
  /^Task completed:/i,
  /^Worker (started|stopped|idle)/i,
  /^Spawning agent/i,
  /^\[paw-/i,
  /^control loop/i,
];

function isNoise(text: string): boolean {
  return NOISE_PATTERNS.some(p => p.test(text.trim()));
}

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

    // POST /api/chat/sessions — create a new chat session
    if (!sessionKey && method === "POST") {
      const body = (await parseBody(req)) as { title?: string; compliance_required?: boolean };
      const title = body?.title || "New Chat";
      const complianceRequired = Boolean(body?.compliance_required ?? false);

      // Resolve the model to use for this session.
      // Compliant sessions use the configured local compliance model so that no
      // user data is sent to cloud providers even before the first message.
      // Falls back to the default cloud model when compliance_model is not configured.
      let sessionModel = "anthropic/claude-sonnet-4-6";
      if (complianceRequired) {
        try {
          const { getRawDb } = await import("../db/connection.js");
          const rawDb = getRawDb();
          const cmRow = rawDb.prepare(
            `SELECT value FROM orchestrator_settings WHERE key = 'compliance_model'`
          ).get() as { value: string } | undefined;
          if (cmRow) {
            const parsed = JSON.parse(cmRow.value) as unknown;
            if (typeof parsed === "string" && parsed.length > 0) {
              sessionModel = parsed;
              log().info(`[COMPLIANCE] Creating compliant chat session with local model: ${sessionModel}`);
            }
          }
        } catch (e) {
          log().warn(`[COMPLIANCE] Could not resolve compliance_model setting: ${e}`);
        }
      }

      try {
        // Spawn through the main agent so the chat inherits the user's
        // personality (SOUL.md, IDENTITY.md, USER.md, workspace files).
        // The task prompt reinforces this is a web chat context.
        const spawnResult = await gatewayInvoke("sessions_spawn", {
          task: `You are chatting with your human through the PAW web dashboard. Use your personality from SOUL.md and your identity from IDENTITY.md. Be yourself — conversational, helpful, and in-character. Read your workspace files to remember who you are and who you're talking to.`,
          mode: "session",
          model: sessionModel,
          thread: true,
        });

        const ocSessionKey = spawnResult?.childSessionKey ?? spawnResult?.sessionKey;
        if (!ocSessionKey) {
          log().error(`chat: spawn returned no session key: ${JSON.stringify(spawnResult)}`);
          return error(res, "Failed to create session — no session key returned", 500);
        }

        const id = crypto.randomUUID().replace(/-/g, "");
        const now = new Date().toISOString();
        db.insert(chatSessions).values({
          id,
          sessionKey: ocSessionKey,
          label: title,
          complianceRequired,
          createdAt: now,
          isActive: true,
          lastMessageAt: now,
        }).run();

        return json(res, { id, key: ocSessionKey, title, createdAt: now, compliance_required: complianceRequired }, 201);
      } catch (err) {
        log().error(`chat: failed to create session: ${err}`);
        return error(res, `Failed to create chat session: ${String(err)}`, 500);
      }
    }

    // POST /api/chat/sessions/:key/messages — send a message
    if (sessionKey && action === "messages" && method === "POST") {
      const body = (await parseBody(req)) as { content?: string };
      const content = body?.content?.trim();
      if (!content) return error(res, "content is required", 400);

      try {
        const sendResult = await gatewayInvoke("sessions_send", {
          sessionKey,
          message: content,
          timeoutSeconds: 120,
        });

        db.update(chatSessions)
          .set({ lastMessageAt: new Date().toISOString() })
          .where(eq(chatSessions.sessionKey, sessionKey))
          .run();

        const reply = sendResult?.reply ?? sendResult?.response ?? sendResult?.text ?? "";

        maybeSummarizeChat(sessionKey).catch(() => {}); // fire-and-forget summary update
        return json(res, {
          reply,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log().error(`chat: failed to send message: ${err}`);
        return error(res, `Failed to send message: ${String(err)}`, 500);
      }
    }

    // GET /api/chat/sessions/:key/messages — fetch message history
    if (sessionKey && action === "messages" && method === "GET") {
      try {
        const historyResult = await gatewayInvoke("sessions_history", {
          sessionKey,
          limit: 100,
          includeTools: false,
        });

        const rawMessages = historyResult?.messages ?? [];
        const messages = rawMessages
          .filter((m: any) => m.role === "user" || m.role === "assistant")
          .map((m: any) => {
            let text = "";
            if (typeof m.content === "string") {
              text = m.content;
            } else if (Array.isArray(m.content)) {
              text = m.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n");
            }
            return { role: m.role, content: text, timestamp: m.timestamp };
          })
          .filter((m: any) => m.content.trim() !== "" && !isNoise(m.content));

        return json(res, { messages });
      } catch (err) {
        log().error(`chat: failed to fetch history: ${err}`);
        return json(res, { messages: [] });
      }
    }

    // GET /api/chat/sessions — list sessions
    if (!sessionKey && method === "GET") {
      const sessions = db.select().from(chatSessions)
        .orderBy(desc(chatSessions.lastMessageAt))
        .all();
      maybeSummarizeChat(sessionKey).catch(() => {}); // fire-and-forget summary update
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

    // POST /api/chat/sessions/:key/summarize — force re-summarize
    if (sessionKey && action === "summarize" && method === "POST") {
      try {
        const summary = await forceSummarize(sessionKey);
        return json(res, { summary });
      } catch (err) {
        log().error(`chat: failed to summarize: ${err}`);
        return error(res, `Failed to summarize: ${String(err)}`, 500);
      }
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
      db.delete(chatSessions).where(eq(chatSessions.sessionKey, sessionKey)).run();
      try { const { port, token } = getGatewayConfig(); if (token) { await fetch(`http://127.0.0.1:${port}/tools/invoke`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ tool: "subagents", args: { action: "kill", target: sessionKey } }) }); } } catch (err) { log().warn(`chat: failed to kill session ${sessionKey}: ${err}`); }
      return json(res, { ok: true });
    }
  }

  return error(res, "Unknown chat endpoint", 404);
}
