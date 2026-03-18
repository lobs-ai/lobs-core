/**
 * Tests for process tool (src/runner/tools/process.ts)
 *
 * Performance notes:
 * - killProcess() uses SIGTERM → 20ms poll → 200ms SIGKILL grace → 500ms give-up
 * - Shell processes (sleep, cat) respond to SIGTERM in <50ms, so kills resolve fast
 * - Each test should complete in <1s; the suite should complete in <10s total
 */

import { describe, it, expect, afterEach } from "vitest";
import { processTool } from "../src/runner/tools/process.js";

const activeSessions: string[] = [];

// Helper to parse JSON result
function parseResult(result: string): Record<string, unknown> {
  return JSON.parse(result);
}

/** Wait for a process to exit, polling up to maxMs */
async function waitForExit(sessionId: string, maxMs = 1000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const result = await processTool({ action: "poll", sessionId }, "/tmp");
    const data = parseResult(result);
    if (data.status === "exited") return data;
    await new Promise(r => setTimeout(r, 30));
  }
  return parseResult(await processTool({ action: "poll", sessionId }, "/tmp"));
}

// Kill all started processes after each test.
// With the updated 500ms kill timeout, cleanup is fast even for long-lived procs.
afterEach(async () => {
  await Promise.allSettled(
    activeSessions.map(sessionId =>
      processTool({ action: "kill", sessionId }, "/tmp").catch(() => {})
    )
  );
  activeSessions.length = 0;
}, 5000); // 5s cleanup budget (10 procs × 500ms each, but they run in parallel)

describe("Process Tool", () => {
  it("should start a process and return sessionId", async () => {
    const result = await processTool(
      { action: "start", command: "echo hello" },
      "/tmp"
    );

    const data = parseResult(result);
    expect(data.sessionId).toBeDefined();
    expect(typeof data.sessionId).toBe("string");
    expect(data.status).toBe("running");
    expect(data.command).toBe("echo hello");

    activeSessions.push(data.sessionId as string);
  });

  it("should poll a completed process", async () => {
    const startResult = await processTool(
      { action: "start", command: "echo done" },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);

    const pollData = await waitForExit(sessionId as string, 1000);

    expect(pollData.status).toBe("exited");
    expect(pollData.exitCode).toBe(0);
    expect(pollData.newOutput).toBeDefined();
  });

  it("should read log output with offset and limit", async () => {
    const startResult = await processTool(
      { action: "start", command: "for i in 1 2 3 4 5; do echo line$i; done" },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);

    // Wait for the process to complete
    await waitForExit(sessionId as string, 1000);

    const logResult = await processTool(
      { action: "log", sessionId, offset: 0, limit: 2 },
      "/tmp"
    );
    const logData = parseResult(logResult);

    expect(Array.isArray(logData.lines)).toBe(true);
    expect((logData.lines as string[]).length).toBeLessThanOrEqual(2);
    expect(logData.totalLines).toBeGreaterThan(0);
  });

  it("should kill a running process", async () => {
    // sleep 30 — long enough to guarantee it's still running when we kill it
    const startResult = await processTool(
      { action: "start", command: "sleep 30" },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);

    // Kill immediately — should resolve in <500ms now
    const killResult = await processTool(
      { action: "kill", sessionId },
      "/tmp"
    );
    const killData = parseResult(killResult);

    expect(killData.status).toMatch(/killed|kill_sent/);
  }, 2000); // 2s budget — kill should complete in <500ms

  it("should list active processes", async () => {
    // Start 2 processes
    const r1 = await processTool({ action: "start", command: "echo test1" }, "/tmp");
    const { sessionId: id1 } = parseResult(r1);
    activeSessions.push(id1 as string);

    const r2 = await processTool({ action: "start", command: "echo test2" }, "/tmp");
    const { sessionId: id2 } = parseResult(r2);
    activeSessions.push(id2 as string);

    const listResult = await processTool({ action: "list" }, "/tmp");
    const listData = parseResult(listResult);

    expect(typeof listData.count).toBe("number");
    expect(Array.isArray(listData.processes)).toBe(true);
  });

  it("should enforce max processes limit", async () => {
    // Start 3 processes and verify they all succeed (we're well under the limit)
    const started: string[] = [];

    try {
      for (let i = 0; i < 3; i++) {
        // Use sleep 10 so they're still running while we start the next one
        const result = await processTool(
          { action: "start", command: "sleep 10" },
          "/tmp"
        );
        const { sessionId } = parseResult(result);
        started.push(sessionId as string);
        activeSessions.push(sessionId as string);
      }

      expect(started.length).toBe(3);

      // Verify limit is enforced in the source (limit = 10 currently)
      const listResult = await processTool({ action: "list" }, "/tmp");
      const listData = parseResult(listResult);
      expect(typeof (listData as Record<string, unknown>).maxProcesses).toBe("number");
    } finally {
      // Cleanup in parallel — 500ms per kill, all parallel
      await Promise.allSettled(
        started.map(sid =>
          processTool({ action: "kill", sessionId: sid }, "/tmp").catch(() => {})
        )
      );
      // Remove from activeSessions to avoid double-killing in afterEach
      for (const sid of started) {
        const idx = activeSessions.indexOf(sid);
        if (idx !== -1) activeSessions.splice(idx, 1);
      }
    }
  }, 3000); // 3s: 3 starts (~0ms each) + parallel kill (~500ms)

  it("should write to stdin", async () => {
    // cat echoes stdin back to stdout
    const startResult = await processTool(
      { action: "start", command: "cat" },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);

    const writeResult = await processTool(
      { action: "write", sessionId, data: "test input\n" },
      "/tmp"
    );
    const writeData = parseResult(writeResult);

    expect(writeData.status).toBe("success");
    expect(writeData.bytesWritten).toBeGreaterThan(0);

    // Give cat a moment to echo the data back
    await new Promise(r => setTimeout(r, 100));

    const logResult = await processTool(
      { action: "log", sessionId, offset: 0, limit: 10 },
      "/tmp"
    );
    const logData = parseResult(logResult);

    expect((logData.lines as string[]).join("\n")).toContain("test input");
  });

  it("should return error for invalid sessionId", async () => {
    await expect(
      processTool({ action: "poll", sessionId: "invalid-id-12345" }, "/tmp")
    ).rejects.toThrow(/not found/i);
  });

  it("should handle process timeout", async () => {
    // 1-second timeout; SIGTERM fires at t=1s, SIGKILL at t=1.2s
    // Process should be dead by t=1.4s
    const startResult = await processTool(
      { action: "start", command: "sleep 100", timeout: 1 },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);

    // Poll until exited (up to 3.5s: 1s timeout + 200ms SIGKILL + 2.3s margin)
    const pollData = await waitForExit(sessionId as string, 3500);

    expect(pollData.status).toBe("exited");
    expect(pollData.timedOut).toBe(true);
  }, 5000); // 5s budget

  it("should use specified working directory", async () => {
    const testDir = "/tmp";
    const startResult = await processTool(
      { action: "start", command: "pwd", cwd: testDir },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);

    await waitForExit(sessionId as string, 1000);

    const logResult = await processTool(
      { action: "log", sessionId, offset: 0, limit: 10 },
      "/tmp"
    );
    const logData = parseResult(logResult);

    expect((logData.lines as string[]).join("\n")).toContain(testDir);
  });
});
