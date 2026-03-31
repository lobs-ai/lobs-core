import { describe, expect, it } from "vitest";
import {
  extractCdTarget,
  splitCommand,
  splitCommandWithOperators,
} from "../src/claude-runtime/bash-parser.js";

describe("claude-runtime bash parser", () => {
  it("does not split on semicolons inside quotes", () => {
    const parts = splitCommandWithOperators(`echo "a;b" ; pwd`);
    expect(parts).toEqual([`echo "a;b"`, ";", "pwd"]);
  });

  it("splits chained commands on control operators", () => {
    const parts = splitCommand("cd src && npm test ; pwd");
    expect(parts).toEqual(["cd src", "npm test", "pwd"]);
  });

  it("joins continuation lines before parsing", () => {
    const parts = splitCommand("echo foo\\\nbar");
    expect(parts).toEqual(["echo foobar"]);
  });

  it("extracts simple cd targets", () => {
    expect(extractCdTarget("cd src")).toBe("src");
    expect(extractCdTarget("cd ~/tmp")).toBe("~/tmp");
    expect(extractCdTarget("cd")).toBe(process.env.HOME ?? "/");
  });

  it("strips simple output redirections when splitting commands", () => {
    const parts = splitCommand("echo hello > out.txt && pwd");
    expect(parts).toEqual(["echo hello", "pwd"]);
  });

  it("preserves heredoc bodies as part of the same command", () => {
    const parts = splitCommand("cat <<EOF\nhello\nEOF\npwd");
    expect(parts[0]).toContain("<<EOF");
    expect(parts[0]).toContain("hello");
  });

  it("does not treat compound commands as bare cd", () => {
    expect(extractCdTarget("cd src && ls")).toBe(null);
    expect(extractCdTarget(`cd "my dir" ; pwd`)).toBe(null);
  });
});
