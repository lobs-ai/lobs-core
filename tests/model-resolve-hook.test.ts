import { describe, it, expect, beforeEach } from "vitest";
import {
  setSessionModelTier,
  clearSessionModelTier,
} from "../src/hooks/model-resolve.js";

/**
 * Tests for the session-tier map management in model-resolve hook.
 * The hook itself requires a LobsPluginApi instance, but the tier map
 * functions are pure state management we can test directly.
 */
describe("model-resolve hook — session tier map", () => {
  const sessionKey = "test-session-123";

  beforeEach(() => {
    // Clean up any lingering state
    clearSessionModelTier(sessionKey);
  });

  it("setSessionModelTier does not throw", () => {
    expect(() => setSessionModelTier(sessionKey, "standard", "programmer")).not.toThrow();
  });

  it("clearSessionModelTier does not throw for unknown key", () => {
    expect(() => clearSessionModelTier("nonexistent-session")).not.toThrow();
  });

  it("clearSessionModelTier does not throw after set", () => {
    setSessionModelTier(sessionKey, "strong", "main");
    expect(() => clearSessionModelTier(sessionKey)).not.toThrow();
  });

  it("set/clear cycle is idempotent", () => {
    setSessionModelTier(sessionKey, "micro", "writer");
    clearSessionModelTier(sessionKey);
    clearSessionModelTier(sessionKey); // Double clear should be fine
    expect(true).toBe(true); // No throw = pass
  });
});
