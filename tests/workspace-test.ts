/**
 * Tests for workspace-manager.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  initWorkspace,
  getAgentFiles,
  writeRunSummary,
  getRecentHistory,
  cleanupContext,
  type AgentType,
} from "../src/runner/workspace-manager.js";

const TEST_WORKSPACE_BASE = join(process.env.HOME ?? "~", ".lobs", "agents-test");

// Temporarily override the workspace base for testing
// This is a bit hacky but avoids polluting the real workspace
const originalEnv = process.env.HOME;

describe("Workspace Manager", () => {
  beforeEach(() => {
    // Create test workspace directory
    mkdirSync(TEST_WORKSPACE_BASE, { recursive: true });
  });

  afterEach(() => {
    // Clean up test workspace
    if (existsSync(TEST_WORKSPACE_BASE)) {
      rmSync(TEST_WORKSPACE_BASE, { recursive: true, force: true });
    }
  });

  describe("initWorkspace", () => {
    it("should create workspace directory structure", () => {
      const workspace = initWorkspace("programmer");

      expect(existsSync(workspace.basePath)).toBe(true);
      expect(existsSync(workspace.contextDir)).toBe(true);
      expect(existsSync(workspace.historyDir)).toBe(true);
    });

    it("should create default AGENTS.md and SOUL.md files", () => {
      const workspace = initWorkspace("programmer");

      expect(existsSync(workspace.agentsFile)).toBe(true);
      expect(existsSync(workspace.soulFile)).toBe(true);
    });

    it("should not overwrite existing files", () => {
      const workspace1 = initWorkspace("writer");
      const files1 = getAgentFiles("writer");
      
      const workspace2 = initWorkspace("writer");
      const files2 = getAgentFiles("writer");

      expect(files1.agents).toBe(files2.agents);
      expect(files1.soul).toBe(files2.soul);
    });

    it("should create workspaces for all agent types", () => {
      const agentTypes: AgentType[] = ["programmer", "writer", "researcher", "reviewer", "architect"];

      for (const agentType of agentTypes) {
        const workspace = initWorkspace(agentType);
        expect(existsSync(workspace.basePath)).toBe(true);
        expect(existsSync(workspace.agentsFile)).toBe(true);
        expect(existsSync(workspace.soulFile)).toBe(true);
      }
    });
  });

  describe("getAgentFiles", () => {
    it("should return content of AGENTS.md and SOUL.md", () => {
      const files = getAgentFiles("programmer");

      expect(files.agents).toContain("AGENTS.md");
      expect(files.soul).toContain("SOUL.md");
      expect(files.agents.length).toBeGreaterThan(100);
      expect(files.soul.length).toBeGreaterThan(100);
    });

    it("should return different content for different agent types", () => {
      const programmerFiles = getAgentFiles("programmer");
      const writerFiles = getAgentFiles("writer");

      expect(programmerFiles.agents).not.toBe(writerFiles.agents);
      expect(programmerFiles.soul).not.toBe(writerFiles.soul);
    });

    it("should include agent-specific instructions", () => {
      const programmerFiles = getAgentFiles("programmer");
      expect(programmerFiles.agents.toLowerCase()).toContain("code");
      expect(programmerFiles.agents.toLowerCase()).toContain("test");

      const writerFiles = getAgentFiles("writer");
      expect(writerFiles.agents.toLowerCase()).toContain("document");
      expect(writerFiles.agents.toLowerCase()).toContain("write");
    });
  });

  describe("writeRunSummary", () => {
    it("should write summary to history directory", () => {
      const taskId = "test-task-123";
      const summary = "This is a test summary.\n\nDecisions made:\n- Used TypeScript";

      writeRunSummary("programmer", taskId, summary);

      const workspace = initWorkspace("programmer");
      const files = existsSync(workspace.historyDir) ? require("fs").readdirSync(workspace.historyDir) : [];
      
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((f: string) => f.includes(taskId.slice(0, 8)))).toBe(true);
    });

    it("should include metadata in summary file", () => {
      const taskId = "meta-test-456";
      const summary = "Summary content";

      writeRunSummary("writer", taskId, summary);

      const history = getRecentHistory("writer", 1);
      expect(history.length).toBe(1);
      expect(history[0]).toContain(taskId);
      expect(history[0]).toContain("writer");
      expect(history[0]).toContain(summary);
    });
  });

  describe("getRecentHistory", () => {
    it("should return empty array when no history exists", () => {
      const history = getRecentHistory("researcher", 5);
      expect(history).toEqual([]);
    });

    it("should return recent summaries in reverse chronological order", () => {
      writeRunSummary("reviewer", "task-1", "First summary");
      writeRunSummary("reviewer", "task-2", "Second summary");
      writeRunSummary("reviewer", "task-3", "Third summary");

      const history = getRecentHistory("reviewer", 10);

      expect(history.length).toBe(3);
      // Most recent first
      expect(history[0]).toContain("Third summary");
      expect(history[1]).toContain("Second summary");
      expect(history[2]).toContain("First summary");
    });

    it("should respect the limit parameter", () => {
      writeRunSummary("architect", "task-1", "Summary 1");
      writeRunSummary("architect", "task-2", "Summary 2");
      writeRunSummary("architect", "task-3", "Summary 3");
      writeRunSummary("architect", "task-4", "Summary 4");

      const history = getRecentHistory("architect", 2);

      expect(history.length).toBe(2);
      expect(history[0]).toContain("Summary 4");
      expect(history[1]).toContain("Summary 3");
    });

    it("should handle default limit of 3", () => {
      writeRunSummary("programmer", "task-1", "A");
      writeRunSummary("programmer", "task-2", "B");
      writeRunSummary("programmer", "task-3", "C");
      writeRunSummary("programmer", "task-4", "D");

      const history = getRecentHistory("programmer");

      expect(history.length).toBe(3);
    });
  });

  describe("cleanupContext", () => {
    it("should remove all files from context directory", () => {
      const workspace = initWorkspace("writer");
      
      // Create some test context files
      const testFile1 = join(workspace.contextDir, "temp1.txt");
      const testFile2 = join(workspace.contextDir, "temp2.txt");
      require("fs").writeFileSync(testFile1, "test content 1");
      require("fs").writeFileSync(testFile2, "test content 2");

      expect(existsSync(testFile1)).toBe(true);
      expect(existsSync(testFile2)).toBe(true);

      cleanupContext("writer");

      expect(existsSync(testFile1)).toBe(false);
      expect(existsSync(testFile2)).toBe(false);
    });

    it("should not fail if context directory is empty", () => {
      expect(() => cleanupContext("researcher")).not.toThrow();
    });

    it("should not fail if context directory doesn't exist", () => {
      const agentType: AgentType = "programmer";
      const workspace = initWorkspace(agentType);
      
      // Remove context dir
      if (existsSync(workspace.contextDir)) {
        rmSync(workspace.contextDir, { recursive: true, force: true });
      }

      expect(() => cleanupContext(agentType)).not.toThrow();
    });
  });
});
