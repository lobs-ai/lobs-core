/**
 * End-to-end tests for the in-process MCP server that ClaudeCliClient stands
 * up for tool calling. Tests run a real MCP client (the SDK's HTTP client)
 * against a real server bound on a loopback ephemeral port — same path
 * claude -p would use.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startClaudeCliMcpServer } from "../src/runner/claude-cli-mcp-server.js";
import type { ClaudeCliMcpServerHandle } from "../src/runner/claude-cli-mcp-server.js";
import type { ToolDefinition } from "../src/runner/types.js";
import type { ClaudeCliToolExecutor } from "../src/runner/providers.js";

const SAMPLE_TOOLS: ToolDefinition[] = [
  {
    name: "Echo",
    description: "Echo input back to caller",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "Crash",
    description: "Always throws",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

async function connectClient(
  handle: ClaudeCliMcpServerHandle,
): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${handle.authToken}` },
    },
  });
  const client = new McpClient(
    { name: "test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

describe("claude-cli MCP server — end-to-end", () => {
  let handle: ClaudeCliMcpServerHandle | undefined;
  let client: McpClient | undefined;

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = undefined;
    }
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it("exposes tools via listTools with our descriptions and schemas", async () => {
    const executor: ClaudeCliToolExecutor = async () => ({ content: "" });
    handle = await startClaudeCliMcpServer({
      tools: SAMPLE_TOOLS,
      executor,
    });
    client = await connectClient(handle);

    const list = await client.listTools();
    expect(list.tools).toHaveLength(2);
    const echo = list.tools.find((t) => t.name === "Echo");
    expect(echo?.description).toBe("Echo input back to caller");
    expect(echo?.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("dispatches tool calls to the executor and returns the result", async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const executor: ClaudeCliToolExecutor = async (name, input) => {
      calls.push({ name, input });
      return { content: `received: ${JSON.stringify(input)}` };
    };
    handle = await startClaudeCliMcpServer({ tools: SAMPLE_TOOLS, executor });
    client = await connectClient(handle);

    const result = await client.callTool({
      name: "Echo",
      arguments: { text: "hello" },
    });

    expect(calls).toEqual([{ name: "Echo", input: { text: "hello" } }]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: 'received: {"text":"hello"}' },
    ]);
    expect(handle.callCount()).toBe(1);
  });

  it("returns isError=true when the executor throws", async () => {
    const executor: ClaudeCliToolExecutor = async (name) => {
      if (name === "Crash") throw new Error("boom");
      return { content: "" };
    };
    handle = await startClaudeCliMcpServer({ tools: SAMPLE_TOOLS, executor });
    client = await connectClient(handle);

    const result = await client.callTool({ name: "Crash", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "boom" }]);
  });

  it("propagates explicit isError from the executor", async () => {
    const executor: ClaudeCliToolExecutor = async () => ({
      content: "permission denied",
      isError: true,
    });
    handle = await startClaudeCliMcpServer({ tools: SAMPLE_TOOLS, executor });
    client = await connectClient(handle);

    const result = await client.callTool({ name: "Echo", arguments: { text: "" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "permission denied" }]);
  });

  it("rejects connections without the bearer token", async () => {
    const executor: ClaudeCliToolExecutor = async () => ({ content: "" });
    handle = await startClaudeCliMcpServer({ tools: SAMPLE_TOOLS, executor });

    // Plain HTTP POST without auth header.
    const resp = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("rejects connections with the wrong bearer token", async () => {
    const executor: ClaudeCliToolExecutor = async () => ({ content: "" });
    handle = await startClaudeCliMcpServer({ tools: SAMPLE_TOOLS, executor });

    const resp = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(resp.status).toBe(401);
  });

  it("close() releases the port", async () => {
    const executor: ClaudeCliToolExecutor = async () => ({ content: "" });
    handle = await startClaudeCliMcpServer({ tools: SAMPLE_TOOLS, executor });
    const { port } = new URL(handle.url);
    await handle.close();
    handle = undefined;

    // After close, the port should be reusable — bind to it explicitly.
    const reuse = await startClaudeCliMcpServer({
      tools: SAMPLE_TOOLS,
      executor,
      port: Number(port),
    });
    expect(new URL(reuse.url).port).toBe(port);
    await reuse.close();
  });

  it("close() is idempotent", async () => {
    const executor: ClaudeCliToolExecutor = async () => ({ content: "" });
    handle = await startClaudeCliMcpServer({ tools: SAMPLE_TOOLS, executor });
    await handle.close();
    // Second close should not throw.
    await handle.close();
    handle = undefined;
  });

  it("binds to a loopback ephemeral port by default", async () => {
    const executor: ClaudeCliToolExecutor = async () => ({ content: "" });
    handle = await startClaudeCliMcpServer({ tools: SAMPLE_TOOLS, executor });
    const url = new URL(handle.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(url.pathname).toBe("/mcp");
  });
});
