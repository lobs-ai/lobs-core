/**
 * Tests for src/util/project-inference.ts
 *
 * inferProjectId(title, notes?) — matches task text against active projects
 * using keyword overrides + auto-keywords derived from project title.
 *
 * Cache-busting strategy: the module has a 60-second cache.
 * We bust it by using vi.useFakeTimers() set to a specific time and
 * advancing it far enough between tests so each test sees a fresh load.
 * The trick: we set fake timers once globally and keep advancing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "../src/db/connection.js";
import { projects } from "../src/db/schema.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function insertProject(
  overrides: Partial<typeof projects.$inferInsert> & { id: string; title: string }
) {
  getDb()
    .insert(projects)
    .values({ type: "kanban", archived: false, ...overrides })
    .run();
}

function clearProjects() {
  getDb().delete(projects).run();
}

// We import inferProjectId after fake timers are set up to ensure any
// module-level Date.now() call also uses the fake clock.
let inferProjectId: (title: string, notes?: string | null) => string | null;

beforeAll(async () => {
  // Install fake timers BEFORE importing the module
  vi.useFakeTimers();
  const mod = await import("../src/util/project-inference.js");
  inferProjectId = mod.inferProjectId;
});

afterAll(() => {
  vi.useRealTimers();
  clearProjects();
});

/** Bust the 60-second rule cache by advancing fake clock past the TTL */
function bustCache() {
  vi.advanceTimersByTime(61_000);
}

// ─── Keyword override matching ─────────────────────────────────────────────

describe("inferProjectId — keyword override matching", () => {
  beforeEach(() => {
    bustCache();
    clearProjects();
    insertProject({ id: "proj-paw", title: "PAW Orchestration Platform" });
    insertProject({ id: "paw-sail", title: "Sail Container" });
    insertProject({ id: "paw-ship", title: "Ship Multi-Tenant" });
    insertProject({ id: "paw-portal", title: "PAW Portal" });
  });

  it("matches 'paw' keyword → proj-paw", () => {
    expect(inferProjectId("fix bug in paw orchestrator")).toBe("proj-paw");
  });

  it("matches 'orchestrator' keyword → proj-paw", () => {
    expect(inferProjectId("debug orchestrator control loop issue")).toBe("proj-paw");
  });

  it("matches 'control-loop' keyword → proj-paw", () => {
    expect(inferProjectId("investigate control-loop stall timeout")).toBe("proj-paw");
  });

  it("matches 'dedup' keyword → proj-paw", () => {
    expect(inferProjectId("fix dedup logic for task queue")).toBe("proj-paw");
  });

  it("matches 'circuit breaker' keyword → proj-paw", () => {
    expect(inferProjectId("circuit breaker health check failing")).toBe("proj-paw");
  });

  it("matches 'spawn' keyword → proj-paw", () => {
    expect(inferProjectId("spawn_count is not being incremented properly")).toBe("proj-paw");
  });

  it("matches 'researcher agent' phrase → proj-paw", () => {
    expect(inferProjectId("researcher agent is not picking up tasks")).toBe("proj-paw");
  });

  it("matches 'sail' keyword → paw-sail", () => {
    expect(inferProjectId("fix sail container boot error")).toBe("paw-sail");
  });

  it("matches 'lobs-sail' → paw-sail", () => {
    expect(inferProjectId("deploy lobs-sail update to production")).toBe("paw-sail");
  });

  it("matches 'ship' keyword → paw-ship", () => {
    expect(inferProjectId("update ship provisioning script")).toBe("paw-ship");
  });

  it("matches 'traefik' → paw-ship", () => {
    expect(inferProjectId("traefik routing config broken after update")).toBe("paw-ship");
  });

  it("matches 'portal' keyword → paw-portal", () => {
    expect(inferProjectId("fix login bug on portal landing page")).toBe("paw-portal");
  });

  it("matches 'paw hub' → paw-portal", () => {
    expect(inferProjectId("paw hub dashboard shows wrong data")).toBe("paw-portal");
  });
});

// ─── Score threshold ───────────────────────────────────────────────────────

describe("inferProjectId — score threshold (< 4 → null)", () => {
  beforeEach(() => {
    bustCache();
    clearProjects();
  });

  it("returns null when no keyword matches any project", () => {
    insertProject({ id: "proj-abc", title: "ABC Project" });
    bustCache();
    expect(inferProjectId("completely unrelated task with no keywords")).toBeNull();
  });

  it("returns null for empty title and no notes", () => {
    insertProject({ id: "proj-abc", title: "ABC Project" });
    bustCache();
    expect(inferProjectId("", null)).toBeNull();
  });

  it("returns null for whitespace-only title", () => {
    insertProject({ id: "proj-abc", title: "ABC Project" });
    bustCache();
    expect(inferProjectId("   ", null)).toBeNull();
  });

  it("returns null when no projects exist in DB", () => {
    // clearProjects already called in beforeEach, no insertProject → empty DB
    expect(inferProjectId("paw orchestrator control loop")).toBeNull();
  });
});

// ─── Auto-keywords from project title ─────────────────────────────────────

describe("inferProjectId — auto-keyword from project title", () => {
  beforeEach(() => {
    bustCache();
    clearProjects();
  });

  it("matches a long-enough word from the project title", () => {
    insertProject({ id: "proj-custom-99", title: "Zephyr Analytics Engine" });
    bustCache();
    expect(inferProjectId("fix bug in zephyr analytics module")).toBe("proj-custom-99");
  });

  it("returns null for project with only short title words (≤ 2 chars)", () => {
    insertProject({ id: "proj-short-words", title: "AB CD EF" });
    bustCache();
    expect(inferProjectId("AB CD EF task")).toBeNull();
  });

  it("score wins: longer keyword match beats shorter keyword match", () => {
    insertProject({ id: "proj-flow", title: "Flow Manager" });
    insertProject({ id: "proj-analytics", title: "Analytics Platform" });
    bustCache();
    expect(inferProjectId("analytics platform performance review")).toBe("proj-analytics");
  });
});

// ─── Notes contribute to matching ─────────────────────────────────────────

describe("inferProjectId — notes contribute to matching", () => {
  beforeEach(() => {
    bustCache();
    clearProjects();
    insertProject({ id: "proj-paw", title: "PAW Orchestration Platform" });
    bustCache();
  });

  it("matches via notes even when title has no keywords", () => {
    expect(
      inferProjectId("investigate slow performance", "the paw orchestrator is timing out")
    ).toBe("proj-paw");
  });

  it("matches via both title and notes (higher score)", () => {
    expect(
      inferProjectId("paw orchestrator spawn issue", "worker spawn_count is wrong in control loop")
    ).toBe("proj-paw");
  });

  it("returns null when both title and notes have no matching keywords", () => {
    expect(inferProjectId("random task", "completely unrelated notes")).toBeNull();
  });

  it("handles null notes gracefully", () => {
    expect(inferProjectId("fix paw orchestrator bug", null)).toBe("proj-paw");
  });

  it("handles undefined notes gracefully", () => {
    expect(inferProjectId("fix paw orchestrator bug")).toBe("proj-paw");
  });
});

// ─── Archived projects excluded ───────────────────────────────────────────

describe("inferProjectId — archived projects excluded", () => {
  beforeEach(() => {
    bustCache();
    clearProjects();
  });

  it("does not match archived projects", () => {
    insertProject({ id: "proj-paw", title: "PAW Orchestration Platform", archived: true });
    bustCache();
    expect(inferProjectId("fix paw orchestrator spawn issue")).toBeNull();
  });

  it("matches active project when archived one has same keywords", () => {
    insertProject({ id: "proj-paw", title: "PAW Orchestration Platform", archived: true });
    insertProject({ id: "proj-paw-v2", title: "PAW Orchestration V2 Platform" });
    bustCache();
    expect(inferProjectId("paw orchestration platform update")).toBe("proj-paw-v2");
  });
});

// ─── Multiple projects: best score wins ───────────────────────────────────

describe("inferProjectId — multiple projects, best score wins", () => {
  beforeEach(() => {
    bustCache();
    clearProjects();
    insertProject({ id: "proj-paw", title: "PAW Orchestration Platform" });
    insertProject({ id: "paw-sail", title: "Sail Container" });
    bustCache();
  });

  it("returns proj-paw when paw keywords dominate", () => {
    expect(inferProjectId("paw orchestrator control loop and spawn improvements")).toBe("proj-paw");
  });

  it("returns paw-sail when sail keywords dominate", () => {
    expect(inferProjectId("sail container boot fails with lobs-sail update")).toBe("paw-sail");
  });
});

// ─── Nexus dashboard project ──────────────────────────────────────────────

describe("inferProjectId — nexus dashboard project", () => {
  beforeEach(() => {
    bustCache();
    clearProjects();
    insertProject({ id: "2bfb7b22-f6ec-454a-9f82-7539a302badb", title: "Nexus Dashboard" });
    bustCache();
  });

  it("matches 'nexus' keyword → nexus dashboard project", () => {
    expect(inferProjectId("fix nexus dashboard rendering bug")).toBe(
      "2bfb7b22-f6ec-454a-9f82-7539a302badb"
    );
  });

  it("matches 'glasscard' keyword → nexus project", () => {
    expect(inferProjectId("glasscard animation is janky")).toBe(
      "2bfb7b22-f6ec-454a-9f82-7539a302badb"
    );
  });

  it("matches 'command palette' phrase → nexus project", () => {
    expect(inferProjectId("implement command palette shortcuts")).toBe(
      "2bfb7b22-f6ec-454a-9f82-7539a302badb"
    );
  });
});

// ─── Shared memory project ────────────────────────────────────────────────

describe("inferProjectId — shared memory project", () => {
  beforeEach(() => {
    bustCache();
    clearProjects();
    insertProject({ id: "proj-shared-mem", title: "Shared Memory Workspace" });
    bustCache();
  });

  it("matches 'shared memory' keyword → shared memory project", () => {
    expect(inferProjectId("update shared memory index files")).toBe("proj-shared-mem");
  });

  it("matches 'adr' keyword combined with other content for score ≥ 4", () => {
    // 'adr' is 3 chars — combined with 'shared memory' in notes brings score above 4
    expect(inferProjectId("write adr notes", "related to shared memory workspace")).toBe(
      "proj-shared-mem"
    );
  });

  it("matches 'lobs-shared-memory' keyword → shared memory project", () => {
    expect(inferProjectId("update the lobs-shared-memory auto-commit logic")).toBe("proj-shared-mem");
  });
});

// ─── Return type contract ─────────────────────────────────────────────────

describe("inferProjectId — return type contract", () => {
  beforeEach(() => {
    bustCache();
    clearProjects();
    insertProject({ id: "proj-paw", title: "PAW Platform" });
    bustCache();
  });

  it("returns a string (the project id) when a match is found", () => {
    const id = inferProjectId("fix paw orchestrator bug");
    expect(typeof id).toBe("string");
  });

  it("returns null (not undefined, not empty string) on no match", () => {
    const id = inferProjectId("something completely different");
    expect(id).toBeNull();
  });

  it("return value is never undefined", () => {
    const id = inferProjectId("xyzzy frobble qux");
    expect(id).not.toBeUndefined();
  });
});
