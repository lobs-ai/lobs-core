import { describe, it, expect } from "vitest";
import { resolveToCwd } from "../src/runner/tools/path-utils.js";
import { resolve } from "node:path";

describe("resolveToCwd", () => {
  const HOME = process.env.HOME ?? "";

  it("resolves relative path against cwd", () => {
    const result = resolveToCwd("foo/bar.ts", "/workspace");
    expect(result).toBe(resolve("/workspace", "foo/bar.ts"));
  });

  it("returns absolute path as-is", () => {
    const result = resolveToCwd("/absolute/path.ts", "/workspace");
    expect(result).toBe("/absolute/path.ts");
  });

  it("expands tilde to HOME", () => {
    const result = resolveToCwd("~/docs/file.txt", "/workspace");
    expect(result).toBe(resolve(HOME, "docs/file.txt"));
  });

  it("handles tilde-only path", () => {
    const result = resolveToCwd("~", "/workspace");
    expect(result).toBe(HOME);
  });

  it("handles nested relative paths", () => {
    const result = resolveToCwd("../sibling/file.ts", "/workspace/project");
    expect(result).toBe(resolve("/workspace/project", "../sibling/file.ts"));
  });

  it("handles dot path", () => {
    const result = resolveToCwd(".", "/workspace");
    expect(result).toBe(resolve("/workspace"));
  });
});
