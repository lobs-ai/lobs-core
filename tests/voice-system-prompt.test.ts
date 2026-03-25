import { describe, expect, it } from "vitest";
import { buildVoiceSystemPrompt } from "../src/services/workspace-loader.js";

describe("buildVoiceSystemPrompt", () => {
  it("tells the voice agent to use context and tools before claiming ignorance", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).toContain("Do NOT claim ignorance");
    expect(prompt).toContain("Use search_memory");
    expect(prompt).toContain("Use read_file");
    expect(prompt).toContain("Use write_note");
    expect(prompt).toContain("NEVER say \"I'd be happy to help\"");
    expect(prompt).toContain("call write_note");
    expect(prompt).toContain("Never say a note was saved");
    expect(prompt).toContain("Never say you cannot save notes or files if write_note is available");
    expect(prompt).toContain("Do not say you cannot see them");
    expect(prompt).toContain("search_memory, read_file, write_note, and spawn_agent");
  });
});
