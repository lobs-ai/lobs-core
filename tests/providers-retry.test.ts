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
    vi.useRealTimers();
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

  test("returns true for timeout-like provider errors", () => {
    const err = Object.assign(new Error("anthropic_stream_timeout after 240s"), {
      name: "AbortError",
    });

    expect(shouldRetryProviderError(err)).toBe(true);
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

  test("does not globally quarantine a key on transient 429s that later succeed", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-openai-429-retry-"));
    process.env.HOME = homeDir;
    writeKeysConfig(homeDir, {
      openai: {
        keys: ["sk-openai-a"],
        strategy: "sticky-failover",
      },
    });

    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount < 3) {
        return new Response("rate limited retry_after 1", { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const { createResilientClient } = await import("../src/runner/providers.js");
    const { getKeyPool, shutdownKeyPool } = await import("../src/services/key-pool.js");

    try {
      const client = createResilientClient("openai/gpt-4o", {
        sessionId: "session-rate-limit",
        maxRetries: 3,
      });

      const response = await client.createMessage({
        model: "gpt-4o",
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        maxTokens: 32,
      });

      expect(response.content).toEqual([{ type: "text", text: "ok" }]);
      expect(getKeyPool().getPoolHealthSummary("openai")).toMatchObject({ healthy: 1, rateLimited: 0 });
    } finally {
      shutdownKeyPool();
    }
  }, 8000);

  test("quarantines and rotates immediately when retry_after is too large for inline waiting", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-openai-429-rotate-"));
    process.env.HOME = homeDir;
    writeKeysConfig(homeDir, {
      openai: {
        keys: ["sk-openai-a", "sk-openai-b"],
        strategy: "sticky-failover",
      },
    });

    const authHeaders: string[] = [];
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      authHeaders.push(auth);

      if (authHeaders.length === 1) {
        return new Response("rate limited retry_after 3600", { status: 429 });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    vi.resetModules();
    const { getKeyPool, shutdownKeyPool } = await import("../src/services/key-pool.js");
    const { createResilientClient } = await import("../src/runner/providers.js");

    try {
      const client = createResilientClient("openai/gpt-4o", {
        sessionId: "session-long-retry",
        maxRetries: 3,
      });

      const response = await client.createMessage({
        model: "gpt-4o",
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        maxTokens: 32,
      });

      expect(response.content).toEqual([{ type: "text", text: "ok" }]);
      expect(authHeaders).toHaveLength(2);
      expect(authHeaders[0]).toMatch(/^Bearer sk-openai-/);
      expect(authHeaders[1]).toMatch(/^Bearer sk-openai-/);
      expect(authHeaders[1]).not.toBe(authHeaders[0]);
      expect(getKeyPool().getPoolHealthSummary("openai")).toMatchObject({ healthy: 1, rateLimited: 1 });
    } finally {
      shutdownKeyPool();
    }
  }, 8000);

  test("retries timeout-like provider failures", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw Object.assign(new Error("socket timed out"), { name: "AbortError" });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const { createResilientClient } = await import("../src/runner/providers.js");
    const client = createResilientClient("openai/gpt-4o", {
      sessionId: "session-timeout",
      maxRetries: 2,
    });

    const responsePromise = client.createMessage({
      model: "gpt-4o",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxTokens: 32,
    });

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.content).toEqual([{ type: "text", text: "ok" }]);
    expect(callCount).toBe(2);
  });
});
