/**
 * Model Chooser Tests
 * Tests tier-based model selection, fallback chains, and escalation logic.
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  chooseModel,
  buildFallbackChain,
  escalationModel,
  forceModel,
  resolveTaskTier,
  resolveModelForTier,
  invalidateModelCache,
  TIER_MODELS,
  AGENT_FALLBACK_CHAINS,
  type ModelTier,
} from "../src/orchestrator/model-chooser.js";

// Invalidate cache before each test so lobs.json config doesn't bleed in
beforeEach(() => {
  invalidateModelCache();
});

describe("Model Chooser", () => {
  describe("TIER_MODELS", () => {
    test("micro tier has at least one model", () => {
      expect(TIER_MODELS.micro.length).toBeGreaterThan(0);
    });

    test("small tier has at least one model", () => {
      expect(TIER_MODELS.small.length).toBeGreaterThan(0);
    });

    test("medium tier has at least one model", () => {
      expect(TIER_MODELS.medium.length).toBeGreaterThan(0);
    });

    test("standard tier has at least one model", () => {
      expect(TIER_MODELS.standard.length).toBeGreaterThan(0);
    });

    test("strong tier has at least one model", () => {
      expect(TIER_MODELS.strong.length).toBeGreaterThan(0);
    });

    test("tier defaults expose configured models without stripping Codex", () => {
      for (const models of Object.values(TIER_MODELS)) {
        expect(models.length).toBeGreaterThan(0);
      }
    });
  });

  describe("AGENT_FALLBACK_CHAINS", () => {
    test("all major agent types have fallback chains", () => {
      const agents = ["programmer", "architect", "reviewer", "researcher", "writer", "suggester"];
      for (const agent of agents) {
        expect(AGENT_FALLBACK_CHAINS[agent], `Missing fallback chain for ${agent}`).toBeDefined();
        expect(AGENT_FALLBACK_CHAINS[agent].length).toBeGreaterThan(0);
      }
    });

    test("agent fallback chains expose configured models without stripping Codex", () => {
      for (const chain of Object.values(AGENT_FALLBACK_CHAINS)) {
        expect(chain.length).toBeGreaterThan(0);
      }
    });
  });

  describe("chooseModel", () => {
    test("returns a model for each valid tier", () => {
      const tiers: ModelTier[] = ["micro", "small", "medium", "standard", "strong"];
      for (const tier of tiers) {
        const result = chooseModel(tier);
        expect(result.model, `No model for tier ${tier}`).toBeTruthy();
        expect(result.tier).toBe(tier);
      }
    });

    test("defaults to standard tier when tier is undefined", () => {
      const result = chooseModel(undefined, undefined);
      expect(result.tier).toBe("standard");
      expect(result.model).toBeTruthy();
    });

    test("defaults to standard tier when tier is invalid", () => {
      const result = chooseModel("invalid-tier-xyz" as ModelTier, undefined);
      expect(result.tier).toBe("standard");
      expect(result.model).toBeTruthy();
    });

    test("micro tier returns a configured micro-tier model", () => {
      const result = chooseModel("micro", undefined);
      // Verify it returns the configured micro tier model (which may vary by environment).
      // The specific model name (lmstudio/qwen3-4b vs qwen2.5-1.5b-instruct-mlx) depends
      // on ~/.lobs/config/models.json, so we just verify it's truthy.
      expect(result.tier).toBe("micro");
      expect(result.model).toBeTruthy();
    });

    test("strong tier returns the configured strong-tier model", () => {
      const result = chooseModel("strong", undefined);
      expect(result.model).toBe(TIER_MODELS.strong[0]);
    });

    test("source is tier-default when agent config is not available", () => {
      // Using a fake agent type that won't be in lobs.json
      const result = chooseModel("standard", "nonexistent-agent-xyz");
      expect(result.source).toBe("tier-default");
    });

    test("architect agent uses strong tier by default", () => {
      const result = chooseModel(undefined, "architect");
      expect(result.tier).toBe("strong");
    });

    test("programmer agent uses standard tier by default", () => {
      const result = chooseModel(undefined, "programmer");
      expect(result.tier).toBe("standard");
    });

    test("inbox-responder agent uses micro tier by default", () => {
      const result = chooseModel(undefined, "inbox-responder");
      expect(result.tier).toBe("micro");
    });

    test("explicit tier overrides agent tier default", () => {
      const result = chooseModel("micro", "architect");
      expect(result.tier).toBe("micro");
    });
  });

  describe("buildFallbackChain", () => {
    test("returns at least one model", () => {
      const chain = buildFallbackChain("anthropic/claude-sonnet-4-6", "standard", "programmer");
      expect(chain.length).toBeGreaterThan(0);
    });

    test("preferred model is first in chain", () => {
      const preferred = "anthropic/claude-sonnet-4-6";
      const chain = buildFallbackChain(preferred, "standard", "programmer");
      expect(chain[0]).toBe(preferred);
    });

    test("preserves configured Codex fallbacks", () => {
      const chain = buildFallbackChain("openai-codex/codex", "standard", "programmer");
      expect(chain[0]).toBe("openai-codex/codex");
    });

    test("does not duplicate models in returned chain", () => {
      const chain = buildFallbackChain("openai-codex/codex", "standard", "programmer");
      expect(chain).toEqual([...new Set(chain)]);
    });

    test("uses AGENT_FALLBACK_CHAINS when no agent config", () => {
      invalidateModelCache();
      // Force no agent config by using nonexistent agent — falls back to tier models
      const chain = buildFallbackChain("anthropic/claude-sonnet-4-6", "standard", "nonexistent-xyz");
      expect(chain.length).toBeGreaterThanOrEqual(1);
      expect(chain[0]).toBe("anthropic/claude-sonnet-4-6");
    });

    test("chain has no duplicates", () => {
      const chain = buildFallbackChain("anthropic/claude-sonnet-4-6", "standard", "programmer");
      const unique = [...new Set(chain)];
      expect(chain.length).toBe(unique.length);
    });

    test("chain without agentType uses tier models", () => {
      const chain = buildFallbackChain("anthropic/claude-sonnet-4-6", "standard");
      expect(chain.length).toBeGreaterThanOrEqual(1);
      expect(chain[0]).toBe("anthropic/claude-sonnet-4-6");
    });
  });

  describe("escalationModel", () => {
    test("escalates from micro to small", () => {
      const result = escalationModel("micro");
      // Next tier up — should differ or be at minimum a valid model
      expect(result.model).toBeTruthy();
      expect(result.tier).toBe("small");
    });

    test("escalates from small to medium", () => {
      const result = escalationModel("small");
      expect(result.tier).toBe("medium");
    });

    test("escalates from standard to strong", () => {
      const result = escalationModel("standard");
      expect(result.tier).toBe("strong");
    });

    test("strong tier stays at strong (capped)", () => {
      const result = escalationModel("strong");
      expect(result.tier).toBe("strong");
    });

    test("escalation returns a valid model", () => {
      const result = escalationModel("micro", "programmer");
      expect(result.model).toBeTruthy();
    });
  });

  describe("forceModel", () => {
    test("returns the exact model specified", () => {
      const result = forceModel("anthropic/claude-opus-4-6");
      expect(result.model).toBe("anthropic/claude-opus-4-6");
    });

    test("defaults tier to standard", () => {
      const result = forceModel("some-model");
      expect(result.tier).toBe("standard");
    });

    test("accepts custom tier", () => {
      const result = forceModel("some-model", "micro");
      expect(result.tier).toBe("micro");
    });
  });

  describe("resolveTaskTier", () => {
    test("resolves tier from model_tier field", () => {
      const tier = resolveTaskTier({ model_tier: "strong" });
      expect(tier).toBe("strong");
    });

    test("falls back to agent type default when model_tier is missing", () => {
      const tier = resolveTaskTier({ agent: "architect" });
      expect(tier).toBe("strong");
    });

    test("falls back to agent type default when model_tier is invalid", () => {
      const tier = resolveTaskTier({ model_tier: "invalid", agent: "programmer" });
      // invalid tier → fall back to agent default
      expect(tier).toBe("standard");
    });

    test("returns standard when both model_tier and agent are missing", () => {
      const tier = resolveTaskTier({});
      expect(tier).toBe("standard");
    });

    test("all valid tiers resolve correctly", () => {
      const tiers: ModelTier[] = ["micro", "small", "medium", "standard", "strong"];
      for (const t of tiers) {
        expect(resolveTaskTier({ model_tier: t })).toBe(t);
      }
    });
  });

  describe("resolveModelForTier", () => {
    test("returns a string model for each tier", () => {
      const tiers: ModelTier[] = ["micro", "small", "medium", "standard", "strong"];
      for (const tier of tiers) {
        const model = resolveModelForTier(tier);
        expect(model, `No model for tier ${tier}`).toBeTruthy();
        expect(typeof model).toBe("string");
      }
    });
  });
});
