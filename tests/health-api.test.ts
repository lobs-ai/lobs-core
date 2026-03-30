/**
 * Tests for src/api/health.ts
 *
 * The handler checks: DB file existence, unified memory DB, LM Studio, and PID.
 * We mock all external I/O (fs, fetch, memory/db) so tests run fast and
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

/** A minimal mock DB that supports the two count queries health.ts runs. */
function makeMemoryDb() {
  return {
    prepare: (sql: string) => ({
      get: () => ({ c: sql.includes("document") ? 42 : 1337 }),
    }),
  };
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
      existsSync: (_p: string) => true,
      readFileSync: (_p: string) => "12345",
    }));
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => makeMemoryDb(),
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
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => { throw new Error("not initialized"); },
    }));
    global.fetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["status"]).toBe("unhealthy");
    expect(b["db"]).toBe("error");
  });

  it("reports memory_server=ok when unified memory DB is ready", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "99",
    }));
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => makeMemoryDb(),
    }));
    // LM Studio fails
    global.fetch = vi.fn().mockRejectedValue(new Error("no lmstudio")) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["memory_server"]).toBe("ok");
    expect(b["lm_studio"]).toBe("down");
  });

  it("reports memory_server=down when unified memory DB is not ready", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "99",
    }));
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => { throw new Error("not initialized"); },
    }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["memory_server"]).toBe("down");
    expect(b["lm_studio"]).toBe("ok");
  });

  it("reports lm_studio=ok when LM Studio responds", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "77",
    }));
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => { throw new Error("not initialized"); },
    }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

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
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => makeMemoryDb(),
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
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => makeMemoryDb(),
    }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    expect(b["lm_studio"]).toBe("ok");
    expect(b["lm_studio_diagnostic"]).toBeUndefined();
  });

  it("memory response includes unified DB stats when ready", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "1",
    }));
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => makeMemoryDb(),
    }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    const { handleHealthRequest } = await import("../src/api/health.js");
    const { res, body } = makeRes();
    await handleHealthRequest(makeReq(), res);

    const b = body();
    const mem = b["memory"] as Record<string, unknown>;
    expect(mem["status"]).toBe("ok");
    expect(mem["mode"]).toBe("unified-db");
    expect(mem["total_memories"]).toBe(1337);
    expect(mem["document_memories"]).toBe(42);
  });

  it("reads PID from pid file when it exists", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (_p: string) => true,
      readFileSync: (_p: string) => "55555",
    }));
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => makeMemoryDb(),
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
      existsSync: (p: string) => !p.endsWith(".pid"),
      readFileSync: () => { throw new Error("no pid file"); },
    }));
    vi.doMock("../src/memory/db.js", () => ({
      getMemoryDb: () => { throw new Error("not initialized"); },
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
