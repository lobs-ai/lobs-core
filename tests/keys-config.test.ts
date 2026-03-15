import { describe, expect, test } from "vitest";
import { normalizeKeyConfig } from "../src/config/keys.js";

describe("normalizeKeyConfig", () => {
  test("accepts init/legacy array-based config", () => {
    const config = normalizeKeyConfig({
      anthropic: [{ key: "sk-ant-123", label: "main" }],
      openrouter: ["sk-or-123"],
    });

    expect(config.anthropic?.keys).toEqual([{ key: "sk-ant-123", label: "main" }]);
    expect(config.anthropic?.strategy).toBe("sticky-failover");
    expect(config.openrouter?.keys).toEqual([{ key: "sk-or-123", label: "key-1" }]);
  });

  test("accepts object-based key pool config", () => {
    const config = normalizeKeyConfig({
      anthropic: {
        keys: [{ key: "sk-ant-abc", label: "primary" }],
        strategy: "sticky-failover",
      },
      openai: {
        keys: ["sk-openai-abc"],
        strategy: "sticky-failover",
      },
    });

    expect(config.anthropic?.keys).toEqual([{ key: "sk-ant-abc", label: "primary" }]);
    expect(config.openai?.keys).toEqual([{ key: "sk-openai-abc", label: "key-1" }]);
  });

  test("drops empty or invalid entries", () => {
    const config = normalizeKeyConfig({
      anthropic: [{ key: "   " }, { nope: true }, "sk-ant-valid"],
      openai: { keys: [] },
      openrouter: null,
    });

    expect(config.anthropic?.keys).toEqual([{ key: "sk-ant-valid", label: "key-3" }]);
    expect(config.openai).toBeUndefined();
    expect(config.openrouter).toBeUndefined();
  });

  test("deduplicates identical keys in the same pool", () => {
    const config = normalizeKeyConfig({
      anthropic: {
        keys: [
          { key: "sk-ant-dup", label: "first" },
          { key: "sk-ant-dup", label: "second" },
          { key: "sk-ant-unique", label: "third" },
        ],
        strategy: "sticky-failover",
      },
    });

    expect(config.anthropic?.keys).toEqual([
      { key: "sk-ant-dup", label: "first" },
      { key: "sk-ant-unique", label: "third" },
    ]);
  });
});
