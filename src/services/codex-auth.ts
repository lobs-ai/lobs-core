/**
 * Codex OAuth token management service.
 *
 * Manages OAuth credentials for the openai-codex provider (chatgpt.com/backend-api).
 * Credentials are stored at ~/.lobs/config/secrets/codex-oauth.json with 0600 permissions.
 * Access tokens auto-refresh when within 5 minutes of expiry.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import os from "node:os";
import path from "node:path";
import type { OAuthAuthInfo, OAuthPrompt } from "@mariozechner/pi-ai/oauth";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";

export interface CodexOAuthCredentials {
  access: string; // Bearer access token
  refresh: string; // Refresh token (long-lived)
  expires: number; // Expiry timestamp in ms
  accountId?: string; // Optional ChatGPT-Account-Id header value
}

// Refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class CodexAuthService {
  credentials: CodexOAuthCredentials | null = null;
  readonly credentialsPath: string;
  private refreshPromise: Promise<void> | null = null;

  constructor() {
    this.credentialsPath = path.join(os.homedir(), ".lobs/config/secrets/codex-oauth.json");
  }

  /** Load saved credentials from disk. Returns null if file doesn't exist or is invalid. */
  async loadCredentials(): Promise<CodexOAuthCredentials | null> {
    if (!existsSync(this.credentialsPath)) return null;
    try {
      const raw = readFileSync(this.credentialsPath, "utf-8");
      const parsed = JSON.parse(raw) as CodexOAuthCredentials;
      if (!parsed.access || !parsed.refresh || !parsed.expires) return null;
      this.credentials = parsed;
      return this.credentials;
    } catch {
      return null;
    }
  }

  /** Save credentials to disk with 0600 permissions. */
  async saveCredentials(creds: CodexOAuthCredentials): Promise<void> {
    const dir = dirname(this.credentialsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), "utf-8");
    chmodSync(this.credentialsPath, 0o600);
    this.credentials = creds;
  }

  /**
   * Run OAuth login flow (opens browser).
   * Prompts user to sign into ChatGPT and captures tokens via localhost callback.
   */
  async login(): Promise<CodexOAuthCredentials> {
    const { createInterface } = await import("node:readline/promises");
    const { stdin, stdout } = process;

    const result = await loginOpenAICodex({
      onAuth: (info: OAuthAuthInfo) => {
        console.log("\n🔐 Opening browser for ChatGPT OAuth login...");
        console.log(`   URL: ${info.url}`);
        if (info.instructions) {
          console.log(`   ${info.instructions}`);
        }
        // Try to open browser (macOS; silently ignore errors on other platforms)
        import("node:child_process")
          .then(({ exec }) => exec(`open "${info.url}"`, () => {}))
          .catch(() => {});
      },
      onPrompt: async (prompt: OAuthPrompt) => {
        const rl = createInterface({ input: stdin, output: stdout });
        const answer = await rl.question(
          `\n${prompt.message}${prompt.placeholder ? ` [${prompt.placeholder}]` : ""}: `,
        );
        rl.close();
        return answer.trim();
      },
      onProgress: (msg: string) => {
        process.stdout.write(`  ${msg}\n`);
      },
    });

    const creds: CodexOAuthCredentials = {
      access: result.access,
      refresh: result.refresh,
      expires: result.expires,
      accountId: typeof result.accountId === "string" ? result.accountId : undefined,
    };

    await this.saveCredentials(creds);
    return creds;
  }

  /**
   * Get a valid access token, auto-refreshing if expired or near expiry.
   * Loads credentials from disk if not already loaded.
   */
  async getAccessToken(): Promise<string> {
    if (!this.credentials) {
      await this.loadCredentials();
    }
    if (!this.credentials) {
      throw new Error(
        "No Codex OAuth credentials found. Run `lobs codex-auth login` to authenticate.",
      );
    }

    // Refresh if near expiry
    if (this._isNearExpiry(this.credentials.expires)) {
      await this._doRefresh();
    }

    return this.credentials.access;
  }

  /**
   * Get the cached access token synchronously (no refresh).
   * Returns null if expired or not loaded. Safe to call in sync contexts.
   */
  getCachedAccessToken(): string | null {
    if (!this.credentials) return null;
    if (this._isNearExpiry(this.credentials.expires)) return null;
    return this.credentials.access;
  }

  /** Check if we have valid non-expired credentials in memory. */
  isAuthenticated(): boolean {
    if (!this.credentials) return false;
    return !this._isNearExpiry(this.credentials.expires);
  }

  /** Check if credentials are loaded (possibly expired). */
  hasCredentials(): boolean {
    return this.credentials !== null;
  }

  /** Refresh the access token using the stored refresh token. */
  async refreshAccessToken(): Promise<void> {
    await this._doRefresh();
  }

  private _isNearExpiry(expires: number): boolean {
    return Date.now() >= expires - REFRESH_BUFFER_MS;
  }

  /** Deduplicated refresh — if a refresh is already in-flight, wait for it. */
  private async _doRefresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this._performRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async _performRefresh(): Promise<void> {
    if (!this.credentials?.refresh) {
      throw new Error(
        "No refresh token available. Run `lobs codex-auth login` to re-authenticate.",
      );
    }
    const result = await refreshOpenAICodexToken(this.credentials.refresh);
    const updated: CodexOAuthCredentials = {
      ...this.credentials,
      access: result.access,
      expires: result.expires,
      // refresh token may be rotated
      refresh: typeof result.refresh === "string" ? result.refresh : this.credentials.refresh,
    };
    await this.saveCredentials(updated);
  }
}

// Singleton
let instance: CodexAuthService | null = null;

export function getCodexAuth(): CodexAuthService {
  if (!instance) {
    instance = new CodexAuthService();
  }
  return instance;
}
