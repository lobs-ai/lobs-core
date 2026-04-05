import {
  Client, GatewayIntentBits, Partials, TextChannel, EmbedBuilder, GatewayDispatchEvents,
  ChannelType, OverwriteType, WebhookClient,
  type GuildChannelCreateOptions, type GuildChannelEditOptions,
  type PermissionOverwriteOptions,
} from "discord.js";
import { registerSlashCommands, handleSlashCommand, handleAutocompleteInteraction } from "./discord-commands.js";

export interface DiscordConfig {
  botToken: string;
  guildId: string;
  channels: {
    alerts?: string;      // Channel ID for alerts
    agentWork?: string;   // Channel ID for agent work updates
    completions?: string; // Channel ID for task completions
  };
  ownerId?: string;       // Primary owner's Discord user ID
  dmAllowFrom: string[];  // User IDs allowed to DM the bot
  botAllowFrom: string[]; // Bot user IDs whose messages are accepted (not silently dropped)
  channelPolicies: Record<string, { allow: boolean; requireMention: boolean }>;
  /** Guild-level allow policies — all channels in these guilds are allowed by default */
  guildPolicies?: Record<string, { allow: boolean; requireMention: boolean }>;
}

/** Connection health states */
type ConnectionState = "disconnected" | "connecting" | "ready" | "resuming" | "reconnecting";

/** Health metrics for monitoring */
interface HealthMetrics {
  state: ConnectionState;
  lastReady: number | null;
  lastDisconnect: number | null;
  reconnectCount: number;
  messagesSent: number;
  messagesReceived: number;
  sendFailures: number;
  lastHeartbeatAck: number | null;
}

const HEALTH_CHECK_INTERVAL_MS = 30_000;   // Check connection health every 30s
const RECONNECT_BACKOFF_BASE_MS = 2_000;   // Start with 2s backoff
const RECONNECT_BACKOFF_MAX_MS = 60_000;   // Max 60s backoff
const SEND_RETRY_ATTEMPTS = 2;             // Retry failed sends once
const SEND_RETRY_DELAY_MS = 1_000;         // 1s between retries
const SEND_TIMEOUT_MS = 15_000;
const TYPING_TIMEOUT_MS = 5_000;

class DiscordService {
  private client: Client | null = null;
  private config: DiscordConfig | null = null;
  private state: ConnectionState = "disconnected";
  private readyPromise: Promise<void> | null = null;
  private messageHandler: ((message: {
    messageId: string; content: string; channelId: string;
    authorId: string; authorTag: string; displayName: string; isDm: boolean;
    isMentioned: boolean; guildId?: string;
    images?: Array<{ data: string; mediaType: string; filename?: string }>;
  }) => void) | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private shuttingDown = false;
  private metrics: HealthMetrics = {
    state: "disconnected",
    lastReady: null,
    lastDisconnect: null,
    reconnectCount: 0,
    messagesSent: 0,
    messagesReceived: 0,
    sendFailures: 0,
    lastHeartbeatAck: null,
  };

  private async withTimeout<T>(label: string, channelId: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    console.debug(`[discord] ${label} start channel=${channelId} timeout_ms=${timeoutMs}`);
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms for ${channelId}`)), timeoutMs),
        ),
      ]);
      console.debug(`[discord] ${label} done channel=${channelId} duration_ms=${Date.now() - startedAt}`);
      return result;
    } catch (err) {
      console.error(`[discord] ${label} failed channel=${channelId} duration_ms=${Date.now() - startedAt}:`, err);
      throw err;
    }
  }

  async connect(config: DiscordConfig): Promise<void> {
    if (this.state === "ready") return;
    this.config = config;
    this.state = "connecting";
    this.metrics.state = "connecting";
    this.shuttingDown = false;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [
        Partials.Channel,  // Required for DM messageCreate events
      ],
    });

    this.setupEventHandlers();

    this.readyPromise = new Promise((resolve, reject) => {
      this.client!.once("ready", async () => {
        console.log(`[discord] Bot connected as ${this.client!.user?.tag}`);
        this.state = "ready";
        this.metrics.state = "ready";
        this.metrics.lastReady = Date.now();
        this.reconnectAttempts = 0;

        // Register slash commands
        await registerSlashCommands(this.client!, config);

        // Set up interaction handler
        this.client!.on("interactionCreate", async (interaction) => {
          if (interaction.isChatInputCommand()) {
            await handleSlashCommand(interaction);
          } else if (interaction.isAutocomplete()) {
            await handleAutocompleteInteraction(interaction);
          }
        });

        resolve();
      });
      this.client!.once("error", (err) => {
        console.error("[discord] Initial connection error:", err);
        reject(err);
      });
    });

    await this.client.login(config.botToken);
    await this.readyPromise;

    // Start health monitoring after initial connection
    this.startHealthCheck();
  }

  /** Set up all Discord.js event handlers for connection resilience */
  private setupEventHandlers(): void {
    if (!this.client) return;

    // Shard-level events (discord.js handles reconnection automatically, but we need to track state)
    this.client.on("shardReady", (shardId) => {
      console.log(`[discord] Shard ${shardId} ready`);
      this.state = "ready";
      this.metrics.state = "ready";
      this.metrics.lastReady = Date.now();
      this.metrics.lastHeartbeatAck = Date.now(); // Reset so health check doesn't immediately trigger
      this.reconnectAttempts = 0;
    });

    this.client.on("shardDisconnect", (event, shardId) => {
      console.warn(`[discord] Shard ${shardId} disconnected (code: ${event.code})`);
      this.state = "reconnecting";
      this.metrics.state = "reconnecting";
      this.metrics.lastDisconnect = Date.now();
      // discord.js will auto-reconnect, but we track the state
    });

    this.client.on("shardReconnecting", (shardId) => {
      console.log(`[discord] Shard ${shardId} reconnecting...`);
      this.state = "reconnecting";
      this.metrics.state = "reconnecting";
      this.metrics.reconnectCount++;
    });

    this.client.on("shardResume", (shardId, replayedEvents) => {
      console.log(`[discord] Shard ${shardId} resumed (replayed ${replayedEvents} events)`);
      this.state = "ready";
      this.metrics.state = "ready";
      this.metrics.lastReady = Date.now();
      this.reconnectAttempts = 0;
    });

    this.client.on("shardError", (error, shardId) => {
      console.error(`[discord] Shard ${shardId} error:`, error.message);
      // Don't change state — discord.js will handle reconnection
    });

    // Client-level error handling
    this.client.on("error", (error) => {
      console.error("[discord] Client error:", error.message);
    });

    this.client.on("warn", (message) => {
      console.warn("[discord] Warning:", message);
    });

    // Track invalidated sessions (requires full reconnect)
    this.client.on("invalidated", () => {
      console.error("[discord] Session invalidated — performing full reconnect");
      this.handleFullReconnect();
    });

    // Debug logging (only when LOBS_DEBUG is set)
    if (process.env.LOBS_DEBUG) {
      this.client.on("debug", (message) => {
        // Filter out noisy heartbeat messages
        if (!message.includes("Heartbeat")) {
          console.debug(`[discord:debug] ${message}`);
        }
      });
    }

    // Track heartbeat acks
    // Note: HEARTBEAT_ACK is opcode 11, not a dispatch event, so the 'raw' event doesn't fire for it.
    // Instead, we use the 'shardReady' and 'shardResume' events to reset the timestamp,
    // and check ws.ping in the health check to detect zombie connections.
    // The raw event only fires for dispatch events (opcode 0).
    this.client.on("raw", (packet: { t: string | null }) => {
      if (packet.t === GatewayDispatchEvents.Resumed) {
        this.metrics.lastHeartbeatAck = Date.now();
      }
    });
  }

  /** Health check — detect zombie connections */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);

    this.healthCheckTimer = setInterval(() => {
      if (this.shuttingDown) return;

      const now = Date.now();
      const ws = this.client?.ws;

      // Check 1: WebSocket ping (discord.js tracks this)
      const wsPing = ws?.ping ?? -1;
      if (wsPing > 10_000) {
        console.warn(`[discord] WebSocket ping very high: ${wsPing}ms`);
      }

      // Check 2: If we think we're ready but the WebSocket status says otherwise
      if (this.state === "ready" && ws) {
        const wsStatus = ws.status;
        // discord.js Status: 0=Ready, 1=Connecting, 2=Reconnecting, 3=Idle, 5=Disconnected, etc.
        if (wsStatus !== 0 && wsStatus !== 3) {
          console.warn(`[discord] State mismatch — we think ready but ws.status=${wsStatus}`);
          this.state = "reconnecting";
          this.metrics.state = "reconnecting";
        }
      }

      // Check 3: Detect zombie connections via ws.ping
      // discord.js tracks ws.ping as the latency of the last heartbeat ack.
      // If ping is -1, we haven't received an ack yet (normal during startup).
      // If we've been "ready" for a while but ping is -1, connection is likely dead.
      if (this.state === "ready" && ws) {
        const timeSinceReady = this.metrics.lastReady ? now - this.metrics.lastReady : 0;
        // If we've been "ready" for >90s but ping is -1, connection is zombie
        if (wsPing === -1 && timeSinceReady > 90_000) {
          console.warn(`[discord] No heartbeat ack received — ping=-1 after ${Math.round(timeSinceReady / 1000)}s ready`);
          if (timeSinceReady > 180_000) {
            console.error("[discord] No heartbeat ack in 3min — forcing reconnect");
            this.handleFullReconnect();
            return; // Don't continue health check after triggering reconnect
          }
        }
      }

      // Log health periodically (every 5 minutes via modulo)
      if (this.metrics.reconnectCount > 0 || wsPing > 5000) {
        console.log(
          `[discord:health] state=${this.state} ping=${wsPing}ms reconnects=${this.metrics.reconnectCount} ` +
          `sent=${this.metrics.messagesSent} recv=${this.metrics.messagesReceived} failures=${this.metrics.sendFailures}`
        );
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /** Full reconnect — destroy client and create fresh connection */
  private async handleFullReconnect(): Promise<void> {
    if (this.shuttingDown) return;
    this.reconnectAttempts++;

    const backoff = Math.min(
      RECONNECT_BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_BACKOFF_MAX_MS,
    );

    console.log(`[discord] Full reconnect attempt ${this.reconnectAttempts} in ${backoff}ms`);
    this.state = "reconnecting";
    this.metrics.state = "reconnecting";

    try {
      // Destroy old client
      if (this.client) {
        this.client.destroy();
      }
    } catch (err) {
      console.error("[discord] Error destroying old client:", err);
    }

    await new Promise(resolve => setTimeout(resolve, backoff));

    if (this.shuttingDown) return;

    try {
      // Create fresh client
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.GuildVoiceStates,
        ],
        partials: [Partials.Channel],
      });

      this.setupEventHandlers();

      // Re-register message handler
      if (this.messageHandler) {
        this.setupMessageListener(this.messageHandler);
      }

      this.readyPromise = new Promise((resolve) => {
        this.client!.once("ready", async () => {
          console.log(`[discord] Reconnected as ${this.client!.user?.tag} (attempt ${this.reconnectAttempts})`);
          this.state = "ready";
          this.metrics.state = "ready";
          this.metrics.lastReady = Date.now();
          this.metrics.reconnectCount++;
          this.reconnectAttempts = 0;

          await registerSlashCommands(this.client!, this.config!);
          this.client!.on("interactionCreate", async (interaction) => {
            if (interaction.isChatInputCommand()) {
              await handleSlashCommand(interaction);
            } else if (interaction.isAutocomplete()) {
              await handleAutocompleteInteraction(interaction);
            }
          });

          resolve();
        });
      });

      await this.client.login(this.config!.botToken);
      await this.readyPromise;
    } catch (err) {
      console.error(`[discord] Reconnect attempt ${this.reconnectAttempts} failed:`, err);
      // Schedule another attempt
      if (!this.shuttingDown && this.reconnectAttempts < 10) {
        setTimeout(() => this.handleFullReconnect(), backoff);
      } else if (this.reconnectAttempts >= 10) {
        console.error("[discord] Gave up reconnecting after 10 attempts");
      }
    }
  }

  /** Send a plain text message to a channel with retry */
  async send(channelId: string, content: string): Promise<void> {
    if (!this.client) {
      console.warn("[discord] Bot not initialized, dropping message");
      return;
    }
    // Guard: only Discord snowflake IDs (numeric strings) should reach here
    if (!/^\d+$/.test(channelId)) {
      console.warn(`[discord] Ignoring non-snowflake channel ID: ${channelId.slice(0, 40)}`);
      return;
    }

    for (let attempt = 0; attempt <= SEND_RETRY_ATTEMPTS; attempt++) {
      // Wait for connection if we're reconnecting (up to 10s)
      let ready = this.state === "ready";
      if (!ready) {
        console.warn(`[discord] Not ready (state=${this.state}), waiting for reconnect...`);
        const waitStart = Date.now();
        while (this.state !== "ready" && Date.now() - waitStart < 10_000) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        ready = this.state === "ready";
        if (!ready) {
          console.error(`[discord] Still not ready after 10s, dropping message to ${channelId}`);
          this.metrics.sendFailures++;
          return;
        }
      }

      try {
        const channel = await this.withTimeout("send", channelId, SEND_TIMEOUT_MS, async () => {
          const fetched = await this.client!.channels.fetch(channelId);
          if (fetched && fetched.isTextBased()) {
            console.debug(`[discord] Sending message to ${channelId} (${content.length} chars, attempt ${attempt})`);
            await (fetched as TextChannel).send(content);
          }
          return fetched;
        });
        if (channel && channel.isTextBased()) {
          this.metrics.messagesSent++;
          return; // Success
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[discord] Send failed (attempt ${attempt + 1}/${SEND_RETRY_ATTEMPTS + 1}) to ${channelId}: ${errMsg}`);
        this.metrics.sendFailures++;

        if (attempt < SEND_RETRY_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, SEND_RETRY_DELAY_MS));
        }
      }
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.client || this.state !== "ready") return;
    if (!/^\d+$/.test(channelId)) return;
    await this.withTimeout("typing", channelId, TYPING_TIMEOUT_MS, async () => {
      const channel = await this.client!.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).sendTyping();
      }
    });
  }

  /** Send an embed message */
  async sendEmbed(channelId: string, embed: {
    title: string;
    description?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: string;
  }): Promise<void> {
    if (!this.client || this.state !== "ready") return;
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
        this.metrics.messagesSent++;
      }
    } catch (err) {
      console.error(`[discord] Failed to send embed to ${channelId}:`, err);
      this.metrics.sendFailures++;
    }
  }

  /** Send a DM to a user by their Discord user ID */
  async sendDm(userId: string, content: string): Promise<void> {
    if (!this.client) {
      console.warn("[discord] Bot not initialized, dropping DM");
      return;
    }
    if (!userId || !/^\d+$/.test(userId)) {
      console.warn(`[discord] Invalid userId for DM: ${userId}`);
      return;
    }
    try {
      const user = await this.client.users.fetch(userId);
      const dmChannel = await user.createDM();
      await dmChannel.send(content);
      this.metrics.messagesSent++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[discord] sendDm failed to userId=${userId}: ${errMsg}`);
      this.metrics.sendFailures++;
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

  /** Register event handler for messages (stored for reconnection) */
  onMessage(handler: (message: {
    messageId: string; content: string; channelId: string;
    authorId: string; authorTag: string; displayName: string; isDm: boolean;
    isMentioned: boolean; guildId?: string;
    images?: Array<{ data: string; mediaType: string; filename?: string }>;
  }) => void): void {
    if (!this.client || !this.config) return;
    this.messageHandler = handler; // Store for reconnection
    this.setupMessageListener(handler);
  }

  /** Internal: set up the messageCreate listener */
  private setupMessageListener(handler: (message: {
    messageId: string; content: string; channelId: string;
    authorId: string; authorTag: string; displayName: string; isDm: boolean;
    isMentioned: boolean; guildId?: string;
    images?: Array<{ data: string; mediaType: string; filename?: string }>;
  }) => void): void {
    if (!this.client || !this.config) return;

    this.client.on("messageCreate", async (msg) => {
      // Always ignore our own messages to prevent loops
      if (msg.author.id === this.client!.user!.id) return;
      // Ignore bot messages unless they're in the allow list
      if (msg.author.bot && !this.config!.botAllowFrom.includes(msg.author.id)) return;
      this.metrics.messagesReceived++;

      // Filter DMs
      if (!msg.guildId) {
        if (!this.config!.dmAllowFrom.includes(msg.author.id)) {
          console.debug(`[discord] Dropping unauthorized DM from ${msg.author.tag} (${msg.author.id})`);
          return; // Silently drop unauthorized DMs
        }
      } else {
        // Filter guild channels — check channel-specific policy first, then guild-level policy
        const policy = this.config!.channelPolicies[msg.channelId]
          ?? (msg.guildId ? this.config!.guildPolicies?.[msg.guildId] : undefined);
        if (!policy || !policy.allow) {
          console.debug(`[discord] Dropping message from disallowed channel ${msg.channelId} guild=${msg.guildId}`);
          return; // Silently drop messages from disallowed channels
        }

        // Check mention requirement
        if (policy.requireMention && !msg.mentions.has(this.client!.user!)) {
          console.debug(`[discord] Dropping message from ${msg.channelId} without required mention`);
          return; // Silently drop if mention required but not present
        }
      }

      const isDm = !msg.guildId;
      const isMentioned = msg.mentions.has(this.client!.user!);

      // Build content: message text + embeds + any text file attachments
      let content = msg.content;
      let images: Array<{ data: string; mediaType: string; filename?: string }> | undefined;

      // Convert embeds to text — Discord embed messages have empty msg.content
      if (msg.embeds.length > 0) {
        const embedText = this.embedsToText(msg.embeds);
        if (embedText) {
          content = content ? `${content}\n\n${embedText}` : embedText;
        }
      }

      if (msg.attachments.size > 0) {
        const textAttachments = await this.fetchTextAttachments(msg.attachments);
        if (textAttachments) {
          content = content ? `${content}\n\n${textAttachments}` : textAttachments;
        }
        // Also fetch image attachments
        images = await this.fetchImageAttachments(msg.attachments);
      }

      // Use the most human-readable name available:
      // Guild nickname > global display name > username
      const displayName = msg.member?.displayName || msg.author.displayName || msg.author.username;

      console.info(
        `[discord] Accepted inbound message channel=${msg.channelId} dm=${isDm} ` +
        `mentioned=${isMentioned} author=${displayName} (${msg.author.tag}) len=${content.length}`,
      );

      handler({
        messageId: msg.id,
        content,
        channelId: msg.channelId,
        authorId: msg.author.id,
        authorTag: msg.author.tag,
        displayName,
        isDm,
        isMentioned,
        guildId: msg.guildId ?? undefined,
        images: images?.length ? images : undefined,
      });
    });
  }

  /**
   * Convert Discord embeds to a readable text representation.
   * Handles title, description, fields, footer, author, and URL.
   * Used when msg.content is empty but the message has rich embed data.
   */
  private embedsToText(embeds: import("discord.js").Embed[]): string {
    const parts: string[] = [];

    for (const embed of embeds) {
      const lines: string[] = [];

      if (embed.author?.name) {
        lines.push(`Author: ${embed.author.name}`);
      }
      if (embed.title) {
        lines.push(`Title: ${embed.title}`);
      }
      if (embed.url) {
        lines.push(`URL: ${embed.url}`);
      }
      if (embed.description) {
        lines.push(embed.description);
      }
      for (const field of embed.fields) {
        if (field.name && field.value) {
          lines.push(`${field.name}: ${field.value}`);
        }
      }
      if (embed.footer?.text) {
        lines.push(`Footer: ${embed.footer.text}`);
      }

      if (lines.length > 0) {
        parts.push(lines.join("\n"));
      }
    }

    return parts.join("\n\n---\n\n");
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

  /** Reply to a specific message */
  async reply(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.client || this.state !== "ready") return;
    if (!/^\d+$/.test(channelId)) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        await msg.reply(content);
        this.metrics.messagesSent++;
      }
    } catch (err) {
      console.error(`[discord] Failed to reply to ${messageId}:`, err);
      // Fall back to regular send
      await this.send(channelId, content);
    }
  }

  /** React to a Discord message */
  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || this.state !== "ready") return;
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
    if (!this.client || this.state !== "ready") return;
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

  /** Fetch recent messages from a channel */
  async fetchMessages(channelId: string, limit = 20, before?: string): Promise<Array<{
    id: string; content: string; authorId: string; authorTag: string; displayName: string;
    timestamp: string; attachments: number; embeds: number;
  }>> {
    if (!this.client || this.state !== "ready") return [];
    if (!/^\d+$/.test(channelId)) return [];
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return [];
      const options: { limit: number; before?: string } = { limit: Math.min(limit, 100) };
      if (before) options.before = before;
      const messages = await (channel as TextChannel).messages.fetch(options);
      return [...messages.values()].map(m => ({
        id: m.id,
        content: m.content,
        authorId: m.author.id,
        authorTag: m.author.tag,
        displayName: m.member?.displayName || m.author.displayName || m.author.username,
        timestamp: m.createdAt.toISOString(),
        attachments: m.attachments.size,
        embeds: m.embeds.length,
      }));
    } catch (err) {
      console.error(`[discord] fetchMessages failed for ${channelId}:`, err);
      return [];
    }
  }

  /** Fetch a single message by ID */
  async fetchMessage(channelId: string, messageId: string): Promise<{
    id: string; content: string; authorId: string; authorTag: string; displayName: string;
    timestamp: string; reactions: Array<{ emoji: string; count: number }>;
    attachments: Array<{ name: string; url: string; size: number }>;
  } | null> {
    if (!this.client || this.state !== "ready") return null;
    if (!/^\d+$/.test(channelId)) return null;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return null;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      return {
        id: msg.id,
        content: msg.content,
        authorId: msg.author.id,
        authorTag: msg.author.tag,
        displayName: msg.member?.displayName || msg.author.displayName || msg.author.username,
        timestamp: msg.createdAt.toISOString(),
        reactions: [...msg.reactions.cache.values()].map(r => ({
          emoji: r.emoji.toString(),
          count: r.count ?? 0,
        })),
        attachments: [...msg.attachments.values()].map(a => ({
          name: a.name ?? "unknown",
          url: a.url,
          size: a.size,
        })),
      };
    } catch (err) {
      console.error(`[discord] fetchMessage failed for ${channelId}/${messageId}:`, err);
      return null;
    }
  }

  /** Create a thread from a message or as a standalone thread */
  async createThread(channelId: string, name: string, messageId?: string, autoArchiveDuration?: number): Promise<{ threadId: string; name: string }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) throw new Error("Channel not found or not text-based");

    if (messageId) {
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      const thread = await msg.startThread({
        name,
        autoArchiveDuration: (autoArchiveDuration ?? 1440) as 60 | 1440 | 4320 | 10080,
      });
      return { threadId: thread.id, name: thread.name };
    } else {
      const thread = await (channel as TextChannel).threads.create({
        name,
        autoArchiveDuration: (autoArchiveDuration ?? 1440) as 60 | 1440 | 4320 | 10080,
      });
      return { threadId: thread.id, name: thread.name };
    }
  }

  /** List active threads in a channel */
  async listThreads(channelId: string): Promise<Array<{
    id: string; name: string; messageCount: number; memberCount: number;
    archived: boolean; createdAt: string;
  }>> {
    if (!this.client || this.state !== "ready") return [];
    if (!/^\d+$/.test(channelId)) return [];
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("threads" in channel)) return [];
      const active = await (channel as TextChannel).threads.fetchActive();
      return [...active.threads.values()].map(t => ({
        id: t.id,
        name: t.name,
        messageCount: t.messageCount ?? 0,
        memberCount: t.memberCount ?? 0,
        archived: t.archived ?? false,
        createdAt: t.createdTimestamp ? new Date(t.createdTimestamp).toISOString() : "",
      }));
    } catch (err) {
      console.error(`[discord] listThreads failed for ${channelId}:`, err);
      return [];
    }
  }

  /** Add a user to a thread */
  async addThreadMember(threadId: string, userId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(threadId)) throw new Error("Invalid thread ID");
    const thread = await this.client.channels.fetch(threadId);
    if (!thread || !thread.isThread()) throw new Error("Not a thread");
    await thread.members.add(userId);
  }

  /** List channels in a guild */
  async listChannels(guildId: string): Promise<Array<{
    id: string; name: string; type: string; parentId: string | null; parentName: string | null;
  }>> {
    if (!this.client || this.state !== "ready") return [];
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const channels = await guild.channels.fetch();
      const typeMap: Record<number, string> = {
        0: "text", 1: "dm", 2: "voice", 4: "category", 5: "announcement",
        10: "announcement_thread", 11: "public_thread", 12: "private_thread",
        13: "stage", 15: "forum", 16: "media",
      };
      return [...channels.values()].filter(c => c !== null).map(c => ({
        id: c!.id,
        name: c!.name,
        type: typeMap[c!.type] ?? `unknown(${c!.type})`,
        parentId: c!.parentId,
        parentName: c!.parent?.name ?? null,
      }));
    } catch (err) {
      console.error(`[discord] listChannels failed for guild ${guildId}:`, err);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message management
  // ─────────────────────────────────────────────────────────────────────────

  /** Edit an existing message's content */
  async editMessage(channelId: string, messageId: string, newContent: string): Promise<{
    id: string; content: string; editedAt: string;
  }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) throw new Error("Channel not found or not text-based");
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      const edited = await msg.edit(newContent);
      return {
        id: edited.id,
        content: edited.content,
        editedAt: edited.editedAt?.toISOString() ?? new Date().toISOString(),
      };
    } catch (err) {
      console.error(`[discord] editMessage failed for ${channelId}/${messageId}:`, err);
      throw err;
    }
  }

  /** Delete a message */
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) throw new Error("Channel not found or not text-based");
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.delete();
    } catch (err) {
      console.error(`[discord] deleteMessage failed for ${channelId}/${messageId}:`, err);
      throw err;
    }
  }

  /** Bulk delete up to 100 messages (messages must be < 14 days old) */
  async bulkDeleteMessages(channelId: string, messageIds: string[]): Promise<{ deleted: number }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    if (messageIds.length === 0) return { deleted: 0 };
    if (messageIds.length > 100) throw new Error("Cannot bulk delete more than 100 messages");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) throw new Error("Channel not found or not a guild text channel");
      const deleted = await (channel as TextChannel).bulkDelete(messageIds, true);
      return { deleted: deleted.size };
    } catch (err) {
      console.error(`[discord] bulkDeleteMessages failed for ${channelId}:`, err);
      throw err;
    }
  }

  /** Pin a message */
  async pinMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) throw new Error("Channel not found or not text-based");
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.pin();
    } catch (err) {
      console.error(`[discord] pinMessage failed for ${channelId}/${messageId}:`, err);
      throw err;
    }
  }

  /** Unpin a message */
  async unpinMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) throw new Error("Channel not found or not text-based");
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.unpin();
    } catch (err) {
      console.error(`[discord] unpinMessage failed for ${channelId}/${messageId}:`, err);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Channel management
  // ─────────────────────────────────────────────────────────────────────────

  /** Create a new text channel in a guild */
  async createChannel(
    guildId: string,
    name: string,
    type: "text" | "voice" | "category" | "announcement" | "forum" = "text",
    options?: {
      parentId?: string;
      topic?: string;
      rateLimitPerUser?: number;
      nsfw?: boolean;
      position?: number;
    },
  ): Promise<{ id: string; name: string; type: string; parentId: string | null }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const typeMap: Record<string, ChannelType> = {
        text: ChannelType.GuildText,
        voice: ChannelType.GuildVoice,
        category: ChannelType.GuildCategory,
        announcement: ChannelType.GuildAnnouncement,
        forum: ChannelType.GuildForum,
      };
      const channelType = typeMap[type] ?? ChannelType.GuildText;
      const createOptions: GuildChannelCreateOptions = {
        name,
        type: channelType as GuildChannelCreateOptions["type"],
        ...(options?.parentId && { parent: options.parentId }),
        ...(options?.topic && { topic: options.topic }),
        ...(options?.rateLimitPerUser !== undefined && { rateLimitPerUser: options.rateLimitPerUser }),
        ...(options?.nsfw !== undefined && { nsfw: options.nsfw }),
        ...(options?.position !== undefined && { position: options.position }),
      };
      const channel = await guild.channels.create(createOptions);
      const channelTypeNameMap: Record<number, string> = {
        0: "text", 2: "voice", 4: "category", 5: "announcement", 15: "forum",
      };
      return {
        id: channel.id,
        name: channel.name,
        type: channelTypeNameMap[channel.type] ?? `unknown(${channel.type})`,
        parentId: channel.parentId,
      };
    } catch (err) {
      console.error(`[discord] createChannel failed for guild ${guildId}:`, err);
      throw err;
    }
  }

  /** Edit channel properties */
  async editChannel(
    channelId: string,
    options: {
      name?: string;
      topic?: string;
      rateLimitPerUser?: number;
      nsfw?: boolean;
      position?: number;
      parentId?: string;
    },
  ): Promise<{ id: string; name: string }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("edit" in channel)) throw new Error("Channel not found or not editable");
      const editOptions: GuildChannelEditOptions = {
        ...(options.name && { name: options.name }),
        ...(options.topic !== undefined && { topic: options.topic }),
        ...(options.rateLimitPerUser !== undefined && { rateLimitPerUser: options.rateLimitPerUser }),
        ...(options.nsfw !== undefined && { nsfw: options.nsfw }),
        ...(options.position !== undefined && { position: options.position }),
        ...(options.parentId && { parent: options.parentId }),
      };
      const edited = await (channel as TextChannel).edit(editOptions);
      return { id: edited.id, name: edited.name };
    } catch (err) {
      console.error(`[discord] editChannel failed for ${channelId}:`, err);
      throw err;
    }
  }

  /** Delete a channel */
  async deleteChannel(channelId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) throw new Error("Channel not found");
      await channel.delete();
    } catch (err) {
      console.error(`[discord] deleteChannel failed for ${channelId}:`, err);
      throw err;
    }
  }

  /** Set permission overwrites for a role or member on a channel.
   * `permissions` is a map of PermissionFlagsBits key names to true (allow), false (deny), or null (neutral).
   * e.g. { SendMessages: true, ManageMessages: false }
   */
  async editChannelPermissions(
    channelId: string,
    overwriteId: string,
    permissions: PermissionOverwriteOptions,
    type: "role" | "member",
  ): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("permissionOverwrites" in channel)) throw new Error("Channel not found or does not support permission overwrites");
      await (channel as TextChannel).permissionOverwrites.edit(overwriteId, permissions, {
        type: type === "role" ? OverwriteType.Role : OverwriteType.Member,
      });
    } catch (err) {
      console.error(`[discord] editChannelPermissions failed for ${channelId}:`, err);
      throw err;
    }
  }

  /** Get info about a single channel */
  async getChannel(channelId: string): Promise<{
    id: string; name: string; type: string; parentId: string | null;
    topic: string | null; position: number | null; nsfw: boolean | null;
    rateLimitPerUser: number | null; messageCount: number | null;
  }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) throw new Error("Channel not found");
      const typeMap: Record<number, string> = {
        0: "text", 1: "dm", 2: "voice", 4: "category", 5: "announcement",
        10: "announcement_thread", 11: "public_thread", 12: "private_thread",
        13: "stage", 15: "forum", 16: "media",
      };
      return {
        id: channel.id,
        name: "name" in channel ? (channel.name as string) : "",
        type: typeMap[channel.type] ?? `unknown(${channel.type})`,
        parentId: "parentId" in channel ? (channel.parentId as string | null) : null,
        topic: "topic" in channel ? (channel.topic as string | null) : null,
        position: "position" in channel ? (channel.position as number) : null,
        nsfw: "nsfw" in channel ? (channel.nsfw as boolean) : null,
        rateLimitPerUser: "rateLimitPerUser" in channel ? (channel.rateLimitPerUser as number) : null,
        messageCount: channel.isThread() ? (channel.messageCount ?? null) : null,
      };
    } catch (err) {
      console.error(`[discord] getChannel failed for ${channelId}:`, err);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Webhook management
  // ─────────────────────────────────────────────────────────────────────────

  /** Create a webhook on a channel */
  async createWebhook(channelId: string, name: string): Promise<{ id: string; name: string; token: string }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) throw new Error("Channel not found or not a guild text channel");
      const webhook = await (channel as TextChannel).createWebhook({ name });
      if (!webhook.token) throw new Error("Webhook created but token is missing");
      return { id: webhook.id, name: webhook.name, token: webhook.token };
    } catch (err) {
      console.error(`[discord] createWebhook failed for ${channelId}:`, err);
      throw err;
    }
  }

  /** List webhooks in a channel */
  async listWebhooks(channelId: string): Promise<Array<{ id: string; name: string; channelId: string; guildId: string | null }>> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(channelId)) throw new Error("Invalid channel ID");
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) throw new Error("Channel not found or not a guild text channel");
      const webhooks = await (channel as TextChannel).fetchWebhooks();
      return [...webhooks.values()].map(w => ({
        id: w.id,
        name: w.name,
        channelId: w.channelId,
        guildId: w.guildId,
      }));
    } catch (err) {
      console.error(`[discord] listWebhooks failed for ${channelId}:`, err);
      throw err;
    }
  }

  /** Send a message via webhook */
  async postWebhook(
    webhookId: string,
    webhookToken: string,
    content: string,
    options?: {
      username?: string;
      avatarUrl?: string;
      embeds?: Array<{ title?: string; description?: string; color?: number }>;
    },
  ): Promise<{ id: string }> {
    try {
      const webhookClient = new WebhookClient({ id: webhookId, token: webhookToken });
      const msg = await webhookClient.send({
        content,
        ...(options?.username && { username: options.username }),
        ...(options?.avatarUrl && { avatarURL: options.avatarUrl }),
        ...(options?.embeds && {
          embeds: options.embeds.map(e => {
            const b = new EmbedBuilder();
            if (e.title) b.setTitle(e.title);
            if (e.description) b.setDescription(e.description);
            if (e.color) b.setColor(e.color);
            return b;
          }),
        }),
      });
      webhookClient.destroy();
      return { id: msg.id };
    } catch (err) {
      console.error(`[discord] postWebhook failed for webhook ${webhookId}:`, err);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Thread management
  // ─────────────────────────────────────────────────────────────────────────

  /** Archive a thread */
  async archiveThread(threadId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(threadId)) throw new Error("Invalid thread ID");
    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!thread || !thread.isThread()) throw new Error("Not a thread");
      await thread.setArchived(true);
    } catch (err) {
      console.error(`[discord] archiveThread failed for ${threadId}:`, err);
      throw err;
    }
  }

  /** Unarchive a thread */
  async unarchiveThread(threadId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(threadId)) throw new Error("Invalid thread ID");
    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!thread || !thread.isThread()) throw new Error("Not a thread");
      await thread.setArchived(false);
    } catch (err) {
      console.error(`[discord] unarchiveThread failed for ${threadId}:`, err);
      throw err;
    }
  }

  /** Lock a thread */
  async lockThread(threadId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(threadId)) throw new Error("Invalid thread ID");
    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!thread || !thread.isThread()) throw new Error("Not a thread");
      await thread.setLocked(true);
    } catch (err) {
      console.error(`[discord] lockThread failed for ${threadId}:`, err);
      throw err;
    }
  }

  /** Unlock a thread */
  async unlockThread(threadId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(threadId)) throw new Error("Invalid thread ID");
    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!thread || !thread.isThread()) throw new Error("Not a thread");
      await thread.setLocked(false);
    } catch (err) {
      console.error(`[discord] unlockThread failed for ${threadId}:`, err);
      throw err;
    }
  }

  /** Edit thread properties */
  async editThread(
    threadId: string,
    options: {
      name?: string;
      autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
      locked?: boolean;
      archived?: boolean;
      appliedTags?: string[];
    },
  ): Promise<{ id: string; name: string }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(threadId)) throw new Error("Invalid thread ID");
    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!thread || !thread.isThread()) throw new Error("Not a thread");
      const edited = await thread.edit({
        ...(options.name && { name: options.name }),
        ...(options.autoArchiveDuration !== undefined && { autoArchiveDuration: options.autoArchiveDuration }),
        ...(options.locked !== undefined && { locked: options.locked }),
        ...(options.archived !== undefined && { archived: options.archived }),
        ...(options.appliedTags && { appliedTags: options.appliedTags }),
      });
      return { id: edited.id, name: edited.name };
    } catch (err) {
      console.error(`[discord] editThread failed for ${threadId}:`, err);
      throw err;
    }
  }

  /** Delete a thread */
  async deleteThread(threadId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(threadId)) throw new Error("Invalid thread ID");
    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!thread || !thread.isThread()) throw new Error("Not a thread");
      await thread.delete();
    } catch (err) {
      console.error(`[discord] deleteThread failed for ${threadId}:`, err);
      throw err;
    }
  }

  /** Remove a member from a thread */
  async removeThreadMember(threadId: string, userId: string): Promise<void> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    if (!/^\d+$/.test(threadId)) throw new Error("Invalid thread ID");
    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!thread || !thread.isThread()) throw new Error("Not a thread");
      await thread.members.remove(userId);
    } catch (err) {
      console.error(`[discord] removeThreadMember failed for ${threadId}:`, err);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Guild / member / role info
  // ─────────────────────────────────────────────────────────────────────────

  /** Get guild info */
  async getGuild(guildId: string): Promise<{
    id: string; name: string; icon: string | null;
    memberCount: number; description: string | null; ownerId: string;
  }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    try {
      const guild = await this.client.guilds.fetch({ guild: guildId, withCounts: true });
      return {
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL() ?? null,
        memberCount: guild.approximateMemberCount ?? guild.memberCount,
        description: guild.description,
        ownerId: guild.ownerId,
      };
    } catch (err) {
      console.error(`[discord] getGuild failed for ${guildId}:`, err);
      throw err;
    }
  }

  /** Get a guild member's info */
  async getMember(guildId: string, userId: string): Promise<{
    id: string; displayName: string; nick: string | null;
    roles: Array<{ id: string; name: string }>; joinedAt: string | null;
  }> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      return {
        id: member.id,
        displayName: member.displayName,
        nick: member.nickname,
        roles: [...member.roles.cache.values()]
          .filter(r => r.id !== guild.id) // exclude @everyone
          .map(r => ({ id: r.id, name: r.name })),
        joinedAt: member.joinedAt?.toISOString() ?? null,
      };
    } catch (err) {
      console.error(`[discord] getMember failed for guild=${guildId} user=${userId}:`, err);
      throw err;
    }
  }

  /** List all roles in a guild */
  async listRoles(guildId: string): Promise<Array<{
    id: string; name: string; color: number; position: number; mentionable: boolean; hoist: boolean;
  }>> {
    if (!this.client || this.state !== "ready") throw new Error("Discord not ready");
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const roles = await guild.roles.fetch();
      return [...roles.values()]
        .sort((a, b) => b.position - a.position)
        .map(r => ({
          id: r.id,
          name: r.name,
          color: r.color,
          position: r.position,
          mentionable: r.mentionable,
          hoist: r.hoist,
        }));
    } catch (err) {
      console.error(`[discord] listRoles failed for guild ${guildId}:`, err);
      throw err;
    }
  }

  /** Get health metrics for monitoring */
  getHealth(): HealthMetrics {
    return { ...this.metrics };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
      this.state = "disconnected";
      this.metrics.state = "disconnected";
    }
  }

  /** Get the underlying Discord.js client (for voice manager, etc.) */
  getClient(): Client | null {
    return this.client;
  }

  isConnected(): boolean {
    return this.state === "ready";
  }

  getState(): ConnectionState {
    return this.state;
  }
}

export const discordService = new DiscordService();
