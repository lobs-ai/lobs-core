import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/connection.js";
import { inboxItems, tasks } from "../src/db/schema.js";
import { handleInboxRequest } from "../src/api/inbox.js";
import { handleTaskRequest } from "../src/api/tasks.js";
import { handleRoutingRequest } from "../src/api/routing.js";

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

function makeRes(): { res: ServerResponse; body: () => Record<string, unknown> } {
  let captured = "";
  const res = {
    statusCode: 200,
    writeHead(code: number) { this.statusCode = code; },
    setHeader() {},
    end(data: string) { captured = data; },
  } as unknown as ServerResponse;
  return {
    res,
    body: () => JSON.parse(captured) as Record<string, unknown>,
  };
}

describe("intake triage APIs", () => {
  it("POST /api/tasks infers agent, priority, and model tier for incoming tasks", async () => {
    const { res, body } = makeRes();
    await handleTaskRequest(
      makeReq("POST", "/api/tasks", {
        title: "Fix production login bug ASAP",
        notes: "Users are blocked and auth is failing.",
      }),
      res,
      undefined,
      ["api", "tasks"],
    );

    expect(res.statusCode).toBe(201);
    const created = body();
    expect(created["agent"]).toBe("programmer");
    expect(created["priority"]).toMatch(/critical|high/);
    expect(created["modelTier"]).toMatch(/standard|strong/);

    getDb().delete(tasks).where(eq(tasks.id, created["id"] as string)).run();
  });

  it("POST /api/inbox stores triage metadata for emails and notifications", async () => {
    const { res, body } = makeRes();
    await handleInboxRequest(
      makeReq("POST", "/api/inbox", {
        title: "Invoice approval needed today",
        content: "Please approve the vendor invoice before EOD.",
        type: "email",
      }),
      res,
      undefined,
      ["api", "inbox"],
    );

    expect(res.statusCode).toBe(201);
    const created = body();
    expect(created["triageCategory"]).toBeTruthy();
    expect(created["triageUrgency"]).toMatch(/high|medium/);
    expect(created["triageRoute"]).toBeTruthy();
    expect(created["triagedAt"]).toBeTruthy();
    expect(typeof created["summary"]).toBe("string");

    getDb().delete(inboxItems).where(eq(inboxItems.id, created["id"] as string)).run();
  });

  it("POST /api/routing/classify returns a routing decision without hitting the workflow layer", async () => {
    const { res, body } = makeRes();
    await handleRoutingRequest(
      makeReq("POST", "/api/routing/classify", {
        kind: "notification",
        title: "Nightly backup completed",
        content: "No action required.",
      }),
      res,
      "classify",
    );

    expect(res.statusCode).toBe(200);
    const triage = body();
    expect(triage["kind"]).toBe("notification");
    expect(triage["route"]).toMatch(/defer|local|standard|strong/);
    expect(triage["urgency"]).toMatch(/critical|high|medium|low/);
    expect(triage["reasoning"]).toBeTruthy();
  });
});
