/**
 * Voice module types — shared interfaces for voice integration
 */

/** Voice session configuration loaded from ~/.lobs/config/voice.json */
export interface VoiceConfig {
  enabled: boolean;
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
}

/** Default voice config when file is missing */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
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

/** Status of a voice session */
export interface VoiceSessionStatus {
  guildId: string;
  channelId: string;
  channelName?: string;
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
