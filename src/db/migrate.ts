/**
 * Auto-migration: create tables if they don't exist.
 * For a v0.1 plugin, we use drizzle-kit push semantics at startup.
 * Future: proper versioned migrations.
 */

import { sql } from "drizzle-orm";
import type { PawDB } from "./connection.js";

export function runMigrations(db: PawDB): void {
  // For now, use raw SQL to create tables.
  // Drizzle-kit generate + migrate is the proper path for production.
  // This ensures tables exist on first boot.
  
  db.run(sql`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    tracking TEXT,
    github_repo TEXT,
    github_label_filter TEXT,
    repo_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    owner TEXT,
    work_state TEXT DEFAULT 'not_started',
    review_state TEXT,
    project_id TEXT REFERENCES projects(id),
    notes TEXT,
    artifact_path TEXT,
    started_at TEXT,
    finished_at TEXT,
    sort_order INTEGER DEFAULT 0,
    blocked_by TEXT,
    pinned INTEGER DEFAULT 0,
    shape TEXT,
    github_issue_number INTEGER,
    agent TEXT,
    external_source TEXT,
    external_id TEXT,
    external_updated_at TEXT,
    sync_state TEXT,
    conflict_payload TEXT,
    workspace_id TEXT,
    model_tier TEXT,
    escalation_tier INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    failure_reason TEXT,
    last_retry_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS agent_profiles (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL UNIQUE,
    display_name TEXT,
    prompt_template TEXT,
    config TEXT,
    policy_tier TEXT NOT NULL DEFAULT 'standard',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS agent_status (
    agent_type TEXT PRIMARY KEY,
    status TEXT,
    activity TEXT,
    thinking TEXT,
    current_task_id TEXT REFERENCES tasks(id),
    current_project_id TEXT REFERENCES projects(id),
    last_active_at TEXT,
    last_completed_task_id TEXT,
    last_completed_at TEXT,
    stats TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS worker_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT,
    started_at TEXT,
    ended_at TEXT,
    tasks_completed INTEGER DEFAULT 0,
    timeout_reason TEXT,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    total_cost_usd REAL,
    task_log TEXT,
    commit_shas TEXT,
    files_modified TEXT,
    github_compare_url TEXT,
    task_id TEXT REFERENCES tasks(id),
    succeeded INTEGER,
    source TEXT,
    summary TEXT,
    validity_result TEXT,
    child_session_key TEXT,
    agent_type TEXT,
    project_id TEXT,
    duration_seconds REAL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    filename TEXT,
    relative_path TEXT,
    content TEXT,
    modified_at TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    summary TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS workflow_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    nodes TEXT NOT NULL,
    edges TEXT NOT NULL,
    trigger TEXT,
    metadata TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
    workflow_version INTEGER NOT NULL,
    task_id TEXT REFERENCES tasks(id),
    trigger_type TEXT NOT NULL,
    trigger_payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    current_node TEXT,
    node_states TEXT NOT NULL DEFAULT '{}',
    context TEXT NOT NULL DEFAULT '{}',
    session_key TEXT,
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS workflow_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    source TEXT,
    processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS workflow_subscriptions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
    event_pattern TEXT NOT NULL,
    filter_conditions TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS control_loop_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload TEXT,
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS model_usage_events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL DEFAULT 'unknown',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    route_type TEXT NOT NULL DEFAULT 'api',
    task_type TEXT NOT NULL DEFAULT 'other',
    budget_lane TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 1,
    latency_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'success',
    estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
    error_code TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS agent_reflections (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL,
    reflection_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    window_start TEXT,
    window_end TEXT,
    context_packet TEXT,
    result TEXT,
    inefficiencies TEXT,
    system_risks TEXT,
    missed_opportunities TEXT,
    identity_adjustments TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS agent_initiatives (
    id TEXT PRIMARY KEY,
    proposed_by_agent TEXT NOT NULL,
    source_reflection_id TEXT REFERENCES agent_reflections(id),
    owner_agent TEXT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    risk_tier TEXT NOT NULL DEFAULT 'A',
    policy_lane TEXT NOT NULL DEFAULT 'review_required',
    policy_reason TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',
    score REAL,
    rationale TEXT,
    approved_by TEXT,
    selected_agent TEXT,
    selected_project_id TEXT REFERENCES projects(id),
    task_id TEXT REFERENCES tasks(id),
    decision_summary TEXT,
    learning_feedback TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS scheduled_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    event_type TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    end_at TEXT,
    all_day INTEGER DEFAULT 0,
    recurrence_rule TEXT,
    recurrence_end TEXT,
    target_type TEXT NOT NULL,
    target_agent TEXT,
    task_project_id TEXT REFERENCES projects(id),
    task_notes TEXT,
    task_priority TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    last_fired_at TEXT,
    next_fire_at TEXT,
    fire_count INTEGER DEFAULT 0,
    external_id TEXT,
    external_source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS orchestrator_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Indexes
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_worker_runs_task ON worker_runs(task_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_worker_runs_session ON worker_runs(child_session_key)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_workflow_events_type ON workflow_events(event_type)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON model_usage_events(timestamp)`);
}
