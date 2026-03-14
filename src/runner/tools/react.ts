/**
 * React tool — add emoji reactions to Discord messages.
 */

import type { ToolDefinition } from "../types.js";

let discordRef: any = null;

export function setDiscordService(service: any) {
  discordRef = service;
}

export const reactToolDefinition: ToolDefinition = {
  name: "react",
  description: "Add a reaction emoji to a Discord message. Supports unicode emoji (👍) and custom emoji (name:id format).",
  input_schema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "Discord channel ID containing the message",
      },
      message_id: {
        type: "string",
        description: "Discord message ID to react to",
      },
      emoji: {
        type: "string",
        description: "Emoji to react with (unicode like 👍 or custom like name:id)",
      },
    },
    required: ["channel_id", "message_id", "emoji"],
  },
};

export async function executeReactTool(input: Record<string, unknown>): Promise<string> {
  if (!discordRef) {
    return "Error: Discord service not connected";
  }

  const channelId = input.channel_id as string;
  const messageId = input.message_id as string;
  const emoji = input.emoji as string;

  if (!channelId || !messageId || !emoji) {
    return "Error: channel_id, message_id, and emoji are all required";
  }

  try {
    await discordRef.react(channelId, messageId, emoji);
    return JSON.stringify({ ok: true, channelId, messageId, emoji });
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
