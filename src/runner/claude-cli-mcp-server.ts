/**
 * In-process MCP server that exposes lobs-core's tools to the Claude CLI.
 *
 * The flow:
 *   1. `ClaudeCliClient.createMessage` is invoked with `tools` + `toolExecutor`.
 *   2. We start this server on a loopback HTTP port.
 *   3. We spawn `claude -p` with `--mcp-config '{"mcpServers":{"lobs":{"url":...}}}'`
 *      and `--allowedTools 'mcp__lobs__*'` so claude can only see our tools.
 *   4. Claude calls tools over MCP; we route each call to `toolExecutor` and
 *      return the result.
 *   5. When `createMessage` returns, we close the server.
 *
 * Why HTTP and not stdio: stdio requires claude to spawn a child process, but
 * our executor lives in the parent process and shares lobs-core state. A
 * loopback HTTP server lets us keep the executor in-process.
 */
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeCliToolExecutor } from "./providers.js";
import type { ToolDefinition } from "./types.js";

/** Loopback host. ::1 is also fine, but 127.0.0.1 dodges IPv6/IPv4 mismatches. */
const LOOPBACK_HOST = "127.0.0.1";

/** Server name claude will see. Tools become `mcp__lobs__<toolName>` on claude's side. */
export const CLAUDE_CLI_MCP_SERVER_NAME = "lobs";

export interface ClaudeCliMcpServerHandle {
  /** URL claude should connect to (e.g. "http://127.0.0.1:53412/mcp"). */
  url: string;
  /** Bearer token claude must present to authenticate. */
  authToken: string;
  /** Close the HTTP server + transport. Idempotent. */
  close: () => Promise<void>;
  /** Number of tool calls handled (for diagnostics/tests). */
  callCount: () => number;
}

export interface StartMcpServerParams {
  tools: ToolDefinition[];
  executor: ClaudeCliToolExecutor;
  /** Optional fixed port for tests; otherwise an ephemeral port is chosen. */
  port?: number;
  /** Optional fixed auth token for tests; otherwise random. */
  authToken?: string;
}

/**
 * Constant-time bearer-token comparison so connection auth can't be timing-attacked.
 */
function bearerTokenEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

function extractBearerToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match?.[1];
}

async function readRequestJson(req: http.IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      buf += chunk;
      // Guard against pathological client payloads.
      if (buf.length > 5 * 1024 * 1024) {
        reject(new Error("MCP request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!buf) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Coerce a lobs-core ToolDefinition.input_schema into the JSON-Schema-shape
 * MCP expects: { type: "object", properties: {...}, required: [...] }.
 */
function toMcpInputSchema(
  schema: ToolDefinition["input_schema"],
): { type: "object"; properties?: Record<string, unknown>; required?: string[] } {
  const s = (schema ?? {}) as Record<string, unknown>;
  return {
    type: "object",
    properties: (s.properties as Record<string, unknown> | undefined) ?? {},
    required: Array.isArray(s.required) ? (s.required as string[]) : [],
  };
}

export async function startClaudeCliMcpServer(
  params: StartMcpServerParams,
): Promise<ClaudeCliMcpServerHandle> {
  const authToken = params.authToken ?? randomUUID();
  let callCount = 0;

  const server = new McpServer(
    { name: CLAUDE_CLI_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: params.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toMcpInputSchema(tool.input_schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    callCount += 1;
    const { name, arguments: args } = request.params;
    const input = (args ?? {}) as Record<string, unknown>;

    try {
      const result = await params.executor(name, input);
      return {
        content: [{ type: "text" as const, text: result.content }],
        isError: Boolean(result.isError),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const presented = extractBearerToken(req);
      if (!presented || !bearerTokenEquals(presented, authToken)) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readRequestJson(req);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            error: "internal",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(params.port ?? 0, LOOPBACK_HOST, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    httpServer.close();
    throw new Error("claude-cli MCP server: failed to determine bound port");
  }
  const url = `http://${LOOPBACK_HOST}:${address.port}/mcp`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  };

  return {
    url,
    authToken,
    close,
    callCount: () => callCount,
  };
}
