import { Client, GatewayIntentBits, Partials, TextChannel, EmbedBuilder } from "discord.js";
import { registerSlashCommands, handleSlashCommand } from "./discord-commands.js";

export interface DiscordConfig {
  botToken: string;
  guildId: string;
  channels: {
    alerts?: string;      // Channel ID for alerts
    agentWork?: string;   // Channel ID for agent work updates
    completions?: string; // Channel ID for task completions
  };
  dmAllowFrom: string[];  // User IDs allowed to DM the bot
  channelPolicies: Record<string, { allow: boolean; requireMention: boolean }>;
}

class DiscordService {
  private client: Client | null = null;
  private config: DiscordConfig | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;

  async connect(config: DiscordConfig): Promise<void> {
    if (this.ready) return;
    this.config = config;
    
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [
        Partials.Channel,  // Required for DM messageCreate events
      ],
    });

    this.readyPromise = new Promise((resolve, reject) => {
      this.client!.once("ready", async () => {
        console.log(`[discord] Bot connected as ${this.client!.user?.tag}`);
        this.ready = true;
        
        // Register slash commands
        await registerSlashCommands(this.client!, config);
        
        // Set up interaction handler
        this.client!.on("interactionCreate", async (interaction) => {
          if (interaction.isChatInputCommand()) {
            await handleSlashCommand(interaction);
          }
        });
        
        resolve();
      });
      this.client!.once("error", reject);
    });

    await this.client.login(config.botToken);
    await this.readyPromise;
  }

  /** Send a plain text message to a channel */
  async send(channelId: string, content: string): Promise<void> {
    if (!this.client || !this.ready) {
      console.warn("[discord] Bot not connected, dropping message");
      return;
    }
    // Guard: only Discord snowflake IDs (numeric strings) should reach here
    if (!/^\d+$/.test(channelId)) {
      console.warn(`[discord] Ignoring non-snowflake channel ID: ${channelId.slice(0, 40)}`);
      return;
    }
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).send(content);
      }
    } catch (err) {
      console.error(`[discord] Failed to send to ${channelId}:`, err);
    }
  }

  /** Send an embed message */
  async sendEmbed(channelId: string, embed: {
    title: string;
    description?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: string;
  }): Promise<void> {
    if (!this.client || !this.ready) return;
    if (!/^\d+$/.test(channelId)) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        const embedBuilder = new EmbedBuilder()
          .setTitle(embed.title)
          .setTimestamp();
        
        if (embed.description) embedBuilder.setDescription(embed.description);
        if (embed.color) embedBuilder.setColor(embed.color);
        if (embed.fields) embed.fields.forEach(f => embedBuilder.addFields(f));
        if (embed.footer) embedBuilder.setFooter({ text: embed.footer });
        
        await (channel as TextChannel).send({ embeds: [embedBuilder] });
      }
    } catch (err) {
      console.error(`[discord] Failed to send embed to ${channelId}:`, err);
    }
  }

  /** Send a notification to the configured alerts channel */
  async alert(message: string): Promise<void> {
    if (this.config?.channels.alerts) {
      await this.send(this.config.channels.alerts, `⚠️ ${message}`);
    }
  }

  /** Send a task completion notification */
  async notifyCompletion(task: {
    title: string;
    agent: string;
    succeeded: boolean;
    summary?: string;
    duration?: number;
    cost?: number;
  }): Promise<void> {
    const channelId = this.config?.channels.completions || this.config?.channels.agentWork;
    if (!channelId) return;

    const color = task.succeeded ? 0x2dd4bf : 0xef4444; // teal or red
    const status = task.succeeded ? "✅ Completed" : "❌ Failed";

    await this.sendEmbed(channelId, {
      title: `${status}: ${task.title}`,
      color,
      fields: [
        { name: "Agent", value: task.agent, inline: true },
        ...(task.duration ? [{ name: "Duration", value: `${Math.round(task.duration)}s`, inline: true }] : []),
        ...(task.cost ? [{ name: "Cost", value: `$${task.cost.toFixed(4)}`, inline: true }] : []),
        ...(task.summary ? [{ name: "Summary", value: task.summary.substring(0, 1024) }] : []),
      ],
    });
  }

  /** Register event handler for messages */
  onMessage(handler: (message: { messageId: string; content: string; channelId: string; authorId: string; authorTag: string; isDm: boolean; isMentioned: boolean; images?: Array<{ data: string; mediaType: string; filename?: string }> }) => void): void {
    if (!this.client || !this.config) return;
    this.client.on("messageCreate", async (msg) => {
      if (msg.author.bot) return; // Ignore bot messages
      
      // Filter DMs
      if (!msg.guildId) {
        if (!this.config!.dmAllowFrom.includes(msg.author.id)) {
          return; // Silently drop unauthorized DMs
        }
      } else {
        // Filter guild channels
        const policy = this.config!.channelPolicies[msg.channelId];
        if (!policy || !policy.allow) {
          return; // Silently drop messages from disallowed channels
        }
        
        // Check mention requirement
        if (policy.requireMention && !msg.mentions.has(this.client!.user!)) {
          return; // Silently drop if mention required but not present
        }
      }
      
      const isDm = !msg.guildId;
      const isMentioned = msg.mentions.has(this.client!.user!);

      // Build content: message text + any text file attachments
      let content = msg.content;
      let images: Array<{ data: string; mediaType: string; filename?: string }> | undefined;

      if (msg.attachments.size > 0) {
        const textAttachments = await this.fetchTextAttachments(msg.attachments);
        if (textAttachments) {
          content = content ? `${content}\n\n${textAttachments}` : textAttachments;
        }
        // Also fetch image attachments
        images = await this.fetchImageAttachments(msg.attachments);
      }

      handler({
        messageId: msg.id,
        content,
        channelId: msg.channelId,
        authorId: msg.author.id,
        authorTag: msg.author.tag,
        isDm,
        isMentioned,
        images: images?.length ? images : undefined,
      });
    });
  }

  /** Fetch text content from Discord message attachments */
  private async fetchTextAttachments(attachments: import("discord.js").Collection<string, import("discord.js").Attachment>): Promise<string | null> {
    // File extensions and MIME types we consider readable as text
    const TEXT_EXTENSIONS = new Set([
      ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".tsv",
      ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
      ".cs", ".swift", ".kt", ".scala", ".sh", ".bash", ".zsh", ".fish", ".ps1",
      ".html", ".css", ".scss", ".less", ".sass",
      ".sql", ".graphql", ".gql",
      ".env", ".ini", ".cfg", ".conf", ".properties",
      ".dockerfile", ".makefile", ".cmake",
      ".r", ".m", ".lua", ".pl", ".pm", ".php",
      ".log", ".diff", ".patch",
      ".tex", ".bib", ".rst", ".adoc", ".org",
      ".gitignore", ".gitattributes", ".editorconfig",
      ".eslintrc", ".prettierrc", ".babelrc",
      ".svelte", ".vue", ".astro",
    ]);
    const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/yaml", "application/toml", "application/javascript", "application/typescript"];
    const MAX_FILE_SIZE = 512 * 1024; // 512KB limit per file

    const parts: string[] = [];

    for (const [, attachment] of attachments) {
      const ext = attachment.name ? "." + attachment.name.split(".").pop()?.toLowerCase() : "";
      const isTextByExt = TEXT_EXTENSIONS.has(ext) || attachment.name?.toLowerCase() === "dockerfile" || attachment.name?.toLowerCase() === "makefile";
      const isTextByMime = attachment.contentType ? TEXT_MIME_PREFIXES.some(p => attachment.contentType!.startsWith(p)) : false;

      if (!isTextByExt && !isTextByMime) continue;
      if (attachment.size > MAX_FILE_SIZE) {
        parts.push(`[Attachment: ${attachment.name} — skipped, too large (${(attachment.size / 1024).toFixed(0)}KB)]`);
        continue;
      }

      try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          parts.push(`[Attachment: ${attachment.name} — failed to download]`);
          continue;
        }
        const text = await response.text();
        parts.push(`--- File: ${attachment.name} ---\n${text}\n--- End: ${attachment.name} ---`);
      } catch (err) {
        parts.push(`[Attachment: ${attachment.name} — error: ${err instanceof Error ? err.message : "unknown"}]`);
      }
    }

    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  /** Fetch image attachments as base64 data for vision */
  private async fetchImageAttachments(
    attachments: import("discord.js").Collection<string, import("discord.js").Attachment>,
  ): Promise<Array<{ data: string; mediaType: string; filename?: string }>> {
    const IMAGE_TYPES: Record<string, string> = {
      "image/png": "image/png",
      "image/jpeg": "image/jpeg",
      "image/gif": "image/gif",
      "image/webp": "image/webp",
    };
    const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB limit (Anthropic's limit)
    const results: Array<{ data: string; mediaType: string; filename?: string }> = [];

    for (const [, attachment] of attachments) {
      // Check if it's an image by content type or extension
      const contentType = attachment.contentType?.toLowerCase() || "";
      const ext = attachment.name ? "." + attachment.name.split(".").pop()?.toLowerCase() : "";
      const extToMime: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
      };

      const mediaType = IMAGE_TYPES[contentType] || extToMime[ext];
      if (!mediaType) continue; // Not an image we can handle
      if (attachment.size > MAX_IMAGE_SIZE) continue; // Too large

      try {
        const response = await fetch(attachment.url);
        if (!response.ok) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        results.push({
          data: buffer.toString("base64"),
          mediaType,
          filename: attachment.name || undefined,
        });
      } catch (err) {
        console.error(`[discord] Failed to fetch image ${attachment.name}:`, err);
      }
    }

    return results;
  }

  /** Send a typing indicator to a channel */
  async sendTyping(channelId: string): Promise<void> {
    if (!this.client || !this.ready) return;
    if (!/^\d+$/.test(channelId)) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).sendTyping();
      }
    } catch {
      // Ignore typing errors
    }
  }

  /** Reply to a specific message in a channel */
  async reply(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.client || !this.ready) return;
    if (!/^\d+$/.test(channelId)) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        await msg.reply(content);
      }
    } catch {
      // Fall back to regular send
      await this.send(channelId, content);
    }
  }

  /** Add a reaction emoji to a Discord message */
  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || !this.ready) return;
    if (!/^\d+$/.test(channelId)) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        await msg.react(emoji);
      }
    } catch (err) {
      console.error(`[discord] Failed to react to ${messageId}:`, err);
      throw err;
    }
  }

  /** Remove a reaction from a Discord message */
  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || !this.ready) return;
    if (!/^\d+$/.test(channelId)) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        const userReactions = msg.reactions.cache.filter(reaction => reaction.me);
        for (const reaction of userReactions.values()) {
          if (reaction.emoji.name === emoji || reaction.emoji.toString() === emoji) {
            await reaction.users.remove(this.client.user!.id);
          }
        }
      }
    } catch (err) {
      console.error(`[discord] Failed to remove reaction from ${messageId}:`, err);
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      this.ready = false;
    }
  }
  
  isConnected(): boolean {
    return this.ready;
  }
}

export const discordService = new DiscordService();
