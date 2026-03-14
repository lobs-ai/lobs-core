import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DiscordConfig } from "../services/discord.js";

export function loadDiscordConfig(): DiscordConfig | null {
  // Try config file first
  const configPath = join(homedir(), ".lobs", "discord.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      console.error("[discord] Failed to parse config:", err);
    }
  }
  
  // Fall back to env vars
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (token && guildId) {
    return {
      botToken: token,
      guildId,
      channels: {
        alerts: process.env.DISCORD_CHANNEL_ALERTS,
        agentWork: process.env.DISCORD_CHANNEL_AGENT_WORK,
        completions: process.env.DISCORD_CHANNEL_COMPLETIONS,
      },
      dmAllowFrom: [],
      channelPolicies: {},
    };
  }
  
  console.log("[discord] No Discord config found — bot disabled");
  return null;
}
