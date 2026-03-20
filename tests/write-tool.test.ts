import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeTool } from "../src/runner/tools/write.js";
import { readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "lobs-write-tool-test-" + Date.now());

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("writeTool", () => {
  it("creates a new file", async () => {
    const path = "newfile.txt";
    await writeTool({ path, content: "hello world" }, TEST_DIR);
    expect(readFileSync(join(TEST_DIR, path), "utf-8")).toBe("hello world");
  });

  it("overwrites existing file", async () => {
    const path = "overwrite.txt";
    await writeTool({ path, content: "first" }, TEST_DIR);
    await writeTool({ path, content: "second" }, TEST_DIR);
    expect(readFileSync(join(TEST_DIR, path), "utf-8")).toBe("second");
  });

  it("creates parent directories", async () => {
    const path = "deep/nested/dir/file.txt";
    await writeTool({ path, content: "nested content" }, TEST_DIR);
    expect(readFileSync(join(TEST_DIR, path), "utf-8")).toBe("nested content");
  });

  it("throws when path is missing", async () => {
    await expect(writeTool({ content: "x" }, TEST_DIR)).rejects.toThrow();
  });

  it("throws when content is missing", async () => {
    await expect(writeTool({ path: "nodata.txt" }, TEST_DIR)).rejects.toThrow();
  });

  it("handles empty content", async () => {
    const path = "empty.txt";
    await writeTool({ path, content: "" }, TEST_DIR);
    expect(readFileSync(join(TEST_DIR, path), "utf-8")).toBe("");
  });

  it("handles content with special characters", async () => {
    const path = "special.txt";
    const content = "line1\nline2\ttab\r\nwindows\n";
    await writeTool({ path, content }, TEST_DIR);
    expect(readFileSync(join(TEST_DIR, path), "utf-8")).toBe(content);
  });

  it("returns a confirmation message", async () => {
    const result = await writeTool({ path: "confirm.txt", content: "x" }, TEST_DIR);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
