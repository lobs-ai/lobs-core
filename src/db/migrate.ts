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
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN spawn_count INTEGER DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN context_refs TEXT`); } catch {}

  // ── Prompt A/B variant on worker_runs (idempotent) ───────────────────────
  try { db.run(sql`ALTER TABLE worker_runs ADD COLUMN prompt_variant TEXT NOT NULL DEFAULT 'A'`); } catch {}

  // ── Stall watchdog: track last tool call time per worker session ──────────
  try { db.run(sql`ALTER TABLE worker_runs ADD COLUMN last_tool_call_at TEXT`); } catch {}

  // ── Work tracker fields on tasks (idempotent) ────────────────────────────
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN estimated_minutes INTEGER`); } catch {}
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN due_date TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'medium'`); } catch {}
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN scheduled_start TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN scheduled_end TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN calendar_event_id TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN actual_minutes INTEGER`); } catch {}

  // ── Project compliance flag (idempotent) ──────────────────────────────────
  // When compliance_required=1, all tasks in this project are forced to use
  // local models only (compliance_model orchestrator setting).
  try { db.run(sql`ALTER TABLE projects ADD COLUMN compliance_required INTEGER NOT NULL DEFAULT 0`); } catch {}

  // ── Task-level compliance flag (idempotent) ───────────────────────────────
  // When compliance_required=1, this specific task is forced to use local models.
  // Also inherited automatically when the parent project has compliance_required=1.
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN compliance_required INTEGER NOT NULL DEFAULT 0`); } catch {}

  // ── Chat-session compliance flag (idempotent) ────────────────────────────
  // When compliance_required=1, all LLM calls in this chat session use local models.
  // Can be set manually by the user or auto-applied by the classification engine.
  try { db.run(sql`ALTER TABLE chat_sessions ADD COLUMN compliance_required INTEGER NOT NULL DEFAULT 0`); } catch {}

  // ── Spawn guard: crash_count column (idempotent) ──────────────────────────
  // Added: 2026-03-07 — tracks gateway-crash-orphaned runs per task so the
  // spawn guard can use effective_fail_count = spawn_count - crash_count
  // instead of raw spawn_count. Prevents crash storms from auto-blocking
  // tasks where the agent never actually failed.
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN crash_count INTEGER NOT NULL DEFAULT 0`); } catch {}

  // ── Failure type classification on worker_runs (idempotent) ──────────────────
  // Added: 2026-03-07 — separates infra failure events (orphaned-on-restart,
  // stale-run-watchdog, stall-watchdog, orchestrator_timeout) from genuine agent
  // quality failures. Values: 'infra' | 'agent_quality' | NULL (success/in-flight).
  //
  // Infra failures do NOT trigger quality-based retry or circuit-breaker penalties.
  // Agent quality failures DO count against reliability metrics and spawn limits.
  //
  // Backfill: classify existing failed rows from timeout_reason + summary.
  try { db.run(sql`ALTER TABLE worker_runs ADD COLUMN failure_type TEXT`); } catch {}
  try {
    // Backfill rows where failure_type is NULL and succeeded = 0 (failed runs).
    // Classification rules (matches classifyFailureType() in worker-manager.ts):
    //   timeout_reason IN ('orphaned on restart','orphaned-on-restart',
    //                      'stale_run_watchdog','stall_watchdog','orchestrator_timeout')
    //     → 'infra'
    //   summary LIKE 'ghost:%' OR summary LIKE 'stale_run_watchdog:%'
    //       OR summary LIKE 'stall_watchdog:%'
    //       OR summary = 'session dead — no progress'
    //     → 'infra'
    //   all others → 'agent_quality'
    db.run(sql`
      UPDATE worker_runs
      SET failure_type = CASE
        WHEN timeout_reason IN (
          'orphaned on restart',
          'orphaned-on-restart',
          'stale_run_watchdog',
          'stall_watchdog',
          'orchestrator_timeout'
        ) THEN 'infra'
        WHEN summary LIKE 'ghost:%'
          OR summary LIKE 'stale_run_watchdog:%'
          OR summary LIKE 'stall_watchdog:%'
          OR summary = 'session dead — no progress'
        THEN 'infra'
        ELSE 'agent_quality'
      END
      WHERE succeeded = 0
        AND failure_type IS NULL
    `);
  } catch {}

  // ── Task sensitivity flag from lobs-server sensitivity_classifier (idempotent) ──
  // is_compliant=1 means the task contains FERPA/HIPAA-sensitive data and must only
  // run on a local model. Synced from lobs-server when the task sync gap is closed.
  // Enforcement gate in control-loop.ts checks this alongside compliance_required.
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN is_compliant INTEGER NOT NULL DEFAULT 0`); } catch {}

  // ── Pre-flight artifact check: expected_artifacts column (idempotent) ────────
  // Added: 2026-03-07 — JSON array of ArtifactSpec objects declared by the task.
  // When set, processSpawnRequest checks whether expected output files already exist
  // and are complete before spawning a new worker session. Prevents redundant
  // rewrites when a worker crashed after writing but before marking the task done.
  // null/empty = no-op (existing tasks are unaffected).
  // @see docs/decisions/designs/preflight-artifact-check.md
  try { db.run(sql`ALTER TABLE tasks ADD COLUMN expected_artifacts TEXT`); } catch {}

  // ── model_health: circuit breaker per (model, agent_type) ──────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS model_health (
    model                TEXT NOT NULL,
    agent_type           TEXT NOT NULL,
    state                TEXT NOT NULL DEFAULT 'closed',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    total_failures       INTEGER NOT NULL DEFAULT 0,
    total_runs           INTEGER NOT NULL DEFAULT 0,
    last_failure_at      TEXT,
    last_success_at      TEXT,
    opened_at            TEXT,
    recovery_after       TEXT,
    last_error_summary   TEXT,
    manual_override      TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (model, agent_type)
  )`);
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_model_health_state ON model_health(state)`); } catch {}

  // ── Meetings ─────────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS meetings (
    id               TEXT PRIMARY KEY,
    title            TEXT,
    filename         TEXT,
    language         TEXT,
    duration_seconds REAL,
    transcript       TEXT NOT NULL,
    segments         TEXT,
    participants     TEXT,
    project_id       TEXT REFERENCES projects(id),
    meeting_type     TEXT DEFAULT 'general',
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_meetings_project_id ON meetings(project_id)`); } catch {}
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings(created_at)`); } catch {}

  // ── Meeting Action Items ──────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS meeting_action_items (
    id               TEXT PRIMARY KEY,
    meeting_id       TEXT NOT NULL REFERENCES meetings(id),
    description      TEXT NOT NULL,
    assignee         TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',
    due_date         TEXT,
    task_id          TEXT REFERENCES tasks(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON meeting_action_items(meeting_id)`); } catch {}
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_action_items_assignee ON meeting_action_items(assignee)`); } catch {}

  // ── Add summary + analysis_status to meetings ────────────────────────
  try { db.run(sql`ALTER TABLE meetings ADD COLUMN summary TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE meetings ADD COLUMN analysis_status TEXT DEFAULT 'pending'`); } catch {}

  // ── YouTube Videos ────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS youtube_videos (
    id               TEXT PRIMARY KEY,
    video_id         TEXT,
    video_url        TEXT NOT NULL,
    title            TEXT,
    channel          TEXT,
    publish_date     TEXT,
    thumbnail        TEXT,
    description      TEXT,
    language         TEXT,
    duration_seconds REAL,
    transcript       TEXT,
    segments         TEXT,
    chunks           TEXT,
    chunk_summaries  TEXT,
    video_summary    TEXT,
    reflection       TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',
    error            TEXT,
    project_id       TEXT REFERENCES projects(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_youtube_video_id ON youtube_videos(video_id)`); } catch {}
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_youtube_status ON youtube_videos(status)`); } catch {}

  // ── Seed default circuit_breaker settings (INSERT OR IGNORE — safe to run on every migration) ──
  try {
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('circuit_breaker', '{"enabled":true,"failure_threshold":3,"recovery_minutes":30}', datetime('now'))`);
  } catch {}

  // ── Seed stall watchdog settings (INSERT OR IGNORE) ──────────────────────
  // grace_period_seconds: how long after session start before stall detection kicks in
  // stall_timeout:<agent_type>: seconds since last tool call before declaring a stall
  try {
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('stall_watchdog', '{"enabled":true,"grace_period_seconds":60}', datetime('now'))`);
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('stall_timeout:researcher', '900', datetime('now'))`);
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('stall_timeout:programmer', '600', datetime('now'))`);
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('stall_timeout:architect', '600', datetime('now'))`);
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('stall_timeout:reviewer', '480', datetime('now'))`);
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('stall_timeout:writer', '600', datetime('now'))`);
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('stall_timeout:default', '600', datetime('now'))`);
  } catch {}

  // ── Memory Compliance Index (idempotent) ──────────────────────────────────
  // Added: 2026-03-06 — tracks compliance metadata for all agent workspace memory files.
  // Part of the bifurcated memory system (ADR-bifurcated-memory-compliance.md).
  //   - Files in memory/           → compliance_required=0 (cloud-safe)
  //   - Files in memory-compliant/ → compliance_required=1 (local-only)
  //   - anomaly=1                  → file is in memory/ but frontmatter says compliant
  db.run(sql`CREATE TABLE IF NOT EXISTS memory_compliance_index (
    id                    TEXT PRIMARY KEY,
    agent_type            TEXT NOT NULL,
    file_path             TEXT NOT NULL,
    filename              TEXT NOT NULL,
    directory             TEXT NOT NULL DEFAULT 'memory',
    compliance_required   INTEGER NOT NULL DEFAULT 0,
    frontmatter_compliance INTEGER,
    content_hash          TEXT,
    size_bytes            INTEGER,
    last_scanned_at       TEXT NOT NULL DEFAULT (datetime('now')),
    anomaly               INTEGER NOT NULL DEFAULT 0,
    anomaly_reason        TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  try {
    db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS memory_compliance_idx_agent_path
      ON memory_compliance_index(agent_type, file_path)`);
    db.run(sql`CREATE INDEX IF NOT EXISTS memory_compliance_idx_compliance
      ON memory_compliance_index(compliance_required)`);
    db.run(sql`CREATE INDEX IF NOT EXISTS memory_compliance_idx_anomaly
      ON memory_compliance_index(anomaly)`);
  } catch {}

  // ── Seed compliance model (INSERT OR IGNORE — configurable via SQL) ──────────
  // compliance_model: the local model to use when a project has compliance_required=1.
  // Change this setting to match the local LM Studio / Ollama model installed.
  try {
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('compliance_model', '"lmstudio/local-compliance-model"', datetime('now'))`);
  } catch {}

  // ── Seed fallback tier chains per agent type (circuit-breaker dispatch order) ──
  // INSERT OR IGNORE so manual overrides via SQL are preserved.
  const fallbackChains = {
    programmer: ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"],
    architect:  ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"],
    reviewer:   ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
    researcher: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
    writer:     ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
    "inbox-responder": ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"],
  };
  try {
    for (const [agentType, chain] of Object.entries(fallbackChains)) {
      db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
        VALUES (
          ${"fallback_chain:" + agentType},
          ${JSON.stringify(chain)},
          datetime('now')
        )`);
    }
  } catch {}

  // ── Learning system: new columns (idempotent) ────────────────────────────
  // Added: 2026-03-07 — injection_hits tracks how many times a learning has been
  // injected into an agent prompt; source distinguishes seeded/synthetic records
  // from real feedback-derived learnings.
  try { db.run(sql`ALTER TABLE outcome_learnings ADD COLUMN injection_hits INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE outcome_learnings ADD COLUMN source TEXT NOT NULL DEFAULT 'feedback'`); } catch {}

  // ── Kill switch: seed LEARNING_INJECTION_ENABLED setting (INSERT OR IGNORE) ──
  // Set to "false" to disable all learning injection without code change.
  // Hot-reloadable: buildPromptInjection() reads this on every call.
  try {
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('LEARNING_INJECTION_ENABLED', 'true', datetime('now'))`);
    db.run(sql`INSERT OR IGNORE INTO orchestrator_settings (key, value, updated_at)
      VALUES ('LEARNING_MIN_CONFIDENCE', '0.7', datetime('now'))`);
  } catch {}

  // ── Seed synthetic outcome_learnings from known failure patterns ──────────
  // Source='seed' marks these as synthetic (safe to query separately from real data).
  // Based on: researcher stall failures 2026-03-06, writer push failures, programmer review rejections.
  // INSERT OR IGNORE on (agent_type, pattern_name) ensures idempotent re-runs.
  try {
    const seedRows: Array<{ id: string; agentType: string; patternName: string; lessonText: string; taskCategory: string | null; confidence: number; failureCount: number }> = [
      // Researcher failures — stall patterns observed 2026-03-06
      {
        id: "seed-researcher-stall-scope",
        agentType: "researcher",
        patternName: "avoid_scope_creep",
        lessonText: "Stay within task scope. Researcher sessions stalled on 2026-03-06 by exploring unrelated branches instead of delivering the requested research output.",
        taskCategory: "research",
        confidence: 0.85,
        failureCount: 3,
      },
      {
        id: "seed-researcher-stall-index",
        agentType: "researcher",
        patternName: "write_index_file",
        lessonText: "Always write research/INDEX.md when creating research directories. Previous researcher task was marked false-success because the INDEX.md file was missing.",
        taskCategory: "research",
        confidence: 0.9,
        failureCount: 2,
      },
      {
        id: "seed-researcher-cite",
        agentType: "researcher",
        patternName: "cite_sources",
        lessonText: "Cite sources and references in research output. Unsupported claims cause rejection.",
        taskCategory: "research",
        confidence: 0.8,
        failureCount: 1,
      },
      // Writer failures — push and tone patterns
      {
        id: "seed-writer-git-push",
        agentType: "writer",
        patternName: "verify_git_push",
        lessonText: "Always run git push and verify it succeeds (exit 0) before marking a task done. Writer tasks have been falsely marked success when git push silently failed.",
        taskCategory: "docs",
        confidence: 0.9,
        failureCount: 3,
      },
      {
        id: "seed-writer-commit-before-push",
        agentType: "writer",
        patternName: "commit_before_push",
        lessonText: "Run 'git add -A && git commit' before git push. Writer tasks have failed because files were written but never committed, causing an empty push.",
        taskCategory: null,
        confidence: 0.85,
        failureCount: 2,
      },
      {
        id: "seed-writer-actionable",
        agentType: "writer",
        patternName: "actionable_output",
        lessonText: "Written output must be concrete and actionable. Avoid hedging language ('might', 'could', 'perhaps') in design docs and task notes — use declarative statements.",
        taskCategory: "docs",
        confidence: 0.75,
        failureCount: 1,
      },
      // Programmer patterns — supplement existing feedback-derived learnings
      {
        id: "seed-programmer-push-verify",
        agentType: "programmer",
        patternName: "verify_push_success",
        lessonText: "Verify git push exits 0 before reporting task done. Treat any non-zero push exit as task failure requiring immediate fix.",
        taskCategory: "feature",
        confidence: 0.9,
        failureCount: 2,
      },
      {
        id: "seed-programmer-no-placeholders",
        agentType: "programmer",
        patternName: "no_placeholders",
        lessonText: "Never use TODO, placeholder, or stub implementations. Reviewers reject code with TODO comments and incomplete logic.",
        taskCategory: null,
        confidence: 0.85,
        failureCount: 3,
      },
      // Reviewer patterns — added 2026-03-07 to bootstrap reviewer learning
      {
        id: "seed-reviewer-actionable-feedback",
        agentType: "reviewer",
        patternName: "actionable_feedback",
        lessonText: "Review comments must be specific and actionable — say exactly what to change and why. Vague feedback ('this is wrong') causes revision loops.",
        taskCategory: null,
        confidence: 0.85,
        failureCount: 2,
      },
      {
        id: "seed-reviewer-create-paw-task",
        agentType: "reviewer",
        patternName: "create_paw_task",
        lessonText: "Create a PAW task (not a handoff file) for all findings requiring programmer follow-up. Reviewer findings without tasks are silently dropped.",
        taskCategory: null,
        confidence: 0.9,
        failureCount: 3,
      },
      {
        id: "seed-reviewer-scope-to-diff",
        agentType: "reviewer",
        patternName: "scope_review_to_diff",
        lessonText: "Limit review to the diff/changes in scope. Raising pre-existing issues outside the current change inflates rejection rates unfairly.",
        taskCategory: null,
        confidence: 0.8,
        failureCount: 2,
      },
    ];

    for (const row of seedRows) {
      const now = new Date().toISOString();
      db.run(sql`
        INSERT OR IGNORE INTO outcome_learnings
          (id, agent_type, pattern_name, lesson_text, task_category, confidence,
           success_count, failure_count, injection_hits, source_outcome_ids,
           source, is_active, created_at, updated_at)
        VALUES
          (${row.id}, ${row.agentType}, ${row.patternName}, ${row.lessonText},
           ${row.taskCategory}, ${row.confidence},
           0, ${row.failureCount}, 0, '[]',
           'seed', 1, ${now}, ${now})
      `);
    }
  } catch (e) {
    // Non-fatal: seeding failures should not block startup
    console.warn("[LEARNING] Seed insert failed (non-fatal):", e);
  }

  // ── PAW Message Routing: Discord tables (idempotent) ────────────────────────
  // Added: 2026-03-07 — central Discord bot routing.
  // discord_guilds:   maps guild_id → client_slug (added when client connects bot via OAuth2)
  // discord_dm_users: maps Discord user_id → client_slug (DM support, user self-registers)
  // deployments:      tracks active PAW client containers + gateway auth info
  //
  // The paw-discord-router service reads these tables to route incoming Discord messages
  // to the correct PAW client container gateway.
  db.run(sql`CREATE TABLE IF NOT EXISTS discord_guilds (
    id          TEXT PRIMARY KEY,
    guild_id    TEXT UNIQUE NOT NULL,
    guild_name  TEXT,
    client_id   TEXT NOT NULL,
    client_slug TEXT NOT NULL,
    added_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    added_by    TEXT,
    status      TEXT NOT NULL DEFAULT 'active'
  )`);
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_discord_guilds_guild_id  ON discord_guilds(guild_id)`); } catch {}
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_discord_guilds_client_id ON discord_guilds(client_id)`); } catch {}

  db.run(sql`CREATE TABLE IF NOT EXISTS discord_dm_users (
    id               TEXT PRIMARY KEY,
    discord_user_id  TEXT UNIQUE NOT NULL,
    client_id        TEXT NOT NULL,
    client_slug      TEXT NOT NULL,
    registered_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    status           TEXT NOT NULL DEFAULT 'active'
  )`);
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_discord_dm_users_discord_user_id ON discord_dm_users(discord_user_id)`); } catch {}
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_discord_dm_users_client_id ON discord_dm_users(client_id)`); } catch {}

  db.run(sql`CREATE TABLE IF NOT EXISTS deployments (
    id              TEXT PRIMARY KEY,
    client_slug     TEXT UNIQUE NOT NULL,
    client_id       TEXT,
    gateway_url     TEXT NOT NULL,
    gateway_secret  TEXT,
    container_name  TEXT,
    is_demo         INTEGER NOT NULL DEFAULT 0,
    provisioned_at  TEXT NOT NULL DEFAULT (datetime('now')),
    status          TEXT NOT NULL DEFAULT 'active'
  )`);
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_deployments_client_slug ON deployments(client_slug)`); } catch {}
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_deployments_status      ON deployments(status)`); } catch {}
  try { db.run(sql`CREATE INDEX IF NOT EXISTS idx_deployments_client_id   ON deployments(client_id)`); } catch {}
}

// ── Model Health circuit breaker table ──────────────────────────────────────
// Added: 2026-03-04 — tracks (model, agent_type) circuit state for dispatch routing


