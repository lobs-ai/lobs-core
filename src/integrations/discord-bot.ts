/**
 * Discord bot integration for lobs-core.
 *
 * Handles:
 * - Receiving messages from Discord (via webhook or bot API)
 * - Sending messages to Discord channels
 * - Running Lobs main chat through our own agent runner
 *
 * For now, this uses Discord's REST API with a bot token.
 * Later we can add WebSocket gateway for real-time events.
 */

import { log } from "../util/logger.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const HOME = process.env.HOME ?? "";
const DISCORD_TOKEN_PATH = resolve(HOME, ".lobs/discord-token.txt");
const DISCORD_API = "https://discord.com/api/v10";

// Channel IDs
const RAFE_DM_CHANNEL = "1466921249421660415";

let discordToken: string | null = null;

/**
 * Load Discord bot token from file.
 */
function getToken(): string | null {
  if (discordToken) return discordToken;

  // Try environment variable first
  if (process.env.DISCORD_BOT_TOKEN) {
    discordToken = process.env.DISCORD_BOT_TOKEN;
    return discordToken;
  }

  // Try file
  if (existsSync(DISCORD_TOKEN_PATH)) {
    discordToken = readFileSync(DISCORD_TOKEN_PATH, "utf-8").trim();
    return discordToken;
  }

  return null;
}

/**
 * Send a message to a Discord channel.
 */
export async function sendMessage(
  channelId: string,
  content: string,
  options?: {
    replyTo?: string;
    silent?: boolean;
  },
): Promise<{ id: string; channel_id: string } | null> {
  const token = getToken();
  if (!token) {
    log().warn("[DISCORD] No bot token configured — cannot send message");
    return null;
  }

  const body: Record<string, unknown> = {
    content: content.slice(0, 2000), // Discord limit
  };

  if (options?.replyTo) {
    body.message_reference = { message_id: options.replyTo };
  }

  if (options?.silent) {
    body.flags = 4096; // SUPPRESS_NOTIFICATIONS
  }

  try {
    const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      log().error(`[DISCORD] Failed to send message: ${response.status} ${error}`);
      return null;
    }

    return await response.json() as { id: string; channel_id: string };
  } catch (err) {
    log().error(`[DISCORD] Send error: ${err}`);
    return null;
  }
}

/**
 * Send a message to Rafe's DM channel.
 */
export async function sendToRafe(
  content: string,
  options?: { replyTo?: string; silent?: boolean },
): Promise<{ id: string; channel_id: string } | null> {
  return sendMessage(RAFE_DM_CHANNEL, content, options);
}

/**
 * Send a long message, splitting into multiple if needed.
 */
export async function sendLongMessage(
  channelId: string,
  content: string,
): Promise<void> {
  const MAX_LEN = 1990;
  if (content.length <= MAX_LEN) {
    await sendMessage(channelId, content);
    return;
  }

  // Split on newlines, then by length
  const lines = content.split("\n");
  let chunk = "";

  for (const line of lines) {
    if (chunk.length + line.length + 1 > MAX_LEN) {
      if (chunk) await sendMessage(channelId, chunk);
      chunk = line;
    } else {
      chunk += (chunk ? "\n" : "") + line;
    }
  }

  if (chunk) await sendMessage(channelId, chunk);
}

/**
 * Check if Discord integration is available.
 */
export function isDiscordAvailable(): boolean {
  return getToken() !== null;
}

/**
 * Get recent messages from a channel.
 */
export async function getMessages(
  channelId: string,
  limit: number = 10,
): Promise<Array<{ id: string; content: string; author: { id: string; username: string }; timestamp: string }>> {
  const token = getToken();
  if (!token) return [];

  try {
    const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages?limit=${limit}`, {
      headers: {
        "Authorization": `Bot ${token}`,
      },
    });

    if (!response.ok) return [];
    return await response.json() as any[];
  } catch {
    return [];
  }
}
