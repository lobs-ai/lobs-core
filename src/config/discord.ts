import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DiscordConfig } from "../services/discord.js";

export function loadDiscordConfig(): DiscordConfig | null {
  const configDir = join(homedir(), ".lobs", "config");
  const configPath = join(configDir, "discord.json");
  const newTokenPath = join(configDir, "secrets", "discord-token.json");

  // Load main config (non-secret settings)
  let config: any = null;
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      config = JSON.parse(raw);
      if (config.enabled === false) {
        console.log("[discord] Bot disabled in config");
        return null;
      }
    } catch (err) {
      console.error("[discord] Failed to parse config:", err);
    }
  }

  // Load botToken from secrets/ (new layout) or discord.json (legacy)
  let botToken: string | undefined;

  // Try new layout first
  if (existsSync(newTokenPath)) {
    try {
      const tokenData = JSON.parse(readFileSync(newTokenPath, "utf-8"));
      botToken = tokenData.botToken;
    } catch (err) {
      console.error("[discord] Failed to parse secrets/discord-token.json:", err);
    }
  }

  // Fall back to legacy layout (botToken in discord.json)
  if (!botToken && config?.botToken) {
    console.warn("[discord] DEPRECATED: botToken in discord.json — migrate to secrets/discord-token.json");
    botToken = config.botToken;
  }

  // Fall back to env var
  if (!botToken) {
    botToken = process.env.DISCORD_BOT_TOKEN;
  }

  if (!botToken) {
    console.log("[discord] No botToken found — bot disabled");
    return null;
  }

  // Merge config with token
  const finalConfig: DiscordConfig = {
    botToken,
    guildId: config?.guildId ?? process.env.DISCORD_GUILD_ID,
    channels: config?.channels ?? {
      alerts: process.env.DISCORD_CHANNEL_ALERTS,
      agentWork: process.env.DISCORD_CHANNEL_AGENT_WORK,
      completions: process.env.DISCORD_CHANNEL_COMPLETIONS,
    },
    dmAllowFrom: config?.dmAllowFrom ?? [],
    channelPolicies: config?.channelPolicies ?? {},
  };

  return finalConfig;
}
