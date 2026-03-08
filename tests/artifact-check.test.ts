/**
 * Tests for the pre-flight artifact existence check.
 *
 * Coverage:
 * - checkArtifacts() returns "proceed" for null/empty specs
 * - checkArtifacts() returns "skip_all_present" when all artifacts pass
 * - checkArtifacts() returns "skip_partial" when some artifacts pass but some fail
 * - checkArtifacts() returns "proceed" when no artifacts pass
 * - Size threshold: files < 512 bytes treated as missing
 * - Age threshold: files older than 7 days treated as missing
 * - ~ expansion in paths
 * - required: false artifacts do not affect outcome
 * - API: POST /api/tasks accepts expected_artifacts
 * - API: PATCH /api/tasks/:id accepts expected_artifacts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkArtifacts } from "../src/orchestrator/artifact-check.js";
import { getDb } from "../src/db/connection.js";
import { tasks } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { handleTaskRequest } from "../src/api/tasks.js";

/** Helper: call handleTaskRequest with correct url parts parsed.
 *  The router splits on "/" and passes parts[1] as `id`. We replicate that here. */
async function callTaskApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req as unknown as Record<string, unknown>).url as string;
  // Router splits "/api/tasks/abc" → ["api","tasks","abc"]; parts[1]="tasks", parts[2]="abc"
  const parts = url.replace(/^\//, "").split("/"); // ["api","tasks"] or ["api","tasks","id"]
  const id = parts[2]; // tasks sub-id (undefined for bare /api/tasks)
  return handleTaskRequest(req, res, id, parts);
}

// ─── Temp file helpers ────────────────────────────────────────────────────────

let tmpDir: string;

function createFile(name: string, content: string, ageDays = 0): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  if (ageDays > 0) {
    const mtime = new Date(Date.now() - ageDays * 86400000);
    utimesSync(path, mtime, mtime);
  }
  return path;
}

// ─── HTTP Mock Helpers ────────────────────────────────────────────────────────

function makeReq(method: string, url: string, body: unknown = {}): IncomingMessage {
  const r = new Readable({ read() {} }) as unknown as IncomingMessage;
  (r as unknown as Record<string, unknown>).method = method;
  (r as unknown as Record<string, unknown>).url = url;
  process.nextTick(() => {
    (r as unknown as Readable).push(JSON.stringify(body));
    (r as unknown as Readable).push(null);
  });
  return r;
}

function makeRes(): { res: ServerResponse; body: () => unknown } {
  let captured = "";
  const res = {
    statusCode: 200,
    writeHead(code: number) { this.statusCode = code; },
    setHeader() {},
    end(data: string) { captured = data; },
  } as unknown as ServerResponse;
  return { res, body: () => JSON.parse(captured) };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = join(tmpdir(), `artifact-check-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Unit tests: checkArtifacts() ────────────────────────────────────────────

describe("checkArtifacts", () => {
  it("returns proceed for null input", () => {
    expect(checkArtifacts(null)).toEqual({ status: "proceed" });
  });

  it("returns proceed for empty array", () => {
    expect(checkArtifacts([])).toEqual({ status: "proceed" });
  });

  it("returns proceed for non-array input", () => {
    expect(checkArtifacts("bad")).toEqual({ status: "proceed" });
  });

  it("returns skip_all_present when all artifacts exist and are large enough", () => {
    const p1 = createFile("doc1.md", "x".repeat(600));
    const p2 = createFile("doc2.md", "x".repeat(700));
    const result = checkArtifacts([{ path: p1 }, { path: p2 }]);
    expect(result.status).toBe("skip_all_present");
  });

  it("returns proceed when file does not exist", () => {
    const result = checkArtifacts([{ path: join(tmpDir, "missing.md") }]);
    expect(result.status).toBe("proceed");
  });

  it("returns proceed when file is too small (< 512 bytes)", () => {
    const p = createFile("small.md", "x".repeat(100));
    const result = checkArtifacts([{ path: p }]);
    expect(result.status).toBe("proceed");
  });

  it("returns proceed when file is too old (> 7 days)", () => {
    const p = createFile("old.md", "x".repeat(600), 8);
    const result = checkArtifacts([{ path: p }]);
    expect(result.status).toBe("proceed");
  });

  it("returns skip_partial when some artifacts pass and some fail", () => {
    const good = createFile("good.md", "x".repeat(600));
    const missing = join(tmpDir, "missing.md");
    const result = checkArtifacts([{ path: good }, { path: missing }]);
    expect(result.status).toBe("skip_partial");
    if (result.status === "skip_partial") {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]).toContain("missing.md");
    }
  });

  it("respects custom minBytes per-spec", () => {
    const p = createFile("small.md", "x".repeat(100));
    // With custom minBytes=50, 100 bytes should pass
    const result = checkArtifacts([{ path: p, minBytes: 50 }]);
    expect(result.status).toBe("skip_all_present");
  });

  it("respects custom maxAgeSeconds per-spec", () => {
    // 2 days old — passes default 7-day window
    const fresh = createFile("fresh.md", "x".repeat(600), 2);
    expect(checkArtifacts([{ path: fresh }]).status).toBe("skip_all_present");

    // 2 days old — fails custom 1-day window
    const result = checkArtifacts([{ path: fresh, maxAgeSeconds: 86400 }]);
    expect(result.status).toBe("proceed");
  });

  it("ignores required:false artifacts in outcome determination", () => {
    const required = createFile("required.md", "x".repeat(600));
    const optional = join(tmpDir, "optional.md"); // missing
    const result = checkArtifacts([
      { path: required, required: true },
      { path: optional, required: false },
    ]);
    // optional is missing but required:false → only required matters → all_present
    expect(result.status).toBe("skip_all_present");
  });

  it("expands ~ in paths", () => {
    const home = process.env["HOME"] ?? tmpdir();
    const p = join(home, `.artifact-check-test-${randomUUID()}.md`);
    try {
      writeFileSync(p, "x".repeat(600));
      const tildeP = p.replace(home, "~");
      expect(checkArtifacts([{ path: tildeP }]).status).toBe("skip_all_present");
    } finally {
      rmSync(p, { force: true });
    }
  });
});

// ─── API tests: expected_artifacts field ─────────────────────────────────────

describe("API: expected_artifacts", () => {

  it("POST /api/tasks persists expected_artifacts as JSON", async () => {
    const db = getDb();
    const title = `artifact-api-test-${randomUUID()}`;
    const artifacts = [{ path: "~/lobs-shared-memory/docs/guides/test.md" }];

    const { res, body } = makeRes();
    await callTaskApi(
      makeReq("POST", "/api/tasks", { title, expected_artifacts: artifacts }),
      res,
    );
    expect(res.statusCode).toBe(201);
    const created = body() as Record<string, unknown>;
    expect(created["id"]).toBeTruthy();

    // Check persisted value
    const row = db.select().from(tasks).where(eq(tasks.id, created["id"] as string)).get();
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.expectedArtifacts as string)).toEqual(artifacts);

    // Cleanup
    db.delete(tasks).where(eq(tasks.id, created["id"] as string)).run();
  });

  it("PATCH /api/tasks/:id updates expected_artifacts", async () => {
    const db = getDb();
    // Create task first
    const taskId = randomUUID();
    db.insert(tasks).values({
      id: taskId,
      title: `patch-artifact-test-${randomUUID()}`,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const newArtifacts = [{ path: "~/lobs-shared-memory/docs/test.md", minBytes: 100 }];
    const { res } = makeRes();
    await callTaskApi(
      makeReq("PATCH", `/api/tasks/${taskId}`, { expected_artifacts: newArtifacts }),
      res,
    );
    expect(res.statusCode).toBe(200);

    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    expect(JSON.parse(row!.expectedArtifacts as string)).toEqual(newArtifacts);

    // Cleanup
    db.delete(tasks).where(eq(tasks.id, taskId)).run();
  });
});
