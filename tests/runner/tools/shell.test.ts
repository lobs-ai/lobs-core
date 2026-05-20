import { afterEach, describe, expect, it, vi } from "vitest";

import { getShellExecutable, getShellScriptArgs, shellExists } from "../../../src/runner/tools/shell.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllEnvs();
});

describe("shell helpers", () => {
  it("prefers existing absolute shells over path lookups", () => {
    vi.stubEnv("LOBS_SHELL", "");
    vi.stubEnv("SHELL", "bash");

    expect(getShellExecutable()).toBe("/bin/bash");
  });

  it("supports explicit shell override", () => {
    vi.stubEnv("LOBS_SHELL", "/bin/sh");

    expect(getShellExecutable()).toBe("/bin/sh");
  });

  it("falls back to -c for missing script paths", () => {
    const missingScript = "/definitely/not/a/script.sh";

    expect(shellExists(missingScript)).toBe(false);
    expect(getShellScriptArgs(missingScript)).toEqual(["-c", missingScript]);
  });
});
