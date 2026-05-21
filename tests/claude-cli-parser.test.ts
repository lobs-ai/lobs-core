/**
 * Pure-function tests for the claude-cli client: JSONL parser and message
 * flattener. Covers the cases that decide what text + usage + stop reason
 * bubble up to the LLMClient contract.
 */
import { describe, it, expect } from "vitest";
import {
  parseJsonlOutput,
  flattenMessagesToPrompt,
  buildClaudeCliArgs,
  buildClaudeCliChildEnv,
  resolveClaudeCliModelAlias,
  CLAUDE_CLI_CLEAR_ENV,
} from "../src/runner/claude-cli-client.js";

const SAMPLE_RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "the answer is forty-two",
  stop_reason: "end_turn",
  session_id: "sess-abc",
  usage: {
    input_tokens: 12,
    output_tokens: 34,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 100,
  },
});

const SAMPLE_INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-abc",
  model: "claude-haiku-4-5",
});

describe("parseJsonlOutput", () => {
  it("extracts text + usage + session from the result event", () => {
    const stdout = [SAMPLE_INIT_LINE, SAMPLE_RESULT_LINE].join("\n");
    const parsed = parseJsonlOutput(stdout);
    expect(parsed.text).toBe("the answer is forty-two");
    expect(parsed.stopReason).toBe("end_turn");
    expect(parsed.sessionId).toBe("sess-abc");
    expect(parsed.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 5,
      cacheWriteTokens: 100,
    });
    expect(parsed.errorMessage).toBeUndefined();
  });

  it("captures thinking blocks from assistant events", () => {
    const assistantWithThinking = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "text", text: "intermediate" },
        ],
      },
    });
    const stdout = [SAMPLE_INIT_LINE, assistantWithThinking, SAMPLE_RESULT_LINE].join("\n");
    const parsed = parseJsonlOutput(stdout);
    expect(parsed.thinking).toBe("Let me reason about this...");
    // Result event text wins over interim assistant text.
    expect(parsed.text).toBe("the answer is forty-two");
  });

  it("falls back to last assistant text when result has no text", () => {
    const assistant = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "interim only" }] },
    });
    const resultNoText = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      stop_reason: "end_turn",
      result: "",
    });
    const parsed = parseJsonlOutput([SAMPLE_INIT_LINE, assistant, resultNoText].join("\n"));
    expect(parsed.text).toBe("interim only");
  });

  it("maps stop_reason variants", () => {
    const make = (stop_reason: string) =>
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason,
        result: "x",
      });
    expect(parseJsonlOutput(make("tool_use")).stopReason).toBe("tool_use");
    expect(parseJsonlOutput(make("max_tokens")).stopReason).toBe("max_tokens");
    expect(parseJsonlOutput(make("something_weird")).stopReason).toBe("stop");
  });

  it("surfaces is_error result with explanatory message", () => {
    const errResult = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "rate limit exceeded",
      stop_reason: "end_turn",
    });
    const parsed = parseJsonlOutput(errResult);
    expect(parsed.errorMessage).toBe("rate limit exceeded");
  });

  it("uses api_error_status when result text is missing on error", () => {
    const errResult = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "",
      api_error_status: "529 overloaded",
    });
    const parsed = parseJsonlOutput(errResult);
    expect(parsed.errorMessage).toBe("529 overloaded");
  });

  it("ignores blank lines and malformed JSON safely", () => {
    const stdout = [
      "",
      "not json at all",
      SAMPLE_INIT_LINE,
      "{partial",
      SAMPLE_RESULT_LINE,
      "",
    ].join("\n");
    const parsed = parseJsonlOutput(stdout);
    expect(parsed.text).toBe("the answer is forty-two");
  });

  it("returns zero-usage defaults when no result event present", () => {
    const parsed = parseJsonlOutput("");
    expect(parsed.text).toBe("");
    expect(parsed.stopReason).toBe("end_turn");
    expect(parsed.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe("flattenMessagesToPrompt", () => {
  it("returns string content directly for a single user message", () => {
    const out = flattenMessagesToPrompt([{ role: "user", content: "hello" }]);
    expect(out).toBe("hello");
  });

  it("serializes multi-turn history with role tags", () => {
    const out = flattenMessagesToPrompt([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]);
    expect(out).toContain("User: first");
    expect(out).toContain("Assistant: reply");
    expect(out.endsWith("User: second")).toBe(true);
  });

  it("appends a continuation prompt when the last message is assistant", () => {
    const out = flattenMessagesToPrompt([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ]);
    expect(out.endsWith("User: (continue)")).toBe(true);
  });

  it("serializes tool_use and tool_result blocks", () => {
    const out = flattenMessagesToPrompt([
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file1\nfile2" },
        ],
      },
    ]);
    expect(out).toContain('[tool_use Bash({"command":"ls"})]');
    expect(out).toContain("[tool_result t1: file1\nfile2]");
  });

  it("renders images as a placeholder", () => {
    const out = flattenMessagesToPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "look:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
        ],
      },
    ]);
    expect(out).toContain("look:");
    expect(out).toContain("[image omitted]");
  });

  it("returns empty string for no messages", () => {
    expect(flattenMessagesToPrompt([])).toBe("");
  });
});

describe("buildClaudeCliArgs", () => {
  it("emits text-only args with disabled built-in tools when no MCP", () => {
    const args = buildClaudeCliArgs({
      model: "opus",
      systemPrompt: "be brief",
    });
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    // No tools → built-ins disabled.
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe("");
    // System prompt appended.
    expect(args.indexOf("--append-system-prompt")).toBeGreaterThan(-1);
    expect(args).toContain("be brief");
  });

  it("emits MCP config + strict + allowlist when mcp is provided", () => {
    const args = buildClaudeCliArgs({
      model: "claude-opus-4-7",
      systemPrompt: "",
      mcp: { url: "http://127.0.0.1:54321/mcp", authToken: "secret-token" },
    });
    expect(args).toContain("--strict-mcp-config");
    const cfgIdx = args.indexOf("--mcp-config");
    expect(cfgIdx).toBeGreaterThan(-1);
    const parsed = JSON.parse(args[cfgIdx + 1]);
    expect(parsed.mcpServers.lobs.url).toBe("http://127.0.0.1:54321/mcp");
    expect(parsed.mcpServers.lobs.type).toBe("http");
    expect(parsed.mcpServers.lobs.headers.Authorization).toBe("Bearer secret-token");
    const allowIdx = args.indexOf("--allowedTools");
    expect(allowIdx).toBeGreaterThan(-1);
    expect(args[allowIdx + 1]).toBe("mcp__lobs__*");
    // With MCP we do NOT pass --tools "" (would override the MCP allowlist).
    expect(args.indexOf("--tools")).toBe(-1);
    // Model alias resolved.
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  it("omits --append-system-prompt when system is empty/whitespace", () => {
    const args = buildClaudeCliArgs({ model: "haiku", systemPrompt: "   " });
    expect(args.indexOf("--append-system-prompt")).toBe(-1);
  });
});

describe("buildClaudeCliChildEnv", () => {
  it("strips env vars that would steer claude away from the OAuth subscription", () => {
    const base = {
      ANTHROPIC_API_KEY: "sk-ant-...",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oat-...",
      PATH: "/usr/bin",
      HOME: "/home/test",
    } as NodeJS.ProcessEnv;
    const env = buildClaudeCliChildEnv(base);
    for (const k of CLAUDE_CLI_CLEAR_ENV) {
      expect(env[k]).toBeUndefined();
    }
    // Non-clobber vars survive.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/test");
  });
});

describe("resolveClaudeCliModelAlias", () => {
  it.each([
    ["opus", "opus"],
    ["claude-opus-4-7", "opus"],
    ["claude-opus-4-6", "opus"],
    ["sonnet", "sonnet"],
    ["claude-sonnet-4-6", "sonnet"],
    ["haiku", "haiku"],
    ["claude-haiku-4-5", "haiku"],
    ["unknown-model", "unknown-model"],
  ])("maps %s → %s", (input, expected) => {
    expect(resolveClaudeCliModelAlias(input)).toBe(expected);
  });
});
