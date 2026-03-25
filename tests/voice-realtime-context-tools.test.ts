import { describe, expect, it } from "vitest";
import { buildRealtimeInstructions } from "../src/services/voice/realtime-context.js";

describe("buildRealtimeInstructions", () => {
  it("includes the live tool catalog and tool-awareness guidance", async () => {
    const instructions = await buildRealtimeInstructions();

    expect(instructions).toContain("Live tools in this session:");
    expect(instructions).toContain("search_memory");
    expect(instructions).toContain("read_file");
    expect(instructions).toContain("write_note");
    expect(instructions).toContain("spawn_agent");
    expect(instructions).toContain("If one clearly fits, use it.");
    expect(instructions).toContain("Don't say you can't see your tools.");
    expect(instructions).toContain("If Rafe says \"write this down\", use write_note.");
    expect(instructions).toContain("If there's a bigger issue to work on, use spawn_agent.");
  });
});
