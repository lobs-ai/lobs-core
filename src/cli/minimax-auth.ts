/**
 * CLI command: lobs minimax-auth
 *
 * Manages OAuth credentials for the minimax provider.
 *
 * Usage:
 *   lobs minimax-auth login [--region cn|global]  — run OAuth flow, save tokens
 *   lobs minimax-auth status                      — show auth status and expiry
 *   lobs minimax-auth refresh                     — manually refresh the token
 */

import { getMinimaxAuth, type MiniMaxRegion } from "../services/minimax-auth.js";

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

export async function cmdMinimaxAuth(subcommand: string | undefined, extraArgs: string[] = []): Promise<void> {
  const auth = getMinimaxAuth();

  if (subcommand === "login") {
    // Parse optional --region flag
    let region: MiniMaxRegion = "global";
    const regionIdx = extraArgs.indexOf("--region");
    if (regionIdx !== -1 && extraArgs[regionIdx + 1]) {
      const val = extraArgs[regionIdx + 1];
      if (val === "cn" || val === "global") {
        region = val;
      } else {
        console.error(`Invalid region: ${val}. Use 'cn' or 'global'.`);
        process.exit(1);
      }
    }

    console.log(`Starting MiniMax OAuth login flow (region: ${region})...\n`);
    try {
      const creds = await auth.login(region);
      console.log("✅ Login successful!");
      console.log(`   Token expires: ${formatExpiry(creds.expires)}`);
      console.log(`   Region: ${creds.region}`);
      if (creds.resourceUrl) {
        console.log(`   Resource URL: ${creds.resourceUrl}`);
      }
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
      console.log("❌ Not authenticated. Run `lobs minimax-auth login` to authenticate.");
      return;
    }
    const creds = auth.credentials;
    if (!creds) {
      console.log("❌ Not authenticated. Run `lobs minimax-auth login` to authenticate.");
      return;
    }
    const isValid = auth.isAuthenticated();
    console.log(`${isValid ? "✅" : "⚠️"} MiniMax OAuth Status`);
    console.log(`   Authenticated: ${isValid ? "yes" : "no (token expired)"}`);
    console.log(`   Expires: ${formatExpiry(creds.expires)}`);
    console.log(`   Region: ${creds.region}`);
    if (creds.resourceUrl) {
      console.log(`   Resource URL: ${creds.resourceUrl}`);
    }
    console.log(`   Credentials file: ${auth.credentialsPath}`);
    if (!isValid) {
      console.log("\n   Run `lobs minimax-auth refresh` to refresh the token.");
    }
    return;
  }

  if (subcommand === "refresh") {
    await auth.loadCredentials();
    if (!auth.hasCredentials()) {
      console.log("❌ No credentials found. Run `lobs minimax-auth login` first.");
      process.exit(1);
    }
    console.log("Refreshing MiniMax OAuth token...");
    try {
      await auth.refreshAccessToken();
      const creds = (auth as unknown as { credentials: { expires: number } }).credentials;
      console.log("✅ Token refreshed successfully!");
      if (creds) console.log(`   Expires: ${formatExpiry(creds.expires)}`);
    } catch (err) {
      console.error("❌ Refresh failed:", err instanceof Error ? err.message : String(err));
      console.error("   You may need to run `lobs minimax-auth login` again.");
      process.exit(1);
    }
    return;
  }

  // Default: show usage
  console.log("Usage: lobs minimax-auth <subcommand> [options]\n");
  console.log("Subcommands:");
  console.log("  login [--region cn|global]  Run OAuth flow (opens browser), save tokens");
  console.log("  status                      Show current auth status and token expiry");
  console.log("  refresh                     Manually refresh the access token");
}
