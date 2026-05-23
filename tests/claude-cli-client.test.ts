/**
 * ClaudeCliClient integration tests. The "claude" binary is mocked via a
 * Node script the client spawns (path injected via constructor option).
 * Covers the lifecycle: argv assembly, stdin delivery, stdout parsing,
 * non-zero exit handling, error-result handling, and MCP server lifecycle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliClient } from "../src/runner/claude-cli-client.js";
import type { ClaudeCliMcpServerHandle } from "../src/runner/claude-cli-mcp-server.js";

const MOCK_BINARY = join(
  process.cwd(),
  "tests/fixtures/mock-claude.mjs",
);

interface ChildInvocation {
  argv: string[];
  stdin: string;
}

function makeMockBinaryEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // We invoke the mock via `node tests/fixtures/mock-claude.mjs`, but the
  // client only takes a binary path — so the mock script is shebanged
  // (#!/usr/bin/env node) and chmod +x at the file system level.
  return {
    ...process.env,
    ...extra,
  };
}

function readLog(path: string): ChildInvocation {
  expect(existsSync(path)).toBe(true);
  return JSON.parse(readFileSync(path, "utf8")) as ChildInvocation;
}

describe("ClaudeCliClient — text-only", () => {
  let logFile: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cli-test-"));
    logFile = join(dir, "invocation.json");
  });

  it("round-trips a single-message prompt through the mock binary", async () => {
    const client = new ClaudeCliClient("haiku", { binaryPath: MOCK_BINARY });
    process.env.MOCK_CLAUDE_MODE = "text";
    process.env.MOCK_CLAUDE_TEXT = "synthetic reply";
    process.env.MOCK_CLAUDE_LOGFILE = logFile;
    process.env.MOCK_CLAUDE_EXIT = "0";
    delete process.env.MOCK_CLAUDE_STDERR;

    const response = await client.createMessage({
      model: "haiku",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxTokens: 100,
    });

    expect(response.content).toEqual([{ type: "text", text: "synthetic reply" }]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage.inputTokens).toBe(11);
    expect(response.usage.outputTokens).toBe(22);

    const log = readLog(logFile);
    expect(log.stdin).toBe("hi");
    expect(log.argv).toContain("--append-system-prompt");
    expect(log.argv).toContain("be terse");
    expect(log.argv).toContain("--tools");
    // Text-only mode: --tools immediately followed by empty string disables built-ins.
    expect(log.argv[log.argv.indexOf("--tools") + 1]).toBe("");
    expect(log.argv.indexOf("--mcp-config")).toBe(-1);
  });

  it("flattens multi-turn history with role tags into stdin", async () => {
    const client = new ClaudeCliClient("opus", { binaryPath: MOCK_BINARY });
    process.env.MOCK_CLAUDE_MODE = "text";
    process.env.MOCK_CLAUDE_TEXT = "ack";
    process.env.MOCK_CLAUDE_LOGFILE = logFile;
    process.env.MOCK_CLAUDE_EXIT = "0";

    await client.createMessage({
      model: "opus",
      system: "",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first reply" },
        { role: "user", content: "second question" },
      ],
      tools: [],
      maxTokens: 100,
    });

    const log = readLog(logFile);
    expect(log.stdin).toContain("User: first question");
    expect(log.stdin).toContain("Assistant: first reply");
    expect(log.stdin.endsWith("User: second question")).toBe(true);
  });

  it("rejects when binary exits non-zero, surfacing stderr", async () => {
    const client = new ClaudeCliClient("haiku", { binaryPath: MOCK_BINARY });
    process.env.MOCK_CLAUDE_MODE = "fail";
    process.env.MOCK_CLAUDE_EXIT = "2";
    process.env.MOCK_CLAUDE_STDERR = "auth required, run `claude login`";
    process.env.MOCK_CLAUDE_LOGFILE = logFile;

    await expect(
      client.createMessage({
        model: "haiku",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 50,
      }),
    ).rejects.toThrow(/exited 2.*auth required/);
  });

  it("surfaces api_error_status when binary exits non-zero with a structured result event", async () => {
    // Real-world shape from Discord report: claude -p exits 1 but stdout has
    // a result event whose `api_error_status` says "529 overloaded". The
    // surfaced error must include both the subtype and "overloaded" so the
    // upstream classifier auto-retries instead of the user seeing JSON garbage.
    const client = new ClaudeCliClient("opus", { binaryPath: MOCK_BINARY });
    process.env.MOCK_CLAUDE_MODE = "error-result-fail";
    process.env.MOCK_CLAUDE_EXIT = "1";
    delete process.env.MOCK_CLAUDE_STDERR;
    process.env.MOCK_CLAUDE_LOGFILE = logFile;

    await expect(
      client.createMessage({
        model: "opus",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 50,
      }),
    ).rejects.toThrow(
      /exited 1.*error_during_execution.*529 overloaded.*Request failed.*bfdb18e5/,
    );
  });

  it("does NOT misclassify as quota exhaustion when status=allowed but overageStatus=rejected", async () => {
    // Regression: orgs with overage disabled emit overageStatus=rejected on
    // EVERY rate_limit_event, including successful requests. Earlier logic
    // keyed off overageStatus alone, so any non-zero exit got rewritten to
    // "subscription quota exhausted" and the real underlying error was lost.
    const client = new ClaudeCliClient("opus", { binaryPath: MOCK_BINARY });
    process.env.MOCK_CLAUDE_MODE = "overage-rejected-but-allowed";
    process.env.MOCK_CLAUDE_EXIT = "1";
    delete process.env.MOCK_CLAUDE_STDERR;

    await expect(
      client.createMessage({
        model: "opus",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 50,
      }),
    ).rejects.toThrow(/529 overloaded.*deadbeef/);

    await expect(
      client.createMessage({
        model: "opus",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 50,
      }),
    ).rejects.not.toThrow(/subscription quota exhausted/);
  });

  it("auto-retries once on 401 (OAuth-refresh race) and succeeds if the second spawn returns text", async () => {
    // Repro of the discord-reported failure: a sibling Claude Code session
    // rotated the OAuth access token, so our first spawn got 401 with a stale
    // cached token. The credentials file is updated atomically — the second
    // spawn a few seconds later picks up the fresh token and succeeds. This
    // test forces the second spawn to succeed and asserts the client doesn't
    // bubble up the transient 401.
    const dir = mkdtempSync(join(tmpdir(), "claude-cli-retry-"));
    const stateFile = join(dir, "counter");
    const client = new ClaudeCliClient("opus", {
      binaryPath: MOCK_BINARY,
      authRetryDelayMs: 50,
    });
    process.env.MOCK_CLAUDE_MODE = "auth-401-then-text";
    process.env.MOCK_CLAUDE_TEXT = "after-retry";
    process.env.MOCK_CLAUDE_STATE_FILE = stateFile;
    delete process.env.MOCK_CLAUDE_STDERR;

    const response = await client.createMessage({
      model: "opus",
      system: "",
      messages: [{ role: "user", content: "x" }],
      tools: [],
      maxTokens: 50,
    });

    expect(response.content).toEqual([{ type: "text", text: "after-retry" }]);
    // Counter file proves the binary was spawned exactly twice.
    expect(readFileSync(stateFile, "utf8").trim()).toBe("2");
    delete process.env.MOCK_CLAUDE_STATE_FILE;
  }, 10_000);

  it("surfaces a structured 401 when both attempts fail auth", async () => {
    const client = new ClaudeCliClient("opus", {
      binaryPath: MOCK_BINARY,
      authRetryDelayMs: 50,
    });
    process.env.MOCK_CLAUDE_MODE = "auth-401";
    process.env.MOCK_CLAUDE_EXIT = "1";
    delete process.env.MOCK_CLAUDE_STDERR;

    const err = await client
      .createMessage({
        model: "opus",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 50,
      })
      .catch((e) => e);
    expect(err.message).toMatch(/auth failed 401.*session=mock-ses/);
    // Reliable status field — downstream resilient client doesn't have to
    // regex the message to know it's a 401.
    expect((err as { status?: number }).status).toBe(401);
    expect((err as { __lobsAuthFailed?: boolean }).__lobsAuthFailed).toBe(true);
  }, 10_000);

  it("classifies as quota exhaustion when status=exceeded_limit", async () => {
    const client = new ClaudeCliClient("opus", { binaryPath: MOCK_BINARY });
    process.env.MOCK_CLAUDE_MODE = "quota-truly-exhausted";
    process.env.MOCK_CLAUDE_EXIT = "1";
    delete process.env.MOCK_CLAUDE_STDERR;

    const err = await client
      .createMessage({
        model: "opus",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 50,
      })
      .catch((e) => e);
    expect(err.message).toMatch(/subscription quota exhausted/);
    expect((err as { status?: number }).status).toBe(429);
    expect((err as { __lobsQuotaExhausted?: boolean }).__lobsQuotaExhausted).toBe(true);
  });

  it("rejects when result event signals is_error", async () => {
    const client = new ClaudeCliClient("haiku", { binaryPath: MOCK_BINARY });
    process.env.MOCK_CLAUDE_MODE = "error-result";
    process.env.MOCK_CLAUDE_EXIT = "0";
    delete process.env.MOCK_CLAUDE_STDERR;

    await expect(
      client.createMessage({
        model: "haiku",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 50,
      }),
    ).rejects.toThrow(/mock error from result/);
  });

  it("rejects empty prompt before spawning", async () => {
    const client = new ClaudeCliClient("haiku", { binaryPath: MOCK_BINARY });
    await expect(
      client.createMessage({
        model: "haiku",
        system: "x",
        messages: [],
        tools: [],
        maxTokens: 50,
      }),
    ).rejects.toThrow(/empty prompt/);
  });

  it("surfaces a clear error when the binary is missing", async () => {
    const client = new ClaudeCliClient("haiku", {
      binaryPath: "/nonexistent/path/to/claude-binary",
    });
    await expect(
      client.createMessage({
        model: "haiku",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 50,
      }),
    ).rejects.toThrow(/failed to spawn/);
  });
});

describe("ClaudeCliClient — tools require executor", () => {
  it("throws when tools are passed but no toolExecutor", async () => {
    const client = new ClaudeCliClient("haiku", { binaryPath: MOCK_BINARY });
    await expect(
      client.createMessage({
        model: "haiku",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [
          { name: "Fake", description: "fake", input_schema: { type: "object", properties: {} } },
        ],
        maxTokens: 50,
      }),
    ).rejects.toThrow(/tools were provided but no toolExecutor/);
  });
});

describe("ClaudeCliClient — MCP lifecycle", () => {
  let logFile: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cli-mcp-test-"));
    logFile = join(dir, "invocation.json");
  });

  it("starts MCP server, passes MCP args to claude, and closes server afterwards", async () => {
    let startCalled = 0;
    let closeCalled = 0;
    let observedTools: string[] = [];

    const fakeStart: typeof import("../src/runner/claude-cli-mcp-server.js").startClaudeCliMcpServer =
      async (params) => {
        startCalled += 1;
        observedTools = params.tools.map((t) => t.name);
        const handle: ClaudeCliMcpServerHandle = {
          url: "http://127.0.0.1:65000/mcp",
          authToken: "stub-token-123",
          callCount: () => 0,
          close: async () => {
            closeCalled += 1;
          },
        };
        return handle;
      };

    const client = new ClaudeCliClient("opus", {
      binaryPath: MOCK_BINARY,
      startMcpServer: fakeStart,
    });

    process.env.MOCK_CLAUDE_MODE = "text";
    process.env.MOCK_CLAUDE_TEXT = "done";
    process.env.MOCK_CLAUDE_LOGFILE = logFile;
    process.env.MOCK_CLAUDE_EXIT = "0";

    const response = await client.createMessage({
      model: "opus",
      system: "",
      messages: [{ role: "user", content: "do the thing" }],
      tools: [
        {
          name: "Bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: {}, required: [] },
        },
      ],
      maxTokens: 100,
      toolExecutor: async () => ({ content: "(unused in this test)" }),
    });

    expect(startCalled).toBe(1);
    expect(closeCalled).toBe(1);
    expect(observedTools).toEqual(["Bash", "Read"]);
    expect(response.content).toEqual([{ type: "text", text: "done" }]);

    const log = readLog(logFile);
    expect(log.argv).toContain("--strict-mcp-config");
    expect(log.argv).toContain("--allowedTools");
    expect(log.argv[log.argv.indexOf("--allowedTools") + 1]).toBe("mcp__lobs__*");
    const mcpIdx = log.argv.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThan(-1);
    const parsed = JSON.parse(log.argv[mcpIdx + 1]);
    expect(parsed.mcpServers.lobs.url).toBe("http://127.0.0.1:65000/mcp");
    expect(parsed.mcpServers.lobs.headers.Authorization).toBe("Bearer stub-token-123");
    // MCP mode should NOT also pass --tools "" (would override allowedTools).
    expect(log.argv.indexOf("--tools")).toBe(-1);
  });

  it("closes MCP server even when claude fails", async () => {
    let closeCalled = 0;
    const fakeStart: typeof import("../src/runner/claude-cli-mcp-server.js").startClaudeCliMcpServer =
      async () => ({
        url: "http://127.0.0.1:65001/mcp",
        authToken: "x",
        callCount: () => 0,
        close: async () => {
          closeCalled += 1;
        },
      });
    const client = new ClaudeCliClient("opus", {
      binaryPath: MOCK_BINARY,
      startMcpServer: fakeStart,
    });

    process.env.MOCK_CLAUDE_MODE = "fail";
    process.env.MOCK_CLAUDE_EXIT = "1";
    process.env.MOCK_CLAUDE_STDERR = "boom";

    await expect(
      client.createMessage({
        model: "opus",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "T", description: "t", input_schema: { type: "object", properties: {} } }],
        maxTokens: 50,
        toolExecutor: async () => ({ content: "" }),
      }),
    ).rejects.toThrow(/exited 1/);
    expect(closeCalled).toBe(1);
  });
});
