import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shouldRetryProviderError } from "../src/runner/providers.js";

function writeKeysConfig(homeDir: string, data: unknown): void {
  const secretsDir = join(homeDir, ".lobs", "config", "secrets");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "keys.json"), JSON.stringify(data, null, 2));
}

describe("shouldRetryProviderError", () => {
  const originalHome = process.env.HOME;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    vi.resetModules();
  });

  test("returns false when provider explicitly disables retries", () => {
    const err = {
      status: 500,
      headers: new Headers({ "x-should-retry": "false" }),
    };

    expect(shouldRetryProviderError(err)).toBe(false);
  });

  test("returns true when provider explicitly enables retries", () => {
    const err = {
      status: 500,
      headers: new Headers({ "x-should-retry": "true" }),
    };

    expect(shouldRetryProviderError(err)).toBe(true);
  });

  test("returns undefined when no retry directive is present", () => {
    const err = {
      status: 500,
      headers: new Headers(),
    };

    expect(shouldRetryProviderError(err)).toBeUndefined();
  });

  test("does not fall back to ANTHROPIC_API_KEY when a configured pool has no healthy key", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-anthropic-pool-"));
    process.env.HOME = homeDir;
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-fallback";

    writeKeysConfig(homeDir, {
      anthropic: {
        keys: ["sk-ant-pooled"],
        strategy: "sticky-failover",
      },
    });

    vi.resetModules();
    const { getKeyPool, shutdownKeyPool } = await import("../src/services/key-pool.js");
    const { createClient } = await import("../src/runner/providers.js");

    try {
      const keyPool = getKeyPool();
      keyPool.markSessionFailed("anthropic", "session-1", "429 rate limited", "rate_limit");

      expect(() => createClient({ provider: "anthropic", modelId: "claude-sonnet-4-6" }, "session-1"))
        .toThrow("all_anthropic_keys_unavailable");
    } finally {
      shutdownKeyPool();
    }
  });
});

describe("OpenAI-compatible tool parsing", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("treats JSON tool call text from LM Studio as tool_use", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: '```json\n{"tool":"read","input":{"path":"README.md"}}\n```',
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as any;

    const { createClient } = await import("../src/runner/providers.js");
    const client = createClient({ provider: "lmstudio", modelId: "qwen/qwen3.5-9b" }, "session-local");
    const response = await client.createMessage({
      model: "qwen/qwen3.5-9b",
      system: "test system",
      messages: [{ role: "user", content: "Read README.md" }],
      tools: [{
        name: "read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
      maxTokens: 256,
    });

    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: expect.stringMatching(/^toolu_/),
        name: "read",
        input: { path: "README.md" },
      },
    ]);
  });
});
