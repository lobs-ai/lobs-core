import { describe, expect, it, vi } from "vitest";
import {
  queueBackgroundVoiceTool,
  realtimeVoiceTools,
} from "../src/services/voice/realtime-tools.js";

describe("queueBackgroundVoiceTool", () => {
  it("returns a background result and enqueues work when a callback exists", async () => {
    const enqueue = vi.fn();

    const result = await queueBackgroundVoiceTool(
      "search_memory",
      "Checking memory.",
      {
        context: {
          enqueueBackgroundToolResult: enqueue,
        },
      } as any,
      Promise.resolve("done"),
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ content: "Checking memory." });
  });

  it("falls back to awaiting the task when no callback exists", async () => {
    const result = await queueBackgroundVoiceTool(
      "read_file",
      "Reading file.",
      {
        context: {},
      } as any,
      Promise.resolve("file contents"),
    );

    expect(result).toBe("file contents");
  });

  it("exposes only the curated realtime voice tools", () => {
    expect(realtimeVoiceTools.map((t) => t.name)).toEqual([
      "search_memory",
      "read_file",
      "write_note",
      "spawn_agent",
    ]);
  });
});
