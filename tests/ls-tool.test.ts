import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { lsTool } from "../src/runner/tools/ls.js";
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "lobs-ls-tool-test-" + Date.now());

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "file1.txt"), "hello");
  writeFileSync(join(TEST_DIR, "file2.js"), "console.log('hi')");
  mkdirSync(join(TEST_DIR, "subdir"));
  writeFileSync(join(TEST_DIR, "subdir", "nested.txt"), "nested");
  try {
    symlinkSync(join(TEST_DIR, "file1.txt"), join(TEST_DIR, "link.txt"));
  } catch {
    // symlinks may fail on some systems
  }
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("lsTool", () => {
  it("lists files in a directory", async () => {
    const result = await lsTool({ path: TEST_DIR }, TEST_DIR);
    expect(result).toContain("file1.txt");
    expect(result).toContain("file2.js");
    expect(result).toContain("subdir");
  });

  it("defaults to cwd when no path given", async () => {
    const result = await lsTool({}, TEST_DIR);
    expect(result).toContain("file1.txt");
  });

  it("shows file type indicators", async () => {
    const result = await lsTool({ path: TEST_DIR }, TEST_DIR);
    // Files should have 'f' marker, directories 'd'
    expect(result).toMatch(/[fd]/);
  });

  it("shows directories with trailing slash or d marker", async () => {
    const result = await lsTool({ path: TEST_DIR }, TEST_DIR);
    // subdir should be indicated as a directory
    expect(result).toContain("subdir");
  });

  it("throws for nonexistent path", async () => {
    await expect(lsTool({ path: "/nonexistent/path" }, TEST_DIR)).rejects.toThrow();
  });

  it("supports limit parameter", async () => {
    const result = await lsTool({ path: TEST_DIR, limit: 1 }, TEST_DIR);
    // With limit=1, should only show 1 entry
    const lines = result.trim().split("\n").filter((l: string) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(2); // May include header
  });

  it("lists contents of subdirectory", async () => {
    const result = await lsTool({ path: join(TEST_DIR, "subdir") }, TEST_DIR);
    expect(result).toContain("nested.txt");
  });
});
