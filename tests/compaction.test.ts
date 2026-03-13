/**
 * Tests for session compaction in context-engine.ts
 */

import { describe, it, expect } from "vitest";
import { compactSession, formatCompactedSession } from "../src/runner/context-engine.js";

describe("Session Compaction", () => {
  describe("compactSession", () => {
    it("should extract decisions from conversation", () => {
      const messages = [
        { role: "user", content: "What should we use for the database?" },
        { role: "assistant", content: "After comparing options, I decided to use PostgreSQL for better JSON support." },
      ];

      const compacted = compactSession(messages);

      expect(compacted.decisionsMade.length).toBeGreaterThan(0);
      expect(compacted.decisionsMade.some(d => d.includes("PostgreSQL"))).toBe(true);
    });

    it("should extract failed approaches", () => {
      const messages = [
        { role: "assistant", content: "Tried using SQLite but it failed due to concurrent write issues." },
        { role: "assistant", content: "The filesystem approach didn't work because of permission errors." },
      ];

      const compacted = compactSession(messages);

      expect(compacted.failedApproaches.length).toBeGreaterThan(0);
      expect(compacted.failedApproaches.some(f => f.toLowerCase().includes("sqlite") || f.toLowerCase().includes("concurrent"))).toBe(true);
    });

    it("should extract key findings", () => {
      const messages = [
        { role: "assistant", content: "I found that the API returns a 429 rate limit error after 100 requests per minute." },
        { role: "assistant", content: "Discovered that the cache invalidation happens on every write." },
      ];

      const compacted = compactSession(messages);

      expect(compacted.keyFindings.length).toBeGreaterThan(0);
      expect(compacted.keyFindings.some(f => f.includes("429") || f.includes("rate limit"))).toBe(true);
    });

    it("should extract current state", () => {
      const messages = [
        { role: "assistant", content: "Currently have implemented the authentication middleware successfully." },
        { role: "assistant", content: "The API is now responding with proper CORS headers." },
      ];

      const compacted = compactSession(messages);

      expect(compacted.currentState.length).toBeGreaterThan(0);
    });

    it("should extract remaining work", () => {
      const messages = [
        { role: "assistant", content: "Still need to add error handling for network timeouts." },
        { role: "assistant", content: "Must implement retry logic before shipping." },
        { role: "assistant", content: "TODO: Add integration tests for the payment flow." },
      ];

      const compacted = compactSession(messages);

      expect(compacted.remainingWork.length).toBeGreaterThan(0);
      expect(compacted.remainingWork.some(r => r.toLowerCase().includes("error") || r.toLowerCase().includes("retry") || r.toLowerCase().includes("test"))).toBe(true);
    });

    it("should handle empty messages", () => {
      const messages: Array<{ role: string; content: string }> = [];

      const compacted = compactSession(messages);

      expect(compacted.decisionsMade).toEqual([]);
      expect(compacted.failedApproaches).toEqual([]);
      expect(compacted.keyFindings).toEqual([]);
      expect(compacted.currentState).toEqual([]);
      expect(compacted.remainingWork).toEqual([]);
    });

    it("should deduplicate similar entries", () => {
      const messages = [
        { role: "assistant", content: "Decided to use Redis for caching." },
        { role: "assistant", content: "Going with Redis for the cache layer." },
        { role: "assistant", content: "Choosing Redis as the caching solution." },
      ];

      const compacted = compactSession(messages);

      // Should deduplicate very similar decisions
      expect(compacted.decisionsMade.length).toBeLessThanOrEqual(3);
    });

    it("should limit each category to 10 items", () => {
      const messages = Array.from({ length: 20 }, (_, i) => ({
        role: "assistant",
        content: `Decided to implement feature ${i} this way.`,
      }));

      const compacted = compactSession(messages);

      expect(compacted.decisionsMade.length).toBeLessThanOrEqual(10);
    });

    it("should handle complex real-world conversation", () => {
      const messages = [
        { role: "user", content: "Can you implement user authentication?" },
        { role: "assistant", content: "I'll start by researching authentication patterns." },
        { role: "assistant", content: "Found that JWT is the most common approach for stateless auth." },
        { role: "assistant", content: "Tried implementing basic auth but realized it doesn't work for SPA." },
        { role: "assistant", content: "Decided to use JWT tokens with refresh tokens for better security." },
        { role: "assistant", content: "Currently have implemented the token generation logic." },
        { role: "assistant", content: "Still need to add token refresh endpoint and expiration handling." },
        { role: "assistant", content: "Discovered that tokens should be stored in httpOnly cookies to prevent XSS." },
      ];

      const compacted = compactSession(messages);

      expect(compacted.decisionsMade.length).toBeGreaterThan(0);
      expect(compacted.failedApproaches.length).toBeGreaterThan(0);
      expect(compacted.keyFindings.length).toBeGreaterThan(0);
      expect(compacted.currentState.length).toBeGreaterThan(0);
      expect(compacted.remainingWork.length).toBeGreaterThan(0);
    });
  });

  describe("formatCompactedSession", () => {
    it("should format compacted session into readable text", () => {
      const compacted = {
        decisionsMade: ["Use PostgreSQL for database"],
        failedApproaches: ["SQLite had concurrency issues"],
        keyFindings: ["API has 100 req/min rate limit"],
        currentState: ["Authentication middleware working"],
        remainingWork: ["Add retry logic", "Write tests"],
      };

      const formatted = formatCompactedSession(compacted);

      expect(formatted).toContain("DECISIONS MADE:");
      expect(formatted).toContain("FAILED APPROACHES:");
      expect(formatted).toContain("KEY FINDINGS:");
      expect(formatted).toContain("CURRENT STATE:");
      expect(formatted).toContain("REMAINING WORK:");
      expect(formatted).toContain("PostgreSQL");
      expect(formatted).toContain("SQLite");
      expect(formatted).toContain("rate limit");
    });

    it("should omit empty sections", () => {
      const compacted = {
        decisionsMade: ["Use Redis"],
        failedApproaches: [],
        keyFindings: [],
        currentState: [],
        remainingWork: [],
      };

      const formatted = formatCompactedSession(compacted);

      expect(formatted).toContain("DECISIONS MADE:");
      expect(formatted).not.toContain("FAILED APPROACHES:");
      expect(formatted).not.toContain("KEY FINDINGS:");
    });

    it("should handle completely empty compaction", () => {
      const compacted = {
        decisionsMade: [],
        failedApproaches: [],
        keyFindings: [],
        currentState: [],
        remainingWork: [],
      };

      const formatted = formatCompactedSession(compacted);

      expect(formatted).toBe("");
    });
  });
});
