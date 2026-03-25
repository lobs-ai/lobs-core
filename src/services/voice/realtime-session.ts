/**
 * Realtime Voice Session — bridges Discord audio ↔ OpenAI Realtime API
 *
 * Uses the OpenAI Agents Realtime SDK to establish a WebSocket connection
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
} from "@openai/agents/realtime";
import type {
  RealtimeSessionConfig,
  TransportLayerAudio,
  TransportError,
} from "@openai/agents/realtime";
import type { VoiceConnection, AudioPlayer } from "@discordjs/voice";
import { createAudioResource, StreamType, AudioPlayerStatus } from "@discordjs/voice";
import { PassThrough } from "node:stream";
import opus from "@discordjs/opus";
import {
  realtimeVoiceTools,
  type RealtimeVoiceToolContext,
} from "./realtime-tools.js";
import { buildRealtimeInstructions } from "./realtime-context.js";
import { buildRealtimeSessionConfig } from "./realtime-config.js";

const { OpusEncoder } = opus;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord's native audio format */
const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;

/** OpenAI Realtime API audio format */
const REALTIME_SAMPLE_RATE = 24000;

const LOG_PREFIX = "[voice:realtime]";
const BACKGROUND_FOLLOW_UP_IDLE_MS = 1200;

interface PendingBackgroundResult {
  jobId: number;
  toolName: string;
  result: string;
  announce: boolean;
}

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
  /** Turn detection mode (default: semantic_vad) */
  turnDetection?: "semantic_vad" | "server_vad";
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
  private session: RealtimeSession<RealtimeVoiceToolContext> | null = null;
  private agent: RealtimeAgent<RealtimeVoiceToolContext> | null = null;
  private transport: OpenAIRealtimeWebSocket | null = null;
  private readonly connection: VoiceConnection;
  private readonly player: AudioPlayer;
  private readonly opusDecoder: InstanceType<typeof OpusEncoder>;
  private playbackStream: PassThrough | null = null;
  private playbackTurnSeq = 0;
  private currentPlaybackTurnId: number | null = null;
  private connected = false;
  private closing = false;
  private reconnecting = false;
  private readonly config: RealtimeVoiceSessionConfig;
  private connectStartedAt = 0;
  private lastUserTranscriptAt: number | null = null;
  private lastResponseCreatedAt: number | null = null;
  private lastAssistantTranscript:
    | { text: string; loggedAt: number }
    | null = null;
  private backgroundJobSeq = 0;
  private pendingBackgroundResults: PendingBackgroundResult[] = [];
  private backgroundFollowUpTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.connectStartedAt = Date.now();

    const model = this.config.model ?? "gpt-4o-realtime-preview";
    const voice = this.config.voice ?? "ash";
    const eagerness = this.config.eagerness ?? "medium";
    const turnDetection = this.config.turnDetection ?? "semantic_vad";
    const noiseReduction = this.config.noiseReduction ?? "near_field";
    const transcriptionModel =
      this.config.transcriptionModel ?? "gpt-4o-mini-transcribe";

    // Build instructions
    const instructions =
      this.config.instructions ?? (await buildRealtimeInstructions());

    console.log(
      `${LOG_PREFIX} Connecting to ${model} (voice=${voice}, turn_detection=${turnDetection}, eagerness=${eagerness})`,
    );
    console.log(
      `${LOG_PREFIX} Instructions loaded: ${instructions.length} chars, includes SOUL=${instructions.includes("SOUL.md")}, USER=${instructions.includes("USER.md")}, MEMORY=${instructions.includes("MEMORY.md")}`,
    );
    console.log(
      `${LOG_PREFIX} Tools loaded: ${realtimeVoiceTools.map((t) => t.name).join(", ")}`,
    );

    // Create the RealtimeAgent with voice-appropriate tools
    const agent = new RealtimeAgent<RealtimeVoiceToolContext>({
      name: "lobs-voice",
      instructions,
      tools: realtimeVoiceTools,
    });
    this.agent = agent;

    const sessionConfig: Partial<RealtimeSessionConfig> =
      buildRealtimeSessionConfig({
        voice,
        turnDetection,
        eagerness,
        noiseReduction,
        transcriptionModel,
      });

    // Create the session with the transport
    // useInsecureApiKey is required for server-side API keys (vs ephemeral client tokens)
    this.transport = new OpenAIRealtimeWebSocket({
      apiKey: this.config.apiKey,
      model,
      useInsecureApiKey: true,
    });

    const session = new RealtimeSession<RealtimeVoiceToolContext>(agent, {
      transport: this.transport,
      config: sessionConfig,
      apiKey: this.config.apiKey,
      context: {
        enqueueBackgroundToolResult: (job: {
          toolName: string;
          task: Promise<string>;
          startedAt: number;
        }) => {
          this.enqueueBackgroundToolResult(job);
        },
      },
    });
    this.session = session;

    // Wire up transport events
    this.setupTransportEvents();

    // Wire up session events
    this.setupSessionEvents();

    // Connect the session
    try {
      await session.connect({
        apiKey: this.config.apiKey,
      });
      this.connected = true;
      console.log(
        `${LOG_PREFIX} Connected to OpenAI Realtime API in ${Date.now() - this.connectStartedAt}ms`,
      );
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

      // Send to OpenAI Realtime API via the session (handles state checks)
      this.session?.sendAudio(arrayBuffer);
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
      if (chunk.length === 0) return;
      this.ensurePlaybackStream();
      const stereo48k = upsampleTo48kStereo(chunk);
      if (stereo48k.length === 0) return;
      const wrote = this.playbackStream?.write(stereo48k);
      if (wrote === false) {
        console.warn(`${LOG_PREFIX} Playback stream backpressure`);
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
   * End the current playback stream so Discord can finish the turn cleanly.
   */
  private onAudioDone(): void {
    this.endPlaybackStream("audio_done");
  }

  /**
   * Handle interruption — user started speaking while the assistant was talking.
   * Stop current Discord playback immediately.
   */
  private onAudioInterrupted(): void {
    console.log(`${LOG_PREFIX} Audio interrupted by user`);
    this.endPlaybackStream("interrupted");
    this.clearBackgroundFollowUpTimer();

    // Stop current Discord playback
    if (this.player.state.status === AudioPlayerStatus.Playing) {
      this.player.stop(true);
    }
  }

  private ensurePlaybackStream(): void {
    if (this.playbackStream) return;

    const turnId = ++this.playbackTurnSeq;
    const stream = new PassThrough();
    this.playbackStream = stream;
    this.currentPlaybackTurnId = turnId;

    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      metadata: { turnId },
    });

    console.log(`${LOG_PREFIX} Starting Discord playback turn=${turnId}`);
    this.player.play(resource);
  }

  private endPlaybackStream(reason: "audio_done" | "interrupted" | "close"): void {
    const stream = this.playbackStream;
    const turnId = this.currentPlaybackTurnId;
    this.playbackStream = null;
    this.currentPlaybackTurnId = null;
    if (!stream) return;

    console.log(
      `${LOG_PREFIX} Ending Discord playback turn=${turnId ?? "unknown"} reason=${reason}`,
    );
    stream.end();
    if (reason === "audio_done") {
      this.maybeScheduleBackgroundFollowUp();
    }
  }

  private clearBackgroundFollowUpTimer(): void {
    if (!this.backgroundFollowUpTimer) return;
    clearTimeout(this.backgroundFollowUpTimer);
    this.backgroundFollowUpTimer = null;
  }

  private injectBackgroundResultSilently(job: PendingBackgroundResult): void {
    if (!this.transport) return;

    this.transport.sendMessage(
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `Background tool result [${job.toolName}]${job.announce ? "" : " (silent only)"}:\n${job.result}\n\n` +
              "This is context only. Do not respond yet.",
          },
        ],
      },
      {},
      { triggerResponse: false },
    );
  }

  private maybeScheduleBackgroundFollowUp(): void {
    const hasAnnounceable = this.pendingBackgroundResults.some((r) => r.announce);
    if (!hasAnnounceable || !this.session || !this.transport || !this.connected || this.closing) {
      return;
    }
    if (this.playbackStream || this.player.state.status !== AudioPlayerStatus.Idle) {
      return;
    }
    this.clearBackgroundFollowUpTimer();
    this.backgroundFollowUpTimer = setTimeout(() => {
      this.backgroundFollowUpTimer = null;
      this.flushBackgroundFollowUpIfIdle();
    }, BACKGROUND_FOLLOW_UP_IDLE_MS);
  }

  private flushBackgroundFollowUpIfIdle(): void {
    if (!this.session || !this.transport || !this.connected || this.closing) return;
    if (this.playbackStream || this.player.state.status !== AudioPlayerStatus.Idle) {
      this.maybeScheduleBackgroundFollowUp();
      return;
    }
    if (
      this.lastUserTranscriptAt !== null &&
      Date.now() - this.lastUserTranscriptAt < BACKGROUND_FOLLOW_UP_IDLE_MS
    ) {
      this.maybeScheduleBackgroundFollowUp();
      return;
    }

    const announceable = this.pendingBackgroundResults.filter((r) => r.announce);
    if (announceable.length === 0) return;
    this.pendingBackgroundResults = this.pendingBackgroundResults.filter((r) => !r.announce);

    const summary = announceable
      .map((r) => `- ${r.toolName}: ${r.result.slice(0, 240)}`)
      .join("\n");

    this.transport.sendEvent({
      type: "response.create",
      response: {
        instructions:
          "One or more background tools finished. If the update materially helps the user right now, tell them in one short spoken update. " +
          "Do not call tools for this follow-up. Do not investigate tool failures unless the user explicitly asked you to debug the tooling itself. " +
          "If a tool failed, mention it briefly and move on.\n\n" +
          `Finished background results:\n${summary}`,
      },
    });
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
      if (event.type === "response.created") {
        this.lastResponseCreatedAt = Date.now();
        const latency =
          this.lastUserTranscriptAt === null
            ? "n/a"
            : `${this.lastResponseCreatedAt - this.lastUserTranscriptAt}ms`;
        console.log(`${LOG_PREFIX} Response created latency=${latency}`);
      }

      if (
        event.type ===
        "conversation.item.input_audio_transcription.completed"
      ) {
        const text = event.transcript?.trim();
        if (text) {
          this.clearBackgroundFollowUpTimer();
          this.lastUserTranscriptAt = Date.now();
          console.log(`${LOG_PREFIX} User: "${text}"`);
          this.onUserTranscript?.(text);
        }
      }
    });

    // Transport errors
    this.transport.on("error", (error: TransportError) => {
      let msg: string;
      if (error.error instanceof Error) {
        msg = error.error.message;
      } else if (typeof error.error === "object" && error.error !== null) {
        msg = JSON.stringify(error.error).slice(0, 500);
      } else {
        msg = String(error.error ?? "Unknown transport error");
      }
      console.error(`${LOG_PREFIX} Transport error: ${msg}`);
    });

    // Connection state changes — only source of reconnect triggers
    this.transport.on("connection_change", (status: string) => {
      console.log(`${LOG_PREFIX} Connection: ${status}`);
      if (status === "disconnected" && !this.closing && !this.reconnecting) {
        console.warn(`${LOG_PREFIX} Transport disconnected unexpectedly`);
        void this.handleDisconnect();
      }
    });
  }

  /** Wire up session-level events (agent handoffs, guardrails, etc.) */
  private setupSessionEvents(): void {
    if (!this.session) return;

    this.session.on("transport_event", (event) => {
      if (event.type === "session.created" || event.type === "session.updated") {
        const sessionData =
          "session" in event && typeof event.session === "object" && event.session
            ? (event.session as {
                tools?: Array<{ name?: string; type?: string }>;
                output_modalities?: string[];
              })
            : null;
        const tools = Array.isArray(sessionData?.tools) ? sessionData.tools : [];
        console.log(
          `${LOG_PREFIX} ${event.type} output_modalities=${JSON.stringify(sessionData?.output_modalities ?? [])} tools=${tools.map((t) => `${t.name ?? "unknown"}:${t.type ?? "unknown"}`).join(", ") || "none"}`,
        );
      }

      if (event.type === "function_call") {
        console.log(
          `${LOG_PREFIX} Raw function_call: ${event.name}(${String(event.arguments ?? "").slice(0, 200)})`,
        );
      }
    });

    // Log when the history is updated (gives us assistant transcripts)
    this.session.on("history_updated", (history) => {
      const last = history[history.length - 1];
      if (!last || last.type !== "message") return;
      if (!("role" in last) || last.role !== "assistant") return;

      const transcript = last.content
        .map((c) => ("transcript" in c ? c.transcript : null))
        .filter(Boolean)
        .join(" ")
        .trim();
      if (transcript) {
        if (
          this.lastAssistantTranscript &&
          this.lastAssistantTranscript.text === transcript &&
          Date.now() - this.lastAssistantTranscript.loggedAt < 1000
        ) {
          return;
        }
        this.lastAssistantTranscript = {
          text: transcript,
          loggedAt: Date.now(),
        };
        console.log(`${LOG_PREFIX} Assistant: "${transcript.slice(0, 200)}"`);
        this.onAssistantTranscript?.(transcript);
      }
    });

    // Tool call logging
    this.session.on("agent_tool_start", (_ctx, _agent, t, details) => {
      const args = "arguments" in details.toolCall ? String(details.toolCall.arguments).slice(0, 100) : "";
      console.log(`${LOG_PREFIX} Tool call: ${t.name}(${args})`);
    });

    this.session.on("agent_tool_end", (_ctx, _agent, t, result) => {
      console.log(`${LOG_PREFIX} Tool result [${t.name}]: ${result.slice(0, 200)}`);
    });

    this.session.on("audio_start", () => {
      const now = Date.now();
      const userToAudio =
        this.lastUserTranscriptAt === null
          ? "n/a"
          : `${now - this.lastUserTranscriptAt}ms`;
      const responseToAudio =
        this.lastResponseCreatedAt === null
          ? "n/a"
          : `${now - this.lastResponseCreatedAt}ms`;
      console.log(
        `${LOG_PREFIX} Audio start latency user_to_audio=${userToAudio} response_to_audio=${responseToAudio}`,
      );
    });

    this.player.on("stateChange", (oldState, newState) => {
      if (oldState.status === newState.status) return;
      console.log(
        `${LOG_PREFIX} Player state ${oldState.status} -> ${newState.status}`,
      );
      if (newState.status === AudioPlayerStatus.Idle) {
        this.maybeScheduleBackgroundFollowUp();
      } else {
        this.clearBackgroundFollowUpTimer();
      }
    });

    // Session-level errors
    this.session.on("error", (event) => {
      let msg: string;
      if (event.error instanceof Error) {
        msg = event.error.message;
      } else if (typeof event.error === "object" && event.error !== null) {
        msg = JSON.stringify(event.error).slice(0, 500);
      } else {
        msg = String(event.error ?? "Unknown session error");
      }
      console.error(`${LOG_PREFIX} Session error: ${msg}`);
    });
  }

  private enqueueBackgroundToolResult(job: {
    toolName: string;
    task: Promise<string>;
    startedAt: number;
  }): void {
    const jobId = ++this.backgroundJobSeq;
    console.log(`${LOG_PREFIX} Background tool #${jobId} queued: ${job.toolName}`);

    void job.task
      .then((result) => {
        const durationMs = Date.now() - job.startedAt;
        console.log(
          `${LOG_PREFIX} Background tool #${jobId} complete: ${job.toolName} duration_ms=${durationMs} result_len=${result.length}`,
        );

        if (!this.session || !this.connected || this.closing) {
          console.warn(
            `${LOG_PREFIX} Dropping background tool #${jobId} result because session is not active`,
          );
          return;
        }
        const lower = result.toLowerCase();
        const isFailure =
          lower.startsWith("failed") ||
          lower.includes(" error") ||
          lower.startsWith("file not found") ||
          lower.startsWith("memory search failed") ||
          lower.startsWith("read error");
        const pendingResult: PendingBackgroundResult = {
          jobId,
          toolName: job.toolName,
          result,
          announce:
            job.toolName === "spawn_agent" ||
            job.toolName === "write_note" ||
            !isFailure,
        };
        this.injectBackgroundResultSilently(pendingResult);
        this.pendingBackgroundResults.push(pendingResult);
        this.maybeScheduleBackgroundFollowUp();
      })
      .catch((err) => {
        console.error(
          `${LOG_PREFIX} Background tool #${jobId} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  /** Handle an unexpected disconnect — try to reconnect once */
  private async handleDisconnect(): Promise<void> {
    if (this.closing || this.reconnecting) return;
    this.reconnecting = true;

    console.warn(`${LOG_PREFIX} Attempting reconnection...`);
    this.connected = false;

    // Clean up old resources
    this.cleanup();

    // Wait briefly before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (this.closing) return;

    try {
      await this.connect();
      this.reconnecting = false;
      console.log(`${LOG_PREFIX} Reconnected successfully`);
    } catch (err) {
      this.reconnecting = false;
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
    this.clearBackgroundFollowUpTimer();

    console.log(`${LOG_PREFIX} Closing session`);

    // Stop Discord playback
    if (this.player.state.status === AudioPlayerStatus.Playing) {
      this.player.stop(true);
    }

    this.endPlaybackStream("close");

    this.cleanup();
    console.log(`${LOG_PREFIX} Session closed`);
  }

  /** Clean up transport and session references */
  private cleanup(): void {
    this.clearBackgroundFollowUpTimer();
    this.pendingBackgroundResults = [];
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
