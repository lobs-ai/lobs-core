import { describe, expect, it } from "vitest";
import { buildRealtimeSessionConfig } from "../src/services/voice/realtime-config.js";

describe("buildRealtimeSessionConfig", () => {
  it("uses audio-only output modality for realtime sessions", () => {
    const config = buildRealtimeSessionConfig({
      voice: "ash",
      turnDetection: "semantic_vad",
      eagerness: "medium",
      noiseReduction: "near_field",
      transcriptionModel: "gpt-4o-mini-transcribe",
    });

    expect(config.outputModalities).toEqual(["audio"]);
  });

  it("preserves voice input and output audio settings", () => {
    const config = buildRealtimeSessionConfig({
      voice: "ballad",
      turnDetection: "server_vad",
      eagerness: "high",
      noiseReduction: null,
      transcriptionModel: "gpt-4o-transcribe",
    });

    expect(config.audio?.input?.turnDetection).toMatchObject({
      type: "server_vad",
      interruptResponse: true,
    });
    expect(config.audio?.input?.turnDetection).not.toHaveProperty("eagerness");
    expect(config.audio?.input?.transcription).toEqual({
      model: "gpt-4o-transcribe",
    });
    expect(config.audio?.input?.noiseReduction).toBeUndefined();
    expect(config.audio?.output?.voice).toBe("ballad");
  });

  it("includes eagerness only for semantic_vad", () => {
    const config = buildRealtimeSessionConfig({
      voice: "ash",
      turnDetection: "semantic_vad",
      eagerness: "high",
      noiseReduction: "near_field",
      transcriptionModel: "gpt-4o-mini-transcribe",
    });

    expect(config.audio?.input?.turnDetection).toMatchObject({
      type: "semantic_vad",
      eagerness: "high",
      interruptResponse: true,
    });
  });
});
