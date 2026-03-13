import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from "discord.js";

export interface DiscordConfig {
  botToken: string;
  guildId: string;
  channels: {
    alerts?: string;      // Channel ID for alerts
    agentWork?: string;   // Channel ID for agent work updates
    completions?: string; // Channel ID for task completions
  };
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
        GatewayIntentBits.MessageContent,
      ],
    });

    this.readyPromise = new Promise((resolve, reject) => {
      this.client!.once("ready", () => {
        console.log(`[discord] Bot connected as ${this.client!.user?.tag}`);
        this.ready = true;
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
  onMessage(handler: (message: { content: string; channelId: string; authorId: string; authorTag: string }) => void): void {
    if (!this.client) return;
    this.client.on("messageCreate", (msg) => {
      if (msg.author.bot) return; // Ignore bot messages
      handler({
        content: msg.content,
        channelId: msg.channelId,
        authorId: msg.author.id,
        authorTag: msg.author.tag,
      });
    });
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
