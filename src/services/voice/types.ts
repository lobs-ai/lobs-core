/**
 * Voice module types — shared interfaces for voice integration
 */

// ---------------------------------------------------------------------------
// Realtime mode configuration (OpenAI Realtime API — speech-to-speech)
// ---------------------------------------------------------------------------

/** Configuration for the OpenAI Realtime API voice mode */
export interface RealtimeConfig {
  /** Enable the Realtime voice pipeline (default: false) */
  enabled: boolean;
  /** OpenAI Realtime model (default: gpt-4o-realtime-preview) */
  model: string;
  /** TTS voice: ash, ballad, coral, sage, verse (default: ash) */
  voice: string;
  /** Turn detection strategy (default: semantic_vad) */
  turnDetection: "semantic_vad" | "server_vad";
  /** How eagerly to detect turn ends (default: medium) */
  eagerness: "low" | "medium" | "high" | "auto";
  /** Noise reduction mode or null to disable (default: near_field) */
  noiseReduction: "near_field" | "far_field" | null;
  /** Transcription model for input audio (default: gpt-4o-mini-transcribe) */
  transcriptionModel: string;
}

/** Default Realtime config */
export const DEFAULT_REALTIME_CONFIG: RealtimeConfig = {
  enabled: false,
  model: "gpt-4o-realtime-preview",
  voice: "ash",
  turnDetection: "semantic_vad",
  eagerness: "medium",
  noiseReduction: "near_field",
  transcriptionModel: "gpt-4o-mini-transcribe",
};

// ---------------------------------------------------------------------------
// Voice session configuration (STT/TTS sidecar pipeline)
// ---------------------------------------------------------------------------

/** Voice session configuration loaded from ~/.lobs/config/voice.json */
export interface VoiceConfig {
  enabled: boolean;
  /** Auto-start STT/TTS sidecar processes when lobs-core starts (default: false) */
  autoStartSidecar: boolean;
  /** Health check interval in ms while sessions are active (default: 30000) */
  healthCheckIntervalMs: number;
  stt: {
    url: string;
    model?: string;
    language?: string;
  };
  tts: {
    url: string;
    voice?: string;
    speed?: number;
  };
  vad: {
    silenceThresholdMs: number;
    energyThreshold: number;
  };
  conversation: {
    maxContextExchanges: number;
    triggerMode: "keyword" | "always";
    triggerWords: string[];
  };
  /** OpenAI Realtime API configuration (speech-to-speech mode) */
  realtime: RealtimeConfig;
}

/** Default voice config when file is missing */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  autoStartSidecar: false,
  healthCheckIntervalMs: 30_000,
  stt: {
    url: "http://localhost:7423",
    model: "base.en",
    language: "en",
  },
  tts: {
    url: "http://localhost:7422",
    voice: "default",
    speed: 1.0,
  },
  vad: {
    silenceThresholdMs: 800,
    energyThreshold: 0.01,
  },
  conversation: {
    maxContextExchanges: 20,
    triggerMode: "keyword",
    triggerWords: ["lobs", "hey lobs"],
  },
  realtime: DEFAULT_REALTIME_CONFIG,
};

/** Trigger mode for when Claude responds to voice input */
export type TriggerMode = "keyword" | "always";

/** A single transcribed utterance */
export interface Transcription {
  userId: string;
  displayName: string;
  text: string;
  timestamp: number;
}

/** An exchange in the voice conversation transcript */
export interface TranscriptEntry {
  role: "user" | "assistant";
  userId?: string;
  displayName?: string;
  text: string;
  timestamp: number;
}

/** Voice pipeline mode */
export type VoiceMode = "sidecar" | "realtime";

/** Status of a voice session */
export interface VoiceSessionStatus {
  guildId: string;
  channelId: string;
  channelName?: string;
  /** Which pipeline is active */
  mode: VoiceMode;
  triggerMode: TriggerMode;
  connectedSince: number;
  usersInChannel: number;
  transcriptLength: number;
  sttHealthy: boolean;
  ttsHealthy: boolean;
}

/** STT transcription response (OpenAI-compatible) */
export interface STTResponse {
  text: string;
}

/** Health check response from sidecar services */
export interface SidecarHealthResponse {
  status: string;
  model?: string;
  device?: string;
}
