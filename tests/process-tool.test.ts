/**
 * Tests for process tool (src/runner/tools/process.ts)
 */

import { describe, it, expect, afterEach } from "vitest";
import { processTool } from "../src/runner/tools/process.js";

const activeSessions: string[] = [];

// Helper to parse JSON result
function parseResult(result: string): Record<string, unknown> {
  return JSON.parse(result);
}

// Clean up all started processes after each test
afterEach(async () => {
  for (const sessionId of activeSessions) {
    try {
      await processTool({ action: "kill", sessionId }, "/tmp");
    } catch {
      // Already dead
    }
  }
  activeSessions.length = 0;
});

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
    // Start process
    const startResult = await processTool(
      { action: "start", command: "echo done" },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);
    
    // Wait a bit for it to complete
    await new Promise(r => setTimeout(r, 500));
    
    // Poll
    const pollResult = await processTool(
      { action: "poll", sessionId },
      "/tmp"
    );
    const pollData = parseResult(pollResult);
    
    expect(pollData.status).toBe("exited");
    expect(pollData.exitCode).toBe(0);
    expect(pollData.newOutput).toBeDefined();
  });

  it("should read log output with offset and limit", async () => {
    // Start a process that outputs multiple lines
    const startResult = await processTool(
      { action: "start", command: "for i in 1 2 3 4 5; do echo line$i; done" },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);
    
    // Wait for completion
    await new Promise(r => setTimeout(r, 500));
    
    // Read first 2 lines
    const logResult = await processTool(
      { action: "log", sessionId, offset: 0, limit: 2 },
      "/tmp"
    );
    const logData = parseResult(logResult);
    
    expect(logData.lines).toBeDefined();
    expect(Array.isArray(logData.lines)).toBe(true);
    expect((logData.lines as string[]).length).toBeLessThanOrEqual(2);
    expect(logData.totalLines).toBeGreaterThan(0);
  });

  it("should kill a running process", async () => {
    // Start a long-running process
    const startResult = await processTool(
      { action: "start", command: "sleep 60" },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);
    
    // Kill it
    const killResult = await processTool(
      { action: "kill", sessionId },
      "/tmp"
    );
    const killData = parseResult(killResult);
    
    expect(killData.status).toMatch(/killed|kill_sent/);
  });

  it("should list active processes", async () => {
    // Start 2 processes
    const result1 = await processTool(
      { action: "start", command: "sleep 10" },
      "/tmp"
    );
    const { sessionId: id1 } = parseResult(result1);
    activeSessions.push(id1 as string);
    
    const result2 = await processTool(
      { action: "start", command: "sleep 10" },
      "/tmp"
    );
    const { sessionId: id2 } = parseResult(result2);
    activeSessions.push(id2 as string);
    
    // List
    const listResult = await processTool(
      { action: "list" },
      "/tmp"
    );
    const listData = parseResult(listResult);
    
    expect(listData.count).toBeGreaterThanOrEqual(2);
    expect(listData.processes).toBeDefined();
    expect(Array.isArray(listData.processes)).toBe(true);
    expect((listData.processes as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("should enforce max processes limit", async () => {
    const MAX_PROCESSES = 10;
    const started: string[] = [];
    
    try {
      // Start MAX_PROCESSES
      for (let i = 0; i < MAX_PROCESSES; i++) {
        const result = await processTool(
          { action: "start", command: "sleep 30" },
          "/tmp"
        );
        const { sessionId } = parseResult(result);
        started.push(sessionId as string);
        activeSessions.push(sessionId as string);
      }
      
      // Try to start one more — should fail
      await expect(
        processTool({ action: "start", command: "echo test" }, "/tmp")
      ).rejects.toThrow(/limit/i);
    } finally {
      // Cleanup
      for (const sid of started) {
        try {
          await processTool({ action: "kill", sessionId: sid }, "/tmp");
        } catch {
          // ignore
        }
      }
    }
  });

  it("should write to stdin", async () => {
    // Start cat (echoes stdin)
    const startResult = await processTool(
      { action: "start", command: "cat" },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);
    
    // Write data
    const writeResult = await processTool(
      { action: "write", sessionId, data: "test input\n" },
      "/tmp"
    );
    const writeData = parseResult(writeResult);
    
    expect(writeData.status).toBe("success");
    expect(writeData.bytesWritten).toBeGreaterThan(0);
    
    // Wait a bit
    await new Promise(r => setTimeout(r, 200));
    
    // Read log to verify output
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
    // Start a long process with short timeout
    const startResult = await processTool(
      { action: "start", command: "sleep 100", timeout: 1 },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);
    
    // Wait for timeout
    await new Promise(r => setTimeout(r, 2000));
    
    // Poll — should be killed
    const pollResult = await processTool(
      { action: "poll", sessionId },
      "/tmp"
    );
    const pollData = parseResult(pollResult);
    
    expect(pollData.status).toBe("exited");
    expect(pollData.timedOut).toBe(true);
  }, 10000); // Increase test timeout

  it("should use specified working directory", async () => {
    const testDir = "/tmp";
    const startResult = await processTool(
      { action: "start", command: "pwd", cwd: testDir },
      "/tmp"
    );
    const { sessionId } = parseResult(startResult);
    activeSessions.push(sessionId as string);
    
    // Wait for completion
    await new Promise(r => setTimeout(r, 300));
    
    // Check output
    const logResult = await processTool(
      { action: "log", sessionId, offset: 0, limit: 10 },
      "/tmp"
    );
    const logData = parseResult(logResult);
    
    expect((logData.lines as string[]).join("\n")).toContain(testDir);
  });
});
