/**
 * Voice module — Discord voice channel integration with local STT + TTS
 *
 * Includes two parallel modes:
 * 1. **Sidecar mode** — local whisper.cpp STT + Chatterbox TTS (default)
 * 2. **Realtime mode** — OpenAI Realtime API for speech-to-speech (opt-in)
 *
 * @module voice
 */

// Sidecar pipeline (STT/TTS)
export { VoiceManager } from "./manager.js";
export { VoiceReceiver } from "./receiver.js";
export { VoiceSpeaker } from "./speaker.js";
export { VoiceTranscript } from "./transcript.js";
export { VADProcessor, calculateRMS } from "./vad.js";
export { loadVoiceConfig, reloadVoiceConfig } from "./config.js";
export { VoiceSidecar } from "./sidecar.js";

// Realtime pipeline (OpenAI Realtime API)
export { RealtimeVoiceSession } from "./realtime-session.js";
export type { RealtimeVoiceSessionConfig } from "./realtime-session.js";
export { realtimeVoiceTools } from "./realtime-tools.js";
export { buildRealtimeInstructions } from "./realtime-context.js";

// Types
export type {
  VoiceConfig,
  RealtimeConfig,
  VoiceSessionStatus,
  Transcription,
  TranscriptEntry,
  TriggerMode,
  SidecarHealthResponse,
} from "./types.js";
export { DEFAULT_REALTIME_CONFIG } from "./types.js";
