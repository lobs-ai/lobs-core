/**
 * Task and goal management tools.
 * Provides first-class tools for creating, updating, listing, and viewing
 * tasks and goals stored in the lobs-core database.
 */

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { ToolDefinition } from "../types.js";
import type { ToolExecutor } from "./index.js";
import { getDb } from "../../db/connection.js";
import { tasks, goals, projects } from "../../db/schema.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ─── task_create ─────────────────────────────────────────────────────────────

const taskCreateDefinition: ToolDefinition = {
  name: "task_create",
  description: "Create a new task and add it to the inbox.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Task title (required)" },
      notes: { type: "string", description: "Additional notes or context" },
      agent: { type: "string", description: "Agent type to handle the task" },
      priority: { type: "string", description: "Priority: low, medium, high (default: medium)" },
      goal_id: { type: "string", description: "ID of the goal this task belongs to" },
      project_id: { type: "string", description: "ID of the project this task belongs to" },
      model_tier: { type: "string", description: "Model tier preference (micro, small, medium, large)" },
      estimated_minutes: { type: "number", description: "Estimated duration in minutes" },
    },
    required: ["title"],
  },
};

const taskCreateExecutor: ToolExecutor = async (params) => {
  const db = getDb();
  const id = randomUUID().slice(0, 8);
  const now = nowIso();

  await db.insert(tasks).values({
    id,
    title: params.title as string,
    status: "inbox",
    owner: "lobs",
    notes: (params.notes as string | undefined) ?? null,
    agent: (params.agent as string | undefined) ?? null,
    priority: (params.priority as string | undefined) ?? "medium",
    goalId: (params.goal_id as string | undefined) ?? null,
    projectId: (params.project_id as string | undefined) ?? null,
    modelTier: (params.model_tier as string | undefined) ?? null,
    estimatedMinutes: (params.estimated_minutes as number | undefined) ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return `Created task ${id}: ${params.title as string}`;
};

// ─── task_update ─────────────────────────────────────────────────────────────

const taskUpdateDefinition: ToolDefinition = {
  name: "task_update",
  description: "Update fields on an existing task.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task ID to update (required)" },
      title: { type: "string", description: "New title" },
      notes: { type: "string", description: "New notes" },
      status: { type: "string", description: "New status (inbox, active, completed, rejected, waiting_on)" },
      priority: { type: "string", description: "New priority (low, medium, high)" },
      agent: { type: "string", description: "Agent assignment" },
      model_tier: { type: "string", description: "Model tier preference" },
      goal_id: { type: "string", description: "Goal ID to link" },
      owner: { type: "string", description: "Owner (lobs or rafe)" },
      due_date: { type: "string", description: "Due date (ISO string)" },
      pinned: { type: "boolean", description: "Whether the task is pinned" },
    },
    required: ["task_id"],
  },
};

const taskUpdateExecutor: ToolExecutor = async (params) => {
  const db = getDb();
  const id = params.task_id as string;

  // Build update object with only provided fields
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { updatedAt: nowIso() };
  if (params.title !== undefined) updates.title = params.title;
  if (params.notes !== undefined) updates.notes = params.notes;
  if (params.status !== undefined) updates.status = params.status;
  if (params.priority !== undefined) updates.priority = params.priority;
  if (params.agent !== undefined) updates.agent = params.agent;
  if (params.model_tier !== undefined) updates.modelTier = params.model_tier;
  if (params.goal_id !== undefined) updates.goalId = params.goal_id;
  if (params.owner !== undefined) updates.owner = params.owner;
  if (params.due_date !== undefined) updates.dueDate = params.due_date;
  if (params.pinned !== undefined) updates.pinned = params.pinned;

  await db.update(tasks).set(updates).where(eq(tasks.id, id));

  return `Updated task ${id}`;
};

// ─── task_delete ─────────────────────────────────────────────────────────────

const taskDeleteDefinition: ToolDefinition = {
  name: "task_delete",
  description: "Soft-delete a task by setting its status to rejected.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task ID to delete (required)" },
      reason: { type: "string", description: "Reason for deletion (appended to notes)" },
    },
    required: ["task_id"],
  },
};

const taskDeleteExecutor: ToolExecutor = async (params) => {
  const db = getDb();
  const id = params.task_id as string;

  // Fetch existing notes if reason is provided
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {
    status: "rejected",
    updatedAt: nowIso(),
  };

  if (params.reason) {
    const existing = await db.select({ notes: tasks.notes }).from(tasks).where(eq(tasks.id, id)).limit(1);
    const existingNotes = existing[0]?.notes ?? "";
    updates.notes = existingNotes
      ? `${existingNotes}\n\nDeleted: ${params.reason as string}`
      : `Deleted: ${params.reason as string}`;
  }

  await db.update(tasks).set(updates).where(eq(tasks.id, id));

  return `Deleted task ${id}`;
};

// ─── task_list ────────────────────────────────────────────────────────────────

const taskListDefinition: ToolDefinition = {
  name: "task_list",
  description: "List tasks with optional filters.",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter by status (default: inbox)" },
      goal_id: { type: "string", description: "Filter by goal ID" },
      project_id: { type: "string", description: "Filter by project ID" },
      limit: { type: "number", description: "Max results (default: 20)" },
    },
    required: [],
  },
};

const taskListExecutor: ToolExecutor = async (params) => {
  const db = getDb();
  const statusFilter = (params.status as string | undefined) ?? "inbox";
  const limitVal = (params.limit as number | undefined) ?? 20;

  // Build where conditions
  const conditions = [eq(tasks.status, statusFilter)];
  if (params.goal_id) conditions.push(eq(tasks.goalId, params.goal_id as string));
  if (params.project_id) conditions.push(eq(tasks.projectId, params.project_id as string));

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      goalId: tasks.goalId,
      goalTitle: goals.title,
    })
    .from(tasks)
    .leftJoin(goals, eq(tasks.goalId, goals.id))
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt))
    .limit(limitVal);

  if (rows.length === 0) return `No tasks found with status '${statusFilter}'.`;

  const lines = rows.map((r) => {
    let line = `[${r.id}] ${r.title} (${r.status})`;
    if (r.goalTitle) line += ` [goal: ${r.goalTitle}]`;
    if (r.priority && r.priority !== "medium") line += ` [${r.priority}]`;
    return line;
  });

  return lines.join("\n");
};

// ─── task_view ────────────────────────────────────────────────────────────────

const taskViewDefinition: ToolDefinition = {
  name: "task_view",
  description: "View full details of a specific task.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task ID to view (required)" },
    },
    required: ["task_id"],
  },
};

const taskViewExecutor: ToolExecutor = async (params) => {
  const db = getDb();
  const id = params.task_id as string;

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      owner: tasks.owner,
      priority: tasks.priority,
      agent: tasks.agent,
      modelTier: tasks.modelTier,
      notes: tasks.notes,
      goalId: tasks.goalId,
      goalTitle: goals.title,
      projectId: tasks.projectId,
      projectName: projects.title,
      estimatedMinutes: tasks.estimatedMinutes,
      dueDate: tasks.dueDate,
      pinned: tasks.pinned,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .leftJoin(goals, eq(tasks.goalId, goals.id))
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.id, id))
    .limit(1);

  if (rows.length === 0) return `Task '${id}' not found.`;

  const t = rows[0];
  const lines = [
    `Task: [${t.id}] ${t.title}`,
    `Status: ${t.status}${t.pinned ? " (pinned)" : ""}`,
    `Owner: ${t.owner ?? "unassigned"}`,
    `Priority: ${t.priority ?? "medium"}`,
  ];
  if (t.agent) lines.push(`Agent: ${t.agent}`);
  if (t.modelTier) lines.push(`Model tier: ${t.modelTier}`);
  if (t.goalTitle) lines.push(`Goal: [${t.goalId}] ${t.goalTitle}`);
  if (t.projectName) lines.push(`Project: [${t.projectId}] ${t.projectName}`);
  if (t.estimatedMinutes) lines.push(`Estimated: ${t.estimatedMinutes} min`);
  if (t.dueDate) lines.push(`Due: ${t.dueDate}`);
  if (t.notes) lines.push(`Notes:\n${t.notes}`);
  lines.push(`Created: ${t.createdAt}`);
  lines.push(`Updated: ${t.updatedAt}`);

  return lines.join("\n");
};

// ─── goal_create ─────────────────────────────────────────────────────────────

const goalCreateDefinition: ToolDefinition = {
  name: "goal_create",
  description: "Create a new goal.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Goal title (required)" },
      description: { type: "string", description: "Detailed description" },
      priority: { type: "number", description: "Priority 1-100 (default: 50)" },
      project_id: { type: "string", description: "Project ID to associate with" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags for categorization",
      },
      notes: { type: "string", description: "Additional notes" },
    },
    required: ["title"],
  },
};

const goalCreateExecutor: ToolExecutor = async (params) => {
  const db = getDb();
  const id = randomUUID().slice(0, 8);
  const now = nowIso();

  await db.insert(goals).values({
    id,
    title: params.title as string,
    description: (params.description as string | undefined) ?? null,
    status: "active",
    priority: (params.priority as number | undefined) ?? 50,
    owner: "lobs",
    projectId: (params.project_id as string | undefined) ?? null,
    tags: (params.tags as string[] | undefined) ?? null,
    notes: (params.notes as string | undefined) ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return `Created goal ${id}: ${params.title as string}`;
};

// ─── goal_update ─────────────────────────────────────────────────────────────

const goalUpdateDefinition: ToolDefinition = {
  name: "goal_update",
  description: "Update fields on an existing goal.",
  input_schema: {
    type: "object",
    properties: {
      goal_id: { type: "string", description: "Goal ID to update (required)" },
      title: { type: "string", description: "New title" },
      description: { type: "string", description: "New description" },
      status: { type: "string", description: "New status (active, paused, completed, archived)" },
      priority: { type: "number", description: "New priority (1-100)" },
      notes: { type: "string", description: "New notes" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "New tags",
      },
    },
    required: ["goal_id"],
  },
};

const goalUpdateExecutor: ToolExecutor = async (params) => {
  const db = getDb();
  const id = params.goal_id as string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { updatedAt: nowIso() };
  if (params.title !== undefined) updates.title = params.title;
  if (params.description !== undefined) updates.description = params.description;
  if (params.status !== undefined) updates.status = params.status;
  if (params.priority !== undefined) updates.priority = params.priority;
  if (params.notes !== undefined) updates.notes = params.notes;
  if (params.tags !== undefined) updates.tags = params.tags;

  await db.update(goals).set(updates).where(eq(goals.id, id));

  return `Updated goal ${id}`;
};

// ─── goal_list ────────────────────────────────────────────────────────────────

const goalListDefinition: ToolDefinition = {
  name: "goal_list",
  description: "List goals filtered by status.",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter by status (default: active)" },
    },
    required: [],
  },
};

const goalListExecutor: ToolExecutor = async (params) => {
  const db = getDb();
  const statusFilter = (params.status as string | undefined) ?? "active";

  const rows = await db
    .select({
      id: goals.id,
      title: goals.title,
      priority: goals.priority,
      taskCount: goals.taskCount,
      lastWorked: goals.lastWorked,
    })
    .from(goals)
    .where(eq(goals.status, statusFilter))
    .orderBy(desc(goals.priority));

  if (rows.length === 0) return `No goals found with status '${statusFilter}'.`;

  const lines = rows.map((g) => {
    const tasks_count = g.taskCount ?? 0;
    const last = g.lastWorked ?? "never";
    return `[${g.id}] ${g.title} (priority: ${g.priority}) — ${tasks_count} tasks, last worked: ${last}`;
  });

  return lines.join("\n");
};

// ─── goal_view ────────────────────────────────────────────────────────────────

const goalViewDefinition: ToolDefinition = {
  name: "goal_view",
  description: "View full details of a specific goal including open task count.",
  input_schema: {
    type: "object",
    properties: {
      goal_id: { type: "string", description: "Goal ID to view (required)" },
    },
    required: ["goal_id"],
  },
};

const goalViewExecutor: ToolExecutor = async (params) => {
  const db = getDb();
  const id = params.goal_id as string;

  const rows = await db
    .select()
    .from(goals)
    .where(eq(goals.id, id))
    .limit(1);

  if (rows.length === 0) return `Goal '${id}' not found.`;

  const g = rows[0];

  // Count open tasks linked to this goal
  const openTasks = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(
      and(
        eq(tasks.goalId, id),
        eq(tasks.status, "inbox"),
      ),
    );

  const lines = [
    `Goal: [${g.id}] ${g.title}`,
    `Status: ${g.status}`,
    `Priority: ${g.priority}`,
    `Owner: ${g.owner}`,
  ];
  if (g.description) lines.push(`Description: ${g.description}`);
  if (g.projectId) lines.push(`Project: ${g.projectId}`);
  if (g.tags && (g.tags as string[]).length > 0) lines.push(`Tags: ${(g.tags as string[]).join(", ")}`);
  if (g.lastWorked) lines.push(`Last worked: ${g.lastWorked}`);
  lines.push(`Open tasks: ${openTasks.length}`);
  if (openTasks.length > 0) {
    openTasks.forEach((t) => {
      lines.push(`  • [${t.id}] ${t.title} (${t.status})`);
    });
  }
  if (g.notes) lines.push(`Notes:\n${g.notes}`);
  lines.push(`Created: ${g.createdAt}`);
  lines.push(`Updated: ${g.updatedAt}`);

  return lines.join("\n");
};

// ─── Exports ──────────────────────────────────────────────────────────────────

export const TASK_TOOL_DEFINITIONS: ToolDefinition[] = [
  taskCreateDefinition,
  taskUpdateDefinition,
  taskDeleteDefinition,
  taskListDefinition,
  taskViewDefinition,
  goalCreateDefinition,
  goalUpdateDefinition,
  goalListDefinition,
  goalViewDefinition,
];

export const TASK_TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  task_create: taskCreateExecutor,
  task_update: taskUpdateExecutor,
  task_delete: taskDeleteExecutor,
  task_list: taskListExecutor,
  task_view: taskViewExecutor,
  goal_create: goalCreateExecutor,
  goal_update: goalUpdateExecutor,
  goal_list: goalListExecutor,
  goal_view: goalViewExecutor,
};
