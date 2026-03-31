import { describe, it, expect } from "vitest";
import { execTool } from "../src/runner/tools/exec.js";
import { tmpdir } from "node:os";

const CWD = tmpdir();

/** Extract the text output from execTool result */
function getText(result: string | { output: string }): string {
  return typeof result === "string" ? result : result.output;
}

describe("execTool", () => {
  describe("basic execution", () => {
    it("runs a simple echo command", async () => {
      const text = getText(await execTool({ command: "echo hello" }, CWD));
      expect(text).toContain("hello");
    });

    it("returns exit code 0 for successful commands", async () => {
      const text = getText(await execTool({ command: "true" }, CWD));
      expect(text).toContain("exit_code: 0");
    });

    it("returns non-zero exit code for failing commands", async () => {
      const text = getText(await execTool({ command: "false" }, CWD));
      expect(text).toContain("exit_code: 1");
    });

    it("captures stderr", async () => {
      const text = getText(await execTool({ command: "echo err >&2" }, CWD));
      expect(text).toContain("stderr:");
      expect(text).toContain("err");
    });

    it("captures both stdout and stderr", async () => {
      const text = getText(await execTool({ command: "echo out && echo err >&2" }, CWD));
      expect(text).toContain("stdout:");
      expect(text).toContain("stderr:");
      expect(text).toContain("out");
      expect(text).toContain("err");
    });
  });

  describe("workdir", () => {
    it("uses custom workdir", async () => {
      const text = getText(await execTool({ command: "pwd", workdir: "/tmp" }, CWD));
      expect(text).toContain("cwd: /tmp");
      expect(text).toContain("/tmp");
    });
  });

  describe("environment variables", () => {
    it("passes custom env vars", async () => {
      const text = getText(
        await execTool(
          { command: "echo $MY_TEST_VAR", env: { MY_TEST_VAR: "hello_lobs" } },
          CWD,
        ),
      );
      expect(text).toContain("hello_lobs");
    });
  });

  describe("compound commands", () => {
    it("handles && chaining", async () => {
      const text = getText(await execTool({ command: "echo first && echo second" }, CWD));
      expect(text).toContain("first");
      expect(text).toContain("second");
    });

    it("handles pipe commands", async () => {
      const text = getText(await execTool({ command: "echo 'hello world' | wc -w" }, CWD));
      expect(text).toContain("2");
    });
  });

  describe("background execution", () => {
    it("can start a command in the background", async () => {
      const text = getText(await execTool({ command: "sleep 1", run_in_background: true }, CWD));
      expect(text).toContain("background_started: true");
      expect(text).toContain("session_id:");
    });
  });

  describe("edge cases", () => {
    it("handles empty stdout", async () => {
      const text = getText(await execTool({ command: "true" }, CWD));
      expect(text).toContain("stdout:");
      expect(typeof text).toBe("string");
    });

    it("handles multiline output", async () => {
      const text = getText(await execTool({ command: "printf 'a\\nb\\nc'" }, CWD));
      expect(text).toContain("a\nb\nc");
    });
  });
});
