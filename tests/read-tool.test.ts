import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTool } from "../src/runner/tools/read.js";

describe("readTool", () => {
  it("returns a preview by default for larger files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobs-read-tool-"));
    try {
      const path = join(dir, "large.txt");
      const content = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n");
      writeFileSync(path, content, "utf-8");

      const result = await readTool({ path }, dir);

      expect(result).toContain("line 1");
      expect(result).toContain("line 500");
      expect(result).toContain("[Lines 1-500 of 600.");
      expect(result).not.toContain("line 501");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the whole file when full=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobs-read-tool-"));
    try {
      const path = join(dir, "full.txt");
      const content = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n");
      writeFileSync(path, content, "utf-8");

      const result = await readTool({ path, full: true }, dir);

      expect(result).toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects oversized full-file reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobs-read-tool-"));
    try {
      const path = join(dir, "oversized.txt");
      const content = "x".repeat(210 * 1024);
      writeFileSync(path, content, "utf-8");

      await expect(readTool({ path, full: true }, dir)).rejects.toThrow(
        /File too large for full read/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
