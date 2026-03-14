/**
 * Tests for tool-sets.ts (session type detection and tool filtering)
 */

import { describe, it, expect } from "vitest";
import { getSessionType, getToolsForSession } from "../src/runner/tools/tool-sets.js";

describe("Tool Sets", () => {
  describe("getSessionType", () => {
    it("should detect nexus session type from nexus:main", () => {
      const result = getSessionType("nexus:main");
      expect(result).toBe("nexus");
    });

    it("should detect nexus session type from nexus:chat-abc123", () => {
      const result = getSessionType("nexus:chat-abc123");
      expect(result).toBe("nexus");
    });

    it("should detect discord session type from Discord snowflake", () => {
      const result = getSessionType("1480648170647195869");
      expect(result).toBe("discord");
    });

    it("should detect system session type", () => {
      const result = getSessionType("system");
      expect(result).toBe("system");
    });

    it("should detect nexus session type from api-request-123", () => {
      const result = getSessionType("api-request-123");
      expect(result).toBe("nexus");
    });

    it("should default to discord for unknown channel IDs", () => {
      const result = getSessionType("some-random-channel-id");
      expect(result).toBe("discord");
    });
  });

  describe("getToolsForSession", () => {
    it("should exclude Discord tools from nexus sessions", () => {
      const tools = getToolsForSession("nexus");
      
      expect(tools).not.toContain("message");
      expect(tools).not.toContain("react");
    });

    it("should include message and react in Discord sessions", () => {
      const tools = getToolsForSession("discord");
      
      expect(tools).toContain("message");
      expect(tools).toContain("react");
    });

    it("should include cron in system sessions", () => {
      const tools = getToolsForSession("system");
      
      expect(tools).toContain("cron");
    });

    it("should include exec in all session types", () => {
      const types: Array<"nexus" | "discord" | "dm" | "system"> = ["nexus", "discord", "dm", "system"];
      
      for (const type of types) {
        const tools = getToolsForSession(type);
        expect(tools).toContain("exec");
      }
    });

    it("should include process in all session types", () => {
      const types: Array<"nexus" | "discord" | "dm" | "system"> = ["nexus", "discord", "dm", "system"];
      
      for (const type of types) {
        const tools = getToolsForSession(type);
        expect(tools).toContain("process");
      }
    });

    it("should include read, write, edit in all session types", () => {
      const types: Array<"nexus" | "discord" | "dm" | "system"> = ["nexus", "discord", "dm", "system"];
      
      for (const type of types) {
        const tools = getToolsForSession(type);
        expect(tools).toContain("read");
        expect(tools).toContain("write");
        expect(tools).toContain("edit");
      }
    });

    it("should include memory tools in all session types", () => {
      const types: Array<"nexus" | "discord" | "dm" | "system"> = ["nexus", "discord", "dm", "system"];
      
      for (const type of types) {
        const tools = getToolsForSession(type);
        expect(tools).toContain("memory_search");
        expect(tools).toContain("memory_read");
      }
    });

    it("should have different tool counts for different session types", () => {
      const nexusTools = getToolsForSession("nexus");
      const discordTools = getToolsForSession("discord");
      const systemTools = getToolsForSession("system");
      
      // Discord should have more tools than nexus (adds message, react)
      expect(discordTools.length).toBeGreaterThan(nexusTools.length);
      
      // System should have more tools than discord (adds cron)
      expect(systemTools.length).toBeGreaterThan(discordTools.length);
    });

    it("should return same tools for discord and dm sessions", () => {
      const discordTools = getToolsForSession("discord");
      const dmTools = getToolsForSession("dm");
      
      expect(discordTools).toEqual(dmTools);
    });
  });
});
