import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.`;
}

describe("CodexAuthService", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.resetModules();
  });

  test("imports ChatGPT Codex subscription credentials from ~/.codex/auth.json", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-codex-auth-"));
    process.env.HOME = homeDir;

    const codexDir = join(homeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });

    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(join(codexDir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: makeJwt(expSeconds),
        refresh_token: "refresh-token",
        account_id: "acct-123",
      },
      last_refresh: new Date().toISOString(),
    }, null, 2));

    const { CodexAuthService } = await import("../src/services/codex-auth.js");
    const auth = new CodexAuthService();

    const creds = await auth.loadCredentials();

    expect(creds).toMatchObject({
      refresh: "refresh-token",
      accountId: "acct-123",
    });
    expect(creds?.access).toBeTruthy();
    expect(creds?.expires).toBe(expSeconds * 1000);
    expect(auth.getCachedAccessToken()).toBe(creds?.access);

    const persistedPath = join(homeDir, ".lobs", "config", "secrets", "codex-oauth.json");
    expect(existsSync(persistedPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(persistedPath, "utf-8"));
    expect(persisted.accountId).toBe("acct-123");
  });

  test("prefers ~/.lobs credentials when they already exist", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lobs-codex-auth-existing-"));
    process.env.HOME = homeDir;

    const secretsDir = join(homeDir, ".lobs", "config", "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, "codex-oauth.json"), JSON.stringify({
      access: "existing-access",
      refresh: "existing-refresh",
      expires: Date.now() + 3600_000,
      accountId: "acct-existing",
    }, null, 2));

    const codexDir = join(homeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 7200),
        refresh_token: "import-refresh",
        account_id: "acct-imported",
      },
    }, null, 2));

    const { CodexAuthService } = await import("../src/services/codex-auth.js");
    const auth = new CodexAuthService();

    const creds = await auth.loadCredentials();

    expect(creds).toMatchObject({
      access: "existing-access",
      refresh: "existing-refresh",
      accountId: "acct-existing",
    });
  });
});
