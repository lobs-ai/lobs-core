/**
 * PAW Database Schema — Drizzle ORM + SQLite
 *
 * Ported from lobs-server/app/models.py (~1010 lines → ~400 lines)
 * Phase 1: Core tables (tasks, projects, agents, worker runs)
 * Phase 2+: Workflow engine, reflections, learning, integrations
 */

import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { getBotId } from "../config/identity.js";

// ─── Helpers ────────────────────────────────────────────────────────────

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
};

const id = () => text("id").primaryKey();

// ─── Projects ───────────────────────────────────────────────────────────

export const projects = sqliteTable("projects", {
  id: id(),
  title: text("title").notNull(),
  notes: text("notes"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  type: text("type").notNull(), // kanban/research/tracker
  sortOrder: integer("sort_order").default(0),
  tracking: text("tracking"), // local/github
  githubRepo: text("github_repo"),
  githubLabelFilter: text("github_label_filter", { mode: "json" }),
  repoPath: text("repo_path"),
  // Compliance flag: when true, all tasks in this project must use local models only.
  // Cascades down to every task dispatch in processSpawnRequest.
  complianceRequired: integer("compliance_required", { mode: "boolean" }).notNull().default(false),
  defaultModelTier: text("default_model_tier"),
  ...timestamps,
});

// ─── Tasks ──────────────────────────────────────────────────────────────

export const tasks = sqliteTable("tasks", {
  id: id(),
  title: text("title").notNull(),
  status: text("status").notNull(), // inbox/active/completed/rejected/waiting_on
  owner: text("owner"), // lobs/rafe
  workState: text("work_state").default("not_started"),
  reviewState: text("review_state"),
  projectId: text("project_id").references(() => projects.id),
  notes: text("notes"),
  contextRefs: text("context_refs", { mode: "json" }),
  artifactPath: text("artifact_path"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  sortOrder: integer("sort_order").default(0),
  blockedBy: text("blocked_by", { mode: "json" }),
  pinned: integer("pinned", { mode: "boolean" }).default(false),
  shape: text("shape"),
  githubIssueNumber: integer("github_issue_number"),
  agent: text("agent"),
  externalSource: text("external_source"),
  externalId: text("external_id"),
  externalUpdatedAt: text("external_updated_at"),
  syncState: text("sync_state"),
  conflictPayload: text("conflict_payload", { mode: "json" }),
  workspaceId: text("workspace_id"),
  modelTier: text("model_tier"),
  escalationTier: integer("escalation_tier").default(0),
  retryCount: integer("retry_count").default(0),
  failureReason: text("failure_reason"),
  lastRetryReason: text("last_retry_reason"),
  evalMetrics: text("eval_metrics", { mode: "json" }),
  spawnCount: integer("spawn_count").default(0),
  estimatedMinutes: integer("estimated_minutes"),
  dueDate: text("due_date"),
  priority: text("priority").default("medium"),
  scheduledStart: text("scheduled_start"),
  scheduledEnd: text("scheduled_end"),
  calendarEventId: text("calendar_event_id"),
  actualMinutes: integer("actual_minutes"),
  // Task-level compliance flag: when true, this task must run on a local model only.
  // If the parent project has complianceRequired=true, all its tasks are treated as
  // compliant regardless of this flag. Setting this flag on a task forces compliance
  // even when the project itself is not marked compliant.
  complianceRequired: integer("compliance_required", { mode: "boolean" }).notNull().default(false),
  // Sensitivity flag set by sensitivity_classifier.py (synced from lobs-server).
  // isCompliant=true means the task contains sensitive/regulated data (FERPA, HIPAA)
  // and must ONLY be processed by a local model — never a cloud model.
  // Default 0 (not sensitive / not yet classified). Enforcement in control-loop.ts.
  isCompliant: integer("is_compliant", { mode: "boolean" }).notNull().default(false),
  // Crash-orphan counter: how many times this task's worker_run was killed by a
  // gateway crash rather than a genuine agent failure. Used by the spawn guard:
  //   effective_fail_count = spawn_count - crash_count
  // Only effective_fail_count is compared against the auto-block threshold.
  crashCount: integer("crash_count").default(0),
  // Pre-flight artifact check: JSON array of ArtifactSpec objects.
  // If set, processSpawnRequest checks these files before spawning a new session.
  // Null/empty = no check (safe default — existing tasks are unaffected).
  // @see src/orchestrator/artifact-check.ts for ArtifactSpec type and logic.
  expectedArtifacts: text("expected_artifacts"),
  ...timestamps,
});

// ─── Agent Profiles ─────────────────────────────────────────────────────

export const agentProfiles = sqliteTable("agent_profiles", {
  id: id(),
  agentType: text("agent_type").notNull().unique(),
  displayName: text("display_name"),
  promptTemplate: text("prompt_template"),
  config: text("config", { mode: "json" }),
  policyTier: text("policy_tier").notNull().default("standard"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

// ─── Agent Status ───────────────────────────────────────────────────────

export const agentStatus = sqliteTable("agent_status", {
  agentType: text("agent_type").primaryKey(),
  status: text("status"),
  activity: text("activity"),
  thinking: text("thinking"),
  currentTaskId: text("current_task_id").references(() => tasks.id),
  currentProjectId: text("current_project_id").references(() => projects.id),
  lastActiveAt: text("last_active_at"),
  lastCompletedTaskId: text("last_completed_task_id"),
  lastCompletedAt: text("last_completed_at"),
  stats: text("stats", { mode: "json" }),
});

// ─── Worker Runs ────────────────────────────────────────────────────────

export const workerRuns = sqliteTable("worker_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workerId: text("worker_id"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  tasksCompleted: integer("tasks_completed").default(0),
  timeoutReason: text("timeout_reason"),
  model: text("model"),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  totalTokens: integer("total_tokens").default(0),
  totalCostUsd: real("total_cost_usd"),
  taskLog: text("task_log", { mode: "json" }),
  commitShas: text("commit_shas", { mode: "json" }),
  filesModified: text("files_modified", { mode: "json" }),
  githubCompareUrl: text("github_compare_url"),
  taskId: text("task_id").references(() => tasks.id),
  succeeded: integer("succeeded", { mode: "boolean" }),
  source: text("source"),
  summary: text("summary"),
  validityResult: text("validity_result", { mode: "json" }),
  childSessionKey: text("child_session_key"),
  agentType: text("agent_type"),
  projectId: text("project_id"),
  durationSeconds: real("duration_seconds"),
  promptVariant: text("prompt_variant").notNull().default("A"),
  lastToolCallAt: text("last_tool_call_at"),
  /**
   * Failure classification: 'infra' | 'agent_quality' | null.
   *
   * 'infra'         — run failed due to infrastructure events, NOT agent logic:
   *                   orphaned-on-restart, stale-run-watchdog, stall-watchdog,
   *                   orchestrator_timeout, ghost-watchdog.
   *                   These should NOT trigger quality-based retry or penalise
   *                   agent reliability metrics. crash_count is incremented instead.
   *
   * 'agent_quality' — run failed due to deliberate agent behaviour or a model error
   *                   that the agent produced (e.g. bad output, tool-call-timeout in
   *                   an otherwise healthy session). These DO count against spawn_count
   *                   and feed into reliability metrics and the circuit-breaker.
   *
   * null            — run succeeded (succeeded=1) or is still in-flight (ended_at IS NULL).
   */
  failureType: text("failure_type"),
});

// ─── Inbox ──────────────────────────────────────────────────────────────

export const inboxItems = sqliteTable("inbox_items", {
  id: id(),
  title: text("title").notNull(),
  filename: text("filename"),
  relativePath: text("relative_path"),
  content: text("content"),
  modifiedAt: text("modified_at"),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
  summary: text("summary"),
  type: text("type").notNull().default("notice"),
  requiresAction: integer("requires_action", { mode: "boolean" }).notNull().default(false),
  actionStatus: text("action_status").notNull().default("pending"),
  triageCategory: text("triage_category"),
  triageUrgency: text("triage_urgency"),
  triageRoute: text("triage_route"),
  triageConfidence: real("triage_confidence"),
  triageReasoning: text("triage_reasoning"),
  triagedAt: text("triaged_at"),
  sourceAgent: text("source_agent"),
  sourceReflectionId: text("source_reflection_id"),
});

// ─── Workflow Engine ────────────────────────────────────────────────────

export const workflowDefinitions = sqliteTable("workflow_definitions", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description"),
  version: integer("version").notNull().default(1),
  nodes: text("nodes", { mode: "json" }).notNull(),
  edges: text("edges", { mode: "json" }).notNull(),
  trigger: text("trigger", { mode: "json" }),
  metadata: text("metadata", { mode: "json" }),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

export const workflowRuns = sqliteTable("workflow_runs", {
  id: id(),
  workflowId: text("workflow_id").notNull().references(() => workflowDefinitions.id),
  workflowVersion: integer("workflow_version").notNull(),
  taskId: text("task_id").references(() => tasks.id),
  triggerType: text("trigger_type").notNull(),
  triggerPayload: text("trigger_payload", { mode: "json" }),
  status: text("status").notNull().default("pending"),
  currentNode: text("current_node"),
  nodeStates: text("node_states", { mode: "json" }).notNull().default({}),
  context: text("context", { mode: "json" }).notNull().default({}),
  sessionKey: text("session_key"),
  error: text("error"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  ...timestamps,
});

export const workflowEvents = sqliteTable("workflow_events", {
  id: id(),
  eventType: text("event_type").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  source: text("source"),
  processed: integer("processed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const workflowSubscriptions = sqliteTable("workflow_subscriptions", {
  id: id(),
  workflowId: text("workflow_id").notNull().references(() => workflowDefinitions.id),
  eventPattern: text("event_pattern").notNull(),
  filterConditions: text("filter_conditions", { mode: "json" }),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Control Loop ───────────────────────────────────────────────────────

export const controlLoopEvents = sqliteTable("control_loop_events", {
  id: id(),
  eventType: text("event_type").notNull(),
  status: text("status").notNull().default("pending"),
  payload: text("payload", { mode: "json" }),
  result: text("result", { mode: "json" }),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  processedAt: text("processed_at"),
});

// ─── Usage Tracking ─────────────────────────────────────────────────────

export const modelUsageEvents = sqliteTable("model_usage_events", {
  id: id(),
  timestamp: text("timestamp").notNull().default(sql`(datetime('now'))`),
  source: text("source").notNull().default("unknown"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  routeType: text("route_type").notNull().default("api"),
  taskType: text("task_type").notNull().default("other"),
  budgetLane: text("budget_lane"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  requests: integer("requests").notNull().default(1),
  latencyMs: integer("latency_ms"),
  status: text("status").notNull().default("success"),
  estimatedCostUsd: real("estimated_cost_usd").notNull().default(0.0),
  errorCode: text("error_code"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Reflections & Initiatives ──────────────────────────────────────────

export const agentReflections = sqliteTable("agent_reflections", {
  id: id(),
  agentType: text("agent_type").notNull(),
  reflectionType: text("reflection_type").notNull(),
  status: text("status").notNull().default("pending"),
  windowStart: text("window_start"),
  windowEnd: text("window_end"),
  contextPacket: text("context_packet", { mode: "json" }),
  result: text("result", { mode: "json" }),
  inefficiencies: text("inefficiencies", { mode: "json" }),
  systemRisks: text("system_risks", { mode: "json" }),
  missedOpportunities: text("missed_opportunities", { mode: "json" }),
  newIdeas: text("new_ideas", { mode: "json" }),
  identityAdjustments: text("identity_adjustments", { mode: "json" }),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});

export const agentInitiatives = sqliteTable("agent_initiatives", {
  id: id(),
  proposedByAgent: text("proposed_by_agent").notNull(),
  sourceReflectionId: text("source_reflection_id").references(() => agentReflections.id),
  ownerAgent: text("owner_agent"),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  riskTier: text("risk_tier").notNull().default("A"),
  policyLane: text("policy_lane").notNull().default("review_required"),
  policyReason: text("policy_reason"),
  status: text("status").notNull().default("proposed"),
  score: real("score"),
  rationale: text("rationale"),
  approvedBy: text("approved_by"),
  selectedAgent: text("selected_agent"),
  selectedProjectId: text("selected_project_id").references(() => projects.id),
  taskId: text("task_id").references(() => tasks.id),
  decisionSummary: text("decision_summary"),
  learningFeedback: text("learning_feedback"),
  ...timestamps,
});

// ─── Scheduled Events / Calendar ────────────────────────────────────────

export const scheduledEvents = sqliteTable("scheduled_events", {
  id: id(),
  title: text("title").notNull(),
  description: text("description"),
  eventType: text("event_type").notNull(),
  scheduledAt: text("scheduled_at").notNull(),
  endAt: text("end_at"),
  allDay: integer("all_day", { mode: "boolean" }).default(false),
  recurrenceRule: text("recurrence_rule"),
  recurrenceEnd: text("recurrence_end"),
  targetType: text("target_type").notNull(),
  targetAgent: text("target_agent"),
  taskProjectId: text("task_project_id").references(() => projects.id),
  taskNotes: text("task_notes"),
  taskPriority: text("task_priority"),
  status: text("status").notNull().default("pending"),
  lastFiredAt: text("last_fired_at"),
  nextFireAt: text("next_fire_at"),
  fireCount: integer("fire_count").default(0),
  externalId: text("external_id"),
  externalSource: text("external_source"),
  ...timestamps,
});

// ─── Orchestrator Settings ──────────────────────────────────────────────

export const orchestratorSettings = sqliteTable("orchestrator_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Agent Capabilities ─────────────────────────────────────────────────

export const agentCapabilities = sqliteTable("agent_capabilities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentType: text("agent_type").notNull(),
  capability: text("capability").notNull(),
  confidence: real("confidence").notNull().default(0.5),
  capabilityMetadata: text("capability_metadata", { mode: "json" }),
  source: text("source").notNull().default("identity"),
  ...timestamps,
});

// ─── Agent Identity Versions ────────────────────────────────────────────

export const agentIdentityVersions = sqliteTable("agent_identity_versions", {
  id: id(),
  agentType: text("agent_type").notNull(),
  version: integer("version").notNull(),
  identityText: text("identity_text").notNull(),
  summary: text("summary"),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  windowStart: text("window_start"),
  windowEnd: text("window_end"),
  changedHeuristics: text("changed_heuristics", { mode: "json" }),
  removedRules: text("removed_rules", { mode: "json" }),
  validationStatus: text("validation_status").notNull().default("pending"),
  validationReason: text("validation_reason"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── System Sweeps ──────────────────────────────────────────────────────

export const systemSweeps = sqliteTable("system_sweeps", {
  id: id(),
  sweepType: text("sweep_type").notNull(),
  status: text("status").notNull().default("pending"),
  windowStart: text("window_start"),
  windowEnd: text("window_end"),
  summary: text("summary", { mode: "json" }),
  decisions: text("decisions", { mode: "json" }),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});

// ─── Initiative Decision Records ────────────────────────────────────────

export const initiativeDecisionRecords = sqliteTable("initiative_decision_records", {
  id: id(),
  initiativeId: text("initiative_id").notNull().references(() => agentInitiatives.id),
  sweepId: text("sweep_id").references(() => systemSweeps.id),
  decision: text("decision").notNull(),
  decidedBy: text("decided_by").notNull().$defaultFn(() => getBotId()),
  decisionSummary: text("decision_summary"),
  overlapWithIds: text("overlap_with_ids", { mode: "json" }),
  contradictionWithIds: text("contradiction_with_ids", { mode: "json" }),
  capabilityGap: integer("capability_gap", { mode: "boolean" }).notNull().default(false),
  sourceReflectionIds: text("source_reflection_ids", { mode: "json" }),
  taskId: text("task_id").references(() => tasks.id),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Task Outcomes & Learnings ──────────────────────────────────────────

export const taskOutcomes = sqliteTable("task_outcomes", {
  id: id(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  workerRunId: text("worker_run_id"),
  agentType: text("agent_type").notNull(),
  success: integer("success", { mode: "boolean" }).notNull(),
  taskCategory: text("task_category"),
  taskComplexity: text("task_complexity"),
  contextHash: text("context_hash"),
  humanFeedback: text("human_feedback"),
  reviewState: text("review_state"),
  appliedLearnings: text("applied_learnings", { mode: "json" }),
  learningDisabled: integer("learning_disabled", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

export const outcomeLearnings = sqliteTable("outcome_learnings", {
  id: id(),
  agentType: text("agent_type").notNull(),
  patternName: text("pattern_name").notNull(),
  lessonText: text("lesson_text").notNull(),
  taskCategory: text("task_category"),
  taskComplexity: text("task_complexity"),
  contextHash: text("context_hash"),
  confidence: real("confidence").notNull().default(1.0),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  injectionHits: integer("injection_hits").notNull().default(0),
  sourceOutcomeIds: text("source_outcome_ids", { mode: "json" }),
  source: text("source").notNull().default("feedback"), // 'feedback' | 'seed' | 'manual'
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

// ─── Routine Registry ───────────────────────────────────────────────────

export const routineRegistry = sqliteTable("routine_registry", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description"),
  trigger: text("trigger"),
  hook: text("hook"),
  schedule: text("schedule"),
  scheduleTimezone: text("schedule_timezone").notNull().default("UTC"),
  nextRunAt: text("next_run_at"),
  lastRunAt: text("last_run_at"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  pausedUntil: text("paused_until"),
  cooldownSeconds: integer("cooldown_seconds"),
  maxRunsPerDay: integer("max_runs_per_day"),
  pendingConfirmation: integer("pending_confirmation", { mode: "boolean" }).notNull().default(false),
  executionPolicy: text("execution_policy").notNull().default("auto"),
  policyTier: text("policy_tier").notNull().default("standard"),
  runCount: integer("run_count").notNull().default(0),
  config: text("config", { mode: "json" }),
  ...timestamps,
});

export const routineAuditEvents = sqliteTable("routine_audit_events", {
  id: id(),
  routineId: text("routine_id").notNull().references(() => routineRegistry.id),
  routineName: text("routine_name").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull().default("ok"),
  message: text("message"),
  eventMetadata: text("event_metadata", { mode: "json" }),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Learning Plans & Lessons ───────────────────────────────────────────

export const learningPlans = sqliteTable("learning_plans", {
  id: id(),
  topic: text("topic").notNull(),
  goal: text("goal"),
  totalDays: integer("total_days").default(30),
  currentDay: integer("current_day").default(0),
  status: text("status").default("active"),
  scheduleCron: text("schedule_cron").default("0 7 * * *"),
  scheduleTz: text("schedule_tz").default("America/New_York"),
  deliveryChannel: text("delivery_channel").default("discord"),
  planOutline: text("plan_outline", { mode: "json" }),
  ...timestamps,
});

export const learningLessons = sqliteTable("learning_lessons", {
  id: id(),
  planId: text("plan_id").notNull().references(() => learningPlans.id),
  dayNumber: integer("day_number").notNull(),
  title: text("title").notNull(),
  content: text("content"),
  summary: text("summary"),
  deliveredAt: text("delivered_at"),
  documentPath: text("document_path"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Text Dumps ─────────────────────────────────────────────────────────

export const textDumps = sqliteTable("text_dumps", {
  id: id(),
  projectId: text("project_id").references(() => projects.id),
  text: text("text").notNull(),
  status: text("status"),
  taskIds: text("task_ids", { mode: "json" }),
  ...timestamps,
});

// ─── Chat Sessions & Messages ───────────────────────────────────────────

export const chatSessions = sqliteTable("chat_sessions", {
  id: id(),
  sessionKey: text("session_key").notNull().unique(),
  label: text("label"),
  summary: text("summary"),
  summaryUpdatedAt: text("summary_updated_at"),
  messageCountAtSummary: integer("message_count_at_summary").default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  lastMessageAt: text("last_message_at"),
  // Chat-level compliance flag: when true, all AI calls in this session must use
  // local models only. Users can toggle this manually or it may be applied
  // automatically when sensitive data is detected.
  complianceRequired: integer("compliance_required", { mode: "boolean" }).notNull().default(false),
  // Per-session tool overrides: JSON array of tool names to disable, e.g. '["exec","write"]'
  disabledTools: text("disabled_tools"),
  // Tracks when the user last viewed this session (for unread badges)
  lastReadAt: text("last_read_at"),
  // Soft-delete: when set, session is archived (hidden from default list)
  // Hard-deleted after 30 days by cleanup routine
  archivedAt: text("archived_at"),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: id(),
  sessionKey: text("session_key").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  messageMetadata: text("message_metadata", { mode: "json" }),
});

// ─── Initiative Messages ────────────────────────────────────────────────

export const initiativeMessages = sqliteTable("initiative_messages", {
  id: id(),
  initiativeId: text("initiative_id").notNull().references(() => agentInitiatives.id),
  author: text("author").notNull(),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Diagnostic Trigger Events ──────────────────────────────────────────

export const diagnosticTriggerEvents = sqliteTable("diagnostic_trigger_events", {
  id: id(),
  triggerType: text("trigger_type").notNull(),
  triggerKey: text("trigger_key").notNull(),
  status: text("status").notNull(),
  suppressionReason: text("suppression_reason"),
  agentType: text("agent_type"),
  taskId: text("task_id").references(() => tasks.id),
  projectId: text("project_id").references(() => projects.id),
  triggerPayload: text("trigger_payload", { mode: "json" }),
  diagnosticReflectionId: text("diagnostic_reflection_id").references(() => agentReflections.id),
  diagnosticResult: text("diagnostic_result", { mode: "json" }),
  remediationTaskIds: text("remediation_task_ids", { mode: "json" }),
  outcome: text("outcome", { mode: "json" }),
  ...timestamps,
});

// ─── Inbox Threads & Messages ───────────────────────────────────────────

export const inboxThreads = sqliteTable("inbox_threads", {
  id: id(),
  docId: text("doc_id").references(() => inboxItems.id),
  triageStatus: text("triage_status"),
  lastProcessedMessageId: text("last_processed_message_id"),
  ...timestamps,
});

export const inboxMessages = sqliteTable("inbox_messages", {
  id: id(),
  threadId: text("thread_id").notNull().references(() => inboxThreads.id),
  author: text("author").notNull(),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Webhooks ───────────────────────────────────────────────────────────

export const webhookRegistrations = sqliteTable("webhook_registrations", {
  id: id(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  secret: text("secret").notNull(),
  eventFilters: text("event_filters", { mode: "json" }),
  targetAction: text("target_action").notNull(),
  actionConfig: text("action_config", { mode: "json" }),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
  lastReceivedAt: text("last_received_at"),
});

export const webhookEvents = sqliteTable("webhook_events", {
  id: id(),
  registrationId: text("registration_id").references(() => webhookRegistrations.id),
  provider: text("provider").notNull(),
  eventType: text("event_type").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  headers: text("headers", { mode: "json" }),
  signatureValid: integer("signature_valid", { mode: "boolean" }).default(false),
  status: text("status").notNull().default("pending"),
  processingResult: text("processing_result", { mode: "json" }),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  processedAt: text("processed_at"),
});

// ─── Model Pricing ──────────────────────────────────────────────────────

export const modelPricing = sqliteTable("model_pricing", {
  id: id(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  routeType: text("route_type").notNull().default("api"),
  inputPer1mUsd: real("input_per_1m_usd").notNull().default(0.0),
  outputPer1mUsd: real("output_per_1m_usd").notNull().default(0.0),
  cachedInputPer1mUsd: real("cached_input_per_1m_usd").notNull().default(0.0),
  effectiveDate: text("effective_date").notNull().default(sql`(datetime('now'))`),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  notes: text("notes"),
  ...timestamps,
});

// ─── Research Memos ─────────────────────────────────────────────────────

export const researchMemos = sqliteTable("research_memos", {
  id: id(),
  initiativeId: text("initiative_id").notNull().references(() => agentInitiatives.id),
  taskId: text("task_id").references(() => tasks.id),
  problem: text("problem").notNull(),
  userSegment: text("user_segment").notNull(),
  specTouchpoints: text("spec_touchpoints", { mode: "json" }).notNull(),
  mvpScope: text("mvp_scope").notNull(),
  owner: text("owner").notNull(),
  decision: text("decision").notNull(),
  rationale: text("rationale").notNull(),
  staleFlagged: integer("stale_flagged", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

// ─── Workspaces ─────────────────────────────────────────────────────────

export const workspaces = sqliteTable("workspaces", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

// ─── Model Health (circuit breaker) ──────────────────────────────────────────

export const modelHealth = sqliteTable("model_health", {
  // SQLite doesn't support composite PKs via drizzle easily — use row-level unique
  id: integer("id").primaryKey({ autoIncrement: true }),
  model: text("model").notNull(),
  agentType: text("agent_type").notNull(),
  state: text("state").notNull().default("closed"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  totalFailures: integer("total_failures").notNull().default(0),
  totalRuns: integer("total_runs").notNull().default(0),
  lastFailureAt: text("last_failure_at"),
  lastSuccessAt: text("last_success_at"),
  openedAt: text("opened_at"),
  recoveryAfter: text("recovery_after"),
  lastErrorSummary: text("last_error_summary"),
  manualOverride: text("manual_override"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({
  uniqModelAgent: uniqueIndex("model_health_model_agent").on(t.model, t.agentType),
}));

// ─── Meetings ────────────────────────────────────────────────────────────

export const meetings = sqliteTable("meetings", {
  id: id(),
  title: text("title"),
  filename: text("filename"),
  language: text("language"),
  durationSeconds: real("duration_seconds"),
  transcript: text("transcript").notNull(),
  segments: text("segments"),
  participants: text("participants"),
  projectId: text("project_id").references(() => projects.id),
  meetingType: text("meeting_type").default("general"),
  summary: text("summary"),
  analysisStatus: text("analysis_status").default("pending"), // pending/processing/completed/failed
  insights: text("insights"),       // JSON array of live session insights
  topics: text("topics"),           // JSON array of topic strings
  ...timestamps,
});

// ─── Meeting Action Items ───────────────────────────────────────────────

export const meetingActionItems = sqliteTable("meeting_action_items", {
  id: id(),
  meetingId: text("meeting_id").notNull().references(() => meetings.id),
  description: text("description").notNull(),
  assignee: text("assignee"),          // name: "rafe", "lobs", "alex", etc.
  status: text("status").notNull().default("pending"), // pending/in_progress/completed
  dueDate: text("due_date"),
  taskId: text("task_id").references(() => tasks.id),  // linked PAW task if auto-created
  ...timestamps,
});

// ─── YouTube Videos ─────────────────────────────────────────────────────

export const youtubeVideos = sqliteTable("youtube_videos", {
  id: id(),
  videoId: text("video_id"),              // YouTube video ID
  videoUrl: text("video_url").notNull(),
  title: text("title"),
  channel: text("channel"),
  publishDate: text("publish_date"),
  thumbnail: text("thumbnail"),
  description: text("description"),
  language: text("language"),
  durationSeconds: real("duration_seconds"),
  transcript: text("transcript"),
  segments: text("segments"),             // JSON array
  chunks: text("chunks"),                 // JSON array of chunk texts
  chunkSummaries: text("chunk_summaries"),// JSON array of summaries
  videoSummary: text("video_summary"),
  reflection: text("reflection"),
  status: text("status").notNull().default("pending"), // pending/downloading/transcribing/processing/ready/failed
  error: text("error"),
  projectId: text("project_id").references(() => projects.id),
  ...timestamps,
});

// ─── Message Routing: Discord Guilds ────────────────────────────────────────
// Maps Discord guild (server) → PAW client container.
// Populated by the OAuth2 callback when a client adds the PAW bot to their server.

export const discordGuilds = sqliteTable("discord_guilds", {
  id: id(),
  guildId: text("guild_id").notNull().unique(),
  guildName: text("guild_name"),
  clientId: text("client_id").notNull(),
  clientSlug: text("client_slug").notNull(),
  addedAt: integer("added_at").notNull().default(sql`(unixepoch())`),
  addedBy: text("added_by"),
  status: text("status").notNull().default("active"),
}, (t) => ({
  idxGuildId:   index("idx_discord_guilds_guild_id").on(t.guildId),
  idxClientId:  index("idx_discord_guilds_client_id").on(t.clientId),
}));

// ─── Message Routing: Discord DM Users ──────────────────────────────────────
// Maps Discord user ID → PAW client container (for DM support).
// Users opt in by registering their Discord user ID in the portal settings.

export const discordDmUsers = sqliteTable("discord_dm_users", {
  id: id(),
  discordUserId: text("discord_user_id").notNull().unique(),
  clientId: text("client_id").notNull(),
  clientSlug: text("client_slug").notNull(),
  registeredAt: integer("registered_at").notNull().default(sql`(unixepoch())`),
  status: text("status").notNull().default("active"),
}, (t) => ({
  idxDiscordUserId: index("idx_discord_dm_users_discord_user_id").on(t.discordUserId),
  idxClientId: index("idx_discord_dm_users_client_id").on(t.clientId),
}));

// ─── Deployments ─────────────────────────────────────────────────────────────
// Tracks active PAW client container deployments.
// Populated by provision-webhook.js after each successful provisioning.
// The paw-discord-router reads this table to resolve client_slug → gateway info.

export const deployments = sqliteTable("deployments", {
  id: id(),
  clientSlug: text("client_slug").notNull().unique(),
  clientId: text("client_id"),
  gatewayUrl: text("gateway_url").notNull(),
  /** SENSITIVE: stored encrypted at rest; never expose in API responses. */
  gatewaySecret: text("gateway_secret"),
  containerName: text("container_name"),
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  provisionedAt: text("provisioned_at").notNull().default(sql`(datetime('now'))`),
  status: text("status").notNull().default("active"),
}, (t) => ({
  idxClientSlug: index("idx_deployments_client_slug").on(t.clientSlug),
  idxStatus:     index("idx_deployments_status").on(t.status),
  idxClientId:   index("idx_deployments_client_id").on(t.clientId),
}));

// ─── Plugin System ──────────────────────────────────────────────────────────

export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),               // "smart-reply", "thread-summarizer", etc.
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(),      // "dev" | "academic" | "productivity" | "lifestyle"
  enabled: integer("enabled").notNull().default(0),
  config: text("config").default("{}"),                   // JSON user settings
  configSchema: text("config_schema").default("{}"),      // JSON schema for settings UI
  uiAffordances: text("ui_affordances").default("[]"),    // JSON array of UIAffordance definitions
  ...timestamps,
});

export const uiConfig = sqliteTable("ui_config", {
  id: text("id").primaryKey().default("default"),
  layout: text("layout").notNull().default("command-center"),
  widgetOrder: text("widget_order").default("[]"),        // JSON array of widget IDs
  hiddenWidgets: text("hidden_widgets").default("[]"),    // JSON array of hidden widget IDs
  agentHighlights: text("agent_highlights").default("[]"), // JSON array of {widgetId, reason, ttl}
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  updatedBy: text("updated_by").default("system"),        // "agent" | "user"
});

// ─── Memory Compliance Index ────────────────────────────────────────────────
// Tracks compliance metadata for all memory files across agent workspaces.
// Populated by the memory scanner service; enables compliance reports and
// anomaly detection without scanning the filesystem on every request.
//
// Key invariants:
//   - Files in memory/           → complianceRequired=0 (cloud-safe)
//   - Files in memory-compliant/ → complianceRequired=1 (local-only)
//   - anomaly=1                  → file is in memory/ but frontmatter says compliant
//
// @see docs/decisions/ADR-bifurcated-memory-compliance.md

export const memoryComplianceIndex = sqliteTable("memory_compliance_index", {
  id: text("id").primaryKey(), // {agent_type}:{relative_path}
  agentType: text("agent_type").notNull(),
  /** Absolute filesystem path to the memory file. */
  filePath: text("file_path").notNull(),
  filename: text("filename").notNull(),
  /** "memory" | "memory-compliant" */
  directory: text("directory").notNull().default("memory"),
  /**
   * Derived compliance flag:
   *   1 if file is in memory-compliant/ OR frontmatter has compliance_required=true
   *   0 otherwise (cloud-safe)
   */
  complianceRequired: integer("compliance_required", { mode: "boolean" }).notNull().default(false),
  /** Frontmatter compliance_required value (null if no frontmatter). */
  frontmatterCompliance: integer("frontmatter_compliance", { mode: "boolean" }),
  /** SHA1 of file content — used for change detection during re-scans. */
  contentHash: text("content_hash"),
  sizeBytes: integer("size_bytes"),
  lastScannedAt: text("last_scanned_at").notNull().default(sql`(datetime('now'))`),
  /**
   * Anomaly flag: 1 if the file is in memory/ but its frontmatter declares
   * compliance_required=true (i.e., it should be in memory-compliant/).
   */
  anomaly: integer("anomaly", { mode: "boolean" }).notNull().default(false),
  anomalyReason: text("anomaly_reason"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  uniqAgentPath: uniqueIndex("memory_compliance_idx_agent_path").on(t.agentType, t.filePath),
}));

// ─── Training Data ──────────────────────────────────────────────────────

export const trainingData = sqliteTable("training_data", {
  id: id(),
  taskType: text("task_type").notNull(),      // braindump | calendar_check | daily_brief | system_state | categorization | summary | chat_title | chat_summary
  systemPrompt: text("system_prompt").notNull(),
  userPrompt: text("user_prompt").notNull(),
  context: text("context", { mode: "json" }), // assembled context blob
  modelOutput: text("model_output").notNull(),
  correctedOutput: text("corrected_output"),   // human correction
  reviewStatus: text("review_status").notNull().default("pending"), // pending | approved | corrected | rejected
  modelUsed: text("model_used").notNull(),
  ...timestamps,
}, (t) => ({
  idxTaskType: index("training_data_task_type_idx").on(t.taskType),
  idxReviewStatus: index("training_data_review_status_idx").on(t.reviewStatus),
}));
