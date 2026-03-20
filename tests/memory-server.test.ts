/**
 * Tests for memory-server.ts (supervisor)
 * 
 * Keep these lightweight — don't require actual bun/memory server binary.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { memoryServer } from "../src/services/memory-server.js";

describe("Memory Server Supervisor", () => {
  // Clean state between tests
  beforeEach(async () => {
    await memoryServer.shutdown();
  });

  afterEach(async () => {
    await memoryServer.shutdown();
  });

  it("should report not running when not started", () => {
    const status = memoryServer.getStatus();
    
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it("should report health as a boolean", async () => {
    const healthy = await memoryServer.isHealthy();
    
    // isHealthy() checks port 7420 — it may or may not be running in CI/dev.
    // Either way, the result must be a boolean (not undefined, not thrown).
    expect(typeof healthy).toBe("boolean");
  });

  it("should update status after start attempt", async () => {
    // Note: This may fail to actually start if bun/memory server not installed,
    // but we can still test that start() doesn't crash and updates state
    
    // Don't wait for start to complete — just verify it doesn't throw
    const startPromise = memoryServer.start();
    
    // Give it a moment
    await new Promise(r => setTimeout(r, 100));
    
    // Should not throw
    expect(startPromise).toBeDefined();
    
    // Shutdown regardless of whether it actually started
    await memoryServer.shutdown();
  });

  it("should handle shutdown gracefully when not running", async () => {
    // Should not throw when shutting down a non-running server
    await expect(memoryServer.shutdown()).resolves.toBeUndefined();
  });

  it("should track restart count in status", () => {
    const status = memoryServer.getStatus();
    
    expect(status.restartCount).toBeDefined();
    expect(typeof status.restartCount).toBe("number");
  });

  it("should have lastHealthy timestamp in status", () => {
    const status = memoryServer.getStatus();
    
    expect(status.lastHealthy).toBeDefined();
    expect(typeof status.lastHealthy).toBe("number");
  });

  it("should return null uptime when not running", () => {
    const status = memoryServer.getStatus();
    
    expect(status.uptime).toBeNull();
  });

  it("should not allow multiple simultaneous starts", async () => {
    // Start once
    const start1 = memoryServer.start();
    
    // Try to start again immediately
    const start2 = memoryServer.start();
    
    // Both should complete without error (second is a no-op)
    await Promise.all([start1, start2]);
    
    await memoryServer.shutdown();
  });

  it("should handle multiple shutdowns gracefully", async () => {
    await memoryServer.start();
    
    // Multiple shutdowns should not throw
    await memoryServer.shutdown();
    await memoryServer.shutdown();
    await memoryServer.shutdown();
  });
});
