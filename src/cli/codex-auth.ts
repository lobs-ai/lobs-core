/**
 * CLI command: lobs codex-auth
 *
 * Manages OAuth credentials for the openai-codex provider.
 *
 * Usage:
 *   lobs codex-auth login    — run OAuth flow, save tokens
 *   lobs codex-auth status   — show auth status and expiry
 *   lobs codex-auth refresh  — manually refresh the token
 */

import { getCodexAuth } from "../services/codex-auth.js";

function formatExpiry(expires: number): string {
  const now = Date.now();
  if (now >= expires) return "EXPIRED";
  const diffMs = expires - now;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr > 0) {
    return `in ${diffHr}h ${diffMin % 60}m (${new Date(expires).toLocaleString()})`;
  }
  return `in ${diffMin}m (${new Date(expires).toLocaleString()})`;
}

export async function cmdCodexAuth(subcommand: string | undefined): Promise<void> {
  const auth = getCodexAuth();

  if (subcommand === "login") {
    console.log("Starting OpenAI Codex OAuth login flow...");
    try {
      const creds = await auth.login();
      console.log("\n✅ Login successful!");
      console.log(`   Token expires: ${formatExpiry(creds.expires)}`);
      console.log(`   Credentials saved to: ${auth.credentialsPath}`);
    } catch (err) {
      console.error("\n❌ Login failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  if (subcommand === "status") {
    await auth.loadCredentials();
    if (!auth.hasCredentials()) {
      console.log("❌ Not authenticated. Run `lobs codex-auth login` to authenticate.");
      return;
    }
    const creds = auth.credentials;
    if (!creds) {
      console.log("❌ Not authenticated. Run `lobs codex-auth login` to authenticate.");
      return;
    }
    const isValid = auth.isAuthenticated();
    console.log(`${isValid ? "✅" : "⚠️"} Codex OAuth Status`);
    console.log(`   Authenticated: ${isValid ? "yes" : "no (token expired)"}`);
    console.log(`   Expires: ${formatExpiry(creds.expires)}`);
    if (creds.accountId) {
      console.log(`   Account ID: ${creds.accountId}`);
    }
    console.log(`   Credentials file: ${auth.credentialsPath}`);
    if (!isValid) {
      console.log("\n   Run `lobs codex-auth refresh` to refresh the token.");
    }
    return;
  }

  if (subcommand === "refresh") {
    await auth.loadCredentials();
    if (!auth.hasCredentials()) {
      console.log("❌ No credentials found. Run `lobs codex-auth login` first.");
      process.exit(1);
    }
    console.log("Refreshing Codex OAuth token...");
    try {
      await auth.refreshAccessToken();
      const creds = (auth as unknown as { credentials: { expires: number } }).credentials;
      console.log("✅ Token refreshed successfully!");
      if (creds) console.log(`   Expires: ${formatExpiry(creds.expires)}`);
    } catch (err) {
      console.error("❌ Refresh failed:", err instanceof Error ? err.message : String(err));
      console.error("   You may need to run `lobs codex-auth login` again.");
      process.exit(1);
    }
    return;
  }

  // Default: show usage
  console.log("Usage: lobs codex-auth <subcommand>");
  console.log("");
  console.log("Subcommands:");
  console.log("  login    Run OAuth flow (opens browser), save tokens");
  console.log("  status   Show current auth status and token expiry");
  console.log("  refresh  Manually refresh the access token");
}
