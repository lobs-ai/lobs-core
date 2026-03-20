import { describe, it, expect } from "vitest";
import { capOutput, DEFAULT_OUTPUT_CAP, DEFAULT_MAX_LINES } from "../src/runner/tools/output-cap.js";

describe("capOutput", () => {
  it("returns short output unchanged", () => {
    const result = capOutput("hello world");
    expect(result).toBe("hello world");
  });

  it("returns empty string unchanged", () => {
    expect(capOutput("")).toBe("");
  });

  it("truncates output exceeding maxChars", () => {
    const long = "x".repeat(100);
    const result = capOutput(long, 50);
    expect(result.length).toBeLessThan(100);
    expect(result).toContain("more lines");
  });

  it("truncates output exceeding maxLines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const result = capOutput(lines, 100000, 5);
    expect(result).toContain("[15 more lines truncated.]");
  });

  it("includes hint in truncation notice when provided", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const result = capOutput(lines, 100000, 5, "Use offset=5 to see more.");
    expect(result).toContain("Use offset=5 to see more.");
  });

  it("tries to break at line boundary when truncating by chars", () => {
    // Create lines that are 10 chars each (including newline)
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(4, "0")}`).join("\n");
    const result = capOutput(lines, 50, 10000);
    // Should contain truncation notice
    expect(result).toContain("more lines");
    // The main content (before truncation notice) should end at a line boundary
    const mainContent = result.split("\n\n[")[0];
    const lastLine = mainContent.split("\n").pop()!;
    // Each line is "line-NNNN" so a complete line should match that pattern
    expect(lastLine).toMatch(/^line-\d{4}$/);
  });

  it("uses default values when no options provided", () => {
    expect(DEFAULT_OUTPUT_CAP).toBe(50000);
    expect(DEFAULT_MAX_LINES).toBe(2000);
  });

  it("shows remaining line and char counts in char-truncation notice", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}: ${"x".repeat(50)}`).join("\n");
    const result = capOutput(lines, 500, 10000);
    expect(result).toMatch(/\d+ more lines/);
    expect(result).toMatch(/~\d+K chars/);
  });

  it("handles single-line output exceeding maxChars", () => {
    const long = "a".repeat(200);
    const result = capOutput(long, 50);
    expect(result.length).toBeLessThan(250); // original + notice
  });

  it("does not truncate when exactly at limits", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
    const result = capOutput(lines, 100000, 5);
    expect(result).toBe(lines);
  });
});
