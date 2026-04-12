/**
 * MiniMax OAuth token management service.
 *
 * Manages OAuth credentials for the minimax provider.
 * Credentials are stored at ~/.lobs/credentials/minimax-oauth.json with 0600 permissions.
 * Access tokens auto-refresh when within 5 minutes of expiry.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { getLobsRoot } from "../config/lobs.js";

export type MiniMaxRegion = "cn" | "global";

export interface MinimaxOAuthCredentials {
  access: string; // Bearer access token
  refresh: string; // Refresh token (long-lived)
  expires: number; // Expiry timestamp in ms
  region: MiniMaxRegion; // Region (cn or global)
  resourceUrl?: string; // Optional API base URL from token response
}

// Refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// MiniMax OAuth configuration
const MINIMAX_OAUTH_CONFIG = {
  cn: {
    baseUrl: "https://api.minimaxi.com",
    clientId: "78257093-7e40-4613-99e0-527b14b39113",
  },
  global: {
    baseUrl: "https://api.minimax.io",
    clientId: "78257093-7e40-4613-99e0-527b14b39113",
  },
} as const;

const MINIMAX_OAUTH_SCOPE = "group_id profile model.completion";
const MINIMAX_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:user_code";

function getOAuthEndpoints(region: MiniMaxRegion) {
  const config = MINIMAX_OAUTH_CONFIG[region];
  return {
    codeEndpoint: `${config.baseUrl}/oauth/code`,
    tokenEndpoint: `${config.baseUrl}/oauth/token`,
    clientId: config.clientId,
    baseUrl: config.baseUrl,
  };
}

// PKCE helpers (inline, not from openclaw)
function generatePkceVerifierChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(verifier).digest();
  const challenge = hash.toString("base64url");
  return { verifier, challenge };
}

function toFormUrlEncoded(obj: Record<string, string | number>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export class MinimaxAuthService {
  credentials: MinimaxOAuthCredentials | null = null;
  readonly credentialsPath: string;
  private refreshPromise: Promise<void> | null = null;

  constructor() {
    this.credentialsPath = path.resolve(getLobsRoot(), "credentials", "minimax-oauth.json");
  }

  /** Load saved credentials from disk. Returns null if file doesn't exist or is invalid. */
  async loadCredentials(): Promise<MinimaxOAuthCredentials | null> {
    return this.loadCredentialsSync();
  }

  /** Save credentials to disk with 0600 permissions. */
  async saveCredentials(creds: MinimaxOAuthCredentials): Promise<void> {
    const dir = dirname(this.credentialsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), "utf-8");
    chmodSync(this.credentialsPath, 0o600);
    this.credentials = creds;
  }

  /**
   * Run OAuth login flow (device code).
   * Prompts user to visit verification_uri and polls for token.
   */
  async login(region: MiniMaxRegion = "global"): Promise<MinimaxOAuthCredentials> {
    const { verifier, challenge } = generatePkceVerifierChallenge();
    const state = randomBytes(16).toString("base64url");

    // Step 1: Request authorization code
    const endpoints = getOAuthEndpoints(region);
    console.log("Requesting authorization code...");

    const codeResponse = await fetch(endpoints.codeEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: toFormUrlEncoded({
        response_type: "code",
        client_id: endpoints.clientId,
        scope: MINIMAX_OAUTH_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }),
    });

    if (!codeResponse.ok) {
      const text = await codeResponse.text();
      throw new Error(`MiniMax OAuth authorization failed: ${text || codeResponse.statusText}`);
    }

    const codeData = (await codeResponse.json()) as Record<string, unknown> & {
      user_code?: string;
      verification_uri?: string;
      expired_in?: number;
      state?: string;
    };

    if (!codeData.user_code || !codeData.verification_uri) {
      throw new Error("MiniMax OAuth authorization returned incomplete payload");
    }

    if (codeData.state !== state) {
      throw new Error("MiniMax OAuth state mismatch: possible CSRF attack");
    }

    const userCode = codeData.user_code as string;
    const verificationUri = codeData.verification_uri as string;
    const expiredInMs = (codeData.expired_in as number) ?? Date.now() + 30 * 60 * 1000; // expired_in is a unix timestamp in ms (from /oauth/code)

    // Step 2: Open browser
    console.log(`\n🔐 MiniMax OAuth Login`);
    console.log(`\n   Visit this URL to authorize:\n   ${verificationUri}\n`);
    console.log(`   User code: ${userCode}\n`);

    // Try to open browser (macOS; silently ignore errors on other platforms)
    try {
      const { exec } = await import("node:child_process");
      exec(`open "${verificationUri}"`, () => {});
    } catch {
      // Silently ignore if open fails
    }

    // Step 3: Poll for token
    const expireTimeMs = expiredInMs;
    let pollIntervalMs = 2000;

    console.log("Waiting for authorization...\n");

    while (Date.now() < expireTimeMs) {
      // Small delay before polling
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      const tokenResponse = await fetch(endpoints.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body: toFormUrlEncoded({
          grant_type: MINIMAX_OAUTH_GRANT_TYPE,
          client_id: endpoints.clientId,
          user_code: userCode,
          code_verifier: verifier,
        }),
      });

      const text = await tokenResponse.text();
      let tokenData: Record<string, unknown> | undefined;

      try {
        tokenData = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Ignore parse errors and retry
        continue;
      }

      if (!tokenResponse.ok) {
        const errorMsg = (tokenData as any)?.base_resp?.status_msg ?? text;
        throw new Error(`MiniMax OAuth token request failed: ${errorMsg}`);
      }

      const status = (tokenData as any)?.status as string | undefined;

      if (status === "error") {
        throw new Error("MiniMax OAuth authorization error. Please try again.");
      }

      if (status !== "success") {
        // Still pending, continue polling
        process.stdout.write(".");
        pollIntervalMs = Math.max(pollIntervalMs, 2000);
        continue;
      }

      // Success! Extract token
      const accessToken = (tokenData as any)?.access_token as string | undefined;
      const refreshToken = (tokenData as any)?.refresh_token as string | undefined;
      const expiredIn = (tokenData as any)?.expired_in as number | undefined;
      const resourceUrl = (tokenData as any)?.resource_url as string | undefined;

      if (!accessToken || !refreshToken || !expiredIn) {
        throw new Error("MiniMax OAuth returned incomplete token payload");
      }

      console.log("\n✅ Authorization successful!\n");

      const creds: MinimaxOAuthCredentials = {
        access: accessToken,
        refresh: refreshToken,
        expires: Date.now() + Math.floor((expiredIn) / 1_000_000_000), // expired_in is a nanosecond duration (from /oauth/token)
        region,
        resourceUrl,
      };

      await this.saveCredentials(creds);
      return creds;
    }

    throw new Error("MiniMax OAuth authorization timed out");
  }

  /**
   * Get a valid access token, auto-refreshing if expired or near expiry.
   * Loads credentials from disk if not already loaded.
   */
  async getAccessToken(): Promise<string> {
    if (!this.credentials) {
      this.loadCredentialsSync();
    }
    if (!this.credentials) {
      throw new Error("No MiniMax OAuth credentials found. Run `lobs minimax-auth login` to authenticate.");
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
    if (!this.credentials) {
      this.loadCredentialsSync();
    }
    if (!this.credentials) return null;
    if (this._isNearExpiry(this.credentials.expires)) return null;
    return this.credentials.access;
  }

  /** Check if we have valid non-expired credentials in memory. */
  isAuthenticated(): boolean {
    if (!this.credentials) {
      this.loadCredentialsSync();
    }
    if (!this.credentials) return false;
    return !this._isNearExpiry(this.credentials.expires);
  }

  /** Check if credentials are loaded (possibly expired). */
  hasCredentials(): boolean {
    if (!this.credentials) {
      this.loadCredentialsSync();
    }
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
    if (!this.credentials?.refresh || !this.credentials.region) {
      throw new Error("No refresh token available. Run `lobs minimax-auth login` to re-authenticate.");
    }

    const endpoints = getOAuthEndpoints(this.credentials.region);
    const response = await fetch(endpoints.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: toFormUrlEncoded({
        grant_type: "refresh_token",
        client_id: endpoints.clientId,
        refresh_token: this.credentials.refresh,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MiniMax token refresh failed: ${text}`);
    }

    const data = (await response.json()) as Record<string, unknown> & {
      access_token?: string;
      refresh_token?: string;
      expired_in?: number;
      resource_url?: string;
    };

    if (!data.access_token || !data.expired_in) {
      throw new Error("MiniMax refresh returned incomplete token payload");
    }

    const updated: MinimaxOAuthCredentials = {
      ...this.credentials,
      access: data.access_token,
      expires: Date.now() + Math.floor((data.expired_in) / 1_000_000_000), // expired_in is a nanosecond duration (from /oauth/token)
      refresh: data.refresh_token ?? this.credentials.refresh,
      resourceUrl: data.resource_url ?? this.credentials.resourceUrl,
    };

    await this.saveCredentials(updated);
  }

  private loadCredentialsSync(): MinimaxOAuthCredentials | null {
    if (!existsSync(this.credentialsPath)) return null;

    try {
      const raw = readFileSync(this.credentialsPath, "utf-8");
      const parsed = JSON.parse(raw) as MinimaxOAuthCredentials;
      if (!parsed.access || !parsed.refresh || !parsed.expires || !parsed.region) return null;
      this.credentials = parsed;
      return parsed;
    } catch {
      return null;
    }
  }
}

// Singleton
let instance: MinimaxAuthService | null = null;

export function getMinimaxAuth(): MinimaxAuthService {
  if (!instance) {
    instance = new MinimaxAuthService();
  }
  return instance;
}
