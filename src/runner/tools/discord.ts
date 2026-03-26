/**
 * Discord tool — unified multi-action tool for all Discord interactions.
 *
 * Replaces the separate message and react tools with a single powerful tool
 * supporting sending, reacting, threads, message history, embeds, and more.
 */

import type { ToolDefinition } from "../types.js";

let discordRef: any = null;

export function setDiscordService(service: any) {
  discordRef = service;
}

export const discordToolDefinition: ToolDefinition = {
  name: "discord",
  description: `Interact with Discord — send messages, react, create threads, fetch message history, and more. Use this for all Discord interactions beyond the automatic reply.

Actions: send, react, remove_reaction, reply, fetch_messages, fetch_message, create_thread, list_threads, add_thread_member, list_channels, send_embed

Note: Discord threads are channels — use fetch_messages with a thread ID to read thread messages.`,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "send", "react", "remove_reaction", "reply",
          "fetch_messages", "fetch_message",
          "create_thread", "list_threads", "add_thread_member",
          "list_channels", "send_embed",
        ],
        description: "Action to perform",
      },
      channel_id: { type: "string", description: "Discord channel or thread ID" },
      guild_id: { type: "string", description: "Discord guild/server ID (for list_channels)" },
      message_id: { type: "string", description: "Discord message ID (for react, remove_reaction, reply, fetch_message, create_thread)" },
      thread_id: { type: "string", description: "Thread ID (for add_thread_member)" },
      user_id: { type: "string", description: "User ID (for add_thread_member)" },
      content: { type: "string", description: "Message content (for send, reply)" },
      emoji: { type: "string", description: "Emoji (for react, remove_reaction) — unicode like 👍 or custom name:id" },
      name: { type: "string", description: "Thread name (for create_thread)" },
      limit: { type: "number", description: "Number of messages to fetch (default 20, max 100)" },
      before: { type: "string", description: "Fetch messages before this message ID (for pagination)" },
      auto_archive_duration: { type: "number", description: "Thread auto-archive in minutes (60, 1440, 4320, 10080)" },
      title: { type: "string", description: "Embed title (for send_embed)" },
      description: { type: "string", description: "Embed description (for send_embed)" },
      color: { type: "number", description: "Embed color as integer (for send_embed)" },
      fields: {
        type: "array",
        description: "Embed fields array of {name, value, inline?} (for send_embed)",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            inline: { type: "boolean" },
          },
          required: ["name", "value"],
        },
      },
      footer: { type: "string", description: "Embed footer text (for send_embed)" },
    },
    required: ["action"],
  },
};

export async function executeDiscordTool(input: Record<string, unknown>): Promise<string> {
  if (!discordRef) return "Error: Discord service not connected";
  const action = input.action as string;

  try {
    switch (action) {
      // ── send ────────────────────────────────────────────────────────
      case "send": {
        const channelId = input.channel_id as string;
        const content = input.content as string;
        if (!channelId) return "Error: channel_id is required";
        if (!content) return "Error: content is required";
        await discordRef.send(channelId, content);
        return JSON.stringify({ ok: true, channelId });
      }

      // ── react ──────────────────────────────────────────────────────
      case "react": {
        const channelId = input.channel_id as string;
        const messageId = input.message_id as string;
        const emoji = input.emoji as string;
        if (!channelId || !messageId || !emoji) {
          return "Error: channel_id, message_id, and emoji are all required";
        }
        await discordRef.react(channelId, messageId, emoji);
        return JSON.stringify({ ok: true });
      }

      // ── remove_reaction ────────────────────────────────────────────
      case "remove_reaction": {
        const channelId = input.channel_id as string;
        const messageId = input.message_id as string;
        const emoji = input.emoji as string;
        if (!channelId || !messageId || !emoji) {
          return "Error: channel_id, message_id, and emoji are all required";
        }
        await discordRef.removeReaction(channelId, messageId, emoji);
        return JSON.stringify({ ok: true });
      }

      // ── reply ──────────────────────────────────────────────────────
      case "reply": {
        const channelId = input.channel_id as string;
        const messageId = input.message_id as string;
        const content = input.content as string;
        if (!channelId || !messageId || !content) {
          return "Error: channel_id, message_id, and content are all required";
        }
        await discordRef.reply(channelId, messageId, content);
        return JSON.stringify({ ok: true });
      }

      // ── fetch_messages ─────────────────────────────────────────────
      case "fetch_messages":
      case "fetch_thread_messages": {
        const channelId = input.channel_id as string;
        if (!channelId) return "Error: channel_id is required";
        const limit = typeof input.limit === "number" ? input.limit : 20;
        const before = input.before as string | undefined;
        const messages = await discordRef.fetchMessages(channelId, limit, before);
        return JSON.stringify(messages);
      }

      // ── fetch_message ──────────────────────────────────────────────
      case "fetch_message": {
        const channelId = input.channel_id as string;
        const messageId = input.message_id as string;
        if (!channelId || !messageId) {
          return "Error: channel_id and message_id are required";
        }
        const message = await discordRef.fetchMessage(channelId, messageId);
        if (!message) return "Error: Message not found";
        return JSON.stringify(message);
      }

      // ── create_thread ──────────────────────────────────────────────
      case "create_thread": {
        const channelId = input.channel_id as string;
        const name = input.name as string;
        if (!channelId || !name) {
          return "Error: channel_id and name are required";
        }
        const messageId = input.message_id as string | undefined;
        const autoArchiveDuration = input.auto_archive_duration as number | undefined;
        const thread = await discordRef.createThread(channelId, name, messageId, autoArchiveDuration);
        return JSON.stringify({ ok: true, threadId: thread.threadId, name: thread.name });
      }

      // ── list_threads ───────────────────────────────────────────────
      case "list_threads": {
        const channelId = input.channel_id as string;
        if (!channelId) return "Error: channel_id is required";
        const threads = await discordRef.listThreads(channelId);
        return JSON.stringify(threads);
      }

      // ── add_thread_member ──────────────────────────────────────────
      case "add_thread_member": {
        const threadId = input.thread_id as string;
        const userId = input.user_id as string;
        if (!threadId || !userId) {
          return "Error: thread_id and user_id are required";
        }
        await discordRef.addThreadMember(threadId, userId);
        return JSON.stringify({ ok: true });
      }

      // ── list_channels ──────────────────────────────────────────────
      case "list_channels": {
        const guildId = input.guild_id as string;
        if (!guildId) return "Error: guild_id is required";
        const channels = await discordRef.listChannels(guildId);
        return JSON.stringify(channels);
      }

      // ── send_embed ─────────────────────────────────────────────────
      case "send_embed": {
        const channelId = input.channel_id as string;
        const title = input.title as string;
        if (!channelId || !title) {
          return "Error: channel_id and title are required";
        }
        await discordRef.sendEmbed(channelId, {
          title,
          description: input.description as string | undefined,
          color: input.color as number | undefined,
          fields: input.fields as Array<{ name: string; value: string; inline?: boolean }> | undefined,
          footer: input.footer as string | undefined,
        });
        return JSON.stringify({ ok: true });
      }

      default:
        return `Error: Unknown action "${action}". Valid actions: send, react, remove_reaction, reply, fetch_messages, fetch_message, create_thread, list_threads, add_thread_member, list_channels, send_embed`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
