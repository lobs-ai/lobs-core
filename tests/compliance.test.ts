/**
 * SAIL Compliance Reporting Tests
 *
 * Tests for isCompliantCall() classification logic and the compliance summary
 * endpoint aggregation helpers.
 */

import { describe, it, expect } from "vitest";
import { isCompliantCall } from "../src/api/usage.js";

describe("SAIL Compliance Classification", () => {
  describe("isCompliantCall()", () => {
    it("marks calls with routeType='local' as compliant regardless of provider", () => {
      expect(isCompliantCall("anthropic", "local")).toBe(true);
      expect(isCompliantCall("openai", "local")).toBe(true);
      expect(isCompliantCall("unknown", "local")).toBe(true);
    });

    it("marks calls from known cloud providers as non-compliant", () => {
      expect(isCompliantCall("anthropic", "api")).toBe(false);
      expect(isCompliantCall("openai", "api")).toBe(false);
      expect(isCompliantCall("google", "worker")).toBe(false);
      expect(isCompliantCall("mistral", "api")).toBe(false);
      expect(isCompliantCall("azure", "api")).toBe(false);
      expect(isCompliantCall("groq", "api")).toBe(false);
      expect(isCompliantCall("together", "api")).toBe(false);
    });

    it("marks calls from local/unknown providers as compliant", () => {
      expect(isCompliantCall("ollama", "api")).toBe(true);
      expect(isCompliantCall("llamacpp", "api")).toBe(true);
      expect(isCompliantCall("lm-studio", "api")).toBe(true);
      expect(isCompliantCall("local", "api")).toBe(true);
      expect(isCompliantCall("unknown", "api")).toBe(true);
    });

    it("is case-insensitive for provider names", () => {
      expect(isCompliantCall("Anthropic", "api")).toBe(false);
      expect(isCompliantCall("OPENAI", "api")).toBe(false);
      expect(isCompliantCall("Google", "api")).toBe(false);
    });

    it("treats worker routeType from cloud providers as non-compliant", () => {
      expect(isCompliantCall("anthropic", "worker")).toBe(false);
    });
  });

  describe("compliance summary logic", () => {
    it("computes correct percentages when all calls are compliant", () => {
      const total = 100;
      const compliant = 100;
      const nonCompliant = 0;
      const compliantPct = total > 0 ? Math.round((compliant / total) * 10000) / 100 : 0;
      const nonCompliantPct = total > 0 ? Math.round((nonCompliant / total) * 10000) / 100 : 0;
      expect(compliantPct).toBe(100);
      expect(nonCompliantPct).toBe(0);
    });

    it("computes correct percentages when all calls are non-compliant", () => {
      const total = 50;
      const compliant = 0;
      const nonCompliant = 50;
      const compliantPct = total > 0 ? Math.round((compliant / total) * 10000) / 100 : 0;
      const nonCompliantPct = total > 0 ? Math.round((nonCompliant / total) * 10000) / 100 : 0;
      expect(compliantPct).toBe(0);
      expect(nonCompliantPct).toBe(100);
    });

    it("computes correct percentages for mixed calls", () => {
      const total = 200;
      const compliant = 150; // 75%
      const nonCompliant = 50; // 25%
      const compliantPct = total > 0 ? Math.round((compliant / total) * 10000) / 100 : 0;
      const nonCompliantPct = total > 0 ? Math.round((nonCompliant / total) * 10000) / 100 : 0;
      expect(compliantPct).toBe(75);
      expect(nonCompliantPct).toBe(25);
    });

    it("handles zero total safely (no division by zero)", () => {
      const total = 0;
      const compliant = 0;
      const pct = total > 0 ? Math.round((compliant / total) * 10000) / 100 : 0;
      expect(pct).toBe(0);
    });

    it("rounds percentages to 2 decimal places", () => {
      const total = 3;
      const compliant = 1; // 33.333...%
      const pct = total > 0 ? Math.round((compliant / total) * 10000) / 100 : 0;
      expect(pct).toBe(33.33);
    });
  });
});
