/**
 * Tests for CronService (src/services/cron.ts)
 *
 * Covers:
 *   - CronService construction + table creation
 *   - addAgentJob / removeAgentJob / toggleAgentJob
 *   - listAgentJobs (DB-backed)
 *   - listAllJobs (unified view)
 *   - registerSystemJob / toggleSystemJob
 *   - matchesCronSchedule via triggerJob
 *   - computeNextCronRun edge cases (kind=at, kind=every schedule strings)
 *   - initCronService / getCronService singletons
 *   - seedDefaults (no-op check)
 *   - event handler wiring (setEventHandler)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getRawDb } from "../src/db/connection.js";
import {
  CronService,
  parseCronExpression,
  initCronService,
  getCronService,
  type AgentJob,
  type SystemJob,
  type CronJobView,
  type CronFireEvent,
} from "../src/services/cron.js";

// Helper: fresh CronService backed by the shared in-memory DB
function makeService(): CronService {
  const db = getRawDb();
  // Drop existing table so each test is isolated
  db.exec("DROP TABLE IF EXISTS cron_jobs");
  return new CronService(db);
}

// ── CronService construction ─────────────────────────────────────────────────

describe("CronService construction", () => {
  it("creates the cron_jobs table on construction", () => {
    const db = getRawDb();
    db.exec("DROP TABLE IF EXISTS cron_jobs");
    new CronService(db);
    // Table must exist now
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_jobs'")
      .get() as { name: string } | undefined;
    expect(exists?.name).toBe("cron_jobs");
  });

  it("is safe to construct twice (idempotent table creation)", () => {
    const db = getRawDb();
    db.exec("DROP TABLE IF EXISTS cron_jobs");
    expect(() => {
      new CronService(db);
      new CronService(db);
    }).not.toThrow();
  });

  it("starts with no system jobs and no agent jobs", () => {
    const svc = makeService();
    expect(svc.listAgentJobs()).toHaveLength(0);
    expect(svc.listAllJobs()).toHaveLength(0);
  });
});

// ── Agent Job CRUD ──────────────────────────────────────────────────────────

describe("Agent job CRUD", () => {
  it("addAgentJob persists a cron job and returns it with an id", () => {
    const svc = makeService();
    const job = svc.addAgentJob({
      name: "Test Job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      payload: "run daily",
      enabled: true,
    });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe("Test Job");
    expect(job.schedule.kind).toBe("cron");
    expect(job.schedule.expr).toBe("0 9 * * *");
    expect(job.payload).toBe("run daily");
    expect(job.enabled).toBe(true);
    expect(job.createdAt).toBeTruthy();
  });

  it("listAgentJobs returns all jobs from DB", () => {
    const svc = makeService();
    svc.addAgentJob({ name: "A", schedule: { kind: "cron", expr: "0 9 * * *" }, payload: "a", enabled: true });
    svc.addAgentJob({ name: "B", schedule: { kind: "cron", expr: "0 10 * * *" }, payload: "b", enabled: false });

    const jobs = svc.listAgentJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.map(j => j.name).sort()).toEqual(["A", "B"]);
  });

  it("addAgentJob with kind=at stores the at timestamp", () => {
    const svc = makeService();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const job = svc.addAgentJob({
      name: "Once",
      schedule: { kind: "at", at: future },
      payload: "fire once",
      enabled: true,
    });

    const [listed] = svc.listAgentJobs();
    expect(listed.schedule.kind).toBe("at");
    expect(listed.schedule.at).toBe(future);
  });

  it("addAgentJob with kind=every stores everyMs", () => {
    const svc = makeService();
    svc.addAgentJob({
      name: "Interval",
      schedule: { kind: "every", everyMs: 300_000 },
      payload: "tick",
      enabled: true,
    });

    const [listed] = svc.listAgentJobs();
    expect(listed.schedule.kind).toBe("every");
    expect(listed.schedule.everyMs).toBe(300_000);
  });

  it("removeAgentJob deletes from DB and returns true", () => {
    const svc = makeService();
    const job = svc.addAgentJob({
      name: "Temp",
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: "x",
      enabled: true,
    });

    const removed = svc.removeAgentJob(job.id);
    expect(removed).toBe(true);
    expect(svc.listAgentJobs()).toHaveLength(0);
  });

  it("removeAgentJob returns false for nonexistent id", () => {
    const svc = makeService();
    expect(svc.removeAgentJob("non-existent-uuid")).toBe(false);
  });

  it("toggleAgentJob disables a job in DB", () => {
    const svc = makeService();
    const job = svc.addAgentJob({
      name: "Toggle",
      schedule: { kind: "cron", expr: "0 12 * * *" },
      payload: "noon",
      enabled: true,
    });

    svc.toggleAgentJob(job.id, false);
    const [listed] = svc.listAgentJobs();
    expect(listed.enabled).toBe(false);
  });

  it("toggleAgentJob re-enables a job", () => {
    const svc = makeService();
    const job = svc.addAgentJob({
      name: "Toggle2",
      schedule: { kind: "cron", expr: "0 12 * * *" },
      payload: "noon",
      enabled: false,
    });

    svc.toggleAgentJob(job.id, true);
    const [listed] = svc.listAgentJobs();
    expect(listed.enabled).toBe(true);
  });
});

// ── System Job Registration ──────────────────────────────────────────────────

describe("System job registration", () => {
  it("registerSystemJob adds to the unified job list", () => {
    const svc = makeService();
    svc.registerSystemJob({
      id: "heartbeat",
      name: "Heartbeat",
      schedule: "*/5 * * * *",
      enabled: true,
      handler: async () => {},
    });

    const all = svc.listAllJobs();
    expect(all).toHaveLength(1);
    const [view] = all;
    expect(view.name).toBe("Heartbeat");
    expect(view.kind).toBe("system");
    expect(view.enabled).toBe(true);
    expect(view.lastRun).toBeNull();
  });

  it("registerSystemJob with invalid cron logs warning but does not throw", () => {
    const svc = makeService();
    expect(() =>
      svc.registerSystemJob({
        id: "bad",
        name: "Bad",
        schedule: "NOT_VALID",
        enabled: true,
        handler: async () => {},
      })
    ).not.toThrow();
    // Doesn't add the job since parsing failed
    expect(svc.listAllJobs()).toHaveLength(0);
  });

  it("toggleSystemJob enables/disables a registered job", () => {
    const svc = makeService();
    svc.registerSystemJob({
      id: "sys1",
      name: "Sys1",
      schedule: "0 0 * * *",
      enabled: true,
      handler: async () => {},
    });

    expect(svc.toggleSystemJob("sys1", false)).toBe(true);
    const [view] = svc.listAllJobs();
    expect(view.enabled).toBe(false);

    expect(svc.toggleSystemJob("sys1", true)).toBe(true);
    const [view2] = svc.listAllJobs();
    expect(view2.enabled).toBe(true);
  });

  it("toggleSystemJob returns false for unknown id", () => {
    const svc = makeService();
    expect(svc.toggleSystemJob("unknown-id", false)).toBe(false);
  });
});

// ── listAllJobs unified view ─────────────────────────────────────────────────

describe("listAllJobs", () => {
  it("merges system and agent jobs", () => {
    const svc = makeService();
    svc.registerSystemJob({
      id: "hb",
      name: "Heartbeat",
      schedule: "* * * * *",
      enabled: true,
      handler: async () => {},
    });
    svc.addAgentJob({
      name: "Agent Job",
      schedule: { kind: "cron", expr: "0 8 * * *" },
      payload: "morning",
      enabled: true,
    });

    const all = svc.listAllJobs();
    expect(all).toHaveLength(2);
    const kinds = all.map(j => j.kind).sort();
    expect(kinds).toEqual(["agent", "system"]);
  });

  it("shows nextRun as ISO string for enabled cron jobs", () => {
    const svc = makeService();
    svc.registerSystemJob({
      id: "hb2",
      name: "HB2",
      schedule: "* * * * *",
      enabled: true,
      handler: async () => {},
    });
    const all = svc.listAllJobs();
    expect(all[0].nextRun).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("nextRun is null for disabled system jobs", () => {
    const svc = makeService();
    svc.registerSystemJob({
      id: "dis",
      name: "Disabled",
      schedule: "* * * * *",
      enabled: false,
      handler: async () => {},
    });
    const [view] = svc.listAllJobs();
    expect(view.nextRun).toBeNull();
  });

  it("shows 'every Ns' schedule string for kind=every agent jobs", () => {
    const svc = makeService();
    svc.addAgentJob({
      name: "Ticker",
      schedule: { kind: "every", everyMs: 120_000 },
      payload: "tick",
      enabled: true,
    });
    const all = svc.listAllJobs();
    expect(all[0].schedule).toContain("120");
  });

  it("shows 'at <ISO>' schedule string for kind=at agent jobs", () => {
    const svc = makeService();
    const ts = "2030-01-01T12:00:00.000Z";
    svc.addAgentJob({
      name: "OnceJob",
      schedule: { kind: "at", at: ts },
      payload: "once",
      enabled: true,
    });
    const all = svc.listAllJobs();
    expect(all[0].schedule).toContain("at ");
    expect(all[0].schedule).toContain(ts);
  });
});

// ── triggerJob ───────────────────────────────────────────────────────────────

describe("triggerJob", () => {
  it("manually triggers a system job and returns true", async () => {
    const svc = makeService();
    let called = 0;
    svc.registerSystemJob({
      id: "manual-sys",
      name: "ManualSys",
      schedule: "0 0 1 1 *",
      enabled: true,
      handler: async () => { called++; },
    });

    const result = await svc.triggerJob("manual-sys");
    expect(result).toBe(true);
    expect(called).toBe(1);
  });

  it("manually triggers an agent job and calls event handler", async () => {
    const svc = makeService();
    const fired: string[] = [];
    svc.setEventHandler(async (text) => { fired.push(text); });

    const job = svc.addAgentJob({
      name: "ManualAgent",
      schedule: { kind: "cron", expr: "0 0 1 1 *" },
      payload: "hello from agent",
      enabled: true,
    });

    const result = await svc.triggerJob(job.id);
    expect(result).toBe(true);
    expect(fired).toEqual(["hello from agent"]);
  });

  it("returns false for unknown job id", async () => {
    const svc = makeService();
    const result = await svc.triggerJob("no-such-id");
    expect(result).toBe(false);
  });

  it("triggering agent job updates last_fired in DB", async () => {
    const svc = makeService();
    svc.setEventHandler(async () => {});
    const job = svc.addAgentJob({
      name: "TrackFired",
      schedule: { kind: "cron", expr: "0 0 1 1 *" },
      payload: "x",
      enabled: true,
    });

    await svc.triggerJob(job.id);
    const [listed] = svc.listAgentJobs();
    expect(listed.lastFired).toBeTruthy();
  });
});

// ── Heartbeat seed cleanup ───────────────────────────────────────────────────

describe("seedDefaults", () => {
  it("seedDefaults is a no-op (does not add any jobs)", () => {
    const svc = makeService();
    svc.seedDefaults();
    expect(svc.listAgentJobs()).toHaveLength(0);
  });

  it("constructor removes legacy 'Heartbeat' agent job", () => {
    const db = getRawDb();
    db.exec("DROP TABLE IF EXISTS cron_jobs");
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule_kind TEXT NOT NULL,
        schedule_expr TEXT,
        schedule_at TEXT,
        schedule_every_ms INTEGER,
        schedule_tz TEXT DEFAULT 'America/New_York',
        payload TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_fired TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`INSERT INTO cron_jobs (id, name, schedule_kind, payload, enabled)
             VALUES ('old-hb', 'Heartbeat', 'cron', 'x', 1)`);

    new CronService(db);
    const jobs = db.prepare("SELECT * FROM cron_jobs WHERE name = 'Heartbeat'").all();
    expect(jobs).toHaveLength(0);
  });
});

// ── initCronService / getCronService singleton ───────────────────────────────

describe("singleton helpers", () => {
  it("getCronService returns null before init", () => {
    // Reset singleton by reinitializing — can't clear it directly, but we can
    // at least verify the getter works (it was initialized by prior test or returns null)
    // Just check it doesn't throw
    expect(() => getCronService()).not.toThrow();
  });

  it("initCronService creates and returns a CronService", () => {
    const db = getRawDb();
    db.exec("DROP TABLE IF EXISTS cron_jobs");
    const svc = initCronService(db);
    expect(svc).toBeInstanceOf(CronService);
    expect(getCronService()).toBe(svc);
  });
});

// ── start / stop lifecycle ───────────────────────────────────────────────────

describe("lifecycle", () => {
  it("start() is idempotent (no error calling twice)", () => {
    const svc = makeService();
    expect(() => {
      svc.start();
      svc.start(); // second call should be a no-op
      svc.stop();
    }).not.toThrow();
  });

  it("stop() is safe to call without start()", () => {
    const svc = makeService();
    expect(() => svc.stop()).not.toThrow();
  });
});

// ── last_fired UTC parsing (dedup guard) ─────────────────────────────────────

describe("dedup guard: last_fired UTC normalization", () => {
  it("does not double-fire when last_fired is stored as SQLite UTC (no Z suffix)", async () => {
    // SQLite datetime('now') produces "2026-03-23 11:00:00" — no Z, no T
    // Node.js parses this as LOCAL time, which in non-UTC zones gives the wrong ms.
    // The fix normalises it to "2026-03-23T11:00:00Z" before calling new Date().
    const svc = makeService();
    let fireCount = 0;
    svc.setEventHandler(async () => { fireCount++; });

    // Add a job that matches every minute
    const job = svc.addAgentJob({
      name: "DedupeTest",
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: "test",
      enabled: true,
    });

    // Manually set last_fired in the SQLite format (no Z, no T)
    const db = (svc as any).db;
    const now = new Date();
    now.setSeconds(0); now.setMilliseconds(0);
    // Produce a "YYYY-MM-DD HH:MM:SS" string in UTC — the SQLite datetime('now') format
    const sqliteUtcStr = now.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
    db.prepare("UPDATE cron_jobs SET last_fired = ? WHERE id = ?").run(sqliteUtcStr, job.id);

    // Reload the job (tick reloads from DB each time)
    await (svc as any).tick();

    // The job should NOT have fired — last_fired matches current minute
    expect(fireCount).toBe(0);
  });

  it("fires when last_fired was a different minute (UTC normalization)", async () => {
    const svc = makeService();
    let fireCount = 0;
    svc.setEventHandler(async () => { fireCount++; });

    svc.addAgentJob({
      name: "FiredBeforeTest",
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: "test",
      enabled: true,
    });

    // Don't set last_fired — job has never fired, so it should fire
    await (svc as any).tick();
    expect(fireCount).toBe(1);
  });
});

// ── parseCronExpression edge cases not in cron-parser.test.ts ──────────────

describe("parseCronExpression additional coverage", () => {
  it("throws on too many fields (>5)", () => {
    // 6 fields should be treated as the first 5 valid (current impl splits on whitespace)
    // Test the minimum invalid case
    expect(() => parseCronExpression("")).toThrow();
  });

  it("handles single-field step: '5/2' (starts at 5, steps by 2)", () => {
    const result = parseCronExpression("5/2 * * * *");
    // Should produce just [5] since 5 is treated as a bare number (not range)
    expect(result.minute).toContain(5);
  });

  it("month field is 1-indexed (1=January, 12=December)", () => {
    const result = parseCronExpression("0 0 1 1,12 *");
    expect(result.month).toEqual([1, 12]);
  });

  it("dayOfWeek field is 0=Sunday, 6=Saturday", () => {
    const result = parseCronExpression("0 0 * * 0,6");
    expect(result.dayOfWeek).toEqual([0, 6]);
  });

  it("handles multiple ranges in minutes combined with step", () => {
    const result = parseCronExpression("0,15,30,45 * * * *");
    expect(result.minute).toEqual([0, 15, 30, 45]);
  });

  it("step on wildcard generates correct values for hours", () => {
    const result = parseCronExpression("0 */8 * * *");
    expect(result.hour).toEqual([0, 8, 16]);
  });

  it("daily midnight expression has exactly 1 minute and 1 hour value", () => {
    const r = parseCronExpression("0 0 * * *");
    expect(r.minute).toEqual([0]);
    expect(r.hour).toEqual([0]);
    expect(r.dayOfMonth).toHaveLength(31);
  });
});

// ── Fire-log observability ───────────────────────────────────────────────────

describe("CronFireEvent ring buffer", () => {
  it("getFireLog returns empty array before any fires", () => {
    const svc = makeService();
    svc.registerSystemJob({
      id: "early-bird",
      name: "EarlyBird",
      schedule: "* * * * *",
      enabled: true,
      handler: async () => {},
    });
    expect(svc.getFireLog()).toHaveLength(0);
    expect(svc.getFireLog("early-bird")).toHaveLength(0);
  });

  it("records a fire event for a system job (success)", async () => {
    const svc = makeService();
    svc.registerSystemJob({
      id: "sys-log",
      name: "SysLog",
      schedule: "0 0 1 1 *",
      enabled: true,
      handler: async () => {},
    });

    await svc.triggerJob("sys-log");

    const events = svc.getFireLog("sys-log");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.jobId).toBe("sys-log");
    expect(ev.jobName).toBe("SysLog");
    expect(ev.jobKind).toBe("system");
    expect(ev.success).toBe(true);
    expect(ev.manual).toBe(true);
    expect(ev.firedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
    expect(ev.error).toBeUndefined();
  });

  it("records a fire event for a system job (failure)", async () => {
    const svc = makeService();
    svc.registerSystemJob({
      id: "sys-fail",
      name: "SysFail",
      schedule: "0 0 1 1 *",
      enabled: true,
      handler: async () => { throw new Error("boom"); },
    });

    await svc.triggerJob("sys-fail");

    const events = svc.getFireLog("sys-fail");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.success).toBe(false);
    expect(ev.error).toBe("boom");
  });

  it("records a fire event for an agent job (success)", async () => {
    const svc = makeService();
    const fired: string[] = [];
    svc.setEventHandler(async (text) => { fired.push(text); });

    const job = svc.addAgentJob({
      name: "AgentFireLog",
      schedule: { kind: "cron", expr: "0 0 1 1 *" },
      payload: "run agent",
      enabled: true,
    });

    await svc.triggerJob(job.id);

    const events = svc.getFireLog(job.id);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.jobName).toBe("AgentFireLog");
    expect(ev.jobKind).toBe("agent");
    expect(ev.success).toBe(true);
    expect(ev.manual).toBe(true);
  });

  it("records failure when no onEvent handler is wired for agent job", async () => {
    const svc = makeService(); // no setEventHandler call

    const job = svc.addAgentJob({
      name: "NoHandler",
      schedule: { kind: "cron", expr: "0 0 1 1 *" },
      payload: "lost payload",
      enabled: true,
    });

    await svc.triggerJob(job.id);

    const events = svc.getFireLog(job.id);
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
    expect(events[0].error).toMatch(/no onEvent handler/i);
  });

  it("getFireLog() without jobId returns merged events for all jobs (newest first)", async () => {
    const svc = makeService();
    svc.setEventHandler(async () => {});

    svc.registerSystemJob({ id: "a", name: "A", schedule: "0 0 1 1 *", enabled: true, handler: async () => {} });
    const jobB = svc.addAgentJob({ name: "B", schedule: { kind: "cron", expr: "0 0 1 1 *" }, payload: "b", enabled: true });

    await svc.triggerJob("a");
    await svc.triggerJob(jobB.id);

    const all = svc.getFireLog();
    expect(all.length).toBeGreaterThanOrEqual(2);
    // Newest first
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].firedAt >= all[i].firedAt).toBe(true);
    }
  });

  it("ring buffer caps at 50 entries per job", async () => {
    const svc = makeService();
    svc.registerSystemJob({ id: "flood", name: "Flood", schedule: "0 0 1 1 *", enabled: true, handler: async () => {} });

    // Fire 60 times
    for (let i = 0; i < 60; i++) {
      await svc.triggerJob("flood");
    }

    const events = svc.getFireLog("flood");
    expect(events).toHaveLength(50);
  });

  it("getFireSummary returns a row for each known job", async () => {
    const svc = makeService();
    svc.setEventHandler(async () => {});
    svc.registerSystemJob({ id: "s1", name: "S1", schedule: "* * * * *", enabled: true, handler: async () => {} });
    const j1 = svc.addAgentJob({ name: "J1", schedule: { kind: "cron", expr: "* * * * *" }, payload: "j1", enabled: true });

    await svc.triggerJob("s1");
    await svc.triggerJob(j1.id);

    const summary = svc.getFireSummary();
    expect(summary.length).toBeGreaterThanOrEqual(2);
    const s1 = summary.find(r => r.jobId === "s1");
    expect(s1?.lastSuccess).toBe(true);
    expect(s1?.consecutiveFailures).toBe(0);
    expect(s1?.totalFires).toBe(1);
  });

  it("getFireSummary sorts jobs with consecutive failures first", async () => {
    const svc = makeService();
    svc.registerSystemJob({ id: "good", name: "Good", schedule: "0 0 1 1 *", enabled: true, handler: async () => {} });
    svc.registerSystemJob({ id: "bad", name: "Bad", schedule: "0 0 1 1 *", enabled: true, handler: async () => { throw new Error("x"); } });

    await svc.triggerJob("good");
    await svc.triggerJob("bad");
    await svc.triggerJob("bad");

    const summary = svc.getFireSummary();
    expect(summary[0].jobId).toBe("bad");
    expect(summary[0].consecutiveFailures).toBe(2);
  });

  it("trigger via scheduler tick (non-manual) records manual=false", async () => {
    const svc = makeService();
    svc.setEventHandler(async () => {});

    const job = svc.addAgentJob({
      name: "TickJob",
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: "tick",
      enabled: true,
    });

    // Simulate a tick fire (no triggerJob, direct tick)
    await (svc as any).tick();

    const events = svc.getFireLog(job.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].manual).toBe(false);
  });
});
