/**
 * tool-gate hook tests
 *
 * Tests the before_tool_call hook for:
 * - Hard block patterns (exec mutations to PAW DB, config file writes, gateway)
 * - Hard block tool names (gateway)
 * - Hard block file path patterns (lobs.json, paw.db, lobs.yml)
 * - Tier A: auto-approve (no block)
 * - Tier B: allow + audit log
 * - Tier C: block dangerous tools, allow safe tools
 * - No block when session is not a worker (no active worker_run)
 * - Dangerous patterns: rm -rf, git push, git merge, deploy, kubectl apply
 *
 * The hook only fires when there's an active worker_run for the sessionKey.
 * We insert rows into worker_runs + tasks to set up each test case.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getRawDb } from "../src/db/connection.js";
import { registerToolGateHook } from "../src/hooks/tool-gate.js";

// ── Fake LobsPluginApi ────────────────────────────────────────────────────────

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function makeFakeApi(): { api: { on: ReturnType<typeof vi.fn> }; getHandler: () => HookHandler } {
  let handler!: HookHandler;
  const api = {
    on: vi.fn((event: string, fn: HookHandler) => {
      if (event === "before_tool_call") handler = fn;
    }),
  };
  return { api, getHandler: () => handler };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

let taskSeq = 0;
let runSeq = 0;

function insertTask(
  id: string,
  opts: { title?: string; agent?: string; notes?: string; status?: string } = {},
): void {
  getRawDb()
    .prepare(
      `INSERT OR REPLACE INTO tasks
         (id, title, status, agent, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(
      id,
      opts.title ?? "Test task",
      opts.status ?? "active",
      opts.agent ?? "programmer",
      opts.notes ?? null,
    );
}

/**
 * Insert an active worker_run for the given sessionKey + taskId.
 * Returns the run ID.
 */
function insertActiveWorkerRun(sessionKey: string, taskId: string): number {
  const db = getRawDb();
  db.prepare(
    `INSERT INTO worker_runs (worker_id, task_id, started_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(sessionKey, taskId);
  const row = db
    .prepare(`SELECT id FROM worker_runs WHERE worker_id = ? AND task_id = ? AND ended_at IS NULL`)
    .get(sessionKey, taskId) as { id: number };
  return row.id;
}

function clearWorkerRuns(): void {
  getRawDb().prepare(`DELETE FROM worker_runs`).run();
}

function clearInboxItems(): void {
  getRawDb().prepare(`DELETE FROM inbox_items`).run();
}

function countInboxItems(): number {
  return (getRawDb().prepare(`SELECT COUNT(*) as n FROM inbox_items`).get() as { n: number }).n;
}

/**
 * Build a standard test context for a worker session.
 * Creates task + worker_run in DB, returns {api, handler, ctx}.
 */
function setupWorkerSession(opts: {
  agent?: string;
  notes?: string;
  title?: string;
  status?: string;
} = {}): {
  handler: HookHandler;
  sessionKey: string;
  taskId: string;
} {
  const taskId = `task-${++taskSeq}`;
  const sessionKey = `worker-session-${++runSeq}`;
  insertTask(taskId, { agent: opts.agent ?? "programmer", notes: opts.notes, title: opts.title, status: opts.status });
  insertActiveWorkerRun(sessionKey, taskId);
  const { api, getHandler } = makeFakeApi();
  registerToolGateHook(api as any);
  return { handler: getHandler(), sessionKey, taskId };
}

// ── Baseline: no sessionKey → no block ───────────────────────────────────────

describe("tool-gate — no sessionKey", () => {
  it("returns undefined (no block) when ctx has no sessionKey", async () => {
    const { api, getHandler } = makeFakeApi();
    registerToolGateHook(api as any);
    const result = await getHandler()({ toolName: "exec", toolInput: { command: "rm -rf /" } }, {});
    expect(result).toBeUndefined();
  });

  it("returns undefined when sessionKey is absent (no worker_run)", async () => {
    const { api, getHandler } = makeFakeApi();
    registerToolResolveHook: registerToolGateHook(api as any);
    const result = await getHandler()(
      { toolName: "Write", toolInput: { path: "lobs.json" } },
      { sessionKey: "no-run-for-this-session" },
    );
    expect(result).toBeUndefined();
  });
});

// ── Hard block: tool name "gateway" ──────────────────────────────────────────

describe("tool-gate — hard block: tool name", () => {
  beforeEach(() => {
    clearWorkerRuns();
    clearInboxItems();
  });

  it("blocks 'gateway' tool for any worker", async () => {
    const { handler, sessionKey } = setupWorkerSession();
    const result = await handler(
      { toolName: "gateway", toolInput: {} },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toMatch(/gateway/i);
  });
});

// ── Hard block: exec patterns ─────────────────────────────────────────────────

describe("tool-gate — hard block: exec mutations to PAW DB", () => {
  beforeEach(() => {
    clearWorkerRuns();
    clearInboxItems();
  });

  const blockedCommands = [
    `sqlite3 ~/.lobs/plugins/paw/paw.db "UPDATE tasks SET status='done' WHERE id='abc'"`,
    `sqlite3 ~/.lobs/paw/paw.db 'INSERT INTO tasks VALUES (1,"foo")'`,
    `sqlite3 /tmp/paw.db DELETE FROM tasks`,
    `sqlite3 paw.db ALTER TABLE tasks ADD COLUMN foo TEXT`,
  ];

  for (const cmd of blockedCommands) {
    it(`blocks exec: ${cmd.slice(0, 60)}…`, async () => {
      const { handler, sessionKey } = setupWorkerSession();
      const result = await handler(
        { toolName: "exec", toolInput: { command: cmd } },
        { sessionKey },
      ) as any;
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toMatch(/orchestrator|lobs/i);
    });
  }

  it("blocks lobs.json mentions in exec", async () => {
    const { handler, sessionKey } = setupWorkerSession();
    const result = await handler(
      { toolName: "exec", toolInput: { command: "cat ~/.lobs/lobs.json && echo done" } },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
  });

  it("blocks lobs.yml mentions in exec", async () => {
    const { handler, sessionKey } = setupWorkerSession();
    const result = await handler(
      { toolName: "exec", toolInput: { command: "cp ./lobs.yml /tmp/backup" } },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
  });

  it("blocks lobs gateway commands in exec", async () => {
    const { handler, sessionKey } = setupWorkerSession();
    const result = await handler(
      { toolName: "exec", toolInput: { command: "lobs gateway restart" } },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
  });

  it("does NOT block a safe sqlite3 command on a different db", async () => {
    const { handler, sessionKey } = setupWorkerSession();
    const result = await handler(
      { toolName: "exec", toolInput: { command: "sqlite3 /tmp/myapp.db 'SELECT 1'" } },
      { sessionKey },
    );
    // No block — different DB file, no mutation pattern matching paw.db
    expect((result as any)?.block).not.toBe(true);
  });

  it("Bash tool name also triggers hard block patterns", async () => {
    const { handler, sessionKey } = setupWorkerSession();
    const result = await handler(
      {
        toolName: "Bash",
        toolInput: { command: `sqlite3 paw.db "UPDATE tasks SET status='done'"` },
      },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
  });
});

// ── Hard block: file path patterns ────────────────────────────────────────────

describe("tool-gate — hard block: write/edit to protected files", () => {
  beforeEach(() => {
    clearWorkerRuns();
    clearInboxItems();
  });

  const toolNames = ["Write", "Edit", "write", "edit"];

  for (const toolName of toolNames) {
    it(`blocks ${toolName} to lobs.json`, async () => {
      const { handler, sessionKey } = setupWorkerSession();
      const result = await handler(
        { toolName, toolInput: { path: "/home/user/.lobs/lobs.json" } },
        { sessionKey },
      ) as any;
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toMatch(/lobs\.json/i);
    });

    it(`blocks ${toolName} to lobs.yml`, async () => {
      const { handler, sessionKey } = setupWorkerSession();
      const result = await handler(
        { toolName, toolInput: { path: "/home/user/.lobs/lobs.yml" } },
        { sessionKey },
      ) as any;
      expect(result?.block).toBe(true);
    });

    it(`blocks ${toolName} to lobs.yaml`, async () => {
      const { handler, sessionKey } = setupWorkerSession();
      const result = await handler(
        { toolName, toolInput: { path: "config/lobs.yaml" } },
        { sessionKey },
      ) as any;
      expect(result?.block).toBe(true);
    });

    it(`blocks ${toolName} to paw.db`, async () => {
      const { handler, sessionKey } = setupWorkerSession();
      const result = await handler(
        { toolName, toolInput: { path: "/tmp/paw.db" } },
        { sessionKey },
      ) as any;
      expect(result?.block).toBe(true);
    });

    it(`allows ${toolName} to safe paths`, async () => {
      const { handler, sessionKey } = setupWorkerSession();
      const result = await handler(
        { toolName, toolInput: { path: "/home/user/myproject/src/main.ts" } },
        { sessionKey },
      );
      expect((result as any)?.block).not.toBe(true);
    });
  }
});

// ── Tier A: auto-approve ──────────────────────────────────────────────────────

describe("tool-gate — Tier A (auto-approve)", () => {
  beforeEach(() => {
    clearWorkerRuns();
    clearInboxItems();
  });

  // Tier A: agent=programmer, notes contain "bug fix"
  it("does not block safe exec for Tier A task", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "bug fix: handle null pointer",
    });
    const result = await handler(
      { toolName: "exec", toolInput: { command: "npm test" } },
      { sessionKey },
    );
    expect((result as any)?.block).not.toBe(true);
  });

  it("does not block Write to normal file for Tier A task", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "fix typo in README",
    });
    const result = await handler(
      { toolName: "Write", toolInput: { path: "/project/src/main.ts" } },
      { sessionKey },
    );
    expect((result as any)?.block).not.toBe(true);
  });

  it("Tier A research task allows all safe tools", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "researcher",
      notes: "research competitor pricing",
    });
    const result = await handler(
      { toolName: "exec", toolInput: { command: "curl https://example.com/api" } },
      { sessionKey },
    );
    expect((result as any)?.block).not.toBe(true);
  });
});

// ── Tier B: allow with audit ──────────────────────────────────────────────────

describe("tool-gate — Tier B (allow, audit log)", () => {
  beforeEach(() => {
    clearWorkerRuns();
    clearInboxItems();
  });

  it("allows safe tools for Tier B refactor task without creating inbox items", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "refactor the utility module",
    });
    const result = await handler(
      { toolName: "exec", toolInput: { command: "npm run build" } },
      { sessionKey },
    );
    expect((result as any)?.block).not.toBe(true);
    // No inbox item for safe Tier B
    expect(countInboxItems()).toBe(0);
  });

  it("Tier B allows dangerous tools (audit, no block)", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "refactor the auth module for better performance",
    });
    // rm -rf is dangerous but Tier B doesn't block it — just logs
    const result = await handler(
      { toolName: "exec", toolInput: { command: "rm -rf ./dist && npm run build" } },
      { sessionKey },
    );
    expect((result as any)?.block).not.toBe(true);
  });
});

// ── Tier C: block dangerous tools ────────────────────────────────────────────

describe("tool-gate — Tier C (block dangerous + inbox)", () => {
  beforeEach(() => {
    clearWorkerRuns();
    clearInboxItems();
  });

  // Tier C: agent=programmer, notes about new UI feature or architecture
  it("blocks rm -rf exec for Tier C task", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "build new dashboard UI feature",
      title: "Dashboard feature",
    });
    const result = await handler(
      { toolName: "exec", toolInput: { command: "rm -rf ./old-dashboard" } },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toMatch(/tier c/i);
  });

  it("creates an inbox item when blocking Tier C", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "implement new payment processing architecture",
      title: "Payment architecture",
    });
    await handler(
      { toolName: "exec", toolInput: { command: "git push origin main" } },
      { sessionKey },
    );
    expect(countInboxItems()).toBeGreaterThan(0);
  });

  it("blocks git push for Tier C task", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "major frontend redesign",
      title: "Frontend redesign",
    });
    const result = await handler(
      { toolName: "exec", toolInput: { command: "git push origin feature/redesign" } },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
  });

  it("blocks git merge for Tier C task", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "deploy new microservices architecture",
      title: "Architecture deploy",
    });
    const result = await handler(
      { toolName: "exec", toolInput: { command: "git merge feature/arch" } },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
  });

  it("blocks deploy command for Tier C task", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "new UI component library",
      title: "Component library",
    });
    const result = await handler(
      { toolName: "exec", toolInput: { command: "deploy production" } },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
  });

  it("blocks kubectl apply for Tier C task", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "new frontend architecture",
      title: "Architecture task",
    });
    const result = await handler(
      { toolName: "exec", toolInput: { command: "kubectl apply -f k8s/deployment.yaml" } },
      { sessionKey },
    ) as any;
    expect(result?.block).toBe(true);
  });

  it("allows safe exec for Tier C (no dangerous pattern)", async () => {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "new frontend architecture",
      title: "Architecture task 2",
    });
    const result = await handler(
      { toolName: "exec", toolInput: { command: "ls -la" } },
      { sessionKey },
    );
    expect((result as any)?.block).not.toBe(true);
  });
});

// ── DANGEROUS_PATTERNS — pattern coverage tests ───────────────────────────────

describe("dangerous pattern matching", () => {
  beforeEach(() => {
    clearWorkerRuns();
    clearInboxItems();
  });

  // These test that isDangerous() correctly matches the patterns.
  // We use a Tier C task so dangerous tools get blocked.
  function makeC(): Promise<{ handler: HookHandler; sessionKey: string }> {
    const { handler, sessionKey } = setupWorkerSession({
      agent: "programmer",
      notes: "new UI dashboard architecture feature",
      title: "Danger test task",
    });
    return Promise.resolve({ handler, sessionKey });
  }

  const dangerCommands: Array<[string, string]> = [
    ["rm -rf /tmp/foo", "rm -rf"],
    ["rm -r /tmp/dir", "rm -r"],
    ["git push origin main", "git push"],
    ["git push --force", "git push --force"],
    ["git merge dev", "git merge"],
    ["deploy my-service", "deploy"],
    ["kubectl apply -f manifest.yaml", "kubectl apply"],
    ["kubectl delete pod/my-pod", "kubectl delete"],
  ];

  for (const [cmd, label] of dangerCommands) {
    it(`blocks: ${label}`, async () => {
      const { handler, sessionKey } = await makeC();
      const result = await handler(
        { toolName: "exec", toolInput: { command: cmd } },
        { sessionKey },
      ) as any;
      expect(result?.block).toBe(true);
    });
  }

  const safeCommands = [
    "npm test",
    "npm run build",
    "ls -la",
    "cat README.md",
    "grep -r 'TODO' src/",
    "echo hello",
    "node --version",
  ];

  for (const cmd of safeCommands) {
    it(`does not block safe: ${cmd}`, async () => {
      const { handler, sessionKey } = await makeC();
      const result = await handler(
        { toolName: "exec", toolInput: { command: cmd } },
        { sessionKey },
      );
      expect((result as any)?.block).not.toBe(true);
    });
  }
});

// ── stall watchdog: last_tool_call_at is updated ──────────────────────────────

describe("tool-gate — stall watchdog side effect", () => {
  beforeEach(() => {
    clearWorkerRuns();
  });

  it("updates last_tool_call_at on active worker_run", async () => {
    const { handler, sessionKey, taskId } = setupWorkerSession({
      agent: "programmer",
      notes: "bug fix",
    });
    const db = getRawDb();

    // Confirm last_tool_call_at is null before hook fires
    const before = db
      .prepare(`SELECT last_tool_call_at FROM worker_runs WHERE worker_id = ? AND ended_at IS NULL`)
      .get(sessionKey) as { last_tool_call_at: string | null };
    expect(before?.last_tool_call_at).toBeNull();

    await handler(
      { toolName: "exec", toolInput: { command: "echo test" } },
      { sessionKey },
    );

    const after = db
      .prepare(`SELECT last_tool_call_at FROM worker_runs WHERE worker_id = ? AND ended_at IS NULL`)
      .get(sessionKey) as { last_tool_call_at: string | null };
    expect(after?.last_tool_call_at).toBeTruthy();
  });
});
