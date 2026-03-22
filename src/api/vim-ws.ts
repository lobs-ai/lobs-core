/**
 * WebSocket handler for lobs-vim integration.
 *
 * Accepts WebSocket connections on /api/vim/ws, routes chat messages
 * to the MainAgent, and streams events (tool calls, text deltas, etc.)
 * back to the Neovim client in real-time.
 *
 * Protocol: see docs/vim-ws-protocol.md (or inline comments below).
 *
 * Phase 1: Chat + streaming events.
 * Phase 2 (stubbed): Tool delegation — server asks Neovim to run
 *   file/exec tools locally via tool.request / tool.result messages.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentStreamEvent } from "../services/main-agent.js";
import { log } from "../util/logger.js";

// ── Tool delegation (Phase 2 stub) ─────────────────────────────
// Tools that should be executed on the Neovim client, not the server.
// These are file/search tools where the user's local filesystem is
// the source of truth. Not wired up yet — requires hooking into the
// MainAgent tool executor.
const CLIENT_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "ls",
  "exec",
  "Grep",
  "Glob",
  "find_files",
  "code_search",
]);

// ── Types ───────────────────────────────────────────────────────

interface VimSession {
  ws: WebSocket;
  sessionKey: string;
  channelId: string;
  projectRoot: string;
  /** Phase 2: pending tool requests waiting for client results */
  pendingToolRequests: Map<
    string,
    {
      toolUseId: string;
      resolve: (result: { content: string; isError: boolean }) => void;
    }
  >;
}

/** Inbound message from the Neovim client */
interface ClientMessage {
  type: string;
  id?: string;
  sessionKey?: string;
  projectRoot?: string;
  content?: string;
  context?: VimContext;
  toolUseId?: string;
  isError?: boolean;
}

interface VimContext {
  current_file?: {
    path?: string;
    relative_path?: string;
    filetype?: string;
    cursor_line?: number;
  };
  selection?: {
    relative_path?: string;
    filetype?: string;
    start_line?: number;
    end_line?: number;
    text?: string;
  };
  open_buffers?: string[];
  project_root?: string;
}

// Active sessions indexed by sessionKey
const sessions = new Map<string, VimSession>();

// ── Public API ──────────────────────────────────────────────────

/**
 * Attach a WebSocket server to the given HTTP server.
 * Handles upgrade requests for the `/api/vim/ws` path only;
 * all other upgrade requests are ignored (socket destroyed).
 */
export function attachVimWebSocket(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP→WS upgrade only for our path
  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/vim/ws") {
      // Not ours — let other upgrade handlers (if any) deal with it,
      // or destroy so the client gets a clean rejection.
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    log().info("[vim-ws] New WebSocket connection");

    // Session is established after a session.open message
    let session: VimSession | null = null;

    ws.on("message", async (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        sendJson(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      try {
        session = await handleMessage(ws, msg, session);
      } catch (err) {
        log().error(`[vim-ws] Error handling message: ${err}`);
        sendJson(ws, { type: "error", message: String(err) });
      }
    });

    ws.on("close", () => {
      if (session) {
        log().info(`[vim-ws] Session ${session.sessionKey} disconnected`);
        sessions.delete(session.sessionKey);
      }
    });

    ws.on("error", (err) => {
      log().error(`[vim-ws] WebSocket error: ${err}`);
    });
  });

  log().info("[vim-ws] WebSocket handler attached on /api/vim/ws");
}

// ── Message handling ────────────────────────────────────────────

async function handleMessage(
  ws: WebSocket,
  msg: ClientMessage,
  session: VimSession | null,
): Promise<VimSession | null> {
  switch (msg.type) {
    case "session.open":
      return handleSessionOpen(ws, msg);

    case "chat.send":
      await handleChatSend(ws, msg, session);
      return session;

    case "tool.result":
      handleToolResult(msg, session);
      return session;

    default:
      sendJson(ws, {
        type: "error",
        message: `Unknown message type: ${msg.type}`,
      });
      return session;
  }
}

// ── session.open ────────────────────────────────────────────────

function handleSessionOpen(ws: WebSocket, msg: ClientMessage): VimSession {
  const sessionKey = msg.sessionKey || `vim-${randomUUID().slice(0, 8)}`;
  const channelId = `vim:${sessionKey}`;
  const projectRoot = msg.projectRoot || process.cwd();

  const newSession: VimSession = {
    ws,
    sessionKey,
    channelId,
    projectRoot,
    pendingToolRequests: new Map(),
  };

  sessions.set(sessionKey, newSession);

  log().info(
    `[vim-ws] Session opened: ${sessionKey} project=${projectRoot}`,
  );

  sendJson(ws, {
    type: "session.opened",
    sessionKey,
    title: `vim:${projectRoot.split("/").pop() || "project"}`,
  });

  return newSession;
}

// ── chat.send ───────────────────────────────────────────────────

async function handleChatSend(
  ws: WebSocket,
  msg: ClientMessage,
  session: VimSession | null,
): Promise<void> {
  if (!session) {
    sendJson(ws, {
      type: "error",
      message: "No session — send session.open first",
    });
    return;
  }

  const mainAgent = (globalThis as any).__lobsMainAgent;
  if (!mainAgent) {
    sendJson(ws, { type: "error", message: "Main agent not initialized" });
    return;
  }

  const { channelId } = session;

  // Build content with optional editor context prefix
  const content = buildContent(msg.content || "", msg.context);

  // Wire up the stream listener BEFORE sending to the agent
  const streamListener = (event: AgentStreamEvent) => {
    if (event.channelId !== channelId) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    forwardStreamEvent(ws, event);

    // Clean up listener when the agent signals done
    if (event.type === "done") {
      mainAgent.events.off("stream", streamListener);
    }
  };

  mainAgent.events.on("stream", streamListener);

  // Dispatch to the MainAgent (same shape the Nexus chat API uses)
  mainAgent
    .handleMessage({
      id: randomUUID(),
      content,
      authorId: "vim-user",
      authorName: "Rafe",
      channelId,
      timestamp: Date.now(),
      chatType: "nexus" as const, // treated like a private chat → steps visible
    })
    .catch((err: unknown) => {
      log().error(`[vim-ws] handleMessage failed: ${err}`);
    });

  // Wait for the agent to finish (or timeout after 5 min)
  try {
    await mainAgent.waitForChannelIdle(channelId, 300_000);
  } catch {
    // Timeout — the "done" event may never have fired
    log().warn(`[vim-ws] Channel ${channelId} idle timeout`);
  }

  // Belt-and-suspenders cleanup
  mainAgent.events.off("stream", streamListener);
}

// ── tool.result (Phase 2 — client responds to delegated tool) ──

function handleToolResult(
  msg: ClientMessage,
  session: VimSession | null,
): void {
  if (!session || !msg.id) return;

  const pending = session.pendingToolRequests.get(msg.id);
  if (pending) {
    pending.resolve({
      content: msg.content || "",
      isError: msg.isError || false,
    });
    session.pendingToolRequests.delete(msg.id);
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Build the user content string, prefixing editor context when present.
 */
function buildContent(text: string, ctx?: VimContext): string {
  if (!ctx) return text;

  const parts: string[] = [];

  if (ctx.current_file) {
    const f = ctx.current_file;
    parts.push(
      `[Current file: ${f.relative_path || f.path} (${f.filetype ?? "unknown"}, line ${f.cursor_line ?? "?"})]`,
    );
  }

  if (ctx.selection) {
    const s = ctx.selection;
    parts.push(
      `[Selected code in ${s.relative_path} lines ${s.start_line}-${s.end_line}]\n\`\`\`${s.filetype ?? ""}\n${s.text}\n\`\`\``,
    );
  }

  if (ctx.open_buffers && ctx.open_buffers.length > 0) {
    const preview = ctx.open_buffers.slice(0, 10).join(", ");
    const overflow =
      ctx.open_buffers.length > 10
        ? ` (+${ctx.open_buffers.length - 10} more)`
        : "";
    parts.push(`[Open buffers: ${preview}${overflow}]`);
  }

  if (ctx.project_root) {
    parts.push(`[Project root: ${ctx.project_root}]`);
  }

  return parts.length > 0 ? parts.join("\n") + "\n\n" + text : text;
}

/**
 * Map an AgentStreamEvent to a client-facing WebSocket message and send it.
 */
function forwardStreamEvent(ws: WebSocket, event: AgentStreamEvent): void {
  switch (event.type) {
    case "processing_start":
    case "thinking":
      sendJson(ws, { type: "chat.status", status: "thinking" });
      break;

    case "queued":
      sendJson(ws, {
        type: "chat.status",
        status: "queued",
        queuePosition: event.queuePosition,
      });
      break;

    case "tool_start":
      sendJson(ws, {
        type: "chat.status",
        status: "tool_running",
        toolName: event.toolName,
        toolInput: event.toolInput,
      });
      break;

    case "tool_result":
      sendJson(ws, {
        type: "chat.status",
        status: "tool_done",
        toolName: event.toolName,
        result: event.result?.substring(0, 500),
        isError: event.isError,
      });
      break;

    case "text_delta":
      sendJson(ws, { type: "chat.delta", content: event.result || "" });
      break;

    case "assistant_reply":
      sendJson(ws, { type: "chat.delta", content: event.result || "" });
      break;

    case "error":
      sendJson(ws, {
        type: "chat.status",
        status: "error",
        error: event.result,
      });
      break;

    case "done":
      sendJson(ws, { type: "chat.status", status: "done" });
      break;
  }
}

/**
 * JSON-serialize and send, guarding for closed connections.
 */
function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// Re-export for testing / future use
export { CLIENT_TOOLS, sessions };
export type { VimSession, ClientMessage, VimContext };
