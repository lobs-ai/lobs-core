/**
 * Tests for OAuth2 state HMAC secret guard in discord.ts.
 *
 * Coverage:
 * - GET /api/discord/connect returns 503 when no state secret is configured
 * - GET /api/discord/callback returns 503 when no state secret is configured
 * - GET /api/discord/connect proceeds when state secret IS configured
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleDiscordRequest } from "../src/api/discord.js";

// ─── HTTP Mock Helpers ────────────────────────────────────────────────────────

function makeReq(method: string, url: string): IncomingMessage {
  const r = new Readable({ read() {} }) as unknown as IncomingMessage;
  (r as unknown as Record<string, unknown>).method = method;
  (r as unknown as Record<string, unknown>).url = url;
  process.nextTick(() => {
    (r as unknown as Readable).push(null);
  });
  return r;
}

interface FakeResponse {
  res: ServerResponse;
  status: () => number;
  body: () => unknown;
  headers: () => Record<string, string>;
}

function makeRes(): FakeResponse {
  let _status = 200;
  let _body: unknown;
  const _headers: Record<string, string> = {};
  const res = {
    writeHead(s: number, h?: Record<string, string>) {
      _status = s;
      if (h) Object.assign(_headers, h);
    },
    end(data?: string) {
      if (data) {
        try { _body = JSON.parse(data); } catch { _body = data; }
      }
    },
  } as unknown as ServerResponse;
  return { res, status: () => _status, body: () => _body, headers: () => _headers };
}

// ─── Save & Restore Env ─────────────────────────────────────────────────────

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    DISCORD_STATE_SECRET: process.env.DISCORD_STATE_SECRET,
    GATEWAY_SECRET: process.env.GATEWAY_SECRET,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  };
});

afterEach(() => {
  // Restore original env values
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Discord OAuth2 state secret guard", () => {
  describe("GET /api/discord/connect", () => {
    it("returns 503 when neither DISCORD_STATE_SECRET nor GATEWAY_SECRET is set", async () => {
      delete process.env.DISCORD_STATE_SECRET;
      delete process.env.GATEWAY_SECRET;

      const req = makeReq("GET", "/api/discord/connect?client_id=test-client&client_slug=test");
      const { res, status, body } = makeRes();

      await handleDiscordRequest(req, res, "connect", ["discord", "connect"]);

      expect(status()).toBe(503);
      expect((body() as { error: string }).error).toContain("DISCORD_STATE_SECRET or GATEWAY_SECRET must be set");
    });

    it("proceeds (302 redirect) when DISCORD_STATE_SECRET is set", async () => {
      process.env.DISCORD_STATE_SECRET = "test-secret-value-12345";
      process.env.DISCORD_CLIENT_ID = "fake-bot-client-id";
      delete process.env.GATEWAY_SECRET;

      const req = makeReq("GET", "/api/discord/connect?client_id=test-client&client_slug=test");
      const { res, status, headers } = makeRes();

      await handleDiscordRequest(req, res, "connect", ["discord", "connect"]);

      expect(status()).toBe(302);
      expect(headers().Location).toContain("discord.com/oauth2/authorize");
    });

    it("proceeds (302 redirect) when GATEWAY_SECRET is set", async () => {
      delete process.env.DISCORD_STATE_SECRET;
      process.env.GATEWAY_SECRET = "gateway-secret-value-12345";
      process.env.DISCORD_CLIENT_ID = "fake-bot-client-id";

      const req = makeReq("GET", "/api/discord/connect?client_id=test-client&client_slug=test");
      const { res, status, headers } = makeRes();

      await handleDiscordRequest(req, res, "connect", ["discord", "connect"]);

      expect(status()).toBe(302);
      expect(headers().Location).toContain("discord.com/oauth2/authorize");
    });
  });

  describe("GET /api/discord/callback", () => {
    it("returns 503 when neither DISCORD_STATE_SECRET nor GATEWAY_SECRET is set", async () => {
      delete process.env.DISCORD_STATE_SECRET;
      delete process.env.GATEWAY_SECRET;

      const req = makeReq("GET", "/api/discord/callback?code=abc&guild_id=123&state=x.y");
      const { res, status, body } = makeRes();

      await handleDiscordRequest(req, res, "callback", ["discord", "callback"]);

      expect(status()).toBe(503);
      expect((body() as { error: string }).error).toContain("DISCORD_STATE_SECRET or GATEWAY_SECRET must be set");
    });
  });
});
