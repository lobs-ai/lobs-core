/**
 * Voice Session Manager — orchestrates Discord voice sessions
 *
 * Supports two parallel modes:
 * 1. **Sidecar mode** (default) — Discord Opus → local STT → Claude → TTS → Discord
 * 2. **Realtime mode** — Discord Opus → OpenAI Realtime API → Discord (speech-to-speech)
 *
 * Mode is selected by `realtime.enabled` in voice.json. One session per guild.
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  VoiceConnectionStatus,
  EndBehaviorType,
  entersState,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import type { Client, VoiceChannel, StageChannel, GuildMember } from "discord.js";
import type {
  VoiceConfig,
  VoiceSessionStatus,
  Transcription,
  TriggerMode,
  VoiceMode,
} from "./types.js";
import { VoiceReceiver } from "./receiver.js";
import { VoiceSpeaker } from "./speaker.js";
import { VoiceTranscript } from "./transcript.js";
import { loadVoiceConfig } from "./config.js";
import { VoiceSidecar } from "./sidecar.js";
import { RealtimeVoiceSession } from "./realtime-session.js";
import { DeferredActionQueue } from "./deferred-action-queue.js";
import { getKeyPool } from "../key-pool.js";
import { MeetingAnalysisService } from "../meeting-analysis.js";

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/** Shared fields for all voice sessions */
interface VoiceSessionBase {
  guildId: string;
  channelId: string;
  channelName: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  connectedSince: number;
  /** Timer that fires when the bot has been alone in the channel too long */
  aloneTimer?: ReturnType<typeof setTimeout>;
}

/** Sidecar-mode session (STT + TTS via local services) */
interface SidecarSession extends VoiceSessionBase {
  mode: "sidecar";
  receiver: VoiceReceiver;
  speaker: VoiceSpeaker;
  transcript: VoiceTranscript;
  onMessage: (text: string, userId: string, displayName: string) => Promise<string>;
}

/** Realtime-mode session (OpenAI Realtime API speech-to-speech) */
interface RealtimeSessionEntry extends VoiceSessionBase {
  mode: "realtime";
  realtimeSession: RealtimeVoiceSession;
  /** Deferred action queue — captures action items during live meetings */
  deferredActionQueue: DeferredActionQueue;
}

type VoiceSession = SidecarSession | RealtimeSessionEntry;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long (ms) the bot stays in a channel alone before auto-leaving */
const ALONE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if STT/TTS service is healthy */
async function checkSidecarHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const data = (await response.json()) as { status: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

/** Resolve OpenAI API key from key pool or environment */
function resolveOpenAIApiKey(): string | undefined {
  try {
    const auth = getKeyPool().getAuth("openai", "voice-realtime");
    if (auth?.apiKey) return auth.apiKey;
  } catch {
    // Key pool not initialized yet — fall through
  }
  return process.env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEYS?.split(",")[0]?.trim();
}

// ---------------------------------------------------------------------------
// VoiceManager
// ---------------------------------------------------------------------------

/**
 * VoiceManager — singleton that manages voice sessions across guilds.
 *
 * When `config.realtime.enabled` is true, sessions use the OpenAI Realtime API
 * for end-to-end speech-to-speech. Otherwise, the local STT/TTS sidecar is used.
 */
export class VoiceManager {
  private sessions = new Map<string, VoiceSession>();
  private client: Client;
  private config: VoiceConfig;
  private sidecar: VoiceSidecar;
  private meetingAnalysis = new MeetingAnalysisService();
  private messageHandler:
    | ((text: string, userId: string, displayName: string, channelId: string) => Promise<void>)
    | null = null;
  /** Pending reply resolvers keyed by voice:GUILD_ID — resolved by onVoiceReply() */
  private pendingReplies = new Map<
    string,
    { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(client: Client) {
    this.client = client;
    this.config = loadVoiceConfig();
    this.sidecar = new VoiceSidecar(this.config);
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize voice services. Call after construction.
   * Auto-starts sidecar if configured and mode is sidecar.
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      console.log("[voice:manager] Voice disabled in config");
      return;
    }

    const mode = this.activeMode;
    console.log(`[voice:manager] Voice enabled — mode: ${mode}`);

    if (mode === "realtime") {
      // Verify we have an OpenAI API key
      const apiKey = resolveOpenAIApiKey();
      if (!apiKey) {
        console.warn(
          "[voice:manager] Realtime mode enabled but no OPENAI_API_KEY found — will fail on join",
        );
      } else {
        console.log(
          `[voice:manager] Realtime ready — model: ${this.config.realtime.model}, voice: ${this.config.realtime.voice}`,
        );
      }
    } else {
      // Sidecar mode
      if (this.config.autoStartSidecar) {
        console.log("[voice:manager] Auto-starting sidecar services...");
        const result = await this.sidecar.start();
        if (!result.stt.healthy) {
          console.warn(
            `[voice:manager] STT not healthy after auto-start: ${result.stt.error ?? "unknown"}`,
          );
        }
        if (!result.tts.healthy) {
          console.warn(
            `[voice:manager] TTS not healthy after auto-start: ${result.tts.error ?? "unknown"}`,
          );
        }
      } else {
        const health = await this.sidecar.checkHealth();
        console.log(
          `[voice:manager] Sidecar status — STT: ${health.stt ? "✓" : "✗"}, TTS: ${health.tts ? "✓" : "✗"} (autoStart: off)`,
        );
      }
    }

    // Listen for voice state changes to detect when the bot is left alone
    this.client.on("voiceStateUpdate", (_oldState, newState) => {
      // Only care about changes in channels where we have a session
      const guildId = newState.guild.id;
      const session = this.sessions.get(guildId);
      if (!session) return;
      this.checkAloneInChannel(guildId);
    });
  }

  /** Which mode is configured */
  get activeMode(): VoiceMode {
    return this.config.realtime.enabled ? "realtime" : "sidecar";
  }

  /** Get the sidecar manager (for health checks, etc.) */
  getSidecar(): VoiceSidecar {
    return this.sidecar;
  }

  /** Set the handler that routes voice transcriptions to Claude (sidecar mode only) */
  setMessageHandler(
    handler: (text: string, userId: string, displayName: string, channelId: string) => Promise<void>,
  ): void {
    this.messageHandler = handler;
  }

  /**
   * Called by the reply handler when a voice channel gets a response.
   * Routes the text to TTS playback and resolves any pending promise.
   * Only relevant for sidecar mode.
   */
  async onVoiceReply(guildId: string, content: string): Promise<void> {
    const session = this.sessions.get(guildId);
    const channelKey = `voice:${guildId}`;
    const pending = this.pendingReplies.get(channelKey);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingReplies.delete(channelKey);
      pending.resolve(content);
    }

    // Feed through TTS (sidecar mode only)
    if (session?.mode === "sidecar" && content) {
      session.transcript.addAssistantResponse(content);
      await session.speaker.feedText(content);
      await session.speaker.flush();
    }
  }

  /** Check if voice is enabled in config */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  // -------------------------------------------------------------------------
  // Join / Leave
  // -------------------------------------------------------------------------

  /**
   * Join a voice channel.
   * Returns null on success, or an error message string.
   */
  async join(guildId: string, channelId: string): Promise<string | null> {
    if (!this.config.enabled) {
      return "Voice is not enabled. Set `enabled: true` in ~/.lobs/config/voice.json";
    }

    // Check if already in a session in this guild
    if (this.sessions.has(guildId)) {
      const existing = this.sessions.get(guildId)!;
      if (existing.channelId === channelId) {
        return "Already connected to this channel.";
      }
      // Move to new channel — leave old first
      await this.leave(guildId);
    }

    const mode = this.activeMode;

    // Mode-specific pre-flight checks
    if (mode === "sidecar") {
      const [sttOk, ttsOk] = await Promise.all([
        checkSidecarHealth(this.config.stt.url),
        checkSidecarHealth(this.config.tts.url),
      ]);
      if (!sttOk) {
        return `STT service not responding at ${this.config.stt.url}. Start it with: cd lobs-voice/stt && ./start-stt.sh`;
      }
      if (!ttsOk) {
        return `TTS service not responding at ${this.config.tts.url}. Start it with: cd lobs-voice/tts && ./start-tts.sh`;
      }
    } else {
      const apiKey = resolveOpenAIApiKey();
      if (!apiKey) {
        return "Realtime mode enabled but no OPENAI_API_KEY found. Set it in .env or the key pool.";
      }
    }

    // Resolve channel
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      return `Guild ${guildId} not found.`;
    }

    const channel = guild.channels.cache.get(channelId) as
      | VoiceChannel
      | StageChannel
      | undefined;
    if (!channel || !("joinable" in channel)) {
      return `Channel ${channelId} is not a voice channel.`;
    }

    try {
      // Join the voice channel
      const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

      const player = createAudioPlayer();
      connection.subscribe(player);

      // Build session based on mode
      let session: VoiceSession;

      if (mode === "realtime") {
        session = await this.buildRealtimeSession(
          guildId,
          channelId,
          channel.name,
          connection,
          player,
        );
      } else {
        session = this.buildSidecarSession(
          guildId,
          channelId,
          channel.name,
          connection,
          player,
        );
      }

      // Store session
      this.sessions.set(guildId, session);

      // Start health monitoring for sidecar mode
      if (mode === "sidecar" && this.sessions.size === 1) {
        this.sidecar.startHealthMonitor();
      }

      // Subscribe to users already in the channel
      this.subscribeExistingUsers(session, channel);

      // Handle connection state changes
      this.setupConnectionListeners(guildId, connection, channel.name, guild.name);

      // Listen for voice state updates (users joining/leaving)
      this.setupVoiceStateListener(guildId);

      console.log(
        `[voice:manager] Connected to #${channel.name} in ${guild.name} (${mode} mode)`,
      );
      return null;
    } catch (err) {
      console.error(`[voice:manager] Failed to join channel:`, err);
      return `Failed to join voice channel: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Leave a voice channel in a guild.
   */
  async leave(guildId: string): Promise<string | null> {
    const session = this.sessions.get(guildId);
    if (!session) {
      return "Not connected to a voice channel in this server.";
    }

    this.destroySession(guildId);
    console.log(`[voice:manager] Left #${session.channelName}`);
    return null;
  }

  // -------------------------------------------------------------------------
  // Session builders
  // -------------------------------------------------------------------------

  /** Build a sidecar-mode session */
  private buildSidecarSession(
    guildId: string,
    channelId: string,
    channelName: string,
    connection: VoiceConnection,
    player: AudioPlayer,
  ): SidecarSession {
    const transcript = new VoiceTranscript(
      this.config.conversation.maxContextExchanges,
      this.config.conversation.triggerMode,
      this.config.conversation.triggerWords,
    );

    const speaker = new VoiceSpeaker(this.config, player, connection);

    const session: SidecarSession = {
      mode: "sidecar",
      guildId,
      channelId,
      channelName,
      connection,
      player,
      receiver: null as unknown as VoiceReceiver,
      speaker,
      transcript,
      connectedSince: Date.now(),
      onMessage: async (text, userId, displayName) => {
        return this.handleTranscription(guildId, text, userId, displayName);
      },
    };

    const receiver = new VoiceReceiver(connection, this.config, (t: Transcription) => {
      this.onUserSpoke(guildId, t);
    });
    session.receiver = receiver;

    return session;
  }

  /** Build a realtime-mode session and connect to OpenAI */
  private async buildRealtimeSession(
    guildId: string,
    channelId: string,
    channelName: string,
    connection: VoiceConnection,
    player: AudioPlayer,
  ): Promise<RealtimeSessionEntry> {
    const apiKey = resolveOpenAIApiKey()!;
    const rc = this.config.realtime;

    // Create deferred action queue for this session
    const deferredActionQueue = new DeferredActionQueue();

    const realtimeSession = new RealtimeVoiceSession({
      guildId,
      channelId,
      connection,
      player,
      apiKey,
      model: rc.model,
      voice: rc.voice,
      turnDetection: rc.turnDetection,
      eagerness: rc.eagerness,
      noiseReduction: rc.noiseReduction,
      transcriptionModel: rc.transcriptionModel,
      deferredActionQueue,
    });

    // Connect to OpenAI Realtime API
    await realtimeSession.connect();

    return {
      mode: "realtime",
      guildId,
      channelId,
      channelName,
      connection,
      player,
      realtimeSession,
      deferredActionQueue,
      connectedSince: Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // User subscription
  // -------------------------------------------------------------------------

  /** Subscribe to users already in the voice channel */
  private subscribeExistingUsers(
    session: VoiceSession,
    channel: VoiceChannel | StageChannel,
  ): void {
    const members = channel.members as Map<string, GuildMember> | undefined;
    if (!members) return;

    for (const [memberId, member] of members) {
      if (member.user.bot) continue;

      if (session.mode === "sidecar") {
        session.receiver.subscribeUser(memberId);
      }
      // Realtime mode: users are subscribed via the speaking event listener
    }
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  /** Set up connection state change listeners */
  private setupConnectionListeners(
    guildId: string,
    connection: VoiceConnection,
    channelName: string,
    guildName: string,
  ): void {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log(`[voice:manager] Disconnected from ${channelName} in ${guildName}`);
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroySession(guildId);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.sessions.delete(guildId);
    });
  }

  /**
   * Listen for voice state changes (users joining/leaving the channel).
   * In realtime mode, pipe Opus packets directly into the realtime session.
   */
  private setupVoiceStateListener(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (!session) return;

    session.connection.receiver.speaking.on("start", (userId: string) => {
      const member = this.client.guilds.cache.get(guildId)?.members.cache.get(userId);
      if (!member || member.user.bot) return;

      if (session.mode === "sidecar") {
        session.receiver.resubscribeUser(userId);
      } else {
        // Realtime mode: subscribe to this user's audio stream and pipe to OpenAI
        this.subscribeUserRealtime(guildId, userId);
      }
    });
  }

  /** Subscribe a user's Discord audio stream to the realtime session */
  private subscribeUserRealtime(guildId: string, userId: string): void {
    const session = this.sessions.get(guildId);
    if (!session || session.mode !== "realtime") return;

    const opusStream = session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterInactivity, duration: 1000 },
    });

    opusStream.on("data", (chunk: Buffer) => {
      session.realtimeSession.processDiscordAudio(chunk);
    });

    opusStream.on("end", () => {
      // Stream ended due to inactivity — will resubscribe on next speaking event
    });
  }

  // -------------------------------------------------------------------------
  // Sidecar-mode message handling
  // -------------------------------------------------------------------------

  /**
   * Called when a user utterance is transcribed (sidecar mode only).
   * Checks trigger conditions, then routes to Claude.
   */
  private async onUserSpoke(guildId: string, transcription: Transcription): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session || session.mode !== "sidecar") return;

    const guild = this.client.guilds.cache.get(guildId);
    const member = guild?.members.cache.get(transcription.userId);
    const displayName = member?.displayName ?? transcription.displayName ?? transcription.userId;
    transcription.displayName = displayName;

    console.log(`[voice:manager] ${displayName}: "${transcription.text}"`);

    const triggeredText = session.transcript.checkTrigger(transcription.text);
    if (triggeredText === null) {
      session.transcript.addUserUtterance(
        transcription.userId,
        displayName,
        transcription.text,
      );
      return;
    }

    session.transcript.addUserUtterance(
      transcription.userId,
      displayName,
      transcription.text,
    );

    if (session.speaker.isBusy) {
      session.speaker.stop();
    }

    try {
      await this.handleTranscription(guildId, triggeredText, transcription.userId, displayName);
    } catch (err) {
      console.error(`[voice:manager] Failed to handle transcription:`, err);
    }
  }

  /**
   * Send transcribed text to Claude via the main agent (sidecar mode).
   */
  private async handleTranscription(
    guildId: string,
    text: string,
    userId: string,
    displayName: string,
  ): Promise<string> {
    if (!this.messageHandler) return "";

    const channelKey = `voice:${guildId}`;

    const responsePromise = new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(channelKey);
        resolve("");
      }, 30_000);
      this.pendingReplies.set(channelKey, { resolve, timer });
    });

    const session = this.sessions.get(guildId);
    const contextPrompt =
      session?.mode === "sidecar" ? session.transcript.toSystemContext() : "";
    const fullPrompt = contextPrompt
      ? `[Voice call context]\n${contextPrompt}\n\n[Current speaker: ${displayName}]\n${text}`
      : `[Current speaker: ${displayName}]\n${text}`;

    this.messageHandler(fullPrompt, userId, displayName, channelKey).catch((err) => {
      console.error(`[voice:manager] Message handler error:`, err);
      const pending = this.pendingReplies.get(channelKey);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingReplies.delete(channelKey);
        pending.resolve("");
      }
    });

    return responsePromise;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Get status of a voice session.
   */
  async getStatus(guildId: string): Promise<VoiceSessionStatus | null> {
    const session = this.sessions.get(guildId);
    if (!session) return null;

    let sttOk: boolean;
    let ttsOk: boolean;

    if (session.mode === "sidecar") {
      [sttOk, ttsOk] = await Promise.all([
        checkSidecarHealth(this.config.stt.url),
        checkSidecarHealth(this.config.tts.url),
      ]);
    } else {
      // Realtime mode — STT/TTS are handled by OpenAI
      const connected = session.realtimeSession.isConnected;
      sttOk = connected;
      ttsOk = connected;
    }

    const guild = this.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(session.channelId) as VoiceChannel | undefined;
    const userCount = channel?.members?.filter((m) => !m.user.bot).size ?? 0;

    return {
      guildId,
      channelId: session.channelId,
      channelName: session.channelName,
      mode: session.mode,
      triggerMode: this.config.conversation.triggerMode,
      connectedSince: session.connectedSince,
      usersInChannel: userCount,
      transcriptLength: session.mode === "sidecar" ? session.transcript.length : 0,
      sttHealthy: sttOk,
      ttsHealthy: ttsOk,
    };
  }

  /** Set trigger mode for a guild's voice session (sidecar mode only) */
  setTriggerMode(guildId: string, mode: TriggerMode): boolean {
    const session = this.sessions.get(guildId);
    if (!session || session.mode !== "sidecar") return false;
    session.transcript.setTriggerMode(mode);
    this.config.conversation.triggerMode = mode;
    console.log(`[voice:manager] Trigger mode set to "${mode}" for ${guildId}`);
    return true;
  }

  /** Check if there's an active session in a guild */
  hasSession(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  // -------------------------------------------------------------------------
  // Alone detection
  // -------------------------------------------------------------------------

  /**
   * Check if the bot is alone in its voice channel.
   * If alone, start a 2-minute timer to auto-leave.
   * If someone joins back, cancel the timer.
   */
  private checkAloneInChannel(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (!session) return;

    const guild = this.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(session.channelId) as
      | VoiceChannel
      | StageChannel
      | undefined;
    if (!channel) return;

    const humanCount =
      channel.members?.filter((m: GuildMember) => !m.user.bot).size ?? 0;

    if (humanCount === 0) {
      // Alone — start timer if not already running
      if (!session.aloneTimer) {
        console.log(
          `[voice:manager] Alone in #${session.channelName} — will leave in ${ALONE_TIMEOUT_MS / 1000}s`,
        );
        session.aloneTimer = setTimeout(() => {
          // Re-check in case someone joined between timer start and fire
          const ch = guild?.channels.cache.get(session.channelId) as
            | VoiceChannel
            | StageChannel
            | undefined;
          const stillAlone =
            (ch?.members?.filter((m: GuildMember) => !m.user.bot).size ?? 0) === 0;
          if (stillAlone && this.sessions.has(guildId)) {
            console.log(
              `[voice:manager] Still alone in #${session.channelName} after ${ALONE_TIMEOUT_MS / 1000}s — leaving`,
            );
            this.leave(guildId);
          }
        }, ALONE_TIMEOUT_MS);
      }
    } else {
      // Not alone — cancel timer if running
      if (session.aloneTimer) {
        console.log(
          `[voice:manager] No longer alone in #${session.channelName} — cancelling leave timer`,
        );
        clearTimeout(session.aloneTimer);
        session.aloneTimer = undefined;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Clean up a voice session */
  private destroySession(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (!session) return;

    // Clear alone timer if active
    if (session.aloneTimer) {
      clearTimeout(session.aloneTimer);
      session.aloneTimer = undefined;
    }

    if (session.mode === "sidecar") {
      session.receiver.destroy();
      session.speaker.stop();
    } else {
      session.realtimeSession.close();

      // Drain deferred action queue and process items
      this.processDeferredActions(session.deferredActionQueue);
    }

    session.player.stop(true);

    try {
      session.connection.destroy();
    } catch {
      // Connection may already be destroyed
    }

    this.sessions.delete(guildId);

    if (this.sessions.size === 0) {
      this.sidecar.stopHealthMonitor();
    }
  }

  /**
   * Process deferred actions from a completed voice session.
   * Drains the queue and passes items to MeetingAnalysisService for
   * merging with transcript-based analysis, or creates tasks directly.
   */
  private processDeferredActions(queue: DeferredActionQueue): void {
    const actions = queue.drain();
    if (actions.length === 0) return;

    const meetingId = queue.getMeetingId();
    console.log(
      `[voice:manager] Processing ${actions.length} deferred action(s) from meeting ${meetingId ?? "no-meeting"}`,
    );

    // Fire-and-forget: merge with meeting analysis or create standalone tasks
    if (meetingId) {
      // Meeting exists — merge deferred items with post-hoc analysis
      void this.meetingAnalysis.analyzeWithDeferred(meetingId, actions).catch((err) => {
        console.error(
          `[voice:manager] Failed to process deferred actions with meeting analysis:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    } else {
      // No meeting ID — create tasks/inbox items directly from deferred actions
      void this.meetingAnalysis.createTasksFromDeferred(actions).catch((err) => {
        console.error(
          `[voice:manager] Failed to create tasks from deferred actions:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  /** Clean up all sessions and sidecar (e.g., on shutdown) */
  destroyAll(): void {
    for (const guildId of this.sessions.keys()) {
      this.destroySession(guildId);
    }
    this.sidecar.shutdown();
  }
}
