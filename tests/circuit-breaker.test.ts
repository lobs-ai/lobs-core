import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the dependencies before importing the module
vi.mock("../src/config/lobs.js", () => ({
  getLobsRoot: () => "/tmp/lobs-cb-test-" + process.pid,
  loadLobsConfig: () => ({}),
}));

vi.mock("../src/util/logger.js", () => ({
  log: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { mkdirSync, rmSync, existsSync } from "node:fs";
import {
  bucketKey,
  GLOBAL_BUCKET,
  classifyOutcome,
  chooseHealthyModel,
  loadConfig,
  invalidateCircuitBreakerConfig,
  onFailure,
  onSuccess,
  isOpen,
  resetCircuit,
  loadStore,
  resolveStorePath,
} from "../src/services/circuit-breaker.js";
import { dirname } from "node:path";

describe("Circuit Breaker", () => {
  beforeEach(() => {
    invalidateCircuitBreakerConfig();
    // Ensure store directory exists
    const storePath = resolveStorePath();
    mkdirSync(dirname(storePath), { recursive: true });
    // Clean any existing store
    if (existsSync(storePath)) {
      rmSync(storePath);
    }
  });

  afterEach(() => {
    const storePath = resolveStorePath();
    if (existsSync(dirname(storePath))) {
      rmSync(dirname(storePath), { recursive: true, force: true });
    }
  });

  describe("bucketKey", () => {
    it("combines model and task type", () => {
      expect(bucketKey("claude-3", "chat")).toBe("claude-3::chat");
    });

    it("uses GLOBAL_BUCKET constant", () => {
      expect(GLOBAL_BUCKET).toBe("__global__");
    });
  });

  describe("loadConfig", () => {
    it("returns default config", () => {
      const cfg = loadConfig();
      expect(cfg.failureThreshold).toBe(10);
      expect(cfg.cooldownMinutes).toBe(30);
      expect(cfg.windowMinutes).toBe(60);
      expect(cfg.enabled).toBe(true);
    });
  });

  describe("classifyOutcome", () => {
    it("returns null for success", () => {
      expect(classifyOutcome({ succeeded: true })).toBeNull();
    });

    it("returns timeout for long-running failures", () => {
      expect(
        classifyOutcome({ succeeded: false, durationMs: 400_000 }),
      ).toBe("timeout");
    });

    it("returns timeout when reason is timeout", () => {
      expect(
        classifyOutcome({ succeeded: false, reason: "timeout" }),
      ).toBe("timeout");
    });

    it("returns crash for fast failures", () => {
      expect(
        classifyOutcome({ succeeded: false, durationMs: 5000 }),
      ).toBe("crash");
    });

    it("returns session_dead for error reason", () => {
      expect(
        classifyOutcome({ succeeded: false, reason: "error", durationMs: 60000 }),
      ).toBe("session_dead");
    });

    it("defaults to session_dead for unknown failures", () => {
      expect(
        classifyOutcome({ succeeded: false, durationMs: 60000 }),
      ).toBe("session_dead");
    });
  });

  describe("chooseHealthyModel", () => {
    it("returns first model when all are healthy", () => {
      expect(chooseHealthyModel(["claude-3", "gpt-4"], "chat")).toBe("claude-3");
    });

    it("returns null for empty chain", () => {
      expect(chooseHealthyModel([], "chat")).toBeNull();
    });
  });

  describe("circuit state transitions", () => {
    it("starts closed (isOpen returns false)", () => {
      expect(isOpen("test-model", "chat")).toBe(false);
    });

    it("opens after enough failures", () => {
      // Default threshold is 10
      for (let i = 0; i < 10; i++) {
        onFailure("test-model", "chat", "crash");
      }
      expect(isOpen("test-model", "chat")).toBe(true);
    });

    it("resets on manual reset", () => {
      for (let i = 0; i < 10; i++) {
        onFailure("test-model", "chat", "crash");
      }
      expect(isOpen("test-model", "chat")).toBe(true);
      resetCircuit("test-model", "chat");
      expect(isOpen("test-model", "chat")).toBe(false);
    });

    it("stores failures in the store", () => {
      onFailure("test-model", "chat", "timeout");
      const store = loadStore();
      const key = bucketKey("test-model", "chat");
      expect(store.buckets[key]).toBeDefined();
      expect(store.buckets[key].failures.length).toBe(1);
    });

    it("doesn't open below threshold", () => {
      for (let i = 0; i < 9; i++) {
        onFailure("test-model", "chat", "crash");
      }
      expect(isOpen("test-model", "chat")).toBe(false);
    });
  });
});
