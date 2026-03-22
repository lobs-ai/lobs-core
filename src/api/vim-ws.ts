/**
 * WebSocket handler for lobs-vim integration.
 *
 * Accepts WebSocket connections on /api/vim/ws, routes chat messages
 * to the MainAgent, and streams events (tool calls, text deltas, etc.)
 * back to the Neovim client in real-time.
 *
 * Tool delegation: file/exec tools are intercepted and sent to the
 * Neovim client for local execution. The agent loop blocks until the
 * client returns the result. Non-file tools (web, memory, agents) run
 * on the server as usual.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentStreamEvent, MainAgent } from "../services/main-agent.js";
import type { ToolExecutionResult } from "../runner/types.js";
import { log } from "../util/logger.js";

// ── Tool delegation config ──────────────────────────────────────
// Tools delegated to the Neovim client (local filesystem is source of truth).
// Uses lowercase names to match the tool registry keys in main-agent.
const CLIENT_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "ls",
  "exec",
  "grep",
  "glob",
  "find_files",
  "code_search",
]);

// Timeout for waiting on a client tool result (ms)
// Generous timeout since exec approval prompts may wait for user input
const TOOL_DELEGATION_TIMEOUT = 120_000;

// ── Types ───────────────────────────────────────────────────────

interface VimSession {
  ws: WebSocket;
  sessionKey: string;
  channelId: string;
  projectRoot: string;
  /** Pending tool requests waiting for client results */
  pendingToolRequests: Map<
    string,
    {
      toolUseId: string;
      resolve: (result: { content: string; isError: boolean }) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
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
  /** Project context (README, AGENTS.md, etc.) sent on new session.open */
  projectContext?: string;
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

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/vim/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    log().info("[vim-ws] New WebSocket connection");

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
        cleanupSession(session);
      }
    });

    ws.on("error", (err) => {
      log().error(`[vim-ws] WebSocket error: ${err}`);
    });
  });

  log().info("[vim-ws] WebSocket handler attached on /api/vim/ws");
}

// ── Session cleanup ─────────────────────────────────────────────

function cleanupSession(session: VimSession): void {
  // Reject any pending tool requests
  for (const [, pending] of session.pendingToolRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error("WebSocket disconnected"));
  }
  session.pendingToolRequests.clear();

  // Unregister the channel tool executor
  const mainAgent = getMainAgent();
  if (mainAgent) {
    mainAgent.channelToolExecutors.delete(session.channelId);
  }

  // Keep session in the map for reconnection — only null out the ws reference
  // so we know it's disconnected. The session data (channelId, projectRoot, etc.)
  // is preserved for when the client reconnects.
  session.ws = null as unknown as WebSocket;
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

    case "session.history":
      handleSessionHistory(ws, msg, session);
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

  // Check if there's an existing session with this key (reconnection case)
  const existingSession = sessions.get(sessionKey);
  if (existingSession) {
    log().info(
      `[vim-ws] Reconnecting to existing session: ${sessionKey} project=${projectRoot}`,
    );

    // Update the WebSocket reference
    existingSession.ws = ws;
    existingSession.projectRoot = projectRoot;

    // Re-register the tool delegation executor with the new ws
    const mainAgent = getMainAgent();
    if (mainAgent) {
      mainAgent.channelToolExecutors.set(
        channelId,
        (toolName, params, toolUseId) =>
          delegateTool(existingSession, toolName, params, toolUseId),
      );

      // Refresh project context on reconnect if provided
      if (msg.projectContext) {
        mainAgent.channelProjectContext.set(channelId, msg.projectContext as string);
      }
    }

    // Use DB title if available, otherwise derive from project root
    const dbTitle = getMainAgent()?.getSessionTitle(channelId);
    sendJson(ws, {
      type: "session.opened",
      sessionKey,
      title: dbTitle ?? `vim:${projectRoot.split("/").pop() || "project"}`,
    });

    return existingSession;
  }

  // New session
  const newSession: VimSession = {
    ws,
    sessionKey,
    channelId,
    projectRoot,
    pendingToolRequests: new Map(),
  };

  sessions.set(sessionKey, newSession);

  // Register the tool delegation executor on this channel
  const mainAgent = getMainAgent();
  if (mainAgent) {
    mainAgent.channelToolExecutors.set(
      channelId,
      (toolName, params, toolUseId) =>
        delegateTool(newSession, toolName, params, toolUseId),
    );

    // Store project context if provided (README, AGENTS.md, pwd, etc.)
    if (msg.projectContext) {
      mainAgent.channelProjectContext.set(channelId, msg.projectContext as string);
      log().info(`[vim-ws] Session opened: ${sessionKey} project=${projectRoot} (with project context, ${(msg.projectContext as string).length} chars)`);
    } else {
      log().info(`[vim-ws] Session opened: ${sessionKey} project=${projectRoot} (tool delegation enabled)`);
    }
  } else {
    log().warn(
      `[vim-ws] Session opened: ${sessionKey} but MainAgent not available — tool delegation disabled`,
    );
  }

  sendJson(ws, {
    type: "session.opened",
    sessionKey,
    title: `vim:${projectRoot.split("/").pop() || "project"}`,
  });

  return newSession;
}

// ── session.history ─────────────────────────────────────────────

/**
 * Handle a session.history request — return past messages for the session.
 * Queries main_agent_messages from the MainAgent's database.
 */
function handleSessionHistory(
  ws: WebSocket,
  msg: ClientMessage,
  session: VimSession | null,
): void {
  const sessionKey = msg.sessionKey || session?.sessionKey;
  if (!sessionKey) {
    sendJson(ws, {
      type: "error",
      message: "No session key for history request",
    });
    return;
  }

  const channelId = `vim:${sessionKey}`;
  const mainAgent = getMainAgent();

  if (!mainAgent) {
    sendJson(ws, {
      type: "session.history",
      messages: [],
    });
    return;
  }

  try {
    // Query the database for past messages on this channel
    const rows = mainAgent.getChannelMessages(channelId, 100);

    // Map to simplified format — strip tool blocks, keep text content
    const messages = rows
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => {
        let content = row.content || "";

        // If content looks like JSON (array of content blocks), extract text
        if (content.startsWith("[")) {
          try {
            const blocks = JSON.parse(content);
            if (Array.isArray(blocks)) {
              content = blocks
                .filter(
                  (b: { type: string; text?: string }) => b.type === "text",
                )
                .map((b: { text: string }) => b.text || "")
                .join("\n");
            }
          } catch {
            // Not JSON, use as-is
          }
        }

        return {
          role: row.role,
          content,
          timestamp:
            typeof row.created_at === "number"
              ? row.created_at
              : new Date(row.created_at).getTime(),
        };
      })
      .filter((m) => m.content.trim() !== "");

    // Get session title
    const title = mainAgent.getSessionTitle(channelId);

    log().info(
      `[vim-ws] Returning ${messages.length} history messages for ${sessionKey} (title: ${title ?? "none"})`,
    );

    sendJson(ws, {
      type: "session.history",
      messages,
      title: title ?? undefined,
    });
  } catch (err) {
    log().error(`[vim-ws] Error fetching session history: ${err}`);
    sendJson(ws, {
      type: "session.history",
      messages: [],
    });
  }
}

// ── Tool delegation ─────────────────────────────────────────────

/**
 * Intercept a tool call and delegate to the Neovim client if it's a
 * file/exec tool. Returns null for non-delegated tools (server handles them).
 */
async function delegateTool(
  session: VimSession,
  toolName: string,
  params: Record<string, unknown>,
  toolUseId: string,
): Promise<ToolExecutionResult | null> {
  // Only delegate tools in CLIENT_TOOLS set
  if (!CLIENT_TOOLS.has(toolName)) {
    return null; // Fall through to server execution
  }

  if (session.ws.readyState !== WebSocket.OPEN) {
    return {
      result: {
        tool_use_id: toolUseId,
        type: "tool_result",
        content: "Error: Neovim client disconnected",
        is_error: true,
      },
    };
  }

  const requestId = randomUUID().slice(0, 12);

  log().info(
    `[vim-ws] Delegating tool ${toolName} to client (session=${session.sessionKey}, request=${requestId})`,
  );

  // Send tool.request to the Neovim client
  sendJson(session.ws, {
    type: "tool.request",
    id: requestId,
    toolUseId,
    tool: toolName,
    args: params,
  });

  // Wait for the client to respond with tool.result
  return new Promise<ToolExecutionResult>((resolve, _reject) => {
    const timer = setTimeout(() => {
      session.pendingToolRequests.delete(requestId);
      log().warn(
        `[vim-ws] Tool delegation timeout: ${toolName} (request=${requestId})`,
      );
      resolve({
        result: {
          tool_use_id: toolUseId,
          type: "tool_result",
          content: `Error: Tool execution timed out after ${TOOL_DELEGATION_TIMEOUT / 1000}s (tool=${toolName})`,
          is_error: true,
        },
      });
    }, TOOL_DELEGATION_TIMEOUT);

    session.pendingToolRequests.set(requestId, {
      toolUseId,
      resolve: (result) => {
        clearTimeout(timer);
        // Anthropic API requires non-empty content when is_error is true
        const content = result.isError && !result.content
          ? "Tool error (no output)"
          : (result.content || "");
        resolve({
          result: {
            tool_use_id: toolUseId,
            type: "tool_result",
            content,
            is_error: result.isError,
          },
        });
      },
      reject: (err) => {
        clearTimeout(timer);
        resolve({
          result: {
            tool_use_id: toolUseId,
            type: "tool_result",
            content: `Error: ${err.message}`,
            is_error: true,
          },
        });
      },
      timer,
    });
  });
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

  const mainAgent = getMainAgent();
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
    if (ws.readyState !== WebSocket.OPEN) {
      log().warn(`[vim-ws] WS closed, dropping ${event.type} for ${channelId}`);
      mainAgent.events.off("stream", streamListener);
      return;
    }
    log().debug?.(`[vim-ws] Forwarding ${event.type} to ${session?.sessionKey}`);
    forwardStreamEvent(ws, event);

    if (event.type === "done") {
      log().info(`[vim-ws] Stream done for ${session?.sessionKey}`);
      mainAgent.events.off("stream", streamListener);
    }
  };

  mainAgent.events.on("stream", streamListener);

  // Dispatch to the MainAgent
  mainAgent
    .handleMessage({
      id: randomUUID(),
      content,
      authorId: "vim-user",
      authorName: "Rafe",
      channelId,
      timestamp: Date.now(),
      chatType: "nexus" as const,
    })
    .catch((err: unknown) => {
      log().error(`[vim-ws] handleMessage failed: ${err}`);
    });

  // Wait for the agent to finish (or timeout after 5 min)
  try {
    await mainAgent.waitForChannelIdle(channelId, 300_000);
  } catch {
    log().warn(`[vim-ws] Channel ${channelId} idle timeout`);
  }

  mainAgent.events.off("stream", streamListener);
}

// ── tool.result (client responds to delegated tool) ─────────────

function handleToolResult(
  msg: ClientMessage,
  session: VimSession | null,
): void {
  if (!session || !msg.id) return;

  const pending = session.pendingToolRequests.get(msg.id);
  if (pending) {
    log().info(
      `[vim-ws] Got tool result for request=${msg.id} error=${msg.isError}`,
    );
    pending.resolve({
      content: msg.content || "",
      isError: msg.isError || false,
    });
    session.pendingToolRequests.delete(msg.id);
  } else {
    log().warn(`[vim-ws] No pending request for tool.result id=${msg.id}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function getMainAgent(): MainAgent | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).__lobsMainAgent ?? null;
}

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

    case "title_update":
      sendJson(ws, { type: "session.title", title: event.title });
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
