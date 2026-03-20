import { describe, it, expect } from "vitest";
import {
  classifyTaskLane,
  classifyModelLane,
  LANE_CRITICAL,
  LANE_STANDARD,
  LANE_BACKGROUND,
} from "../src/orchestrator/budget-guard.js";

describe("Budget Guard", () => {
  describe("classifyTaskLane", () => {
    it("returns critical for high criticality", () => {
      expect(classifyTaskLane("programmer", "high")).toBe(LANE_CRITICAL);
    });

    it("returns critical for strong model tier", () => {
      expect(classifyTaskLane("programmer", "normal", "strong")).toBe(LANE_CRITICAL);
    });

    it("returns background for writer agents", () => {
      expect(classifyTaskLane("writer", "normal")).toBe(LANE_BACKGROUND);
    });

    it("returns background for reviewer agents", () => {
      expect(classifyTaskLane("reviewer", "normal")).toBe(LANE_BACKGROUND);
    });

    it("returns standard for programmer with normal criticality", () => {
      expect(classifyTaskLane("programmer", "normal")).toBe(LANE_STANDARD);
    });

    it("returns standard for researcher with normal criticality", () => {
      expect(classifyTaskLane("researcher", "normal")).toBe(LANE_STANDARD);
    });

    it("returns standard for main agent", () => {
      expect(classifyTaskLane("main", "normal")).toBe(LANE_STANDARD);
    });

    it("critical trumps background agent type", () => {
      // Even a writer with high criticality should be critical
      expect(classifyTaskLane("writer", "high")).toBe(LANE_CRITICAL);
    });
  });

  describe("classifyModelLane", () => {
    it("classifies opus as critical", () => {
      expect(classifyModelLane("claude-3-opus-20240229")).toBe(LANE_CRITICAL);
    });

    it("classifies gpt-5 as critical", () => {
      expect(classifyModelLane("gpt-5-turbo")).toBe(LANE_CRITICAL);
    });

    it("classifies o3 as critical", () => {
      expect(classifyModelLane("o3-mini")).toBe(LANE_CRITICAL);
    });

    it("classifies haiku as background", () => {
      expect(classifyModelLane("claude-3-haiku-20240307")).toBe(LANE_BACKGROUND);
    });

    it("classifies mini models as background", () => {
      expect(classifyModelLane("gpt-4o-mini")).toBe(LANE_BACKGROUND);
    });

    it("classifies ollama as background", () => {
      expect(classifyModelLane("ollama/llama3")).toBe(LANE_BACKGROUND);
    });

    it("classifies qwen as background", () => {
      expect(classifyModelLane("qwen-72b")).toBe(LANE_BACKGROUND);
    });

    it("classifies sonnet as standard", () => {
      expect(classifyModelLane("claude-3-5-sonnet-20241022")).toBe(LANE_STANDARD);
    });

    it("classifies gpt-4 as standard", () => {
      expect(classifyModelLane("gpt-4-turbo")).toBe(LANE_STANDARD);
    });

    it("classifies unknown models as standard", () => {
      expect(classifyModelLane("some-new-model")).toBe(LANE_STANDARD);
    });
  });

  describe("lane constants", () => {
    it("has expected values", () => {
      expect(LANE_CRITICAL).toBe("critical");
      expect(LANE_STANDARD).toBe("standard");
      expect(LANE_BACKGROUND).toBe("background");
    });
  });
});
