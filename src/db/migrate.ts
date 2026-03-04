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
    summary TEXT,
    type TEXT NOT NULL DEFAULT 'notice',
    requires_action INTEGER NOT NULL DEFAULT 0,
    action_status TEXT NOT NULL DEFAULT 'pending',
    source_agent TEXT,
    source_reflection_id TEXT
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

  // ── Phase 3-5 tables ──────────────────────────────────────────────────

  db.run(sql`CREATE TABLE IF NOT EXISTS agent_capabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_type TEXT NOT NULL,
    capability TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    capability_metadata TEXT,
    source TEXT NOT NULL DEFAULT 'identity',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_type, capability)
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS agent_identity_versions (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL,
    version INTEGER NOT NULL,
    identity_text TEXT NOT NULL,
    summary TEXT,
    active INTEGER NOT NULL DEFAULT 0,
    window_start TEXT,
    window_end TEXT,
    changed_heuristics TEXT,
    removed_rules TEXT,
    validation_status TEXT NOT NULL DEFAULT 'pending',
    validation_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_type, version)
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS system_sweeps (
    id TEXT PRIMARY KEY,
    sweep_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    window_start TEXT,
    window_end TEXT,
    summary TEXT,
    decisions TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS initiative_decision_records (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES agent_initiatives(id),
    sweep_id TEXT REFERENCES system_sweeps(id),
    decision TEXT NOT NULL,
    decided_by TEXT NOT NULL DEFAULT 'lobs',
    decision_summary TEXT,
    overlap_with_ids TEXT,
    contradiction_with_ids TEXT,
    capability_gap INTEGER NOT NULL DEFAULT 0,
    source_reflection_ids TEXT,
    task_id TEXT REFERENCES tasks(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS task_outcomes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    worker_run_id TEXT,
    agent_type TEXT NOT NULL,
    success INTEGER NOT NULL,
    task_category TEXT,
    task_complexity TEXT,
    context_hash TEXT,
    human_feedback TEXT,
    review_state TEXT,
    applied_learnings TEXT,
    learning_disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS outcome_learnings (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL,
    pattern_name TEXT NOT NULL,
    lesson_text TEXT NOT NULL,
    task_category TEXT,
    task_complexity TEXT,
    context_hash TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    source_outcome_ids TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS routine_registry (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    trigger TEXT,
    hook TEXT,
    schedule TEXT,
    schedule_timezone TEXT NOT NULL DEFAULT 'UTC',
    next_run_at TEXT,
    last_run_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    paused_until TEXT,
    cooldown_seconds INTEGER,
    max_runs_per_day INTEGER,
    pending_confirmation INTEGER NOT NULL DEFAULT 0,
    execution_policy TEXT NOT NULL DEFAULT 'auto',
    policy_tier TEXT NOT NULL DEFAULT 'standard',
    run_count INTEGER NOT NULL DEFAULT 0,
    config TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS routine_audit_events (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routine_registry(id),
    routine_name TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    message TEXT,
    event_metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS learning_plans (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    goal TEXT,
    total_days INTEGER DEFAULT 30,
    current_day INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    schedule_cron TEXT DEFAULT '0 7 * * *',
    schedule_tz TEXT DEFAULT 'America/New_York',
    delivery_channel TEXT DEFAULT 'discord',
    plan_outline TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS learning_lessons (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES learning_plans(id),
    day_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    summary TEXT,
    delivered_at TEXT,
    document_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS text_dumps (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    text TEXT NOT NULL,
    status TEXT,
    task_ids TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL UNIQUE,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active INTEGER NOT NULL DEFAULT 1,
    last_message_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    message_metadata TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS initiative_messages (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES agent_initiatives(id),
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS diagnostic_trigger_events (
    id TEXT PRIMARY KEY,
    trigger_type TEXT NOT NULL,
    trigger_key TEXT NOT NULL,
    status TEXT NOT NULL,
    suppression_reason TEXT,
    agent_type TEXT,
    task_id TEXT REFERENCES tasks(id),
    project_id TEXT REFERENCES projects(id),
    trigger_payload TEXT,
    diagnostic_reflection_id TEXT REFERENCES agent_reflections(id),
    diagnostic_result TEXT,
    remediation_task_ids TEXT,
    outcome TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS inbox_threads (
    id TEXT PRIMARY KEY,
    doc_id TEXT REFERENCES inbox_items(id),
    triage_status TEXT,
    last_processed_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES inbox_threads(id),
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS webhook_registrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    secret TEXT NOT NULL,
    event_filters TEXT,
    target_action TEXT NOT NULL,
    action_config TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_received_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    registration_id TEXT REFERENCES webhook_registrations(id),
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    headers TEXT,
    signature_valid INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    processing_result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS model_pricing (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    route_type TEXT NOT NULL DEFAULT 'api',
    input_per_1m_usd REAL NOT NULL DEFAULT 0.0,
    output_per_1m_usd REAL NOT NULL DEFAULT 0.0,
    cached_input_per_1m_usd REAL NOT NULL DEFAULT 0.0,
    effective_date TEXT NOT NULL DEFAULT (datetime('now')),
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS research_memos (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES agent_initiatives(id),
    task_id TEXT REFERENCES tasks(id),
    problem TEXT NOT NULL,
    user_segment TEXT NOT NULL,
    spec_touchpoints TEXT NOT NULL,
    mvp_scope TEXT NOT NULL,
    owner TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    stale_flagged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // ── Additional indexes ────────────────────────────────────────────────
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_capabilities_agent ON agent_capabilities(agent_type)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_identity_versions_agent ON agent_identity_versions(agent_type)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_task_outcomes_task ON task_outcomes(task_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_task_outcomes_agent ON task_outcomes(agent_type)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_learnings_agent ON outcome_learnings(agent_type)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_learnings_active ON outcome_learnings(is_active)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_diagnostic_events_type ON diagnostic_trigger_events(trigger_type)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_reflections_agent ON agent_reflections(agent_type)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_initiatives_status ON agent_initiatives(status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_inbox_threads_status ON inbox_threads(triage_status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_key)`);

  // ── Chat summary columns (idempotent) ─────────────────────────────────
  try { db.run(sql`ALTER TABLE chat_sessions ADD COLUMN summary TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE chat_sessions ADD COLUMN summary_updated_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE chat_sessions ADD COLUMN message_count_at_summary INTEGER DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE inbox_items ADD COLUMN type TEXT NOT NULL DEFAULT 'notice'`); } catch {}
  try { db.run(sql`ALTER TABLE inbox_items ADD COLUMN requires_action INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE inbox_items ADD COLUMN action_status TEXT NOT NULL DEFAULT 'pending'`); } catch {}
  try { db.run(sql`ALTER TABLE inbox_items ADD COLUMN source_agent TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE inbox_items ADD COLUMN source_reflection_id TEXT`); } catch {}

  // ── Eval metrics on tasks (idempotent) ────────────────────────────────
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN eval_metrics TEXT`); } catch {}
}
