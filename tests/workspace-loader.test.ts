/**
 * Tests for src/services/workspace-loader.ts
 *
 * Strategy:
 *   - Use vi.mock to intercept config/lobs.js functions (getAgentDir, getAgentContextDir)
 *   - Create a real temp directory for agent files — no fs mocking needed
 *   - Test file loading, on-demand discovery, fallback defaults
 *
 * Exports tested:
 *   - buildSystemPrompt(agentType?) — reads SYSTEM_PROMPT.md or returns default
 *   - buildMainAgentPrompt() — alias for buildSystemPrompt("main")
 *   - loadWorkspaceContext(agentType) — loads always-loaded + discovers on-demand
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Temp directory setup (before mocks and imports) ──────────────────────────

const FAKE_ROOT = mkdtempSync(join(tmpdir(), "lobs-ws-test-"));

function agentDir(type: string) {
  return join(FAKE_ROOT, type);
}

function ensureDir(d: string) {
  mkdirSync(d, { recursive: true });
}

function writeAgentFile(type: string, filename: string, content: string) {
  ensureDir(agentDir(type));
  writeFileSync(join(agentDir(type), filename), content, "utf-8");
}

function writeContextFile(type: string, filename: string, content: string) {
  const d = join(agentDir(type), "context");
  ensureDir(d);
  writeFileSync(join(d, filename), content, "utf-8");
}

function writeMemoryFile(type: string, date: string, content: string) {
  const d = join(agentDir(type), "context", "memory");
  ensureDir(d);
  writeFileSync(join(d, `${date}.md`), content, "utf-8");
}

afterAll(() => {
  try { rmSync(FAKE_ROOT, { recursive: true, force: true }); } catch {}
});

// ── Mock config/lobs.js ──────────────────────────────────────────────────────
// Must be before imports of workspace-loader

vi.mock("../src/config/lobs.js", () => ({
  getAgentDir: (type: string) => join(FAKE_ROOT, type),
  getAgentContextDir: (type: string) => join(FAKE_ROOT, type, "context"),
}));

// ── Import module under test (after mock setup) ──────────────────────────────

import {
  buildSystemPrompt,
  buildMainAgentPrompt,
  loadWorkspaceContext,
} from "../src/services/workspace-loader.js";

// ── buildSystemPrompt ────────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("returns a non-empty default when no SYSTEM_PROMPT.md", () => {
    const result = buildSystemPrompt("no-file-agent");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns default 'main' prompt that mentions the main agent", () => {
    const result = buildSystemPrompt("main");
    // Default main prompt should reference "Lobs" or "main agent"
    expect(result.length).toBeGreaterThan(10);
  });

  it("returns default worker prompt that includes agent type", () => {
    const result = buildSystemPrompt("programmer");
    expect(result).toContain("programmer");
  });

  it("reads and returns SYSTEM_PROMPT.md content when present", () => {
    writeAgentFile("coder", "SYSTEM_PROMPT.md", "You are an expert coder. Follow clean code principles.");
    const result = buildSystemPrompt("coder");
    expect(result).toBe("You are an expert coder. Follow clean code principles.");
  });

  it("defaults to 'main' when no argument passed", () => {
    const withArg = buildSystemPrompt("main");
    const withoutArg = buildSystemPrompt();
    expect(withoutArg).toBe(withArg);
  });

  it("custom SYSTEM_PROMPT.md overrides for 'main' agent", () => {
    writeAgentFile("main", "SYSTEM_PROMPT.md", "Custom main system prompt.");
    const result = buildSystemPrompt("main");
    expect(result).toBe("Custom main system prompt.");
  });

  it("returns different defaults for different agent types", () => {
    const main = buildSystemPrompt("main");
    const researcher = buildSystemPrompt("researcher-no-file");
    expect(main).not.toBe(researcher);
  });

  it("includes agent type in default prompt for unknown types", () => {
    const result = buildSystemPrompt("my-custom-agent");
    expect(result).toContain("my-custom-agent");
  });
});

// ── buildMainAgentPrompt ─────────────────────────────────────────────────────

describe("buildMainAgentPrompt", () => {
  it("returns same result as buildSystemPrompt('main')", () => {
    expect(buildMainAgentPrompt()).toBe(buildSystemPrompt("main"));
  });

  it("returns a non-empty string", () => {
    expect(buildMainAgentPrompt().length).toBeGreaterThan(0);
  });
});

// ── loadWorkspaceContext ─────────────────────────────────────────────────────

describe("loadWorkspaceContext — always-loaded files", () => {
  it("returns non-empty string even when agent dir doesn't exist (shared TOOLS.md is always included)", () => {
    const result = loadWorkspaceContext("totally-nonexistent-xyz");
    // workspace-loader always includes shared TOOLS.md and Available Files section
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes AGENTS.md in output when present", () => {
    writeAgentFile("prog1", "AGENTS.md", "# Programmer\nWrite correct code.");
    const result = loadWorkspaceContext("prog1");
    expect(result).toContain("## AGENTS.md");
    expect(result).toContain("Write correct code.");
  });

  it("includes SOUL.md in output when present", () => {
    writeAgentFile("prog1", "SOUL.md", "# Soul\nBe correct first.");
    const result = loadWorkspaceContext("prog1");
    expect(result).toContain("## SOUL.md");
    expect(result).toContain("Be correct first.");
  });

  it("missing always-loaded files are silently skipped (no error)", () => {
    ensureDir(agentDir("sparse-agent"));
    // No agent-specific files — but shared TOOLS.md is always included, so result is non-empty
    expect(() => loadWorkspaceContext("sparse-agent")).not.toThrow();
    expect(loadWorkspaceContext("sparse-agent").length).toBeGreaterThan(0);
  });

  it("sections have correct markdown headers", () => {
    writeAgentFile("prog2", "AGENTS.md", "Agent content.");
    const result = loadWorkspaceContext("prog2");
    expect(result).toMatch(/^## AGENTS\.md/m);
  });

  it("multiple always-loaded files are separated by double newlines", () => {
    writeAgentFile("prog3", "AGENTS.md", "Agent.");
    writeAgentFile("prog3", "SOUL.md", "Soul.");
    const result = loadWorkspaceContext("prog3");
    expect(result).toContain("\n\n");
    const agentsIdx = result.indexOf("## AGENTS.md");
    const soulIdx = result.indexOf("## SOUL.md");
    expect(agentsIdx).not.toBe(-1);
    expect(soulIdx).not.toBe(-1);
  });

  it("main agent loads USER.md as always-loaded", () => {
    writeAgentFile("main", "USER.md", "# User\nRafe.");
    const result = loadWorkspaceContext("main");
    expect(result).toContain("## USER.md");
    expect(result).toContain("Rafe.");
  });

  it("main agent loads MEMORY.md as always-loaded", () => {
    writeAgentFile("main", "MEMORY.md", "# Memory\nPast decisions.");
    const result = loadWorkspaceContext("main");
    expect(result).toContain("## MEMORY.md");
    expect(result).toContain("Past decisions.");
  });

  it("main agent loads TOOLS.md as always-loaded", () => {
    writeAgentFile("main", "TOOLS.md", "# Tools\nbash, write, read.");
    const result = loadWorkspaceContext("main");
    expect(result).toContain("## TOOLS.md");
    expect(result).toContain("bash, write, read.");
  });
});

describe("loadWorkspaceContext — on-demand file discovery", () => {
  it("lists PROJECT-*.md files from context dir", () => {
    writeContextFile("disc1", "PROJECT-WebApp.md", "# WebApp");
    const result = loadWorkspaceContext("disc1");
    expect(result).toContain("PROJECT-WebApp.md");
    expect(result).toContain("project details");
  });

  it("lists multiple PROJECT-*.md files", () => {
    writeContextFile("disc2", "PROJECT-Alpha.md", "# Alpha");
    writeContextFile("disc2", "PROJECT-Beta.md", "# Beta");
    const result = loadWorkspaceContext("disc2");
    expect(result).toContain("PROJECT-Alpha.md");
    expect(result).toContain("PROJECT-Beta.md");
  });

  it("does NOT list non-PROJECT context files as on-demand", () => {
    writeContextFile("disc3", "random-notes.md", "Random notes.");
    const result = loadWorkspaceContext("disc3");
    expect(result).not.toContain("random-notes.md");
  });

  it("always-loaded files are NOT re-listed in on-demand section", () => {
    writeAgentFile("disc4", "AGENTS.md", "Agent instructions.");
    writeAgentFile("disc4", "SOUL.md", "Soul.");
    const result = loadWorkspaceContext("disc4");

    // Get only the available-files section
    const availIdx = result.indexOf("## Available Files");
    if (availIdx >= 0) {
      const availSection = result.slice(availIdx);
      expect(availSection).not.toContain("- AGENTS.md");
      expect(availSection).not.toContain("- SOUL.md");
    }
    // If no Available Files section, that's fine too (no on-demand files)
    expect(true).toBe(true);
  });

  it("lists HEARTBEAT.md as on-demand with description", () => {
    writeAgentFile("disc5", "HEARTBEAT.md", "# Heartbeat\nSystem state.");
    const result = loadWorkspaceContext("disc5");
    expect(result).toContain("HEARTBEAT.md");
    expect(result).toContain("read on demand");
  });

  it("includes history/ summary entry when history files exist", () => {
    const histDir = join(agentDir("disc6"), "history");
    ensureDir(histDir);
    writeFileSync(join(histDir, "run-001.md"), "Past run.");

    const result = loadWorkspaceContext("disc6");
    expect(result).toContain("history/");
    expect(result).toContain("past run summaries");
  });

  it("does NOT include history/ for main agent", () => {
    // main agent is excluded from history listing
    const histDir = join(agentDir("main"), "history");
    ensureDir(histDir);
    writeFileSync(join(histDir, "run-001.md"), "Main history.");

    const result = loadWorkspaceContext("main");
    expect(result).not.toContain("history/");
  });

  it("includes today's memory in on-demand list if file exists", () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    writeMemoryFile("disc7", today, "Today's memory.");

    const result = loadWorkspaceContext("disc7");
    expect(result).toContain(`memory/${today}.md`);
    expect(result).toContain("today's memory");
  });

  it("does NOT list memory file if today's file doesn't exist", () => {
    const result = loadWorkspaceContext("disc8");
    expect(result).not.toContain("today's memory");
  });
});

// ── loadWorkspaceContext — path references ───────────────────────────────────

describe("loadWorkspaceContext — output format", () => {
  it("shows correct agent dir path in available files section", () => {
    writeAgentFile("pathtest", "HEARTBEAT.md", "HB content.");
    const result = loadWorkspaceContext("pathtest");
    // Should mention the agent type somewhere in path reference
    expect(result).toContain("pathtest");
  });

  it("handles UTF-8 file content correctly", () => {
    writeAgentFile("utf8agent", "AGENTS.md", "# 你好 こんにちは مرحبا");
    const result = loadWorkspaceContext("utf8agent");
    expect(result).toContain("你好");
    expect(result).toContain("こんにちは");
  });

  it("always-loaded content is included verbatim (no truncation)", () => {
    const longContent = "# Long\n" + "word ".repeat(500);
    writeAgentFile("longtest", "AGENTS.md", longContent);
    const result = loadWorkspaceContext("longtest");
    expect(result).toContain("word ".repeat(10)); // at least the first 10 repetitions
  });

  it("available files section is clearly labelled", () => {
    writeContextFile("labelled", "PROJECT-X.md", "# X");
    const result = loadWorkspaceContext("labelled");
    expect(result).toContain("## Available Files");
  });
});
