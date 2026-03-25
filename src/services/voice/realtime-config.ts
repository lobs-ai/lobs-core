import type { RealtimeSessionConfig } from "@openai/agents/realtime";

const REALTIME_SAMPLE_RATE = 24000;

export interface RealtimeSessionConfigOptions {
  voice: string;
  turnDetection: "semantic_vad" | "server_vad";
  eagerness: "low" | "medium" | "high" | "auto";
  noiseReduction: "near_field" | "far_field" | null;
  transcriptionModel: string;
}

export function buildRealtimeSessionConfig(
  options: RealtimeSessionConfigOptions,
): Partial<RealtimeSessionConfig> {
  const {
    voice,
    turnDetection,
    eagerness,
    noiseReduction,
    transcriptionModel,
  } = options;

  return {
    audio: {
      input: {
        format: {
          type: "audio/pcm" as const,
          rate: REALTIME_SAMPLE_RATE,
        },
        turnDetection: {
          type: turnDetection,
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
    // Current Realtime API sessions only accept a single output modality.
    outputModalities: ["audio"],
  };
}
