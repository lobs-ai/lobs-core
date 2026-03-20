/**
 * Tests for src/workers/base-worker.ts
 *
 * Covers:
 * - BaseWorker.run() lifecycle (available / unavailable model)
 * - Error recovery — execute() throwing
 * - onEvent() delegation
 * - durationMs measurement
 * - callLocalModel() — mocked fetch (timeout, bad status, success)
 * - callLocalModelJSON() — JSON parsing, code fence stripping
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BaseWorker,
  callLocalModel,
  callLocalModelJSON,
} from "../src/workers/base-worker.js";
import type {
  WorkerConfig,
  WorkerContext,
  WorkerEvent,
  WorkerResult,
} from "../src/workers/base-worker.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// isLocalModelAvailable — we control this to test both paths
vi.mock("../src/runner/local-classifier.js", () => ({
  isLocalModelAvailable: vi.fn(),
}));

vi.mock("../src/config/models.js", () => ({
  getLocalConfig: () => ({
    chatModel: "qwen3:8b",
    baseUrl: "http://localhost:1234/v1",
  }),
}));

// Import the mock so we can change its return value per test
import { isLocalModelAvailable } from "../src/runner/local-classifier.js";
const mockIsAvailable = isLocalModelAvailable as ReturnType<typeof vi.fn>;

// ── Concrete worker implementations for testing ────────────────────────────────

class OkWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "ok-worker",
    name: "OK Worker",
    description: "Always succeeds",
    enabled: true,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    return {
      success: true,
      artifacts: [{ type: "draft", content: "hello world" }],
      alerts: [],
      tokensUsed: 42,
      durationMs: 0,
      summary: "Done",
    };
  }
}

class ThrowingWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "throw-worker",
    name: "Throwing Worker",
    description: "Always throws",
    enabled: true,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    throw new Error("intentional worker failure");
  }
}

class EventAwareWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "event-worker",
    name: "Event Worker",
    description: "Handles events",
    enabled: true,
  };

  readonly receivedEvents: WorkerEvent[] = [];

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    return { success: true, artifacts: [], alerts: [], tokensUsed: 0, durationMs: 0, summary: "execute" };
  }

  async onEvent(event: WorkerEvent): Promise<WorkerResult> {
    this.receivedEvents.push(event);
    return { success: true, artifacts: [], alerts: [], tokensUsed: 0, durationMs: 0, summary: "onEvent" };
  }
}

class NullEventWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "null-event-worker",
    name: "Null Event Worker",
    description: "onEvent returns null (falls through to execute)",
    enabled: true,
  };

  executeCallCount = 0;

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    this.executeCallCount++;
    return { success: true, artifacts: [], alerts: [], tokensUsed: 0, durationMs: 0, summary: "execute" };
  }

  async onEvent(_event: WorkerEvent): Promise<WorkerResult | null> {
    return null; // fall through to execute
  }
}

class ArtifactWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "artifact-worker",
    name: "Artifact Worker",
    description: "Returns multiple artifacts",
    enabled: true,
  };

  async execute(_ctx: WorkerContext): Promise<WorkerResult> {
    return {
      success: true,
      artifacts: [
        { type: "file", path: "/tmp/out.txt", content: "file content" },
        { type: "memory", content: "memory content" },
        { type: "alert", content: "alert content" },
      ],
      alerts: [
        { severity: "info", title: "Info", message: "all good", actionRequired: false },
        { severity: "critical", title: "Oops", message: "something bad", actionRequired: true },
      ],
      tokensUsed: 100,
      durationMs: 0,
      summary: "Three artifacts, two alerts",
    };
  }
}

// ── BaseWorker.run() — model availability ─────────────────────────────────────

describe("BaseWorker.run() — model availability", () => {
  it("returns success:false when model is unavailable", async () => {
    mockIsAvailable.mockResolvedValue(false);
    const worker = new OkWorker();
    const result = await worker.run();
    expect(result.success).toBe(false);
    expect(result.error).toBe("Local model unavailable");
  });

  it("returns a warning alert when model is unavailable", async () => {
    mockIsAvailable.mockResolvedValue(false);
    const result = await new OkWorker().run();
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.severity).toBe("warning");
    expect(result.alerts[0]!.actionRequired).toBe(false);
  });

  it("returns tokensUsed=0 and durationMs=0 when model is unavailable", async () => {
    mockIsAvailable.mockResolvedValue(false);
    const result = await new OkWorker().run();
    expect(result.tokensUsed).toBe(0);
    expect(result.durationMs).toBe(0);
  });

  it("calls execute() when model is available", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const result = await new OkWorker().run();
    expect(result.success).toBe(true);
    expect(result.summary).toBe("Done");
    expect(result.tokensUsed).toBe(42);
  });

  it("result has artifacts when model is available", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const result = await new OkWorker().run();
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.content).toBe("hello world");
  });
});

// ── BaseWorker.run() — error recovery ─────────────────────────────────────────

describe("BaseWorker.run() — error recovery", () => {
  it("catches thrown errors and returns success:false", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const result = await new ThrowingWorker().run();
    expect(result.success).toBe(false);
  });

  it("error message appears in result.error", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const result = await new ThrowingWorker().run();
    expect(result.error).toBe("intentional worker failure");
  });

  it("returns a warning alert with the error message", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const result = await new ThrowingWorker().run();
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.message).toContain("intentional worker failure");
    expect(result.alerts[0]!.severity).toBe("warning");
  });

  it("result has no artifacts after an error", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const result = await new ThrowingWorker().run();
    expect(result.artifacts).toHaveLength(0);
  });

  it("durationMs is positive even after an error", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const result = await new ThrowingWorker().run();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── BaseWorker.run() — durationMs ────────────────────────────────────────────

describe("BaseWorker.run() — durationMs measurement", () => {
  it("durationMs is positive for a successful run", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const result = await new OkWorker().run();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("durationMs reflects actual execution time for slow workers", async () => {
    mockIsAvailable.mockResolvedValue(true);
    class SlowWorker extends BaseWorker {
      readonly config: WorkerConfig = { id: "slow", name: "Slow", description: "", enabled: true };
      async execute(_ctx: WorkerContext): Promise<WorkerResult> {
        await new Promise(r => setTimeout(r, 20));
        return { success: true, artifacts: [], alerts: [], tokensUsed: 0, durationMs: 0 };
      }
    }
    const result = await new SlowWorker().run();
    expect(result.durationMs).toBeGreaterThanOrEqual(15);
  });
});

// ── BaseWorker.run() — onEvent delegation ────────────────────────────────────

describe("BaseWorker.run() — onEvent delegation", () => {
  it("calls onEvent when a triggerEvent is passed", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const worker = new EventAwareWorker();
    const event: WorkerEvent = { type: "task.created", payload: { id: "t1" }, timestamp: new Date() };
    await worker.run(event);
    expect(worker.receivedEvents).toHaveLength(1);
    expect(worker.receivedEvents[0]!.type).toBe("task.created");
  });

  it("uses onEvent result when it returns a WorkerResult", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const worker = new EventAwareWorker();
    const event: WorkerEvent = { type: "test.event", payload: {}, timestamp: new Date() };
    const result = await worker.run(event);
    expect(result.summary).toBe("onEvent");
  });

  it("falls through to execute() when onEvent returns null", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const worker = new NullEventWorker();
    const event: WorkerEvent = { type: "test.event", payload: {}, timestamp: new Date() };
    await worker.run(event);
    expect(worker.executeCallCount).toBe(1);
  });

  it("does not call onEvent when no triggerEvent is passed", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const worker = new EventAwareWorker();
    await worker.run(); // no event
    expect(worker.receivedEvents).toHaveLength(0);
  });

  it("event payload is forwarded intact", async () => {
    mockIsAvailable.mockResolvedValue(true);
    const worker = new EventAwareWorker();
    const event: WorkerEvent = {
      type: "git.push",
      payload: { repo: "lobs-core", branch: "main", commits: 3 },
      timestamp: new Date(),
    };
    await worker.run(event);
    expect(worker.receivedEvents[0]!.payload["repo"]).toBe("lobs-core");
    expect(worker.receivedEvents[0]!.payload["commits"]).toBe(3);
  });
});

// ── BaseWorker.run() — artifacts and alerts ───────────────────────────────────

describe("BaseWorker.run() — artifacts and alerts passthrough", () => {
  beforeEach(() => mockIsAvailable.mockResolvedValue(true));

  it("all artifacts are present in result", async () => {
    const result = await new ArtifactWorker().run();
    expect(result.artifacts).toHaveLength(3);
  });

  it("file artifact has path and content", async () => {
    const result = await new ArtifactWorker().run();
    const file = result.artifacts.find(a => a.type === "file");
    expect(file!.path).toBe("/tmp/out.txt");
    expect(file!.content).toBe("file content");
  });

  it("all alerts are present in result", async () => {
    const result = await new ArtifactWorker().run();
    expect(result.alerts).toHaveLength(2);
  });

  it("critical alert has actionRequired=true", async () => {
    const result = await new ArtifactWorker().run();
    const crit = result.alerts.find(a => a.severity === "critical");
    expect(crit!.actionRequired).toBe(true);
  });

  it("info alert has actionRequired=false", async () => {
    const result = await new ArtifactWorker().run();
    const info = result.alerts.find(a => a.severity === "info");
    expect(info!.actionRequired).toBe(false);
  });

  it("summary is carried through", async () => {
    const result = await new ArtifactWorker().run();
    expect(result.summary).toBe("Three artifacts, two alerts");
  });
});

// ── WorkerContext ─────────────────────────────────────────────────────────────

describe("BaseWorker.run() — WorkerContext passed to execute()", () => {
  it("ctx.startedAt is a Date", async () => {
    mockIsAvailable.mockResolvedValue(true);
    let capturedCtx: WorkerContext | null = null;
    class CtxCapture extends BaseWorker {
      readonly config: WorkerConfig = { id: "ctx", name: "Ctx", description: "", enabled: true };
      async execute(ctx: WorkerContext): Promise<WorkerResult> {
        capturedCtx = ctx;
        return { success: true, artifacts: [], alerts: [], tokensUsed: 0, durationMs: 0 };
      }
    }
    await new CtxCapture().run();
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.startedAt).toBeInstanceOf(Date);
  });

  it("ctx.model comes from config", async () => {
    mockIsAvailable.mockResolvedValue(true);
    let capturedModel = "";
    class ModelCapture extends BaseWorker {
      readonly config: WorkerConfig = {
        id: "model-cfg", name: "MC", description: "", enabled: true, model: "qwen3:14b",
      };
      async execute(ctx: WorkerContext): Promise<WorkerResult> {
        capturedModel = ctx.model;
        return { success: true, artifacts: [], alerts: [], tokensUsed: 0, durationMs: 0 };
      }
    }
    await new ModelCapture().run();
    expect(capturedModel).toBe("qwen3:14b");
  });

  it("ctx.triggerEvent is forwarded to execute() when onEvent returns null", async () => {
    mockIsAvailable.mockResolvedValue(true);
    let capturedEvent: WorkerEvent | undefined;
    class EventCapture extends BaseWorker {
      readonly config: WorkerConfig = { id: "ec", name: "EC", description: "", enabled: true };
      async execute(ctx: WorkerContext): Promise<WorkerResult> {
        capturedEvent = ctx.triggerEvent;
        return { success: true, artifacts: [], alerts: [], tokensUsed: 0, durationMs: 0 };
      }
      async onEvent(_e: WorkerEvent): Promise<WorkerResult | null> { return null; }
    }
    const evt: WorkerEvent = { type: "custom", payload: { x: 1 }, timestamp: new Date() };
    await new EventCapture().run(evt);
    expect(capturedEvent!.type).toBe("custom");
  });
});

// ── callLocalModel ────────────────────────────────────────────────────────────

describe("callLocalModel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns text and tokensUsed from a successful response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "  hello world  " } }],
        usage: { total_tokens: 77 },
      }),
    }) as unknown as typeof fetch;

    const result = await callLocalModel("test prompt");
    expect(result.text).toBe("hello world"); // trimmed
    expect(result.tokensUsed).toBe(77);
  });

  it("throws on non-OK response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    }) as unknown as typeof fetch;

    await expect(callLocalModel("prompt")).rejects.toThrow("503");
  });

  it("throws timeout error after timeoutMs", async () => {
    global.fetch = vi.fn().mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            (err as unknown as Record<string, unknown>)["name"] = "AbortError";
            reject(err);
          });
        });
      },
    ) as unknown as typeof fetch;

    await expect(
      callLocalModel("prompt", { timeoutMs: 10 })
    ).rejects.toThrow(/timed out/i);
  }, 5_000);

  it("strips lmstudio/ prefix from model before calling API", async () => {
    let capturedBody: unknown;
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } }),
      };
    }) as unknown as typeof fetch;

    await callLocalModel("test", { model: "lmstudio/qwen3:14b" });
    expect((capturedBody as Record<string, unknown>)["model"]).toBe("qwen3:14b");
  });

  it("includes system prompt as first message when provided", async () => {
    let capturedMessages: unknown[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedMessages = (JSON.parse(init.body as string) as { messages: unknown[] }).messages;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } }),
      };
    }) as unknown as typeof fetch;

    await callLocalModel("user prompt", { systemPrompt: "You are a coding assistant." });
    expect(capturedMessages).toHaveLength(2);
    expect((capturedMessages[0] as Record<string, unknown>)["role"]).toBe("system");
    expect((capturedMessages[0] as Record<string, unknown>)["content"]).toBe("You are a coding assistant.");
    expect((capturedMessages[1] as Record<string, unknown>)["role"]).toBe("user");
  });

  it("truncates prompts exceeding MAX_INPUT_CHARS (16000)", async () => {
    let capturedMessages: unknown[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedMessages = (JSON.parse(init.body as string) as { messages: unknown[] }).messages;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } }),
      };
    }) as unknown as typeof fetch;

    const longPrompt = "x".repeat(20_000);
    await callLocalModel(longPrompt);
    const userMsg = (capturedMessages[0] as Record<string, unknown>)["content"] as string;
    expect(userMsg.length).toBeLessThan(20_000);
    expect(userMsg).toContain("[truncated]");
  });

  it("returns empty text when choices array is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [], usage: { total_tokens: 0 } }),
    }) as unknown as typeof fetch;

    const { text } = await callLocalModel("prompt");
    expect(text).toBe("");
  });
});

// ── callLocalModelJSON ────────────────────────────────────────────────────────

describe("callLocalModelJSON", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses clean JSON response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"answer": 42}' } }],
        usage: { total_tokens: 10 },
      }),
    }) as unknown as typeof fetch;

    const { data } = await callLocalModelJSON<{ answer: number }>("prompt");
    expect(data.answer).toBe(42);
  });

  it("strips ```json code fence before parsing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n{"ok": true}\n```' } }],
        usage: { total_tokens: 5 },
      }),
    }) as unknown as typeof fetch;

    const { data } = await callLocalModelJSON<{ ok: boolean }>("prompt");
    expect(data.ok).toBe(true);
  });

  it("strips ``` code fence (without json) before parsing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```\n{"x": 1}\n```' } }],
        usage: { total_tokens: 5 },
      }),
    }) as unknown as typeof fetch;

    const { data } = await callLocalModelJSON<{ x: number }>("prompt");
    expect(data.x).toBe(1);
  });

  it("throws SyntaxError on non-JSON response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "This is plain text, not JSON." } }],
        usage: { total_tokens: 5 },
      }),
    }) as unknown as typeof fetch;

    await expect(callLocalModelJSON("prompt")).rejects.toThrow(SyntaxError);
  });

  it("returns tokensUsed from the response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"val": "ok"}' } }],
        usage: { total_tokens: 999 },
      }),
    }) as unknown as typeof fetch;

    const { tokensUsed } = await callLocalModelJSON("prompt");
    expect(tokensUsed).toBe(999);
  });

  it("parses array JSON response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n[1, 2, 3]\n```' } }],
        usage: { total_tokens: 5 },
      }),
    }) as unknown as typeof fetch;

    const { data } = await callLocalModelJSON<number[]>("prompt");
    expect(data).toEqual([1, 2, 3]);
  });
});
