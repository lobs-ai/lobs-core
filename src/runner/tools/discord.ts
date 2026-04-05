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
  description: `Interact with Discord — send messages, react, create threads, fetch message history, manage channels, webhooks, threads, and more.

Actions: send, react, remove_reaction, reply, fetch_messages, fetch_message, create_thread, list_threads, add_thread_member, list_channels, send_embed, edit_message, delete_message, bulk_delete_messages, pin_message, unpin_message, create_channel, edit_channel, delete_channel, edit_channel_permissions, get_channel, create_webhook, list_webhooks, post_webhook, archive_thread, unarchive_thread, lock_thread, unlock_thread, edit_thread, delete_thread, remove_thread_member, get_guild, get_member, list_roles

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
          "edit_message", "delete_message", "bulk_delete_messages",
          "pin_message", "unpin_message",
          "create_channel", "edit_channel", "delete_channel", "edit_channel_permissions", "get_channel",
          "create_webhook", "list_webhooks", "post_webhook",
          "archive_thread", "unarchive_thread", "lock_thread", "unlock_thread",
          "edit_thread", "delete_thread", "remove_thread_member",
          "get_guild", "get_member", "list_roles",
        ],
        description: "Action to perform",
      },
      channel_id: { type: "string", description: "Discord channel or thread ID" },
      guild_id: { type: "string", description: "Discord guild/server ID (for list_channels, create_channel, get_guild, get_member, list_roles)" },
      message_id: { type: "string", description: "Discord message ID" },
      thread_id: { type: "string", description: "Thread ID (for add_thread_member, remove_thread_member, archive/unarchive/lock/unlock/edit/delete_thread)" },
      user_id: { type: "string", description: "User ID (for add_thread_member, remove_thread_member, get_member)" },
      content: { type: "string", description: "Message content (for send, reply, edit_message, post_webhook)" },
      emoji: { type: "string", description: "Emoji (for react, remove_reaction) — unicode like 👍 or custom name:id" },
      name: { type: "string", description: "Thread/channel/webhook name" },
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
      message_ids: { type: "array", items: { type: "string" }, description: "Array of message IDs (for bulk_delete_messages)" },
      channel_type: { type: "string", description: "Channel type for create_channel: text, voice, category, announcement, forum (default: text)" },
      topic: { type: "string", description: "Channel topic (for create_channel, edit_channel)" },
      nsfw: { type: "boolean", description: "NSFW flag (for create_channel, edit_channel)" },
      position: { type: "number", description: "Channel position (for create_channel, edit_channel)" },
      parent_id: { type: "string", description: "Category channel ID (for create_channel, edit_channel)" },
      rate_limit_per_user: { type: "number", description: "Slowmode in seconds (for create_channel, edit_channel, edit_thread)" },
      overwrite_id: { type: "string", description: "Role or user ID for permission overwrite (for edit_channel_permissions)" },
      overwrite_type: { type: "string", description: "'role' or 'member' (for edit_channel_permissions)" },
      allow: { type: "string", description: "Permissions to allow as bitfield string (for edit_channel_permissions)" },
      deny: { type: "string", description: "Permissions to deny as bitfield string (for edit_channel_permissions)" },
      webhook_id: { type: "string", description: "Webhook ID (for post_webhook)" },
      webhook_token: { type: "string", description: "Webhook token (for post_webhook)" },
      webhook_username: { type: "string", description: "Override display name for webhook post" },
      webhook_avatar_url: { type: "string", description: "Override avatar URL for webhook post" },
      locked: { type: "boolean", description: "Lock/unlock flag (for edit_thread)" },
      archived: { type: "boolean", description: "Archive/unarchive flag (for edit_thread)" },
      applied_tags: { type: "array", items: { type: "string" }, description: "Forum tag IDs to apply (for edit_thread on forum posts)" },
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

      // ── edit_message ───────────────────────────────────────────────
      case "edit_message": {
        const channelId = input.channel_id as string;
        const messageId = input.message_id as string;
        const content = input.content as string;
        if (!channelId || !messageId || !content) {
          return "Error: channel_id, message_id, and content are required";
        }
        const result = await discordRef.editMessage(channelId, messageId, content);
        return JSON.stringify({ ok: true, ...result });
      }

      // ── delete_message ─────────────────────────────────────────────
      case "delete_message": {
        const channelId = input.channel_id as string;
        const messageId = input.message_id as string;
        if (!channelId || !messageId) {
          return "Error: channel_id and message_id are required";
        }
        await discordRef.deleteMessage(channelId, messageId);
        return JSON.stringify({ ok: true });
      }

      // ── bulk_delete_messages ───────────────────────────────────────
      case "bulk_delete_messages": {
        const channelId = input.channel_id as string;
        const messageIds = input.message_ids as string[];
        if (!channelId || !Array.isArray(messageIds) || messageIds.length === 0) {
          return "Error: channel_id and message_ids (non-empty array) are required";
        }
        const result = await discordRef.bulkDeleteMessages(channelId, messageIds);
        return JSON.stringify({ ok: true, ...result });
      }

      // ── pin_message ────────────────────────────────────────────────
      case "pin_message": {
        const channelId = input.channel_id as string;
        const messageId = input.message_id as string;
        if (!channelId || !messageId) {
          return "Error: channel_id and message_id are required";
        }
        await discordRef.pinMessage(channelId, messageId);
        return JSON.stringify({ ok: true });
      }

      // ── unpin_message ──────────────────────────────────────────────
      case "unpin_message": {
        const channelId = input.channel_id as string;
        const messageId = input.message_id as string;
        if (!channelId || !messageId) {
          return "Error: channel_id and message_id are required";
        }
        await discordRef.unpinMessage(channelId, messageId);
        return JSON.stringify({ ok: true });
      }

      // ── create_channel ─────────────────────────────────────────────
      case "create_channel": {
        const guildId = input.guild_id as string;
        const name = input.name as string;
        if (!guildId || !name) {
          return "Error: guild_id and name are required";
        }
        const channelType = (input.channel_type as "text" | "voice" | "category" | "announcement" | "forum") ?? "text";
        const channel = await discordRef.createChannel(guildId, name, channelType, {
          parentId: input.parent_id as string | undefined,
          topic: input.topic as string | undefined,
          rateLimitPerUser: input.rate_limit_per_user as number | undefined,
          nsfw: input.nsfw as boolean | undefined,
          position: input.position as number | undefined,
        });
        return JSON.stringify({ ok: true, ...channel });
      }

      // ── edit_channel ───────────────────────────────────────────────
      case "edit_channel": {
        const channelId = input.channel_id as string;
        if (!channelId) return "Error: channel_id is required";
        const result = await discordRef.editChannel(channelId, {
          name: input.name as string | undefined,
          topic: input.topic as string | undefined,
          rateLimitPerUser: input.rate_limit_per_user as number | undefined,
          nsfw: input.nsfw as boolean | undefined,
          position: input.position as number | undefined,
          parentId: input.parent_id as string | undefined,
        });
        return JSON.stringify({ ok: true, ...result });
      }

      // ── delete_channel ─────────────────────────────────────────────
      case "delete_channel": {
        const channelId = input.channel_id as string;
        if (!channelId) return "Error: channel_id is required";
        await discordRef.deleteChannel(channelId);
        return JSON.stringify({ ok: true });
      }

      // ── edit_channel_permissions ───────────────────────────────────
      case "edit_channel_permissions": {
        const channelId = input.channel_id as string;
        const overwriteId = input.overwrite_id as string;
        const overwriteType = input.overwrite_type as string;
        if (!channelId || !overwriteId || !overwriteType) {
          return "Error: channel_id, overwrite_id, and overwrite_type are required";
        }
        if (overwriteType !== "role" && overwriteType !== "member") {
          return "Error: overwrite_type must be 'role' or 'member'";
        }
        await discordRef.editChannelPermissions(
          channelId,
          overwriteId,
          {
            allow: input.allow as string | undefined,
            deny: input.deny as string | undefined,
          },
          overwriteType,
        );
        return JSON.stringify({ ok: true });
      }

      // ── get_channel ────────────────────────────────────────────────
      case "get_channel": {
        const channelId = input.channel_id as string;
        if (!channelId) return "Error: channel_id is required";
        const channel = await discordRef.getChannel(channelId);
        return JSON.stringify({ ok: true, ...channel });
      }

      // ── create_webhook ─────────────────────────────────────────────
      case "create_webhook": {
        const channelId = input.channel_id as string;
        const name = input.name as string;
        if (!channelId || !name) {
          return "Error: channel_id and name are required";
        }
        const webhook = await discordRef.createWebhook(channelId, name);
        return JSON.stringify({ ok: true, ...webhook });
      }

      // ── list_webhooks ──────────────────────────────────────────────
      case "list_webhooks": {
        const channelId = input.channel_id as string;
        if (!channelId) return "Error: channel_id is required";
        const webhooks = await discordRef.listWebhooks(channelId);
        return JSON.stringify(webhooks);
      }

      // ── post_webhook ───────────────────────────────────────────────
      case "post_webhook": {
        const webhookId = input.webhook_id as string;
        const webhookToken = input.webhook_token as string;
        const content = input.content as string;
        if (!webhookId || !webhookToken || !content) {
          return "Error: webhook_id, webhook_token, and content are required";
        }
        const result = await discordRef.postWebhook(webhookId, webhookToken, content, {
          username: input.webhook_username as string | undefined,
          avatarUrl: input.webhook_avatar_url as string | undefined,
          embeds: input.fields as Array<{ title?: string; description?: string; color?: number }> | undefined,
        });
        return JSON.stringify({ ok: true, ...result });
      }

      // ── archive_thread ─────────────────────────────────────────────
      case "archive_thread": {
        const threadId = input.thread_id as string;
        if (!threadId) return "Error: thread_id is required";
        await discordRef.archiveThread(threadId);
        return JSON.stringify({ ok: true });
      }

      // ── unarchive_thread ───────────────────────────────────────────
      case "unarchive_thread": {
        const threadId = input.thread_id as string;
        if (!threadId) return "Error: thread_id is required";
        await discordRef.unarchiveThread(threadId);
        return JSON.stringify({ ok: true });
      }

      // ── lock_thread ────────────────────────────────────────────────
      case "lock_thread": {
        const threadId = input.thread_id as string;
        if (!threadId) return "Error: thread_id is required";
        await discordRef.lockThread(threadId);
        return JSON.stringify({ ok: true });
      }

      // ── unlock_thread ──────────────────────────────────────────────
      case "unlock_thread": {
        const threadId = input.thread_id as string;
        if (!threadId) return "Error: thread_id is required";
        await discordRef.unlockThread(threadId);
        return JSON.stringify({ ok: true });
      }

      // ── edit_thread ────────────────────────────────────────────────
      case "edit_thread": {
        const threadId = input.thread_id as string;
        if (!threadId) return "Error: thread_id is required";
        const result = await discordRef.editThread(threadId, {
          name: input.name as string | undefined,
          autoArchiveDuration: input.auto_archive_duration as 60 | 1440 | 4320 | 10080 | undefined,
          locked: input.locked as boolean | undefined,
          archived: input.archived as boolean | undefined,
          appliedTags: input.applied_tags as string[] | undefined,
        });
        return JSON.stringify({ ok: true, ...result });
      }

      // ── delete_thread ──────────────────────────────────────────────
      case "delete_thread": {
        const threadId = input.thread_id as string;
        if (!threadId) return "Error: thread_id is required";
        await discordRef.deleteThread(threadId);
        return JSON.stringify({ ok: true });
      }

      // ── remove_thread_member ───────────────────────────────────────
      case "remove_thread_member": {
        const threadId = input.thread_id as string;
        const userId = input.user_id as string;
        if (!threadId || !userId) {
          return "Error: thread_id and user_id are required";
        }
        await discordRef.removeThreadMember(threadId, userId);
        return JSON.stringify({ ok: true });
      }

      // ── get_guild ──────────────────────────────────────────────────
      case "get_guild": {
        const guildId = input.guild_id as string;
        if (!guildId) return "Error: guild_id is required";
        const guild = await discordRef.getGuild(guildId);
        return JSON.stringify({ ok: true, ...guild });
      }

      // ── get_member ─────────────────────────────────────────────────
      case "get_member": {
        const guildId = input.guild_id as string;
        const userId = input.user_id as string;
        if (!guildId || !userId) {
          return "Error: guild_id and user_id are required";
        }
        const member = await discordRef.getMember(guildId, userId);
        return JSON.stringify({ ok: true, ...member });
      }

      // ── list_roles ─────────────────────────────────────────────────
      case "list_roles": {
        const guildId = input.guild_id as string;
        if (!guildId) return "Error: guild_id is required";
        const roles = await discordRef.listRoles(guildId);
        return JSON.stringify(roles);
      }

      default:
        return `Error: Unknown action "${action}"`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
