/**
 * Voice Activity Detection — energy-based silence detection for PCM audio
 *
 * Tracks whether incoming audio contains speech or silence.
 * Used to segment continuous audio into discrete utterances.
 */

export interface VADConfig {
  /** How long silence must last before we consider speech "done" (ms) */
  silenceThresholdMs: number;
  /** RMS energy below this = silence (0.0 to 1.0 scale for float, adjusted for int16) */
  energyThreshold: number;
}

export interface VADState {
  isSpeaking: boolean;
  silenceStart: number | null;
  speechStart: number | null;
}

/**
 * Calculate RMS energy of a PCM16 buffer (signed 16-bit little-endian).
 * Returns value in 0..1 range (normalized by 32768).
 */
export function calculateRMS(pcm: Buffer): number {
  if (pcm.length < 2) return 0;

  const sampleCount = Math.floor(pcm.length / 2);
  let sumSquares = 0;

  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount) / 32768;
}

/**
 * Simple energy-based VAD processor.
 *
 * Feed it PCM chunks. It emits events when:
 * - Speech starts (first non-silent frame after silence)
 * - Speech ends (silence exceeds threshold)
 */
export class VADProcessor {
  private config: VADConfig;
  private state: VADState = {
    isSpeaking: false,
    silenceStart: null,
    speechStart: null,
  };

  // Callbacks
  onSpeechStart?: () => void;
  onSpeechEnd?: (durationMs: number) => void;

  constructor(config: VADConfig) {
    this.config = config;
  }

  /** Process a PCM16 audio chunk. Returns true if speech is active. */
  process(pcm: Buffer, timestampMs: number = Date.now()): boolean {
    const energy = calculateRMS(pcm);
    const isVoice = energy > this.config.energyThreshold;

    if (isVoice) {
      if (!this.state.isSpeaking) {
        // Speech just started
        this.state.isSpeaking = true;
        this.state.speechStart = timestampMs;
        this.state.silenceStart = null;
        this.onSpeechStart?.();
      } else {
        // Continuation of speech — reset any silence tracking
        this.state.silenceStart = null;
      }
    } else {
      if (this.state.isSpeaking) {
        // In speech but got silence
        if (!this.state.silenceStart) {
          this.state.silenceStart = timestampMs;
        } else if (timestampMs - this.state.silenceStart >= this.config.silenceThresholdMs) {
          // Silence long enough — speech is done
          const duration = this.state.silenceStart - (this.state.speechStart ?? this.state.silenceStart);
          this.state.isSpeaking = false;
          this.state.speechStart = null;
          this.state.silenceStart = null;
          this.onSpeechEnd?.(duration);
        }
      }
    }

    return this.state.isSpeaking;
  }

  /** Reset VAD state (e.g., when user leaves/joins) */
  reset(): void {
    this.state = {
      isSpeaking: false,
      silenceStart: null,
      speechStart: null,
    };
  }

  get isSpeaking(): boolean {
    return this.state.isSpeaking;
  }
}
