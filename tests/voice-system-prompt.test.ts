import { describe, expect, it } from "vitest";
import { buildVoiceSystemPrompt } from "../src/services/workspace-loader.js";

describe("buildVoiceSystemPrompt", () => {
  it("tells the voice agent to use context and tools before claiming ignorance", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).toContain("same Lobs he talks to elsewhere");
    expect(prompt).toContain("No fake warmth");
    expect(prompt).toContain("one to three sentences");
    expect(prompt).toContain("\"I'd be happy to help\"");
    expect(prompt).toContain("search_memory");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("write_note");
    expect(prompt).toContain("spawn_agent");
    expect(prompt).toContain("be proactive with tools");
    expect(prompt).toContain("don't say you can't see your tools");
    expect(prompt).toContain("never claim a note was saved unless write_note succeeded");
    expect(prompt).toContain("go look before saying you don't know");
    expect(prompt).toContain("don't end with filler like");
    expect(prompt).toContain("stay focused on the main task");
    expect(prompt).toContain("don't turn an internal tool failure into a new task");
    expect(prompt).toContain("start investigating right away");
    expect(prompt).toContain("take it instead of asking for permission");
    expect(prompt).toContain("only ask a question when a specific missing detail is actually blocking the next step");
  });
});
