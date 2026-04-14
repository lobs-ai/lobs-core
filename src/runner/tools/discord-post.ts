/**
 * discord-post tool — post a message to a Discord channel via the API.
 *
 * Reads the bot token from ~/.lobs/discord.json (field: token) and POSTs
 * to the Discord v10 API. Sova can use this to post directly without
 * routing through the Lobs Discord service layer.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const discordPostToolDefinition: ToolDefinition = {
  name: "discord-post",
  description:
    "Post a message to a Discord channel via the Discord API. " +
    "Uses Lobs's bot token. Sova can use this to post directly without routing through Lobs.",
  input_schema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "Discord channel ID to post to",
      },
      content: {
        type: "string",
        description: "Message content to post",
      },
    },
    required: ["channel_id", "content"],
  },
};

// ── Implementation ───────────────────────────────────────────────────────────

function readBotToken(): string {
  const configPath = join(homedir(), ".lobs", "config", "secrets", "discord-token.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const token = parsed.botToken;
    if (typeof token !== "string" || !token) {
      throw new Error("discord-token.json missing 'botToken' field");
    }
    return token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read Discord token from ${configPath}: ${message}`);
  }
}

export async function discordPostTool(params: Record<string, unknown>): Promise<string> {
  const channelId = params.channel_id;
  const content = params.content;

  if (typeof channelId !== "string" || !channelId) {
    throw new Error("channel_id is required");
  }
  if (typeof content !== "string" || !content) {
    throw new Error("content is required");
  }

  const token = readBotToken();
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(`Discord API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return `Message posted to channel ${channelId} (message ID: ${String(data.id ?? "unknown")})`;
}
