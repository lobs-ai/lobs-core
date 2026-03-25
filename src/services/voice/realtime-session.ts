/**
 * Realtime Voice Session — bridges Discord audio ↔ OpenAI Realtime API
 *
 * Uses the @openai/agents-realtime SDK to establish a WebSocket connection
 * to OpenAI's Realtime API, enabling speech-to-speech conversation without
 * local STT/TTS services.
 *
 * Audio pipeline:
 *   Input:  Discord Opus → PCM 48kHz stereo → 24kHz mono → OpenAI Realtime
 *   Output: OpenAI Realtime 24kHz mono → 48kHz stereo PCM → Discord AudioPlayer
 */

import {
  RealtimeAgent,
  RealtimeSession,
  OpenAIRealtimeWebSocket,
} from "@openai/agents-realtime";
import type {
  RealtimeSessionConfig,
  TransportLayerAudio,
  TransportError,
} from "@openai/agents-realtime";
import type { VoiceConnection, AudioPlayer } from "@discordjs/voice";
import { createAudioResource, StreamType, AudioPlayerStatus } from "@discordjs/voice";
import { Readable } from "node:stream";
import opus from "@discordjs/opus";
import { realtimeVoiceTools } from "./realtime-tools.js";
import { buildRealtimeInstructions } from "./realtime-context.js";

const { OpusEncoder } = opus;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord's native audio format */
const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;

/** OpenAI Realtime API audio format */
const REALTIME_SAMPLE_RATE = 24000;

/** Minimum bytes to buffer before flushing to Discord (~100ms of 24kHz mono PCM16) */
const MIN_FLUSH_BYTES = REALTIME_SAMPLE_RATE * 2 * 0.1;

/** Maximum audio buffer size before forced flush (~10s of audio) */
const MAX_BUFFER_BYTES = REALTIME_SAMPLE_RATE * 2 * 10;

const LOG_PREFIX = "[voice:realtime]";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RealtimeVoiceSessionConfig {
  /** Discord guild (server) ID */
  guildId: string;
  /** Discord voice channel ID */
  channelId: string;
  /** Active Discord voice connection */
  connection: VoiceConnection;
  /** Discord audio player for outbound audio */
  player: AudioPlayer;
  /** OpenAI API key */
  apiKey: string;
  /** OpenAI Realtime model (default: gpt-4o-realtime-preview) */
  model?: string;
  /** Voice for TTS output (default: ash) */
  voice?: string;
  /** System prompt / instructions override (built automatically if omitted) */
  instructions?: string;
  /** Turn detection eagerness (default: medium) */
  eagerness?: "low" | "medium" | "high" | "auto";
  /** Noise reduction mode (default: near_field) */
  noiseReduction?: "near_field" | "far_field" | null;
  /** Transcription model (default: gpt-4o-mini-transcribe) */
  transcriptionModel?: string;
}

// ---------------------------------------------------------------------------
// Audio resampling helpers
// ---------------------------------------------------------------------------

/**
 * Downsample 48kHz stereo PCM16 → 24kHz mono PCM16.
 * Factor: 48000/24000 = 2. Average L+R, take every 2nd sample pair.
 */
function downsampleTo24kMono(stereo48k: Buffer): Buffer {
  const bytesPerStereoPair = 4; // 2 bytes L + 2 bytes R
  const srcPairs = Math.floor(stereo48k.length / bytesPerStereoPair);
  // Factor-of-2 decimation
  const dstSamples = Math.floor(srcPairs / 2);
  const mono = Buffer.alloc(dstSamples * 2);

  for (let i = 0; i < dstSamples; i++) {
    const srcIdx = i * 2; // take every 2nd stereo pair
    const byteOffset = srcIdx * bytesPerStereoPair;
    if (byteOffset + 3 >= stereo48k.length) break;

    const left = stereo48k.readInt16LE(byteOffset);
    const right = stereo48k.readInt16LE(byteOffset + 2);
    const sample = Math.round((left + right) / 2);
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return mono;
}

/**
 * Upsample 24kHz mono PCM16 → 48kHz stereo PCM16.
 * Factor: 24000→48000 = 2x samples, mono→stereo = duplicate channels.
 * Uses simple sample-and-hold (each sample repeated twice, both channels).
 */
function upsampleTo48kStereo(mono24k: Buffer): Buffer {
  const srcSamples = Math.floor(mono24k.length / 2);
  // Each input sample produces 2 output stereo frames (4 bytes each = 8 bytes)
  const dst = Buffer.alloc(srcSamples * 2 * 4);

  for (let i = 0; i < srcSamples; i++) {
    const sample = mono24k.readInt16LE(i * 2);
    // Write 2 stereo frames per input sample
    for (let j = 0; j < 2; j++) {
      const outOffset = (i * 2 + j) * 4;
      dst.writeInt16LE(sample, outOffset); // Left channel
      dst.writeInt16LE(sample, outOffset + 2); // Right channel
    }
  }

  return dst;
}

// ---------------------------------------------------------------------------
// RealtimeVoiceSession
// ---------------------------------------------------------------------------

export class RealtimeVoiceSession {
  private session: RealtimeSession | null = null;
  private agent: RealtimeAgent | null = null;
  private transport: OpenAIRealtimeWebSocket | null = null;
  private readonly connection: VoiceConnection;
  private readonly player: AudioPlayer;
  private readonly opusDecoder: InstanceType<typeof OpusEncoder>;
  private audioOutBuffer: Buffer[] = [];
  private audioOutBytes = 0;
  private connected = false;
  private closing = false;
  private readonly config: RealtimeVoiceSessionConfig;

  /** Callback invoked when we get a user transcript (for logging/display) */
  onUserTranscript?: (text: string) => void;
  /** Callback invoked when we get an assistant transcript */
  onAssistantTranscript?: (text: string) => void;

  constructor(config: RealtimeVoiceSessionConfig) {
    this.config = config;
    this.connection = config.connection;
    this.player = config.player;

    // Opus decoder for incoming Discord audio (48kHz stereo)
    this.opusDecoder = new OpusEncoder(DISCORD_SAMPLE_RATE, DISCORD_CHANNELS);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to OpenAI Realtime API and start the session.
   * Builds the system prompt, creates the agent and transport, then connects.
   */
  async connect(): Promise<void> {
    if (this.connected || this.closing) return;

    const model = this.config.model ?? "gpt-4o-realtime-preview";
    const voice = this.config.voice ?? "ash";
    const eagerness = this.config.eagerness ?? "medium";
    const noiseReduction = this.config.noiseReduction ?? "near_field";
    const transcriptionModel =
      this.config.transcriptionModel ?? "gpt-4o-mini-transcribe";

    // Build instructions
    const instructions =
      this.config.instructions ?? (await buildRealtimeInstructions());

    console.log(
      `${LOG_PREFIX} Connecting to ${model} (voice=${voice}, eagerness=${eagerness})`,
    );

    // Create the RealtimeAgent with voice-appropriate tools
    this.agent = new RealtimeAgent({
      name: "lobs-voice",
      instructions,
      tools: realtimeVoiceTools,
    });

    // Session configuration
    const sessionConfig: Partial<RealtimeSessionConfig> = {
      audio: {
        input: {
          format: {
            type: "audio/pcm" as const,
            rate: REALTIME_SAMPLE_RATE,
          },
          turnDetection: {
            type: "semantic_vad" as const,
            eagerness,
            interruptResponse: true,
          },
          transcription: { model: transcriptionModel },
          noiseReduction: noiseReduction
            ? { type: noiseReduction }
            : undefined,
        },
        output: {
          format: {
            type: "audio/pcm" as const,
            rate: REALTIME_SAMPLE_RATE,
          },
          voice,
        },
      },
      outputModalities: ["text", "audio"],
    };

    // Create the session with the transport
    this.transport = new OpenAIRealtimeWebSocket({
      apiKey: this.config.apiKey,
      model,
    });

    this.session = new RealtimeSession(this.agent, {
      transport: this.transport,
      config: sessionConfig,
      apiKey: this.config.apiKey,
    });

    // Wire up transport events
    this.setupTransportEvents();

    // Wire up session events
    this.setupSessionEvents();

    // Connect the session
    try {
      await this.session.connect({
        apiKey: this.config.apiKey,
      });
      this.connected = true;
      console.log(`${LOG_PREFIX} Connected to OpenAI Realtime API`);
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Connection failed:`,
        err instanceof Error ? err.message : String(err),
      );
      this.cleanup();
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Inbound audio (Discord → OpenAI)
  // -------------------------------------------------------------------------

  /**
   * Process an incoming Opus packet from a Discord user.
   * Decodes Opus → PCM, resamples to 24kHz mono, sends to OpenAI.
   */
  processDiscordAudio(opusPacket: Buffer): void {
    if (!this.connected || !this.transport || this.closing) return;

    try {
      // Decode Opus → PCM 48kHz stereo s16le
      const pcm48kStereo = this.opusDecoder.decode(opusPacket);

      // Resample 48kHz stereo → 24kHz mono
      const pcm24kMono = downsampleTo24kMono(pcm48kStereo);

      if (pcm24kMono.length === 0) return;

      // Convert Node Buffer → ArrayBuffer for the SDK
      const arrayBuffer = pcm24kMono.buffer.slice(
        pcm24kMono.byteOffset,
        pcm24kMono.byteOffset + pcm24kMono.byteLength,
      ) as ArrayBuffer;

      // Send to OpenAI Realtime API
      this.transport.sendAudio(arrayBuffer, { commit: false });
    } catch {
      // Don't log audio decode errors — they happen naturally
      // during silence, user join/leave, or codec transitions
    }
  }

  // -------------------------------------------------------------------------
  // Outbound audio (OpenAI → Discord)
  // -------------------------------------------------------------------------

  /**
   * Handle audio chunk received from OpenAI Realtime API.
   * Buffers chunks and flushes to Discord player when complete.
   */
  private onAudioReceived(event: TransportLayerAudio): void {
    if (this.closing) return;

    try {
      const chunk = Buffer.from(event.data);
      this.audioOutBuffer.push(chunk);
      this.audioOutBytes += chunk.length;

      // Auto-flush if buffer gets large (prevents unbounded memory use)
      if (this.audioOutBytes >= MAX_BUFFER_BYTES) {
        this.flushAudioToDiscord();
      }
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} Audio output buffer error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Handle audio_done — OpenAI finished generating this response's audio.
   * Flush any remaining buffered audio to Discord.
   */
  private onAudioDone(): void {
    this.flushAudioToDiscord();
  }

  /**
   * Flush buffered 24kHz mono PCM to Discord as 48kHz stereo PCM.
   * Creates an AudioResource and plays it through the player.
   */
  private flushAudioToDiscord(): void {
    if (
      this.audioOutBuffer.length === 0 ||
      this.audioOutBytes < MIN_FLUSH_BYTES
    ) {
      return;
    }

    try {
      // Concatenate buffered chunks
      const mono24k = Buffer.concat(this.audioOutBuffer);
      this.audioOutBuffer = [];
      this.audioOutBytes = 0;

      // Upsample to Discord's expected format
      const stereo48k = upsampleTo48kStereo(mono24k);

      if (stereo48k.length === 0) return;

      // Create a readable stream from the PCM buffer
      const pcmBuffer = stereo48k;
      const stream = new Readable({
        read() {
          this.push(pcmBuffer);
          this.push(null);
        },
      });

      // Create an AudioResource from raw s16le 48kHz stereo PCM
      const resource = createAudioResource(stream, {
        inputType: StreamType.Raw,
      });

      // Play through Discord
      this.player.play(resource);
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} Audio flush error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Handle interruption — user started speaking while the assistant was talking.
   * Stop current Discord playback immediately.
   */
  private onAudioInterrupted(): void {
    console.log(`${LOG_PREFIX} Audio interrupted by user`);

    // Clear pending audio buffer
    this.audioOutBuffer = [];
    this.audioOutBytes = 0;

    // Stop current Discord playback
    if (this.player.state.status === AudioPlayerStatus.Playing) {
      this.player.stop(true);
    }
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  /** Wire up transport-level events (audio, interruption, errors) */
  private setupTransportEvents(): void {
    if (!this.transport) return;

    // Audio output from OpenAI
    this.transport.on("audio", (event: TransportLayerAudio) => {
      this.onAudioReceived(event);
    });

    // Audio generation complete
    this.transport.on("audio_done", () => {
      this.onAudioDone();
    });

    // User interrupted
    this.transport.on("audio_interrupted", () => {
      this.onAudioInterrupted();
    });

    // Catch-all for transport events — used for transcription events
    this.transport.on("*", (event: { type?: string; transcript?: string }) => {
      if (
        event.type ===
        "conversation.item.input_audio_transcription.completed"
      ) {
        const text = event.transcript?.trim();
        if (text) {
          console.log(`${LOG_PREFIX} User: "${text}"`);
          this.onUserTranscript?.(text);
        }
      }
    });

    // Transport errors
    this.transport.on("error", (error: TransportError) => {
      const msg =
        error.error instanceof Error
          ? error.error.message
          : String(error.error ?? "Unknown transport error");
      console.error(`${LOG_PREFIX} Transport error: ${msg}`);

      // If the connection dropped, attempt to reconnect
      if (!this.closing) {
        void this.handleDisconnect();
      }
    });

    // Transport closed
    this.transport.on("closed", () => {
      if (!this.closing) {
        console.warn(`${LOG_PREFIX} Transport closed unexpectedly`);
        void this.handleDisconnect();
      }
    });
  }

  /** Wire up session-level events (agent handoffs, guardrails, etc.) */
  private setupSessionEvents(): void {
    if (!this.session) return;

    // Log when the history is updated (gives us assistant transcripts)
    this.session.on("history_updated", (history: unknown[]) => {
      // The last item may contain the assistant's text transcript
      const last = history[history.length - 1] as
        | { role?: string; type?: string; content?: Array<{ transcript?: string }> }
        | undefined;
      if (last?.role === "assistant" && last.content) {
        const transcript = last.content
          .map((c) => c.transcript)
          .filter(Boolean)
          .join(" ")
          .trim();
        if (transcript) {
          console.log(`${LOG_PREFIX} Assistant: "${transcript.slice(0, 200)}"`);
          this.onAssistantTranscript?.(transcript);
        }
      }
    });

    // Session-level errors
    this.session.on("error", (event: unknown) => {
      const e = event as { error?: Error; message?: string };
      const msg =
        e.error?.message ?? e.message ?? "Unknown session error";
      console.error(`${LOG_PREFIX} Session error: ${msg}`);
    });
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  /** Handle an unexpected disconnect — try to reconnect once */
  private async handleDisconnect(): Promise<void> {
    if (this.closing) return;

    console.warn(`${LOG_PREFIX} Attempting reconnection...`);
    this.connected = false;

    // Clean up old resources
    this.cleanup();

    // Wait briefly before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (this.closing) return;

    try {
      await this.connect();
      console.log(`${LOG_PREFIX} Reconnected successfully`);
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Reconnection failed:`,
        err instanceof Error ? err.message : String(err),
      );
      // Don't retry further — let the caller handle recovery
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Disconnect and clean up all resources */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.connected = false;

    console.log(`${LOG_PREFIX} Closing session`);

    // Stop Discord playback
    if (this.player.state.status === AudioPlayerStatus.Playing) {
      this.player.stop(true);
    }

    // Clear audio buffer
    this.audioOutBuffer = [];
    this.audioOutBytes = 0;

    this.cleanup();
    console.log(`${LOG_PREFIX} Session closed`);
  }

  /** Clean up transport and session references */
  private cleanup(): void {
    // Close session
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // Ignore close errors
      }
      this.session = null;
    }

    // Close transport
    if (this.transport) {
      try {
        this.transport.close();
      } catch {
        // Ignore close errors
      }
      this.transport = null;
    }

    this.agent = null;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Whether the session is currently connected to OpenAI Realtime API */
  get isConnected(): boolean {
    return this.connected;
  }

  /** The guild ID this session is associated with */
  get guildId(): string {
    return this.config.guildId;
  }

  /** The channel ID this session is associated with */
  get channelId(): string {
    return this.config.channelId;
  }
}
