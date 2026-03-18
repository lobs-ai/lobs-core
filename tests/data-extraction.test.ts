import { describe, expect, it, vi } from "vitest";
import {
  applyDataTransform,
  buildExtractionSchemaPrompt,
  extractStructuredData,
} from "../src/services/data-extraction.js";

describe("data extraction service", () => {
  it("builds a readable schema prompt", () => {
    const prompt = buildExtractionSchemaPrompt({
      sender: { type: "string", required: true, description: "email sender" },
      priority: { type: "string", enum: ["high", "low"] },
    });

    expect(prompt).toContain("\"sender\": string, required, email sender");
    expect(prompt).toContain("\"priority\": string, allowed: high | low");
  });

  it("applies deterministic transforms after extraction", () => {
    const result = applyDataTransform(
      {
        sender_name: "  Alice  ",
        summary: "   ",
      },
      {
        rename: { sender_name: "sender" },
        defaults: { source: "email" },
        trimStrings: true,
        dropEmptyStrings: true,
      },
    );

    expect(result).toEqual({
      sender: "Alice",
      source: "email",
    });
  });

  it("extracts structured data with injected local-model dependencies", async () => {
    const extractor = vi.fn(async () => ({
      sender_name: " Alice ",
      subject: "Project update",
    }));

    const result = await extractStructuredData<{
      sender: string;
      subject: string;
      source: string;
    }>({
      text: "From: Alice\nSubject: Project update",
      instructions: "Extract the sender and subject.",
      schema: {
        sender_name: { type: "string", description: "sender name", required: true },
        subject: { type: "string", description: "email subject" },
      },
      transform: {
        rename: { sender_name: "sender" },
        defaults: { source: "email" },
        trimStrings: true,
      },
    }, {
      isAvailable: vi.fn(async () => true),
      extractor,
    });

    expect(result.localModelUsed).toBe(true);
    expect(result.data).toEqual({
      sender: "Alice",
      subject: "Project update",
      source: "email",
    });
    expect(extractor).toHaveBeenCalledOnce();
    expect(extractor.mock.calls[0]?.[0]).toContain("From: Alice");
  });

  it("returns a clear error when the local model is unavailable", async () => {
    const result = await extractStructuredData({
      text: "hello",
      schema: {
        value: { type: "string" },
      },
    }, {
      isAvailable: vi.fn(async () => false),
    });

    expect(result).toEqual({
      data: null,
      localModelUsed: false,
      error: "local model unavailable",
    });
  });
});
