import { describe, expect, it } from "vitest";
import { getToolDefinitions, executeTool } from "../src/runner/tools/index.js";

describe("Claude Code tool compatibility", () => {
  it("exposes Claude Code canonical names for overlapping tools", () => {
    const defs = getToolDefinitions(["exec", "read", "write", "edit", "grep", "glob", "web_search", "web_fetch", "spawn_agent"]);
    expect(defs.map((d) => d.name)).toEqual([
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "WebSearch",
      "WebFetch",
      "Task",
    ]);
  });

  it("resolves canonical tool names back to internal executors", async () => {
    const result = await executeTool("Read", { file_path: "/tmp/definitely-not-here.txt" }, "tool-1", "/tmp");
    expect(result.result.type).toBe("tool_result");
    expect(result.result.is_error).toBe(true);
    expect(String(result.result.content)).toContain("File not found");
  });
});
