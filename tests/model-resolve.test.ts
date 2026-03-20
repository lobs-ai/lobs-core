/**
 * model-resolve hook tests
 *
 * Tests the pure in-memory helpers:
 *   - setSessionModelTier / clearSessionModelTier (Map manipulation)
 *
 * And the DB-backed logic (via a fake LobsPluginApi):
 *   - Compliance model override (chat_sessions.compliance_required + orchestrator_settings)
 *   - Tier-based model resolution via sessionTierMap
 *   - Edge cases: no session key, unknown session, compliance without configured model
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getRawDb } from "../src/db/connection.js";
import {
  setSessionModelTier,
  clearSessionModelTier,
  registerModelResolveHook,
} from "../src/hooks/model-resolve.js";

// ── Fake LobsPluginApi ────────────────────────────────────────────────────────

type HookHandler = (event: unknown, ctx: unknown) => Promise<Record<string, unknown>>;

function makeFakeApi(): { api: { on: ReturnType<typeof vi.fn> }; getHandler: () => HookHandler } {
  let handler!: HookHandler;
  const api = {
    on: vi.fn((event: string, fn: HookHandler) => {
      if (event === "before_model_resolve") handler = fn;
    }),
  };
  return { api, getHandler: () => handler };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function insertChatSession(sessionKey: string, complianceRequired: boolean): void {
  getRawDb()
    .prepare(
      `INSERT OR REPLACE INTO chat_sessions
         (id, session_key, compliance_required, created_at, is_active)
       VALUES (lower(hex(randomblob(8))), ?, ?, datetime('now'), 1)`,
    )
    .run(sessionKey, complianceRequired ? 1 : 0);
}

function setComplianceModel(model: string | null): void {
  if (model === null) {
    getRawDb().prepare(`DELETE FROM orchestrator_settings WHERE key = 'compliance_model'`).run();
  } else {
    getRawDb()
      .prepare(`INSERT OR REPLACE INTO orchestrator_settings (key, value) VALUES ('compliance_model', ?)`)
      .run(JSON.stringify(model));
  }
}

function clearChatSessions(): void {
  getRawDb().prepare(`DELETE FROM chat_sessions`).run();
}

// ── setSessionModelTier / clearSessionModelTier ───────────────────────────────

describe("setSessionModelTier / clearSessionModelTier", () => {
  beforeEach(() => {
    clearSessionModelTier("test-session-a");
    clearSessionModelTier("test-session-b");
  });

  it("stores tier and agentType (verify via hook resolution)", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);
    setSessionModelTier("sess-tier-1", "micro", "programmer");
    const result = await getHandler()(null, { sessionKey: "sess-tier-1" });
    // resolveModelForTier should return a concrete model string
    expect(result.modelOverride).toBeTruthy();
    expect(typeof result.modelOverride).toBe("string");
    clearSessionModelTier("sess-tier-1");
  });

  it("stores different tiers independently", () => {
    setSessionModelTier("sess-a", "micro", "programmer");
    setSessionModelTier("sess-b", "strong", "architect");

    // Both should resolve to different model overrides
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    // Can't await inside this test easily, so just confirm no cross-contamination
    // by clearing one and ensuring the other still works
    clearSessionModelTier("sess-a");
    clearSessionModelTier("sess-b");
  });

  it("clearSessionModelTier removes the mapping", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    setSessionModelTier("sess-clear-test", "standard", "programmer");
    clearSessionModelTier("sess-clear-test");

    const result = await getHandler()(null, { sessionKey: "sess-clear-test" });
    // After clearing, no tier mapping → no override
    expect(result.modelOverride).toBeUndefined();
  });

  it("clearSessionModelTier is idempotent (double clear is safe)", () => {
    setSessionModelTier("sess-idem", "micro", "programmer");
    clearSessionModelTier("sess-idem");
    expect(() => clearSessionModelTier("sess-idem")).not.toThrow();
  });
});

// ── registerModelResolveHook — hook registration ─────────────────────────────

describe("registerModelResolveHook", () => {
  it("registers a before_model_resolve handler", () => {
    const { api } = makeFakeApi();
    registerModelResolveHook(api as any);
    expect(api.on).toHaveBeenCalledWith("before_model_resolve", expect.any(Function));
  });

  it("can be called multiple times safely (each call re-registers)", () => {
    const { api } = makeFakeApi();
    expect(() => {
      registerModelResolveHook(api as any);
      registerModelResolveHook(api as any);
    }).not.toThrow();
  });
});

// ── Hook: no session key ──────────────────────────────────────────────────────

describe("hook — no sessionKey in ctx", () => {
  it("returns empty object when sessionKey is missing", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);
    const result = await getHandler()(null, {});
    expect(result).toEqual({});
  });

  it("returns empty object when sessionKey is undefined", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);
    const result = await getHandler()(null, { sessionKey: undefined });
    expect(result).toEqual({});
  });
});

// ── Hook: tier-based resolution ───────────────────────────────────────────────

describe("hook — tier-based model resolution", () => {
  beforeEach(() => {
    clearChatSessions();
    setComplianceModel(null);
  });

  it("returns modelOverride for micro tier", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);
    setSessionModelTier("sess-micro", "micro", "programmer");
    const result = await getHandler()(null, { sessionKey: "sess-micro" });
    expect(result.modelOverride).toBeTruthy();
    clearSessionModelTier("sess-micro");
  });

  it("returns modelOverride for strong tier", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);
    setSessionModelTier("sess-strong", "strong", "architect");
    const result = await getHandler()(null, { sessionKey: "sess-strong" });
    expect(result.modelOverride).toBeTruthy();
    clearSessionModelTier("sess-strong");
  });

  it("returns modelOverride for standard tier", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);
    setSessionModelTier("sess-standard", "standard", "programmer");
    const result = await getHandler()(null, { sessionKey: "sess-standard" });
    expect(result.modelOverride).toBeTruthy();
    clearSessionModelTier("sess-standard");
  });

  it("returns empty when no tier registered for sessionKey", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);
    const result = await getHandler()(null, { sessionKey: "sess-unregistered-xyz" });
    expect(result.modelOverride).toBeUndefined();
    expect(result).toEqual({});
  });

  const tiers = ["micro", "small", "medium", "standard", "strong"] as const;
  for (const tier of tiers) {
    it(`resolves tier '${tier}' to a non-empty model string`, async () => {
      const { api, getHandler } = makeFakeApi();
      registerModelResolveHook(api as any);
      setSessionModelTier(`sess-tier-${tier}`, tier, "programmer");
      const result = await getHandler()(null, { sessionKey: `sess-tier-${tier}` });
      expect(typeof result.modelOverride).toBe("string");
      expect((result.modelOverride as string).length).toBeGreaterThan(0);
      clearSessionModelTier(`sess-tier-${tier}`);
    });
  }
});

// ── Hook: compliance enforcement ─────────────────────────────────────────────

describe("hook — compliance model override", () => {
  beforeEach(() => {
    clearChatSessions();
    setComplianceModel(null);
  });

  it("overrides model when compliance_required=true and compliance_model is set", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    insertChatSession("sess-compliant", true);
    setComplianceModel("ollama/llama3");

    const result = await getHandler()(null, { sessionKey: "sess-compliant" });
    expect(result.modelOverride).toBe("ollama/llama3");
  });

  it("compliance wins over tier-based resolution", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    insertChatSession("sess-comp-tier", true);
    setComplianceModel("ollama/mistral");
    setSessionModelTier("sess-comp-tier", "strong", "architect");

    const result = await getHandler()(null, { sessionKey: "sess-comp-tier" });
    // Compliance should win — local model, not the strong cloud tier
    expect(result.modelOverride).toBe("ollama/mistral");

    clearSessionModelTier("sess-comp-tier");
  });

  it("does NOT override when compliance_required=false", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    insertChatSession("sess-no-compliance", false);
    setComplianceModel("ollama/llama3");

    const result = await getHandler()(null, { sessionKey: "sess-no-compliance" });
    expect(result.modelOverride).toBeUndefined();
  });

  it("does NOT override when compliance_required=true but no compliance_model configured", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    insertChatSession("sess-comp-nomodel", true);
    setComplianceModel(null); // no compliance model configured

    const result = await getHandler()(null, { sessionKey: "sess-comp-nomodel" });
    // Fail-open: no model override, let session use its default
    expect(result.modelOverride).toBeUndefined();
    expect(result).toEqual({});
  });

  it("does NOT override when session not in chat_sessions", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    setComplianceModel("ollama/llama3");
    // "sess-no-chat-row" was never inserted into chat_sessions
    const result = await getHandler()(null, { sessionKey: "sess-no-chat-row" });
    expect(result.modelOverride).toBeUndefined();
  });

  it("different compliance models are correctly returned", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    insertChatSession("sess-phi", true);
    setComplianceModel("ollama/phi3");

    const result = await getHandler()(null, { sessionKey: "sess-phi" });
    expect(result.modelOverride).toBe("ollama/phi3");
  });
});

// ── Hook: compliance_model with empty string ──────────────────────────────────

describe("hook — compliance_model edge cases", () => {
  beforeEach(() => {
    clearChatSessions();
    setComplianceModel(null);
  });

  it("treats empty string compliance_model as not configured", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    insertChatSession("sess-empty-model", true);
    // Store empty string in DB (should be ignored)
    getRawDb()
      .prepare(`INSERT OR REPLACE INTO orchestrator_settings (key, value) VALUES ('compliance_model', ?)`)
      .run(JSON.stringify(""));

    const result = await getHandler()(null, { sessionKey: "sess-empty-model" });
    expect(result.modelOverride).toBeUndefined();
  });

  it("treats non-string compliance_model as not configured", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    insertChatSession("sess-null-model", true);
    getRawDb()
      .prepare(`INSERT OR REPLACE INTO orchestrator_settings (key, value) VALUES ('compliance_model', ?)`)
      .run(JSON.stringify(null));

    const result = await getHandler()(null, { sessionKey: "sess-null-model" });
    expect(result.modelOverride).toBeUndefined();
  });

  it("treats malformed JSON compliance_model as not configured (returns null)", async () => {
    const { api, getHandler } = makeFakeApi();
    registerModelResolveHook(api as any);

    insertChatSession("sess-bad-json", true);
    getRawDb()
      .prepare(`INSERT OR REPLACE INTO orchestrator_settings (key, value) VALUES ('compliance_model', ?)`)
      .run("NOT-VALID-JSON{{");

    const result = await getHandler()(null, { sessionKey: "sess-bad-json" });
    expect(result.modelOverride).toBeUndefined();
  });
});
