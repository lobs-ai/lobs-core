import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  it("rejects directories as executable script paths", () => {
    const scriptDir = mkdtempSync(join(tmpdir(), "lobs-shell-test-"));

    try {
      expect(shellExists(scriptDir)).toBe(false);
      expect(getShellScriptArgs(scriptDir)).toEqual(["-c", scriptDir]);
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it("falls back to -c for missing script paths", () => {
    const missingScript = "/definitely/not/a/script.sh";

    expect(shellExists(missingScript)).toBe(false);
    expect(getShellScriptArgs(missingScript)).toEqual(["-c", missingScript]);
  });
});
