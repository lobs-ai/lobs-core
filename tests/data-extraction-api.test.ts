import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { extractStructuredDataMock } = vi.hoisted(() => ({
  extractStructuredDataMock: vi.fn(),
}));

vi.mock("../src/services/data-extraction.js", () => ({
  extractStructuredData: extractStructuredDataMock,
}));

import { handleExtractionRequest } from "../src/api/extraction.js";

function makeReq(method: string, url: string, body: unknown = {}): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  (req as unknown as Record<string, unknown>).method = method;
  (req as unknown as Record<string, unknown>).url = url;
  process.nextTick(() => {
    (req as unknown as Readable).push(JSON.stringify(body));
    (req as unknown as Readable).push(null);
  });
  return req;
}

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 200;
  let captured = "";
  const res = {
    writeHead(code: number) { statusCode = code; },
    setHeader() {},
    end(data: string) { captured = data; },
  } as unknown as ServerResponse;

  return {
    res,
    status: () => statusCode,
    body: () => JSON.parse(captured) as Record<string, unknown>,
  };
}

describe("extraction API", () => {
  beforeEach(() => {
    extractStructuredDataMock.mockReset();
  });

  it("returns extracted structured data", async () => {
    extractStructuredDataMock.mockResolvedValue({
      data: { sender: "Alice", priority: "high" },
      localModelUsed: true,
    });

    const { res, status, body } = makeRes();
    await handleExtractionRequest(
      makeReq("POST", "/api/extraction/structured", {
        text: "From: Alice\nPriority: high",
        schema: {
          sender: { type: "string" },
          priority: { type: "string" },
        },
      }),
      res,
      "structured",
    );

    expect(status()).toBe(200);
    expect(body()).toEqual({
      data: { sender: "Alice", priority: "high" },
      localModelUsed: true,
    });
  });

  it("validates required text input", async () => {
    const { res, status, body } = makeRes();
    await handleExtractionRequest(
      makeReq("POST", "/api/extraction/structured", {
        schema: { sender: { type: "string" } },
      }),
      res,
      "structured",
    );

    expect(status()).toBe(400);
    expect(body().error).toMatch(/text required/i);
  });

  it("surfaces local-model availability failures as 503", async () => {
    extractStructuredDataMock.mockResolvedValue({
      data: null,
      localModelUsed: false,
      error: "local model unavailable",
    });

    const { res, status, body } = makeRes();
    await handleExtractionRequest(
      makeReq("POST", "/api/extraction/structured", {
        text: "From: Alice",
        schema: { sender: { type: "string" } },
      }),
      res,
      "structured",
    );

    expect(status()).toBe(503);
    expect(body().error).toMatch(/local model unavailable/i);
  });
});
