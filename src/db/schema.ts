/**
 * PAW Database Schema — Drizzle ORM + SQLite
 *
 * Ported from lobs-server/app/models.py (~1010 lines → ~400 lines)
 * Phase 1: Core tables (tasks, projects, agents, worker runs)
 * Phase 2+: Workflow engine, reflections, learning, integrations
 */

import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

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
