import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readTool } from "../src/runner/tools/read.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "lobs-read-tool-test-" + Date.now());

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });

  // Small file
  writeFileSync(join(TEST_DIR, "small.txt"), "line1\nline2\nline3\n");

  // 1000-line file
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
  writeFileSync(join(TEST_DIR, "large.txt"), lines);

  // Binary file
  const binary = Buffer.alloc(100);
  binary[50] = 0; // null byte
  writeFileSync(join(TEST_DIR, "binary.bin"), binary);

  // Empty file
  writeFileSync(join(TEST_DIR, "empty.txt"), "");

  // Subdirectory
  mkdirSync(join(TEST_DIR, "subdir"), { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readTool", () => {
  it("reads a small file", async () => {
    const result = await readTool({ path: "small.txt" }, TEST_DIR);
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("line3");
  });

  it("throws for missing file", async () => {
    await expect(readTool({ path: "nonexistent.txt" }, TEST_DIR)).rejects.toThrow("not found");
  });

  it("throws for directory path", async () => {
    await expect(readTool({ path: "subdir" }, TEST_DIR)).rejects.toThrow("directory");
  });

  it("throws when path is missing", async () => {
    await expect(readTool({}, TEST_DIR)).rejects.toThrow("required");
  });

  it("detects binary files", async () => {
    const result = await readTool({ path: "binary.bin" }, TEST_DIR);
    expect(result).toContain("Binary file");
    expect(result).toContain("100 bytes");
  });

  it("reads an empty file without error", async () => {
    const result = await readTool({ path: "empty.txt" }, TEST_DIR);
    expect(typeof result).toBe("string");
  });

  it("supports offset parameter (1-indexed)", async () => {
    const result = await readTool({ path: "large.txt", offset: 500 }, TEST_DIR);
    expect(result).toContain("line 500");
    expect(result).not.toContain("line 1\n");
  });

  it("supports limit parameter", async () => {
    const result = await readTool({ path: "large.txt", offset: 1, limit: 5 }, TEST_DIR);
    expect(result).toContain("line 1");
    expect(result).toContain("line 5");
    // Shouldn't contain line 10 in the main content
    const mainContent = result.split("[")[0];
    expect(mainContent).not.toContain("line 10");
  });

  it("supports full=true for complete file content", async () => {
    const result = await readTool({ path: "large.txt", full: true }, TEST_DIR);
    expect(result).toContain("line 1");
    expect(result).toContain("line 1000");
  });

  it("default read truncates large files", async () => {
    const result = await readTool({ path: "large.txt" }, TEST_DIR);
    // Default limit is 500 lines, file has 1000
    expect(result).toContain("line 1");
    // Should have truncation notice
    expect(result).toContain("more lines");
  });

  it("shows metadata for partial reads", async () => {
    const result = await readTool({ path: "large.txt", offset: 1, limit: 10 }, TEST_DIR);
    expect(result).toContain("Lines");
    expect(result).toContain("more lines");
  });

  it("handles offset beyond file length gracefully", async () => {
    const result = await readTool({ path: "large.txt", offset: 5000 }, TEST_DIR);
    expect(typeof result).toBe("string");
  });

  it("handles absolute paths", async () => {
    const result = await readTool({ path: join(TEST_DIR, "small.txt"), full: true }, TEST_DIR);
    expect(result).toContain("line1");
  });

  it("returns full content on repeated reads of the same file region (no unchanged stub)", async () => {
    const first = await readTool({ path: "small.txt", offset: 1, limit: 2 }, TEST_DIR);
    const second = await readTool({ path: "small.txt", offset: 1, limit: 2 }, TEST_DIR);

    expect(first).toContain("line1");
    // readTool always returns full content — no "File unchanged" stub behavior
    expect(second).toContain("line1");
  });

  it("invalidates the repeated-read cache after the file changes", async () => {
    await readTool({ path: "small.txt", offset: 1, limit: 2 }, TEST_DIR);
    writeFileSync(join(TEST_DIR, "small.txt"), "line1\nline2 changed\nline3\n");

    const result = await readTool({ path: "small.txt", offset: 1, limit: 2 }, TEST_DIR);
    expect(result).toContain("line2 changed");
  });
});
