import { Client, GatewayIntentBits, Partials, TextChannel, EmbedBuilder, GatewayDispatchEvents } from "discord.js";
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
    authorId: string; authorTag: string; isDm: boolean;
    isMentioned: boolean; images?: Array<{ data: string; mediaType: string; filename?: string }>;
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
    authorId: string; authorTag: string; isDm: boolean;
    isMentioned: boolean; images?: Array<{ data: string; mediaType: string; filename?: string }>;
  }) => void): void {
    if (!this.client || !this.config) return;
    this.messageHandler = handler; // Store for reconnection
    this.setupMessageListener(handler);
  }

  /** Internal: set up the messageCreate listener */
  private setupMessageListener(handler: (message: {
    messageId: string; content: string; channelId: string;
    authorId: string; authorTag: string; isDm: boolean;
    isMentioned: boolean; images?: Array<{ data: string; mediaType: string; filename?: string }>;
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

      console.info(
        `[discord] Accepted inbound message channel=${msg.channelId} dm=${isDm} ` +
        `mentioned=${isMentioned} author=${msg.author.tag} len=${content.length}`,
      );

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
