/**
 * Unit tests for compliance model classifier.
 * @see src/util/compliance-model.ts
 */

import { describe, it, expect } from "vitest";
import {
  isLocalModel,
  isCloudModel,
  isComplianceModel,
  extractProvider,
  isCloudProvider,
} from "../src/util/compliance-model.js";

describe("isLocalModel", () => {
  it("identifies ollama models as local", () => {
    expect(isLocalModel("ollama/llama3")).toBe(true);
    expect(isLocalModel("ollama/mistral-7b")).toBe(true);
  });

  it("identifies lmstudio models as local", () => {
    expect(isLocalModel("lmstudio/local-compliance-model")).toBe(true);
    expect(isLocalModel("lm-studio/llama3")).toBe(true);
  });

  it("identifies local/ prefix as local", () => {
    expect(isLocalModel("local/llama3")).toBe(true);
  });

  it("identifies llamacpp as local", () => {
    expect(isLocalModel("llamacpp/phi-3")).toBe(true);
    expect(isLocalModel("llama.cpp/phi-3")).toBe(true);
  });

  it("identifies localai as local", () => {
    expect(isLocalModel("localai/model")).toBe(true);
  });

  it("identifies cloud models as NOT local", () => {
    expect(isLocalModel("anthropic/claude-sonnet-4-6")).toBe(false);
    expect(isLocalModel("openai/gpt-4o")).toBe(false);
    expect(isLocalModel("google/gemini-pro")).toBe(false);
    expect(isLocalModel("mistral/mistral-7b")).toBe(false);
  });
});

describe("isCloudModel", () => {
  it("identifies anthropic as cloud", () => {
    expect(isCloudModel("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(isCloudModel("anthropic/claude-opus-4-6")).toBe(true);
    expect(isCloudModel("anthropic/claude-haiku-4-5")).toBe(true);
  });

  it("identifies openai as cloud", () => {
    expect(isCloudModel("openai/gpt-4o")).toBe(true);
  });

  it("identifies local models as NOT cloud", () => {
    expect(isCloudModel("ollama/llama3")).toBe(false);
    expect(isCloudModel("lmstudio/compliance")).toBe(false);
  });
});

describe("isComplianceModel", () => {
  it("returns true for local models", () => {
    expect(isComplianceModel("ollama/llama3")).toBe(true);
    expect(isComplianceModel("lmstudio/local-compliance-model")).toBe(true);
  });

  it("returns true when model matches configured compliance model", () => {
    expect(isComplianceModel("anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6")).toBe(false);
    // Any model matching the explicit configured compliance model
    expect(isComplianceModel("my-special-model", "my-special-model")).toBe(true);
  });

  it("returns false for cloud models not in configured compliance list", () => {
    expect(isComplianceModel("anthropic/claude-sonnet-4-6")).toBe(false);
    expect(isComplianceModel("openai/gpt-4o")).toBe(false);
  });
});

describe("extractProvider", () => {
  it("extracts provider prefix from model string", () => {
    expect(extractProvider("anthropic/claude-sonnet-4-6")).toBe("anthropic");
    expect(extractProvider("openai/gpt-4o")).toBe("openai");
    expect(extractProvider("ollama/llama3")).toBe("ollama");
    expect(extractProvider("lmstudio/local")).toBe("lmstudio");
  });

  it("returns the full string lowercased when no slash", () => {
    expect(extractProvider("anthropic")).toBe("anthropic");
    expect(extractProvider("OPENAI")).toBe("openai");
  });
});

describe("isCloudProvider", () => {
  it("identifies known cloud providers", () => {
    expect(isCloudProvider("anthropic")).toBe(true);
    expect(isCloudProvider("openai")).toBe(true);
    expect(isCloudProvider("google")).toBe(true);
    expect(isCloudProvider("mistral")).toBe(true);
    expect(isCloudProvider("azure")).toBe(true);
    expect(isCloudProvider("groq")).toBe(true);
  });

  it("identifies local providers as NOT cloud", () => {
    expect(isCloudProvider("ollama")).toBe(false);
    expect(isCloudProvider("lmstudio")).toBe(false);
    expect(isCloudProvider("llamacpp")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isCloudProvider("Anthropic")).toBe(true);
    expect(isCloudProvider("OPENAI")).toBe(true);
    expect(isCloudProvider("Google")).toBe(true);
  });
});
