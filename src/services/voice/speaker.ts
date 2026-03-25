/**
 * Voice Speaker — text → TTS → Discord audio playback pipeline
 *
 * Takes text (from Claude streaming response), buffers until sentence boundaries,
 * sends each sentence to Chatterbox TTS, and queues audio for Discord playback.
 * Supports pipeline parallelism: generate sentence N+1 while playing sentence N.
 */

import { createAudioResource, AudioPlayerStatus, type AudioPlayer, type VoiceConnection, StreamType } from "@discordjs/voice";
import { Readable } from "node:stream";
import type { VoiceConfig } from "./types.js";

/** Sentence boundary regex — split on . ! ? followed by space or end */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

/** Minimum text length to send to TTS (avoids single-word fragments) */
const MIN_SENTENCE_LENGTH = 10;

/**
 * VoiceSpeaker — manages the outbound text-to-speech pipeline.
 */
export class VoiceSpeaker {
  private config: VoiceConfig;
  private player: AudioPlayer;
  private connection: VoiceConnection;
  private textBuffer = "";
  private audioQueue: Buffer[] = [];
  private isPlaying = false;
  private isFlushing = false;

  constructor(config: VoiceConfig, player: AudioPlayer, connection: VoiceConnection) {
    this.config = config;
    this.player = player;
    this.connection = connection;

    // When current audio finishes, play next in queue
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.isPlaying = false;
      this.playNext();
    });
  }

  /**
   * Feed streaming text from Claude. Call this as tokens arrive.
   * Text is buffered until sentence boundaries, then sent to TTS.
   */
  async feedText(text: string): Promise<void> {
    this.textBuffer += text;

    // Check for sentence boundaries
    const sentences = this.textBuffer.split(SENTENCE_BOUNDARY);

    if (sentences.length > 1) {
      // All but the last are complete sentences
      const complete = sentences.slice(0, -1);
      this.textBuffer = sentences[sentences.length - 1];

      for (const sentence of complete) {
        const trimmed = sentence.trim();
        if (trimmed.length >= MIN_SENTENCE_LENGTH) {
          // Don't await — fire and queue for parallel TTS generation
          this.generateAndQueue(trimmed).catch(err => {
            console.error("[voice:speaker] TTS generation failed:", err);
          });
        }
      }
    }
  }

  /**
   * Flush any remaining buffered text. Call when Claude response is complete.
   */
  async flush(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;

    const remaining = this.textBuffer.trim();
    this.textBuffer = "";

    if (remaining.length > 0) {
      try {
        await this.generateAndQueue(remaining);
      } catch (err) {
        console.error("[voice:speaker] TTS flush failed:", err);
      }
    }

    this.isFlushing = false;
  }

  /**
   * Stop playback and clear queued audio. Used for interrupts.
   */
  stop(): void {
    this.textBuffer = "";
    this.audioQueue = [];
    this.isPlaying = false;
    this.player.stop(true);
  }

  /**
   * Generate TTS audio for a sentence and add to playback queue.
   */
  private async generateAndQueue(text: string): Promise<void> {
    console.log(`[voice:speaker] Generating TTS: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

    const t0 = Date.now();
    const audioBuffer = await this.synthesize(text);
    console.log(`[voice:speaker] TTS generated in ${Date.now() - t0}ms (${audioBuffer.length} bytes)`);

    this.audioQueue.push(audioBuffer);
    this.playNext();
  }

  /**
   * Play the next audio buffer in the queue if not already playing.
   */
  private playNext(): void {
    if (this.isPlaying || this.audioQueue.length === 0) return;

    const audioData = this.audioQueue.shift()!;
    this.isPlaying = true;

    // Create a readable stream from the WAV buffer
    const stream = Readable.from(audioData);

    // Create an audio resource from the WAV data
    // discord.js handles WAV decoding internally
    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
    });

    this.player.play(resource);
  }

  /**
   * Send text to the Chatterbox TTS service and get WAV audio back.
   */
  private async synthesize(text: string): Promise<Buffer> {
    const response = await fetch(`${this.config.tts.url}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatterbox",
        input: text,
        voice: this.config.tts.voice ?? "default",
        response_format: "wav",
        speed: this.config.tts.speed ?? 1.0,
      }),
    });

    if (!response.ok) {
      throw new Error(`TTS request failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /** Check if speaker is currently playing or has queued audio */
  get isBusy(): boolean {
    return this.isPlaying || this.audioQueue.length > 0;
  }
}
