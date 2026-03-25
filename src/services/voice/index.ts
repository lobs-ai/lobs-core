/**
 * Voice module — Discord voice channel integration with local STT + TTS
 *
 * @module voice
 */

export { VoiceManager } from "./manager.js";
export { VoiceReceiver } from "./receiver.js";
export { VoiceSpeaker } from "./speaker.js";
export { VoiceTranscript } from "./transcript.js";
export { VADProcessor, calculateRMS } from "./vad.js";
export { loadVoiceConfig, reloadVoiceConfig } from "./config.js";
export type {
  VoiceConfig,
  VoiceSessionStatus,
  Transcription,
  TranscriptEntry,
  TriggerMode,
  SidecarHealthResponse,
} from "./types.js";
