import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function writeKeysConfig(homeDir: string, data: unknown): void {
  const secretsDir = join(homeDir, ".lobs", "config", "secrets");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "keys.json"), JSON.stringify(data, null, 2));
}

describe("key rotation", () => {
  const originalHome = process.env.HOME;
  const originalFetch = global.fetch;

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.OPENAI_API_KEY = "";
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test("marks the current session key unhealthy and advances to the next key", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-keypool-"));
    process.env.HOME = homeDir;
    writeKeysConfig(homeDir, {
      openai: {
        keys: ["sk-openai-a", "sk-openai-b"],
        strategy: "sticky-failover",
      },
    });

    vi.resetModules();
    const { getKeyPool, shutdownKeyPool } = await import("../src/services/key-pool.js");

    try {
      const keyPool = getKeyPool();
      const first = keyPool.getAuth("openai", "session-1");
      expect(first?.apiKey).toBeTruthy();

      keyPool.markSessionFailed("openai", "session-1", "401 unauthorized", "auth");

      const second = keyPool.getAuth("openai", "session-1");
      expect(second?.apiKey).toBeTruthy();
      expect(second?.apiKey).not.toBe(first?.apiKey);
      expect(second?.keyIndex).not.toBe(first?.keyIndex);
    } finally {
      shutdownKeyPool();
    }
  });

  test("retries with a fresh client so a rotated key is used on the next attempt", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-rotate-client-"));
    process.env.HOME = homeDir;
    writeKeysConfig(homeDir, {
      openai: {
        keys: ["sk-openai-a", "sk-openai-b"],
        strategy: "sticky-failover",
      },
    });

    const authHeaders: string[] = [];
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));

      if (authHeaders.length === 1) {
        return new Response("unauthorized", { status: 401 });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    vi.resetModules();
    const { createResilientClient } = await import("../src/runner/providers.js");
    const { shutdownKeyPool } = await import("../src/services/key-pool.js");

    try {
      const client = createResilientClient("openai/gpt-4o", {
        sessionId: "session-rotate",
        maxRetries: 2,
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
    } finally {
      shutdownKeyPool();
    }
  });

  test("reloads key config so newly added keys enter rotation without restart", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-keypool-reload-"));
    process.env.HOME = homeDir;
    writeKeysConfig(homeDir, {
      anthropic: {
        keys: ["sk-ant-a", "sk-ant-b"],
        strategy: "sticky-failover",
      },
    });

    vi.resetModules();
    const { getKeyPool, shutdownKeyPool } = await import("../src/services/key-pool.js");

    try {
      const keyPool = getKeyPool();
      keyPool.markSessionFailed("anthropic", "session-reload", "401 unauthorized", "auth");

      writeKeysConfig(homeDir, {
        anthropic: {
          keys: ["sk-ant-a", "sk-ant-b", "sk-ant-c"],
          strategy: "sticky-failover",
        },
      });

      const first = keyPool.getAuth("anthropic", "a");
      const second = keyPool.getAuth("anthropic", "b");
      const third = keyPool.getAuth("anthropic", "c");

      const indices = [first?.keyIndex, second?.keyIndex, third?.keyIndex];
      expect(indices).toContain(2);
      expect(indices).not.toContain(0);
    } finally {
      shutdownKeyPool();
    }
  });

  test("successful request heals a previously unhealthy key", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-keypool-heal-"));
    process.env.HOME = homeDir;
    writeKeysConfig(homeDir, {
      openai: {
        keys: ["sk-openai-a", "sk-openai-b"],
        strategy: "sticky-failover",
      },
    });

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    vi.resetModules();
    const { getKeyPool, shutdownKeyPool } = await import("../src/services/key-pool.js");
    const { createResilientClient } = await import("../src/runner/providers.js");

    try {
      const keyPool = getKeyPool();
      const client = createResilientClient("openai/gpt-4o", {
        sessionId: "session-rotate",
        maxRetries: 1,
      });

      keyPool.markSessionFailed("openai", "session-rotate", "429 rate limited", "rate_limit", 60_000);
      expect(keyPool.getPoolHealthSummary("openai")).toMatchObject({ healthy: 1, rateLimited: 1 });

      await client.createMessage({
        model: "gpt-4o",
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        maxTokens: 32,
      });

      expect(keyPool.getPoolHealthSummary("openai")).toMatchObject({ healthy: 2, rateLimited: 0 });
    } finally {
      shutdownKeyPool();
    }
  });

  test("prefers the last successful key for new sessions", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-keypool-prefer-success-"));
    process.env.HOME = homeDir;
    writeKeysConfig(homeDir, {
      anthropic: {
        keys: [
          { key: "sk-ant-a", label: "personal" },
          { key: "sk-ant-b", label: "umich" },
          { key: "sk-ant-c", label: "lobsbot" },
        ],
        strategy: "sticky-failover",
      },
    });

    vi.resetModules();
    const { getKeyPool, shutdownKeyPool } = await import("../src/services/key-pool.js");

    try {
      const keyPool = getKeyPool();
      keyPool.markSessionFailed("anthropic", "session-a", "401 unauthorized", "auth");
      keyPool.markSessionFailed("anthropic", "session-b", "401 unauthorized", "auth");
      keyPool.markHealthy("anthropic", 2);

      const selection = keyPool.getAuth("anthropic", "fresh-session");
      expect(selection?.apiKey).toBe("sk-ant-c");
      expect(selection?.keyIndex).toBe(2);
      expect(selection?.label).toBe("lobsbot");
    } finally {
      shutdownKeyPool();
    }
  });

  test("uses the bootstrap preferred key before any success is recorded", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-keypool-balance-"));
    process.env.HOME = homeDir;
    writeKeysConfig(homeDir, {
      anthropic: {
        keys: [
          { key: "sk-ant-a", label: "personal" },
          { key: "sk-ant-b", label: "umich" },
          { key: "sk-ant-c", label: "lobsbot" },
        ],
        strategy: "sticky-failover",
      },
    });

    vi.resetModules();
    const { getKeyPool, shutdownKeyPool } = await import("../src/services/key-pool.js");

    try {
      const keyPool = getKeyPool();
      const a = keyPool.getAuth("anthropic", "session-a");
      const b = keyPool.getAuth("anthropic", "session-b");
      const c = keyPool.getAuth("anthropic", "session-c");

      expect(a?.keyIndex).toBe(2);
      expect(b?.keyIndex).toBe(2);
      expect(c?.keyIndex).toBe(2);
    } finally {
      shutdownKeyPool();
    }
  });
});
