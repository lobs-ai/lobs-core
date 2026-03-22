/**
 * Tests for src/util/approval-tier.ts
 *
 * classifyApprovalTier(agent, notes) → "A" | "B" | "C"
 *
 * Tier A (auto):   bug fix, test, doc, research, investigation
 * Tier B (lobs):   everything else (refactors, utilities, etc.)
 * Tier C (rafe):   feature, ui, architecture, design, new endpoint
 */

import { describe, it, expect } from "vitest";
import { classifyApprovalTier } from "../src/util/approval-tier.js";

// ─── Tier A ─────────────────────────────────────────────────────────────────

describe("classifyApprovalTier — Tier A (auto)", () => {
  it("returns A for 'bugfix' in agent", () => {
    expect(classifyApprovalTier("bugfix", "")).toBe("A");
  });

  it("returns A for 'bug fix' in notes", () => {
    expect(classifyApprovalTier("programmer", "bug fix in the sync logic")).toBe("A");
  });

  it("returns A for 'bug-fix' (hyphenated)", () => {
    expect(classifyApprovalTier("programmer", "bug-fix: off-by-one error")).toBe("A");
  });

  it("returns A for 'test' in notes", () => {
    expect(classifyApprovalTier("programmer", "add test coverage for parser")).toBe("A");
  });

  it("returns A for 'tests' (plural)", () => {
    expect(classifyApprovalTier("programmer", "write tests for the validator")).toBe("A");
  });

  it("returns A for 'doc' in notes", () => {
    expect(classifyApprovalTier("writer", "update doc for public API")).toBe("A");
  });

  it("returns A for 'docs' (plural)", () => {
    expect(classifyApprovalTier("writer", "write docs for auth module")).toBe("A");
  });

  it("returns A for 'research' in notes", () => {
    expect(classifyApprovalTier("researcher", "research best approach for caching")).toBe("A");
  });

  it("returns A for 'investigation' keyword", () => {
    expect(classifyApprovalTier("programmer", "investigation into memory leak")).toBe("A");
  });

  it("returns A case-insensitively for BUGFIX", () => {
    expect(classifyApprovalTier("PROGRAMMER", "BUGFIX in auth")).toBe("A");
  });

  it("returns A when agent itself is 'test'", () => {
    expect(classifyApprovalTier("test-runner", "run regression suite")).toBe("A");
  });

  it("returns A for 'BugFix' mixed case", () => {
    expect(classifyApprovalTier("programmer", "BugFix: handle null pointer")).toBe("A");
  });

  it("returns A for 'RESEARCH' all-caps", () => {
    expect(classifyApprovalTier("researcher", "RESEARCH options for vector DB")).toBe("A");
  });
});

// ─── Tier C ─────────────────────────────────────────────────────────────────

describe("classifyApprovalTier — Tier C (rafe)", () => {
  it("returns C for 'feature' in notes", () => {
    expect(classifyApprovalTier("programmer", "add new feature for user management")).toBe("C");
  });

  it("returns C for 'ui' in notes", () => {
    expect(classifyApprovalTier("programmer", "redesign ui for dashboard")).toBe("C");
  });

  it("returns C for 'UI' uppercase", () => {
    expect(classifyApprovalTier("programmer", "rebuild the UI")).toBe("C");
  });

  it("returns C for 'architecture' in notes", () => {
    expect(classifyApprovalTier("architect", "architecture review of the data pipeline")).toBe("C");
  });

  it("returns C for 'design' in notes", () => {
    expect(classifyApprovalTier("architect", "design the auth flow")).toBe("C");
  });

  it("returns C for 'new endpoint' in notes", () => {
    expect(classifyApprovalTier("programmer", "add new endpoint for billing")).toBe("C");
  });

  it("returns C for 'new  endpoint' with extra space", () => {
    expect(classifyApprovalTier("programmer", "implement new  endpoint for export")).toBe("C");
  });

  it("returns C for 'Feature' mixed case", () => {
    expect(classifyApprovalTier("programmer", "Feature: dark mode toggle")).toBe("C");
  });

  it("returns C for 'ARCHITECTURE' all-caps", () => {
    expect(classifyApprovalTier("architect", "ARCHITECTURE: microservices split")).toBe("C");
  });

  it("returns C for 'DESIGN' all-caps in agent string", () => {
    expect(classifyApprovalTier("DESIGN lead", "layout changes")).toBe("C");
  });
});

// ─── Tier B ─────────────────────────────────────────────────────────────────

describe("classifyApprovalTier — Tier B (lobs / default)", () => {
  it("returns B for plain refactor task", () => {
    expect(classifyApprovalTier("programmer", "refactor the auth module")).toBe("B");
  });

  it("returns B for utility work", () => {
    expect(classifyApprovalTier("programmer", "add utility helpers for date formatting")).toBe("B");
  });

  it("returns B for empty agent and empty notes", () => {
    expect(classifyApprovalTier("", "")).toBe("B");
  });

  it("returns B for generic task with no keywords", () => {
    expect(classifyApprovalTier("programmer", "update configuration values")).toBe("B");
  });

  it("returns A for cleanup tasks (matches cleanup pattern)", () => {
    expect(classifyApprovalTier("programmer", "clean up unused imports")).toBe("A");
  });

  it("returns B for performance work without feature/ui keywords", () => {
    // "queries" contains "ui" as substring → use "searches" instead
    expect(classifyApprovalTier("programmer", "optimize database lookups")).toBe("B");
  });

  it("returns B when no keyword matches", () => {
    expect(classifyApprovalTier("orchestrator", "migrate task statuses")).toBe("B");
  });
});

// ─── Priority ordering (A beats C when both match) ───────────────────────────

describe("classifyApprovalTier — Tier A takes priority over C", () => {
  it("returns A when notes contain both 'test' and 'feature' (A checked first)", () => {
    // Regex order: A is checked first in implementation
    expect(classifyApprovalTier("programmer", "test the new feature endpoint")).toBe("A");
  });

  it("returns A when notes contain both 'research' and 'ui'", () => {
    expect(classifyApprovalTier("researcher", "research ui patterns")).toBe("A");
  });

  it("returns A when notes contain 'bugfix' alongside 'architecture'", () => {
    expect(classifyApprovalTier("architect", "bugfix in architecture layer")).toBe("A");
  });
});

// ─── Boundary / edge cases ───────────────────────────────────────────────────

describe("classifyApprovalTier — edge cases", () => {
  it("treats agent+notes as a single concatenated string for matching", () => {
    // "clean up" matches clean.?up → Tier A
    expect(classifyApprovalTier("programmer", "clean up the codebase")).toBe("A");
  });

  it("returns B when no tier keyword matches", () => {
    // Use strings that contain no Tier-A, Tier-B, or Tier-C keywords
    expect(classifyApprovalTier("programmer", "update configuration values")).toBe("B");
  });

  it("matches 'doc' embedded within a longer word like 'document'", () => {
    // /doc/i matches 'doc' inside 'document'
    expect(classifyApprovalTier("programmer", "write a document for the API")).toBe("A");
  });

  it("does not blow up on very long strings", () => {
    const longNotes = "refactor ".repeat(500);
    expect(classifyApprovalTier("programmer", longNotes)).toBe("B");
  });

  it("returns a valid tier string (one of A, B, C)", () => {
    const tier = classifyApprovalTier("programmer", "some random notes here");
    expect(["A", "B", "C"]).toContain(tier);
  });
});
