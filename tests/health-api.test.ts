/**
 * Tests for src/api/health.ts
 *
 * The handler checks: DB file existence, memory server, LM Studio, and PID.
 * We mock all external I/O (fs, fetch, memory-server) so tests run fast and
 * deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRes(): { res: ServerResponse; body: () => Record<string, unknown>; statusCode: () => number } {
  let captured = "";
  let code = 200;
  const res = {
    statusCode: 200,
    writeHead(c: number) { code = c; this.statusCode = c; },
    setHeader() {},
    end(data: string) { captured = data; },
  } as unknown as ServerResponse;
  return {
    res,
    body: () => JSON.parse(captured) as Record<string, unknown>,
    statusCode: () => code,
  };
}

function makeReq(): IncomingMessage {
  return { method: "GET", url: "/api/health" } as unknown as IncomingMessage;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleHealthRequest", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns status=healthy when DB file exists", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (_p: string) => true, // DB file exists
      readFileSync: (_p: string) => "12345",
    }));
    vi.doMock("../src/services/memory-server.js", () => ({
      memoryServer: { getStatus: () => ({ pid: 1, restartCount: 0, running: true }) },
    }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["status"]).toBe("healthy");
    expect(b["db"]).toBe("ok");
    expect(typeof b["uptime"]).toBe("number");
    expect(typeof b["pid"]).toBe("number");
  });

  it("returns status=unhealthy when DB file is missing", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (_p: string) => false,
      readFileSync: () => { throw new Error("no file"); },
    }));
    vi.doMock("../src/services/memory-server.js", () => ({
      memoryServer: { getStatus: () => ({ pid: null, restartCount: 0, running: false }) },
    }));
    global.fetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["status"]).toBe("unhealthy");
    expect(b["db"]).toBe("error");
  });

  it("reports memory_server=ok when memory server responds", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "99",
    }));
    vi.doMock("../src/services/memory-server.js", () => ({
      memoryServer: { getStatus: () => ({ pid: 2, restartCount: 1, running: true }) },
    }));
    // First fetch (memory server) succeeds, second (lmstudio) fails
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("no lmstudio")) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["memory_server"]).toBe("ok");
    expect(b["lm_studio"]).toBe("down");
  });

  it("reports lm_studio=ok when LM Studio responds", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "77",
    }));
    vi.doMock("../src/services/memory-server.js", () => ({
      memoryServer: { getStatus: () => ({ pid: 5, restartCount: 0, running: true }) },
    }));
    // memory-server fails, lm-studio succeeds
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new Error("no mem"))
      .mockResolvedValueOnce({ ok: true }) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["lm_studio"]).toBe("ok");
    expect(b["memory_server"]).toBe("down");
  });

  it("includes lm_studio_diagnostic block when LM Studio is down", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "42",
    }));
    vi.doMock("../src/services/memory-server.js", () => ({
      memoryServer: { getStatus: () => ({ pid: 0, restartCount: 0, running: false }) },
    }));
    global.fetch = vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["lm_studio"]).toBe("down");
    expect(b["lm_studio_diagnostic"]).toBeDefined();
    const diag = b["lm_studio_diagnostic"] as Record<string, unknown>;
    expect(typeof diag["hint"]).toBe("string");
    expect(diag["cli"]).toBe("lobs preflight");
    const api = diag["api"] as Record<string, unknown>;
    expect(api["status"]).toBe("/api/lm-studio");
    expect(api["models"]).toBe("/api/lm-studio/models");
  });

  it("does NOT include lm_studio_diagnostic when LM Studio is up", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "1",
    }));
    vi.doMock("../src/services/memory-server.js", () => ({
      memoryServer: { getStatus: () => ({ pid: 1, restartCount: 0, running: true }) },
    }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["lm_studio"]).toBe("ok");
    expect(b["lm_studio_diagnostic"]).toBeUndefined();
  });

  it("includes memory_supervisor fields in response", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "1",
    }));
    vi.doMock("../src/services/memory-server.js", () => ({
      memoryServer: {
        getStatus: () => ({ pid: 9001, restartCount: 3, running: true }),
      },
    }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    const sup = b["memory_supervisor"] as Record<string, unknown>;
    expect(sup["pid"]).toBe(9001);
    expect(sup["restarts"]).toBe(3);
    expect(sup["running"]).toBe(true);
  });

  it("reads PID from pid file when it exists", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (p: string) => true, // both db and pid file exist
      readFileSync: (_p: string) => "55555",
    }));
    vi.doMock("../src/services/memory-server.js", () => ({
      memoryServer: { getStatus: () => ({ pid: 1, restartCount: 0, running: true }) },
    }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["pid"]).toBe(55555);
  });

  it("falls back to process.pid when pid file is missing", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (p: string) => {
        // DB file exists but PID file does not
        return !p.endsWith(".pid");
      },
      readFileSync: () => { throw new Error("no pid file"); },
    }));
    vi.doMock("../src/services/memory-server.js", () => ({
      memoryServer: { getStatus: () => ({ pid: null, restartCount: 0, running: false }) },
    }));
    global.fetch = vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(typeof b["pid"]).toBe("number");
    expect(b["pid"]).toBeGreaterThan(0);
  });
});
