/**
 * Migration Integrity Tests
 * Validates that the DB schema is correct after migrations run.
 */
import { describe, test, expect } from "vitest";
import { getDb, getRawDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tableNames(): string[] {
  const raw = getRawDb();
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return rows.map(r => r.name);
}

function columnNames(table: string): string[] {
  const raw = getRawDb();
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map(r => r.name);
}

function indexNames(): string[] {
  const raw = getRawDb();
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as { name: string }[];
  return rows.map(r => r.name);
}

function getSetting(key: string): string | undefined {
  const raw = getRawDb();
  const row = raw.prepare("SELECT value FROM orchestrator_settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Migration integrity", () => {
  describe("Core tables", () => {
    test("all expected core tables exist", () => {
      const names = tableNames();
      const expected = [
        "tasks",
        "projects",
        "agent_profiles",
        "agent_status",
        "worker_runs",
        "inbox_items",
        "workflow_definitions",
        "workflow_runs",
        "workflow_events",
        "workflow_subscriptions",
        "control_loop_events",
        "model_usage_events",
        "orchestrator_settings",
      ];
      for (const table of expected) {
        expect(names, `Expected table '${table}' to exist`).toContain(table);
      }
    });

    test("phase 3-5 tables exist", () => {
      const names = tableNames();
      const expected = [
        "agent_reflections",
        "agent_identity_versions",
        "agent_initiatives",
        "agent_capabilities",
        "system_sweeps",
        "task_outcomes",
        "outcome_learnings",
        "routine_registry",
        "learning_plans",
        "learning_lessons",
        "text_dumps",
        "chat_sessions",
        "chat_messages",
        "scheduled_events",
        "initiative_decision_records",
        "diagnostic_trigger_events",
        "inbox_threads",
        "inbox_messages",
        "webhook_registrations",
        "webhook_events",
        "model_pricing",
        "research_memos",
        "workspaces",
        "model_health",
        "memory_compliance_index",
      ];
      for (const table of expected) {
        expect(names, `Expected table '${table}' to exist`).toContain(table);
      }
    });

    test("plugin system tables exist", () => {
      const names = tableNames();
      expect(names).toContain("plugins");
      expect(names).toContain("ui_config");
    });

    test("discord routing tables exist", () => {
      const names = tableNames();
      expect(names).toContain("discord_guilds");
      expect(names).toContain("discord_dm_users");
      expect(names).toContain("deployments");
    });

    test("meeting tables exist", () => {
      const names = tableNames();
      expect(names).toContain("meetings");
      expect(names).toContain("meeting_action_items");
    });

    test("youtube table exists", () => {
      const names = tableNames();
      expect(names).toContain("youtube_videos");
    });
  });

  describe("Column checks", () => {
    test("tasks table has all expected columns", () => {
      const cols = columnNames("tasks");
      const expected = [
        "id", "title", "status", "owner", "work_state", "review_state",
        "project_id", "notes", "artifact_path", "started_at", "finished_at",
        "sort_order", "blocked_by", "pinned", "shape", "github_issue_number",
        "agent", "model_tier", "escalation_tier", "retry_count", "failure_reason",
        "created_at", "updated_at",
        // added columns
        "eval_metrics", "spawn_count", "context_refs",
        "estimated_minutes", "due_date", "priority",
        "compliance_required", "is_compliant",
        "crash_count", "expected_artifacts",
      ];
      for (const col of expected) {
        expect(cols, `Expected column '${col}' in tasks`).toContain(col);
      }
    });

    test("projects table has compliance column", () => {
      const cols = columnNames("projects");
      expect(cols).toContain("compliance_required");
    });

    test("worker_runs table has failure_type column", () => {
      const cols = columnNames("worker_runs");
      expect(cols).toContain("failure_type");
      expect(cols).toContain("prompt_variant");
      expect(cols).toContain("last_tool_call_at");
    });

    test("chat_sessions table has compliance and summary columns", () => {
      const cols = columnNames("chat_sessions");
      expect(cols).toContain("compliance_required");
      expect(cols).toContain("summary");
      expect(cols).toContain("summary_updated_at");
    });

    test("inbox_items table has action columns", () => {
      const cols = columnNames("inbox_items");
      expect(cols).toContain("type");
      expect(cols).toContain("requires_action");
      expect(cols).toContain("action_status");
      expect(cols).toContain("source_agent");
      expect(cols).toContain("source_reflection_id");
    });

    test("outcome_learnings table has injection_hits and source", () => {
      const cols = columnNames("outcome_learnings");
      expect(cols).toContain("injection_hits");
      expect(cols).toContain("source");
    });

    test("plugins table has expected columns", () => {
      const cols = columnNames("plugins");
      expect(cols).toContain("id");
      expect(cols).toContain("name");
      expect(cols).toContain("description");
      expect(cols).toContain("category");
      expect(cols).toContain("enabled");
      expect(cols).toContain("config");
      expect(cols).toContain("config_schema");
      expect(cols).toContain("ui_affordances");
    });

    test("ui_config table has expected columns", () => {
      const cols = columnNames("ui_config");
      expect(cols).toContain("id");
      expect(cols).toContain("layout");
      expect(cols).toContain("widget_order");
      expect(cols).toContain("hidden_widgets");
      expect(cols).toContain("agent_highlights");
      expect(cols).toContain("updated_at");
      expect(cols).toContain("updated_by");
    });
  });

  describe("Indexes", () => {
    test("core indexes exist", () => {
      const indexes = indexNames();
      const expected = [
        "idx_tasks_status",
        "idx_tasks_project",
        "idx_tasks_agent",
        "idx_worker_runs_task",
        "idx_worker_runs_session",
        "idx_workflow_runs_status",
        "idx_workflow_events_type",
        "idx_usage_timestamp",
      ];
      for (const idx of expected) {
        expect(indexes, `Expected index '${idx}' to exist`).toContain(idx);
      }
    });

    test("phase 3-5 indexes exist", () => {
      const indexes = indexNames();
      const expected = [
        "idx_capabilities_agent",
        "idx_identity_versions_agent",
        "idx_task_outcomes_task",
        "idx_task_outcomes_agent",
        "idx_learnings_agent",
        "idx_learnings_active",
        "idx_reflections_agent",
        "idx_initiatives_status",
      ];
      for (const idx of expected) {
        expect(indexes, `Expected index '${idx}' to exist`).toContain(idx);
      }
    });

    test("memory compliance indexes exist", () => {
      const indexes = indexNames();
      expect(indexes).toContain("memory_compliance_idx_compliance");
      expect(indexes).toContain("memory_compliance_idx_anomaly");
    });
  });

  describe("Seed data", () => {
    test("circuit_breaker setting is seeded", () => {
      const value = getSetting("circuit_breaker");
      expect(value).toBeDefined();
      const parsed = JSON.parse(value!);
      expect(parsed.enabled).toBe(true);
      expect(parsed.failure_threshold).toBeGreaterThan(0);
    });

    test("stall_watchdog setting is seeded", () => {
      const value = getSetting("stall_watchdog");
      expect(value).toBeDefined();
      const parsed = JSON.parse(value!);
      expect(parsed.enabled).toBe(true);
    });

    test("stall timeouts are seeded for all agents", () => {
      const agents = ["programmer", "researcher", "writer", "architect", "reviewer"];
      for (const agent of agents) {
        const value = getSetting(`stall_timeout:${agent}`);
        expect(value, `stall_timeout:${agent} should be seeded`).toBeDefined();
        expect(Number(value)).toBeGreaterThan(0);
      }
    });

    test("compliance_model setting is seeded", () => {
      const value = getSetting("compliance_model");
      expect(value).toBeDefined();
    });

    test("fallback chains are seeded for all agents", () => {
      const agents = ["programmer", "architect", "reviewer", "researcher", "writer", "inbox-responder"];
      for (const agent of agents) {
        const value = getSetting(`fallback_chain:${agent}`);
        expect(value, `fallback_chain:${agent} should be seeded`).toBeDefined();
        const chain = JSON.parse(value!);
        expect(Array.isArray(chain)).toBe(true);
        expect(chain.length).toBeGreaterThan(0);
      }
    });

    test("LEARNING_INJECTION_ENABLED setting is seeded", () => {
      const value = getSetting("LEARNING_INJECTION_ENABLED");
      expect(value).toBeDefined();
      expect(value).toBe("true");
    });

    test("seed outcome_learnings from known failure patterns", () => {
      const raw = getRawDb();
      const rows = raw.prepare("SELECT id, source FROM outcome_learnings WHERE source='seed'").all() as { id: string; source: string }[];
      expect(rows.length).toBeGreaterThanOrEqual(5);
      const ids = rows.map(r => r.id);
      expect(ids.some(id => id.startsWith("seed-researcher"))).toBe(true);
      expect(ids.some(id => id.startsWith("seed-writer"))).toBe(true);
      expect(ids.some(id => id.startsWith("seed-programmer"))).toBe(true);
    });

    test("plugins are seeded with expected count", () => {
      const raw = getRawDb();
      const rows = raw.prepare("SELECT id FROM plugins").all() as { id: string }[];
      expect(rows.length).toBe(16);
    });

    test("ui_config default row is seeded", () => {
      const raw = getRawDb();
      const row = raw.prepare("SELECT id, layout FROM ui_config WHERE id='default'").get() as { id: string; layout: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.layout).toBe("command-center");
    });
  });

  describe("Idempotency", () => {
    test("running migrations twice does not throw", () => {
      const db = getDb();
      expect(() => runMigrations(db)).not.toThrow();
    });

    test("table count stays the same after second migration", () => {
      const before = tableNames().length;
      const db = getDb();
      runMigrations(db);
      const after = tableNames().length;
      expect(after).toBe(before);
    });
  });
});
