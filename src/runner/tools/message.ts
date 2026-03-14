import type { ToolDefinition } from "../types.js";

let discordRef: any = null;

export function setDiscordService(service: any) {
  discordRef = service;
}

export const messageToolDefinition: ToolDefinition = {
  name: "message",
  description: "Send a message to a Discord channel or user. Use this to proactively communicate, send notifications, or reply in specific channels.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["send"],
        description: "Action to perform",
      },
      channel_id: {
        type: "string",
        description: "Discord channel ID to send to",
      },
      content: {
        type: "string",
        description: "Message content to send",
      },
    },
    required: ["action", "content"],
  },
};

export async function executeMessageTool(input: Record<string, unknown>): Promise<string> {
  if (!discordRef) return "Error: Discord service not connected";
  
  const action = input.action as string;
  if (action === "send") {
    const channelId = input.channel_id as string;
    const content = input.content as string;
    if (!channelId) return "Error: channel_id is required";
    if (!content) return "Error: content is required";
    
    await discordRef.send(channelId, content);
    return JSON.stringify({ ok: true, channelId, sent: true });
  }
  
  return `Unknown action: ${action}`;
}
