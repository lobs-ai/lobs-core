/**
 * tool-gate hook tests
 *
 * The tool-gate hook is currently intentionally disabled. These tests verify
 * the disabled state: that registerToolGateHook() does not register any handler
 * via api.on() and does not throw.
 */

import { describe, it, expect, vi } from "vitest";
import { registerToolGateHook } from "../src/hooks/tool-gate.js";

// ── Fake LobsPluginApi ────────────────────────────────────────────────────────

function makeFakeApi(): { api: { on: ReturnType<typeof vi.fn> } } {
  const api = {
    on: vi.fn(),
  };
  return { api };
}

// ── Hook is disabled: api.on is never called ─────────────────────────────────

describe("tool-gate hook — disabled state", () => {
  it("does not throw when called", () => {
    const { api } = makeFakeApi();
    expect(() => registerToolGateHook(api as any)).not.toThrow();
  });

  it("never calls api.on() (no handler is registered)", () => {
    const { api } = makeFakeApi();
    registerToolGateHook(api as any);
    expect(api.on).not.toHaveBeenCalled();
  });

  it("calling registerToolGateHook multiple times still never registers a handler", () => {
    const { api } = makeFakeApi();
    registerToolGateHook(api as any);
    registerToolGateHook(api as any);
    registerToolGateHook(api as any);
    expect(api.on).not.toHaveBeenCalled();
  });

  it("returns undefined (no return value)", () => {
    const { api } = makeFakeApi();
    const result = registerToolGateHook(api as any);
    expect(result).toBeUndefined();
  });

  it("does not register a 'before_tool_call' event handler", () => {
    const { api } = makeFakeApi();
    registerToolGateHook(api as any);
    const callsForBeforeToolCall = api.on.mock.calls.filter(
      ([event]) => event === "before_tool_call",
    );
    expect(callsForBeforeToolCall).toHaveLength(0);
  });

  it("works with a null-ish api object without throwing", () => {
    // The implementation does `void api`, so any truthy value is fine
    const minimalApi = { on: vi.fn() };
    expect(() => registerToolGateHook(minimalApi as any)).not.toThrow();
    expect(minimalApi.on).not.toHaveBeenCalled();
  });
});
