import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceLoaderMock = vi.hoisted(() => ({
  buildVoiceSystemPrompt: vi.fn(() => "VOICE_PROMPT"),
  loadWorkspaceContext: vi.fn(() => "## SOUL.md\nSoul\n## USER.md\nUser\n## MEMORY.md\nMemory\n## TOOLS.md\nTools"),
}));

vi.mock("../src/services/workspace-loader.js", () => workspaceLoaderMock);

import { buildRealtimeInstructions } from "../src/services/voice/realtime-context.js";

describe("buildRealtimeInstructions", () => {
  beforeEach(() => {
    workspaceLoaderMock.buildVoiceSystemPrompt.mockClear();
    workspaceLoaderMock.loadWorkspaceContext.mockClear();
  });

  it("reuses the main workspace context for realtime voice instructions", async () => {
    const instructions = await buildRealtimeInstructions();

    expect(workspaceLoaderMock.buildVoiceSystemPrompt).toHaveBeenCalledTimes(1);
    expect(workspaceLoaderMock.loadWorkspaceContext).toHaveBeenCalledWith("main");
    expect(instructions).toContain("VOICE_PROMPT");
    expect(instructions).toContain("## SOUL.md");
    expect(instructions).toContain("## USER.md");
    expect(instructions).toContain("## MEMORY.md");
    expect(instructions).toContain("## TOOLS.md");
    expect(instructions).toContain("Current time:");
  });
});
