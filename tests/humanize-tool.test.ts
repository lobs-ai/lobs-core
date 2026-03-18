import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { humanizeTool } from "../src/runner/tools/humanize.js";

describe("humanizeTool", () => {
  it("accepts raw text input", async () => {
    const result = await humanizeTool({ action: "score", text: "This is a short paragraph." }, "/tmp");
    expect(result).toContain("Score:");
    expect(result).toContain("Revision instructions:");
    expect(result).toContain("Do not use em dashes at all.");
  });

  it("strips html from raw text input", async () => {
    const result = await humanizeTool(
      { action: "humanize", text: "<div>Hello <strong>world</strong><script>ignored()</script></div>" },
      "/tmp",
    );

    expect(result).toContain("AI Score:");
    expect(result).not.toContain("<strong>");
    expect(result).not.toContain("ignored()");
  });

  it("reads plain text files from path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobs-humanize-tool-"));
    try {
      const path = join(dir, "draft.txt");
      writeFileSync(path, "This is a plain text draft for testing.", "utf-8");

      const result = await humanizeTool({ action: "analyze", path }, dir);

      expect(result).toContain("Score:");
      expect(result).toContain("Words:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips html before analysis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobs-humanize-tool-"));
    try {
      const path = join(dir, "page.html");
      writeFileSync(
        path,
        "<html><body><h1>Title</h1><p>Hello <strong>world</strong>.</p><script>ignored()</script></body></html>",
        "utf-8",
      );

      const result = await humanizeTool({ action: "humanize", path }, dir);

      expect(result).toContain("AI Score:");
      expect(result).not.toContain("<html>");
      expect(result).not.toContain("ignored()");
      expect(result).toContain("Revision instructions:");
      expect(result).toContain("Do not use em dashes at all.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires either text or path", async () => {
    await expect(humanizeTool({ action: "score" }, "/tmp")).rejects.toThrow(
      /Provide either text or path/,
    );
  });
});
