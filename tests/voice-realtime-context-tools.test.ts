import { describe, expect, it } from "vitest";
import { buildRealtimeInstructions } from "../src/services/voice/realtime-context.js";

describe("buildRealtimeInstructions", () => {
  it("includes the live tool catalog and tool-awareness guidance", async () => {
    const instructions = await buildRealtimeInstructions();

    expect(instructions).toContain("Available tools in this live session right now:");
    expect(instructions).toContain("search_memory");
    expect(instructions).toContain("read_file");
    expect(instructions).toContain("write_note");
    expect(instructions).toContain("spawn_agent");
    expect(instructions).toContain("Do not say you cannot see your tools.");
    expect(instructions).toContain("If Rafe says \"write this down\", call write_note.");
  });
});
