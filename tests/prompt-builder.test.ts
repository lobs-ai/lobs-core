/**
 * Tests for src/runner/prompt-builder.ts
 *
 * Tests the two prompt builders and the context-ref loader.
 * External dependencies (context-engine, workspace-manager, skills, fs) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must come before imports) ─────────────────────────────────────────

vi.mock("../src/runner/context-engine.js", () => ({
  assembleContext: vi.fn(),
}));

vi.mock("../src/runner/workspace-manager.js", () => ({
  getAgentFiles: vi.fn(),
  getRecentHistory: vi.fn(),
}));

vi.mock("../src/services/workspace-loader.js", () => ({
  loadWorkspaceContext: vi.fn(),
}));

vi.mock("../src/services/skills.js", () => ({
  skillsService: {
    matchSkills: vi.fn(),
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { assembleContext } from "../src/runner/context-engine.js";
import { getRecentHistory } from "../src/runner/workspace-manager.js";
import { loadWorkspaceContext } from "../src/services/workspace-loader.js";
import { skillsService } from "../src/services/skills.js";
import {
  buildSystemPrompt,
  buildSmartSystemPrompt,
  loadContextRefs,
} from "../src/runner/prompt-builder.js";
import type { AgentSpec } from "../src/runner/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockAssembleContext = vi.mocked(assembleContext);
const mockGetRecentHistory = vi.mocked(getRecentHistory);
const mockLoadWorkspaceContext = vi.mocked(loadWorkspaceContext);
const mockMatchSkills = vi.mocked(skillsService.matchSkills);

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    task: "Write a hello world function in TypeScript",
    agent: "programmer",
    model: "claude-3-5-sonnet",
    cwd: "/home/user/project",
    tools: ["exec", "read", "write"],
    timeout: 300,
    ...overrides,
  };
}

function makeAssembledContext(overrides: Partial<{
  contextBlock: string;
  snippets: unknown[];
  tokenEstimate: number;
}> = {}) {
  return {
    contextBlock: overrides.contextBlock ?? "# Context\nSome memory snippets here.",
    snippets: overrides.snippets ?? [],
    tokenEstimate: overrides.tokenEstimate ?? 500,
  };
}

// ── buildSystemPrompt ─────────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("includes the agent template for known agent types", () => {
    const agents = ["programmer", "writer", "researcher", "reviewer", "architect"] as const;
    for (const agent of agents) {
      const prompt = buildSystemPrompt(makeSpec({ agent }));
      expect(prompt.length).toBeGreaterThan(100);
    }
  });

  it("uses the default template for unknown agent types", () => {
    const prompt = buildSystemPrompt(makeSpec({ agent: "unknown-type" }));
    expect(prompt).toContain("You are an AI agent");
    expect(prompt).toContain("Complete the assigned task");
  });

  it("includes the working directory", () => {
    const prompt = buildSystemPrompt(makeSpec({ cwd: "/my/special/dir" }));
    expect(prompt).toContain("/my/special/dir");
  });

  it("includes the Claude-style system and runtime context", () => {
    const prompt = buildSystemPrompt(makeSpec());
    expect(prompt).toContain("# System");
    expect(prompt).toContain("# Task Execution");
    expect(prompt).toMatch(/Use tools (aggressively for verification|to inspect reality) instead of guessing/);
    expect(prompt).toContain("# Runtime Context");
    expect(prompt).toContain("Enabled tools: exec, read, write");
  });

  it("includes an available tools section for enabled tools", () => {
    const prompt = buildSystemPrompt(makeSpec());
    expect(prompt).toContain("# Available Tools");
    expect(prompt).toContain("Bash:");
    expect(prompt).toContain("Read:");
    expect(prompt).toContain("Write:");
  });

  it("includes today's date", () => {
    const today = new Date().toISOString().split("T")[0];
    const prompt = buildSystemPrompt(makeSpec());
    expect(prompt).toContain(today);
  });

  it("injects contextRefs when provided", () => {
    const spec = makeSpec({
      context: {
        contextRefs: [
          { path: "/path/to/readme.md", content: "This is the README content." },
          { path: "/path/to/config.ts", content: "export const X = 1;" },
        ],
      },
    });
    const prompt = buildSystemPrompt(spec);
    expect(prompt).toContain("Reference Context");
    expect(prompt).toContain("/path/to/readme.md");
    expect(prompt).toContain("This is the README content.");
    expect(prompt).toContain("/path/to/config.ts");
    expect(prompt).toContain("export const X = 1;");
  });

  it("does not include contextRefs section when empty", () => {
    const spec = makeSpec({ context: { contextRefs: [] } });
    const prompt = buildSystemPrompt(spec);
    expect(prompt).not.toContain("Reference Context");
  });

  it("does not include contextRefs section when context is absent", () => {
    const prompt = buildSystemPrompt(makeSpec({ context: undefined }));
    expect(prompt).not.toContain("Reference Context");
  });

  it("truncates very long contextRef content at 30000 chars", () => {
    const longContent = "x".repeat(35000);
    const spec = makeSpec({
      context: {
        contextRefs: [{ path: "/large-file.txt", content: longContent }],
      },
    });
    const prompt = buildSystemPrompt(spec);
    expect(prompt).toContain("(truncated)");
    // The raw 35000 char content should NOT appear intact
    expect(prompt).not.toContain(longContent);
  });

  it("does not truncate content exactly at 30000 chars", () => {
    const exactContent = "y".repeat(30000);
    const spec = makeSpec({
      context: {
        contextRefs: [{ path: "/exact.txt", content: exactContent }],
      },
    });
    const prompt = buildSystemPrompt(spec);
    expect(prompt).not.toContain("(truncated)");
  });

  it("injects learnings when provided", () => {
    const spec = makeSpec({
      context: { learnings: "Always use strict TypeScript. Never use any." },
    });
    const prompt = buildSystemPrompt(spec);
    expect(prompt).toContain("Relevant Learnings");
    expect(prompt).toContain("Always use strict TypeScript");
  });

  it("injects additionalContext when provided", () => {
    const spec = makeSpec({
      context: { additionalContext: "## Special Instructions\nDo this extra thing." },
    });
    const prompt = buildSystemPrompt(spec);
    expect(prompt).toContain("Special Instructions");
    expect(prompt).toContain("Do this extra thing.");
  });

  it("includes structured working state when provided", () => {
    const spec = makeSpec({
      context: {
        workingState: {
          objective: "Finish the runtime upgrade",
          currentCwd: "/tmp/project",
          filesInPlay: ["src/runner/agent-loop.ts", "src/claude-runtime/llm-prompt.ts"],
          outstandingWork: ["Integrate subagent result into next step"],
          activeDecisions: ["Use one shared loop for main and worker agents"],
          recentToolSummary: "Read, Edit; 2 succeeded, 0 failed",
          lastAssistantConclusion: "The loop is unified; next is structured delegation state.",
        },
      },
    });
    const prompt = buildSystemPrompt(spec);
    expect(prompt).toContain("Finish the runtime upgrade");
    expect(prompt).toContain("Current working directory: /tmp/project");
    expect(prompt).toContain("src/runner/agent-loop.ts");
    expect(prompt).toContain("Integrate subagent result into next step");
    expect(prompt).toContain("Use one shared loop for main and worker agents");
    expect(prompt).toContain("Read, Edit; 2 succeeded, 0 failed");
  });

  it("includes structured delegation state when provided", () => {
    const spec = makeSpec({
      context: {
        subagentEvents: [{
          runId: "abc123",
          agentType: "programmer",
          status: "completed",
          task: "Implement the parser changes",
          turns: 4,
          costUsd: 0.0123,
          durationSeconds: 12.4,
          result: "Updated bash parsing and added tests.",
        }],
      },
    });
    const prompt = buildSystemPrompt(spec);
    expect(prompt).toContain("# Delegation State");
    expect(prompt).toContain("programmer (abc123) — completed");
    expect(prompt).toContain("Implement the parser changes");
    expect(prompt).toContain("Updated bash parsing and added tests.");
  });

  it("does not crash when context object is empty", () => {
    const spec = makeSpec({ context: {} });
    expect(() => buildSystemPrompt(spec)).not.toThrow();
  });

  it("programmer template mentions commit rules", () => {
    const prompt = buildSystemPrompt(makeSpec({ agent: "programmer" }));
    expect(prompt).toMatch(/commit/i);
  });

  it("writer template mentions documentation", () => {
    const prompt = buildSystemPrompt(makeSpec({ agent: "writer" }));
    expect(prompt).toMatch(/document|write/i);
  });

  it("architect template mentions NOT writing code", () => {
    const prompt = buildSystemPrompt(makeSpec({ agent: "architect" }));
    expect(prompt).toMatch(/NOT write implementation code|design/i);
  });

  it("reviewer template mentions critical issues vs suggestions", () => {
    const prompt = buildSystemPrompt(makeSpec({ agent: "reviewer" }));
    expect(prompt).toMatch(/critical|suggest/i);
  });
});

// ── buildSmartSystemPrompt ────────────────────────────────────────────────────

describe("buildSmartSystemPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock returns
    mockLoadWorkspaceContext.mockReturnValue(null);
    mockGetRecentHistory.mockReturnValue([]);
    mockAssembleContext.mockResolvedValue(makeAssembledContext());
    mockMatchSkills.mockReturnValue([]);
  });

  it("returns a systemPrompt string and a context object", async () => {
    const { systemPrompt, context } = await buildSmartSystemPrompt(makeSpec());
    expect(typeof systemPrompt).toBe("string");
    expect(context).toBeDefined();
    expect(context.contextBlock).toBeDefined();
  });

  it("uses workspace context when available", async () => {
    mockLoadWorkspaceContext.mockReturnValue("# AGENTS.md\nYou are the best programmer ever.");
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec());
    expect(systemPrompt).toContain("You are the best programmer ever.");
  });

  it("falls back to built-in template when workspace context is null", async () => {
    mockLoadWorkspaceContext.mockReturnValue(null);
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec({ agent: "programmer" }));
    // Should include the built-in programmer template content
    expect(systemPrompt).toMatch(/programmer|code|write/i);
  });

  it("includes working directory in the prompt", async () => {
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec({ cwd: "/proj/myapp" }));
    expect(systemPrompt).toContain("/proj/myapp");
  });

  it("includes today's date", async () => {
    const today = new Date().toISOString().split("T")[0];
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec());
    expect(systemPrompt).toContain(today);
  });

  it("includes the Claude-style sections in the smart prompt", async () => {
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec());
    expect(systemPrompt).toContain("# System");
    expect(systemPrompt).toContain("# Available Tools");
    expect(systemPrompt).toContain("Enabled tools: exec, read, write");
  });

  it("injects recent history when available", async () => {
    mockGetRecentHistory.mockReturnValue([
      "Run 1: Fixed auth bug in middleware.ts",
      "Run 2: Added unit tests for login flow",
    ]);
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec());
    expect(systemPrompt).toContain("Recent Run History");
    expect(systemPrompt).toContain("Fixed auth bug");
    expect(systemPrompt).toContain("Added unit tests");
  });

  it("does not include history section when history is empty", async () => {
    mockGetRecentHistory.mockReturnValue([]);
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec());
    expect(systemPrompt).not.toContain("Recent Run History");
  });

  it("includes the assembled context block", async () => {
    mockAssembleContext.mockResolvedValue(
      makeAssembledContext({ contextBlock: "## Memory\nKey info from past runs." })
    );
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec());
    expect(systemPrompt).toContain("Key info from past runs.");
  });

  it("skips context section when contextBlock is empty", async () => {
    mockAssembleContext.mockResolvedValue(makeAssembledContext({ contextBlock: "" }));
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec());
    // No double-dashes from empty context block
    expect(systemPrompt).not.toContain("\n---\n\n---");
  });

  it("injects matched skills (up to 2)", async () => {
    mockMatchSkills.mockReturnValue([
      { name: "git-workflow", description: "Git patterns", tags: ["git"], instructions: "Always rebase before push.", path: "/skills/git" },
      { name: "image-generation", description: "Image gen", tags: ["image"], instructions: "Use the imagine tool.", path: "/skills/img" },
      { name: "third-skill", description: "Extra", tags: ["misc"], instructions: "Should not appear.", path: "/skills/extra" },
    ]);
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec());
    expect(systemPrompt).toContain("git-workflow");
    expect(systemPrompt).toContain("Always rebase before push.");
    expect(systemPrompt).toContain("Use the imagine tool.");
    expect(systemPrompt).not.toContain("Should not appear.");
  });

  it("does not include skills section when no skills matched", async () => {
    mockMatchSkills.mockReturnValue([]);
    const { systemPrompt } = await buildSmartSystemPrompt(makeSpec());
    expect(systemPrompt).not.toContain("Relevant Skills");
  });

  it("injects additionalContext for backwards compatibility", async () => {
    const spec = makeSpec({
      context: { additionalContext: "## Legacy Context\nOld school data." },
    });
    const { systemPrompt } = await buildSmartSystemPrompt(spec);
    expect(systemPrompt).toContain("Legacy Context");
  });

  it("calls assembleContext with the correct task and agent type", async () => {
    const spec = makeSpec({ task: "Fix the login bug", agent: "programmer" });
    await buildSmartSystemPrompt(spec);
    expect(mockAssembleContext).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Fix the login bug",
        agentType: "programmer",
      })
    );
  });

  it("does not call getRecentHistory for unknown agent types", async () => {
    await buildSmartSystemPrompt(makeSpec({ agent: "custom-type" }));
    expect(mockGetRecentHistory).not.toHaveBeenCalled();
  });

  it("handles getRecentHistory throwing without crashing", async () => {
    mockGetRecentHistory.mockImplementation(() => { throw new Error("FS error"); });
    await expect(buildSmartSystemPrompt(makeSpec())).resolves.toBeDefined();
  });

  it("handles matchSkills throwing without crashing", async () => {
    mockMatchSkills.mockImplementation(() => { throw new Error("Skills unavailable"); });
    await expect(buildSmartSystemPrompt(makeSpec())).resolves.toBeDefined();
  });
});

// ── loadContextRefs ───────────────────────────────────────────────────────────

describe("loadContextRefs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns loaded content for existing files", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("  file content here  " as unknown as Buffer);

    const result = loadContextRefs(["/some/file.md"]);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/some/file.md");
    expect(result[0].content).toBe("file content here"); // trimmed
  });

  it("skips files that do not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const result = loadContextRefs(["/nonexistent/file.md"]);
    expect(result).toHaveLength(0);
  });

  it("skips files with empty content after trimming", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("   \n\n  " as unknown as Buffer);
    const result = loadContextRefs(["  /whitespace-only.md"]);
    expect(result).toHaveLength(0);
  });

  it("skips files that throw on read", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error("Permission denied"); });
    expect(() => loadContextRefs(["/forbidden.md"])).not.toThrow();
    const result = loadContextRefs(["/forbidden.md"]);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array for an empty input list", () => {
    expect(loadContextRefs([])).toEqual([]);
  });

  it("loads multiple files and returns all successful ones", () => {
    mockExistsSync.mockImplementation((p) => p !== "/missing.md");
    mockReadFileSync.mockImplementation((p) => {
      if (p === "/file-a.md") return "Content A" as unknown as Buffer;
      if (p === "/file-b.md") return "Content B" as unknown as Buffer;
      throw new Error("unexpected");
    });

    const result = loadContextRefs(["/file-a.md", "/missing.md", "/file-b.md"]);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.path)).toEqual(["/file-a.md", "/file-b.md"]);
  });

  it("truncates content to 50000 characters", () => {
    const huge = "z".repeat(60000);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(huge as unknown as Buffer);
    const result = loadContextRefs(["/large.bin"]);
    expect(result[0].content.length).toBe(50000);
  });

  it("expands ~ to HOME in file paths", () => {
    const home = process.env.HOME ?? "/root";
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("tilde content" as unknown as Buffer);

    const result = loadContextRefs(["~/docs/readme.md"]);
    // existsSync should be called with the expanded path (not ~)
    expect(mockExistsSync).toHaveBeenCalledWith(`${home}/docs/readme.md`);
    expect(result[0].content).toBe("tilde content");
  });
});
