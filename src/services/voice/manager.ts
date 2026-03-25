/**
 * Voice Session Manager — orchestrates Discord voice ↔ STT ↔ Claude ↔ TTS
 *
 * Manages the lifecycle of voice sessions: joining/leaving channels,
 * routing transcribed speech to Claude, and playing back TTS responses.
 *
 * One session per guild. Each session has:
 * - A VoiceConnection (discord.js/voice)
 * - A VoiceReceiver (per-user audio → STT)
 * - A VoiceSpeaker (TTS → audio playback)
 * - A VoiceTranscript (conversation context)
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import type { Client, VoiceChannel, StageChannel, GuildMember } from "discord.js";
import type { VoiceConfig, VoiceSessionStatus, Transcription, TriggerMode } from "./types.js";
import { VoiceReceiver } from "./receiver.js";
import { VoiceSpeaker } from "./speaker.js";
import { VoiceTranscript } from "./transcript.js";
import { loadVoiceConfig } from "./config.js";

/** Active voice session for a guild */
interface VoiceSession {
  guildId: string;
  channelId: string;
  channelName: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  receiver: VoiceReceiver;
  speaker: VoiceSpeaker;
  transcript: VoiceTranscript;
  connectedSince: number;
  /** Callback to send message to Claude */
  onMessage: (text: string, userId: string, displayName: string) => Promise<string>;
}

/** Check if STT service is healthy */
async function checkSidecarHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const data = await response.json() as { status: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

/**
 * VoiceManager — singleton that manages voice sessions across guilds.
 */
export class VoiceManager {
  private sessions = new Map<string, VoiceSession>();
  private client: Client;
  private config: VoiceConfig;
  private messageHandler: ((text: string, userId: string, displayName: string, channelId: string) => Promise<string>) | null = null;

  constructor(client: Client) {
    this.client = client;
    this.config = loadVoiceConfig();
  }

  /** Set the handler that routes voice transcriptions to Claude */
  setMessageHandler(handler: (text: string, userId: string, displayName: string, channelId: string) => Promise<string>): void {
    this.messageHandler = handler;
  }

  /** Check if voice is enabled in config */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

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

    // Verify sidecar services are running
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

    // Resolve channel
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      return `Guild ${guildId} not found.`;
    }

    const channel = guild.channels.cache.get(channelId) as VoiceChannel | StageChannel | undefined;
    if (!channel || !("joinable" in channel)) {
      return `Channel ${channelId} is not a voice channel.`;
    }

    try {
      // Join the voice channel
      const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false, // Need to hear users
        selfMute: false,
      });

      // Wait for connection to be ready
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

      // Create audio player for TTS playback
      const player = createAudioPlayer();
      connection.subscribe(player);

      // Create transcript
      const transcript = new VoiceTranscript(
        this.config.conversation.maxContextExchanges,
        this.config.conversation.triggerMode,
        this.config.conversation.triggerWords,
      );

      // Create speaker (TTS → playback)
      const speaker = new VoiceSpeaker(this.config, player, connection);

      // Build session
      const session: VoiceSession = {
        guildId,
        channelId,
        channelName: channel.name,
        connection,
        player,
        receiver: null as unknown as VoiceReceiver, // Set below after session is created
        speaker,
        transcript,
        connectedSince: Date.now(),
        onMessage: async (text, userId, displayName) => {
          return this.handleTranscription(guildId, text, userId, displayName);
        },
      };

      // Create receiver (audio → STT) with transcription callback
      const receiver = new VoiceReceiver(connection, this.config, (t: Transcription) => {
        this.onUserSpoke(guildId, t);
      });
      session.receiver = receiver;

      // Store session
      this.sessions.set(guildId, session);

      // Subscribe to users already in the channel
      const members = channel.members as Map<string, GuildMember> | undefined;
      if (members) {
        for (const [memberId, member] of members) {
          if (!member.user.bot) {
            receiver.subscribeUser(memberId);
          }
        }
      }

      // Handle connection state changes
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.log(`[voice:manager] Disconnected from ${channel.name} in ${guild.name}`);
        try {
          // Try to reconnect
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          // Reconnecting...
        } catch {
          // Can't reconnect — clean up
          this.destroySession(guildId);
        }
      });

      connection.on(VoiceConnectionStatus.Destroyed, () => {
        this.sessions.delete(guildId);
      });

      // Listen for voice state updates (users joining/leaving)
      this.setupVoiceStateListener(guildId);

      console.log(`[voice:manager] Connected to #${channel.name} in ${guild.name}`);
      return null; // Success
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

  /**
   * Get status of a voice session.
   */
  async getStatus(guildId: string): Promise<VoiceSessionStatus | null> {
    const session = this.sessions.get(guildId);
    if (!session) return null;

    const [sttOk, ttsOk] = await Promise.all([
      checkSidecarHealth(this.config.stt.url),
      checkSidecarHealth(this.config.tts.url),
    ]);

    // Count non-bot users in channel
    const guild = this.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(session.channelId) as VoiceChannel | undefined;
    const userCount = channel?.members?.filter(m => !m.user.bot).size ?? 0;

    return {
      guildId,
      channelId: session.channelId,
      channelName: session.channelName,
      triggerMode: this.config.conversation.triggerMode,
      connectedSince: session.connectedSince,
      usersInChannel: userCount,
      transcriptLength: session.transcript.length,
      sttHealthy: sttOk,
      ttsHealthy: ttsOk,
    };
  }

  /** Set trigger mode for a guild's voice session */
  setTriggerMode(guildId: string, mode: TriggerMode): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    session.transcript.setTriggerMode(mode);
    this.config.conversation.triggerMode = mode;
    console.log(`[voice:manager] Trigger mode set to "${mode}" for ${guildId}`);
    return true;
  }

  /** Check if there's an active session in a guild */
  hasSession(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  /**
   * Called when a user utterance is transcribed.
   * Checks trigger conditions, then routes to Claude.
   */
  private async onUserSpoke(guildId: string, transcription: Transcription): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) return;

    // Look up display name from guild member
    const guild = this.client.guilds.cache.get(guildId);
    const member = guild?.members.cache.get(transcription.userId);
    const displayName = member?.displayName ?? transcription.displayName ?? transcription.userId;
    transcription.displayName = displayName;

    console.log(`[voice:manager] ${displayName}: "${transcription.text}"`);

    // Check trigger
    const triggeredText = session.transcript.checkTrigger(transcription.text);
    if (triggeredText === null) {
      // No trigger — just add to transcript for context but don't respond
      session.transcript.addUserUtterance(transcription.userId, displayName, transcription.text);
      return;
    }

    // Add to transcript
    session.transcript.addUserUtterance(transcription.userId, displayName, transcription.text);

    // If user speaks while Lobs is speaking, interrupt
    if (session.speaker.isBusy) {
      session.speaker.stop();
    }

    // Route to Claude via the message handler
    try {
      const response = await this.handleTranscription(guildId, triggeredText, transcription.userId, displayName);
      if (response) {
        session.transcript.addAssistantResponse(response);
      }
    } catch (err) {
      console.error(`[voice:manager] Failed to handle transcription:`, err);
    }
  }

  /**
   * Send transcribed text to Claude and stream the response through TTS.
   */
  private async handleTranscription(guildId: string, text: string, userId: string, displayName: string): Promise<string> {
    const session = this.sessions.get(guildId);
    if (!session || !this.messageHandler) return "";

    // Build context-enriched prompt
    const contextPrompt = session.transcript.toSystemContext();
    const fullPrompt = `[Voice call context]\n${contextPrompt}\n\n[Current speaker: ${displayName}]\n${text}`;

    // Send to Claude via the main agent message handler
    const response = await this.messageHandler(fullPrompt, userId, displayName, `voice:${guildId}`);

    // Feed response through TTS → playback
    if (response) {
      await session.speaker.feedText(response);
      await session.speaker.flush();
    }

    return response;
  }

  /**
   * Listen for voice state changes (users joining/leaving the channel).
   */
  private setupVoiceStateListener(guildId: string): void {
    // This is a simplified approach — ideally we'd use the client's voiceStateUpdate event
    // For now, the receiver subscribes to users it hears from (lazy subscription)
    // The connection.receiver auto-creates streams when users speak

    const session = this.sessions.get(guildId);
    if (!session) return;

    // discord.js/voice automatically handles user audio subscriptions
    // when VoiceConnection.receiver is accessed. We subscribe to speaking events.
    session.connection.receiver.speaking.on("start", (userId: string) => {
      if (!session.receiver) return;
      // Auto-subscribe to any user who starts speaking
      const member = this.client.guilds.cache.get(guildId)?.members.cache.get(userId);
      if (member && !member.user.bot) {
        session.receiver.subscribeUser(userId);
      }
    });
  }

  /**
   * Clean up a voice session.
   */
  private destroySession(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (!session) return;

    session.receiver.destroy();
    session.speaker.stop();
    session.player.stop(true);

    try {
      session.connection.destroy();
    } catch {
      // Connection may already be destroyed
    }

    this.sessions.delete(guildId);
  }

  /** Clean up all sessions (e.g., on shutdown) */
  destroyAll(): void {
    for (const guildId of this.sessions.keys()) {
      this.destroySession(guildId);
    }
  }
}
