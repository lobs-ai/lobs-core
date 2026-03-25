/**
 * Voice Receiver — per-user audio pipeline: Discord Opus → PCM → VAD → STT
 *
 * Subscribes to individual user audio streams from the Discord voice connection,
 * decodes Opus to PCM, runs VAD, buffers speech segments, and sends completed
 * segments to whisper.cpp for transcription.
 */

import type { VoiceConnection } from "@discordjs/voice";
import { EndBehaviorType } from "@discordjs/voice";
import { OpusEncoder } from "@discordjs/opus";
import type { VoiceConfig, Transcription } from "./types.js";
import { VADProcessor } from "./vad.js";

/** Discord voice audio: 48kHz, stereo, 16-bit, 20ms frames */
const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const _DISCORD_FRAME_MS = 20;

/** whisper.cpp expects: 16kHz, mono, 16-bit PCM */
const WHISPER_SAMPLE_RATE = 16000;

/** Max buffer size before force-flushing (~30s at 16kHz mono 16-bit) */
const MAX_BUFFER_BYTES = WHISPER_SAMPLE_RATE * 2 * 30;

/** Min speech duration to bother transcribing (ms) */
const MIN_SPEECH_MS = 300;

/**
 * Per-user audio receiver. One instance per user speaking in the channel.
 */
class UserReceiver {
  readonly userId: string;
  private opus: OpusEncoder;
  private vad: VADProcessor;
  private audioBuffer: Buffer[] = [];
  private bufferByteCount = 0;
  private speechStartTime = 0;
  private onTranscription: (t: Transcription) => void;
  private config: VoiceConfig;
  private destroyed = false;

  constructor(
    userId: string,
    config: VoiceConfig,
    onTranscription: (t: Transcription) => void,
  ) {
    this.userId = userId;
    this.config = config;
    this.onTranscription = onTranscription;

    // Opus decoder: 48kHz stereo (Discord's format)
    this.opus = new OpusEncoder(DISCORD_SAMPLE_RATE, DISCORD_CHANNELS);

    // VAD with config thresholds
    this.vad = new VADProcessor({
      silenceThresholdMs: config.vad.silenceThresholdMs,
      energyThreshold: config.vad.energyThreshold,
    });

    this.vad.onSpeechStart = () => {
      this.speechStartTime = Date.now();
    };

    this.vad.onSpeechEnd = (durationMs: number) => {
      if (durationMs >= MIN_SPEECH_MS) {
        this.flushBuffer();
      } else {
        // Too short — discard (probably a cough or click)
        this.clearBuffer();
      }
    };
  }

  /**
   * Process an incoming Opus packet from Discord.
   */
  processOpus(opusPacket: Buffer): void {
    if (this.destroyed) return;

    try {
      // Decode Opus → PCM (48kHz stereo int16)
      const pcmStereo = this.opus.decode(opusPacket);

      // Downsample: 48kHz stereo → 16kHz mono
      const pcmMono = downsampleToMono16k(pcmStereo);

      // Run VAD on the downsampled audio
      const isSpeech = this.vad.process(pcmMono);

      // Buffer if speech is active
      if (isSpeech || this.vad.isSpeaking) {
        this.audioBuffer.push(pcmMono);
        this.bufferByteCount += pcmMono.length;

        // Force-flush if buffer gets too large (prevents unbounded memory growth)
        if (this.bufferByteCount >= MAX_BUFFER_BYTES) {
          console.warn(`[voice:receiver] Force-flushing buffer for user ${this.userId} (${this.bufferByteCount} bytes)`);
          this.flushBuffer();
        }
      }
    } catch (err) {
      // Opus decode errors happen occasionally — not fatal
      console.debug(`[voice:receiver] Opus decode error for ${this.userId}:`, err);
    }
  }

  /** Flush buffered audio → send to STT */
  private async flushBuffer(): Promise<void> {
    if (this.audioBuffer.length === 0) return;

    const pcm = Buffer.concat(this.audioBuffer);
    this.clearBuffer();

    const durationMs = (pcm.length / 2 / WHISPER_SAMPLE_RATE) * 1000;
    console.log(`[voice:receiver] Sending ${durationMs.toFixed(0)}ms audio from ${this.userId} to STT`);

    try {
      const text = await transcribeAudio(pcm, this.config.stt.url);

      if (text && text.trim().length > 0) {
        this.onTranscription({
          userId: this.userId,
          displayName: "", // Filled in by manager
          text: text.trim(),
          timestamp: this.speechStartTime || Date.now(),
        });
      }
    } catch (err) {
      console.error(`[voice:receiver] STT failed for ${this.userId}:`, err);
    }
  }

  private clearBuffer(): void {
    this.audioBuffer = [];
    this.bufferByteCount = 0;
  }

  destroy(): void {
    this.destroyed = true;
    this.clearBuffer();
    this.vad.reset();
  }
}

/**
 * Downsample 48kHz stereo PCM16 → 16kHz mono PCM16.
 * Simple method: average L+R channels, take every 3rd sample (48/16 = 3).
 */
function downsampleToMono16k(stereo48k: Buffer): Buffer {
  const srcSamples = Math.floor(stereo48k.length / 4); // 2 bytes * 2 channels
  const dstSamples = Math.floor(srcSamples / 3);       // 48k → 16k
  const mono = Buffer.alloc(dstSamples * 2);

  for (let i = 0; i < dstSamples; i++) {
    const srcIdx = i * 3; // every 3rd sample pair
    const byteOffset = srcIdx * 4; // 4 bytes per stereo sample

    if (byteOffset + 3 >= stereo48k.length) break;

    const left = stereo48k.readInt16LE(byteOffset);
    const right = stereo48k.readInt16LE(byteOffset + 2);
    const monoSample = Math.round((left + right) / 2);

    mono.writeInt16LE(Math.max(-32768, Math.min(32767, monoSample)), i * 2);
  }

  return mono;
}

/**
 * Send PCM audio to whisper.cpp STT service.
 * Creates a WAV in memory and POSTs to the OpenAI-compatible endpoint.
 */
async function transcribeAudio(pcm: Buffer, sttUrl: string): Promise<string> {
  // Build a minimal WAV header (16kHz mono PCM16)
  const wav = createWavBuffer(pcm, WHISPER_SAMPLE_RATE, 1, 16);

  const formData = new FormData();
  formData.append("file", new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer], { type: "audio/wav" }), "audio.wav");
  formData.append("model", "base.en");
  formData.append("response_format", "json");

  const response = await fetch(`${sttUrl}/v1/audio/transcriptions`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`STT request failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json() as { text: string };
  return result.text;
}

/** Create a WAV file buffer from raw PCM data */
function createWavBuffer(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);

  // fmt sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // Sub-chunk size
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28); // Byte rate
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);             // Block align
  header.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * VoiceReceiver — manages per-user audio receivers for a voice connection.
 */
export class VoiceReceiver {
  private connection: VoiceConnection;
  private config: VoiceConfig;
  private receivers = new Map<string, UserReceiver>();
  private onTranscription: (t: Transcription) => void;
  private subscriptions = new Map<string, { unsubscribe: () => void }>();

  constructor(
    connection: VoiceConnection,
    config: VoiceConfig,
    onTranscription: (t: Transcription) => void,
  ) {
    this.connection = connection;
    this.config = config;
    this.onTranscription = onTranscription;
  }

  /** Start listening for audio from a specific user */
  subscribeUser(userId: string): void {
    if (this.receivers.has(userId)) return;

    console.log(`[voice:receiver] Subscribing to audio from ${userId}`);

    const receiver = new UserReceiver(userId, this.config, this.onTranscription);
    this.receivers.set(userId, receiver);

    // Subscribe to this user's audio stream
    const audioStream = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 2000, // End stream after 2s silence (we handle VAD ourselves)
      },
    });

    audioStream.on("data", (chunk: Buffer) => {
      receiver.processOpus(chunk);
    });

    audioStream.on("end", () => {
      console.log(`[voice:receiver] Audio stream ended for ${userId}`);
      // Don't destroy — user may speak again. Stream will be re-created by discord.js.
    });

    audioStream.on("error", (err: Error) => {
      console.error(`[voice:receiver] Audio stream error for ${userId}:`, err);
    });
  }

  /** Stop listening to a specific user */
  unsubscribeUser(userId: string): void {
    const receiver = this.receivers.get(userId);
    if (receiver) {
      receiver.destroy();
      this.receivers.delete(userId);
      console.log(`[voice:receiver] Unsubscribed from ${userId}`);
    }
  }

  /** Clean up all receivers */
  destroy(): void {
    for (const [_userId, receiver] of this.receivers) {
      receiver.destroy();
    }
    this.receivers.clear();
    this.subscriptions.clear();
  }
}
