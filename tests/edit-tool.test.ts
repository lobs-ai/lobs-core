import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { editTool } from "../src/runner/tools/edit.js";
import { readTool, clearRecentReadTracking } from "../src/runner/tools/read.js";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("editTool", () => {
  const testDir = join(tmpdir(), "lobs-edit-test-" + Date.now());
  const testFile = join(testDir, "test.txt");

  beforeEach(() => {
    clearRecentReadTracking();
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testFile, [
      "line 1: hello world",
      "line 2: foo bar",
      "line 3: baz qux",
      "line 4: end of file",
    ].join("\n"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("replaces exact match", async () => {
    await readTool({ path: testFile }, testDir);
    const result = await editTool(
      { path: testFile, old_string: "foo bar", new_string: "replaced" },
      testDir,
    );
    const content = readFileSync(testFile, "utf-8");
    expect(content).toContain("replaced");
    expect(content).not.toContain("foo bar");
    expect(result).toContain("Edit applied");
  });

  it("shows diff output", async () => {
    await readTool({ path: testFile }, testDir);
    const result = await editTool(
      { path: testFile, old_string: "foo bar", new_string: "replaced" },
      testDir,
    );
    expect(result).toContain("-");
    expect(result).toContain("+");
    expect(result).toContain("@@");
  });

  it("throws when old_string not found (and new_string not present)", async () => {
    await readTool({ path: testFile }, testDir);
    await expect(
      editTool({ path: testFile, old_string: "nonexistent", new_string: "totally_unique_text" }, testDir),
    ).rejects.toThrow("Could not find the specified text");
  });

  it("throws when file does not exist", async () => {
    await expect(
      editTool({ path: join(testDir, "missing.txt"), old_string: "x", new_string: "y" }, testDir),
    ).rejects.toThrow("File not found");
  });

  it("detects idempotent edit (new_string already exists)", async () => {
    await readTool({ path: testFile }, testDir);
    const result = await editTool(
      { path: testFile, old_string: "nonexistent text", new_string: "hello world" },
      testDir,
    );
    expect(result).toContain("already exists");
  });

  it("throws on multiple matches", async () => {
    writeFileSync(testFile, "hello\nhello\nworld");
    await readTool({ path: testFile }, testDir);
    await expect(
      editTool({ path: testFile, old_string: "hello", new_string: "hi" }, testDir),
    ).rejects.toThrow("multiple matches");
  });

  it("handles multi-line replacements", async () => {
    await readTool({ path: testFile }, testDir);
    const result = await editTool(
      {
        path: testFile,
        old_string: "line 2: foo bar\nline 3: baz qux",
        new_string: "line 2: new content\nline 3: also new\nline 3.5: inserted",
      },
      testDir,
    );
    const content = readFileSync(testFile, "utf-8");
    expect(content).toContain("new content");
    expect(content).toContain("inserted");
    expect(result).toContain("2 lines → 3 lines");
  });

  it("throws when path is missing", async () => {
    await expect(
      editTool({ old_string: "x", new_string: "y" }, testDir),
    ).rejects.toThrow("path is required");
  });

  it("throws when old_string is missing", async () => {
    await expect(
      editTool({ path: testFile, new_string: "y" }, testDir),
    ).rejects.toThrow("old_string is required");
  });

  it("resolves relative paths against cwd", async () => {
    await readTool({ path: "test.txt" }, testDir);
    const result = await editTool(
      { path: "test.txt", old_string: "foo bar", new_string: "replaced" },
      testDir,
    );
    const content = readFileSync(testFile, "utf-8");
    expect(content).toContain("replaced");
    expect(result).toContain("Edit applied");
  });

  it("suggests fuzzy match when whitespace differs", async () => {
    writeFileSync(testFile, "  function hello() {\n    return 1;\n  }");
    await readTool({ path: testFile }, testDir);
    await expect(
      editTool(
        { path: testFile, old_string: "function hello() {\n  return 1;\n}", new_string: "x" },
        testDir,
      ),
    ).rejects.toThrow("Did you mean");
  });

  it("rejects empty old_string", async () => {
    await readTool({ path: testFile }, testDir);
    await expect(
      editTool({ path: testFile, old_string: "", new_string: "x" }, testDir),
    ).rejects.toThrow("must not be empty");
  });

  it("rejects duplicate batch edits", async () => {
    await readTool({ path: testFile }, testDir);
    await expect(
      editTool({
        path: testFile,
        edits: [
          { old_string: "foo bar", new_string: "alpha" },
          { old_string: "foo bar", new_string: "alpha" },
        ],
      }, testDir),
    ).rejects.toThrow("duplicates an earlier edit");
  });

  it("rejects brittle overlapping batch edits", async () => {
    await readTool({ path: testFile }, testDir);
    await expect(
      editTool({
        path: testFile,
        edits: [
          { old_string: "foo bar", new_string: "alpha" },
          { old_string: "alpha", new_string: "beta" },
        ],
      }, testDir),
    ).rejects.toThrow("likely brittle");
  });

  it("requires a prior read before editing", async () => {
    await expect(
      editTool({ path: testFile, old_string: "foo bar", new_string: "replaced" }, testDir),
    ).rejects.toThrow("You must use Read");
  });
});
