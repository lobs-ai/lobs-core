# Goals System Design

**Status:** Draft  
**Author:** Lobs  
**Date:** 2026-04-11

---

## Problem

Lobs is reactive. It responds to messages, heartbeats, and cron triggers — but it has no persistent sense of what it's trying to accomplish. Between conversations, nothing is being made. Goals give the system a direction to push toward autonomously, generating and executing tasks without Rafe driving every step.

---

## Overview

The goals system sits one layer above the existing task execution loop. It does not replace anything — tasks still run exactly as they do today. Goals are simply the source that *generates* those tasks.

```
Goals (persistent, high-level intent)
    ↓  goals loop (periodic)
Tasks (DB — inbox/active/completed)
    ↓  existing execution loop
Workers / Subagents
```

The goals loop runs on a schedule, reads the current goals, inspects system state (existing tasks, recent work, blockers), and creates net-new tasks to make progress. Nothing else changes.

---

## Goals Storage

Goals live in a new `goals` table in the existing SQLite DB. They are first-class persistent objects, not a markdown file — this makes them queryable, editable by tools, and visible in Nexus.

### Schema

```sql
CREATE TABLE goals (
  id          TEXT PRIMARY KEY,              -- nanoid
  title       TEXT NOT NULL,                 -- short label, e.g. "Lobs becomes genuinely autonomous"
  description TEXT,                          -- what done looks like, context, constraints
  status      TEXT NOT NULL DEFAULT 'active', -- active | paused | completed | archived
  priority    INTEGER NOT NULL DEFAULT 50,   -- 1–100, higher = more important
  owner       TEXT NOT NULL DEFAULT 'lobs',  -- lobs | rafe
  project_id  TEXT REFERENCES projects(id),  -- optional project linkage
  tags        TEXT,                          -- JSON array of strings
  last_worked TEXT,                          -- ISO timestamp of last task spawned
  task_count  INTEGER DEFAULT 0,             -- total tasks ever created for this goal
  notes       TEXT,                          -- freeform notes / current state summary
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Goal Statuses
- **active** — goals loop will generate tasks for this goal
- **paused** — skip in the loop, keep visible
- **completed** — done, archived for history
- **archived** — soft-deleted, hidden by default

---

## Goals Loop

A new worker registered in the `WorkerRegistry` alongside existing workers. Runs on a cron schedule (suggested: every 30 minutes).

### GoalsWorker (`src/workers/goals-worker.ts`)

```
1. Load all active goals ordered by priority DESC
2. For each goal:
   a. Count open tasks already linked to this goal (status = inbox | active)
   b. If open task count >= max_open_tasks_per_goal (default: 2), skip — enough in flight
   c. Read recent completed tasks for this goal (last 5) to understand momentum
   d. Build a prompt: goal description + current open tasks + recent completed + system context
   e. Ask the model: "What is the single most valuable next task for this goal?"
   f. Model returns: { title, notes, agent, model_tier, estimated_minutes } or null (if nothing to do)
   g. If task returned: insert into tasks table with status=inbox, goal_id=<goal.id>
   h. Update goal.last_worked, goal.task_count
3. Log run to worker_logs
```

The max_open_tasks_per_goal cap is critical — it prevents the loop from flooding the task queue with speculative work while real tasks are still running.

### Task ↔ Goal Linkage

Add a `goal_id` column to the existing `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id);
```

This is additive — all existing tasks simply have `goal_id = null`. No migration needed beyond the column addition.

---

## Task Tools (CRUD)

Lobs needs to be able to create, read, update, and delete tasks itself without going through any external API. These are implemented as native tools loaded from `~/.lobs/tools/`.

### `task-create`
```
Inputs: title, notes?, agent?, priority?, goal_id?, project_id?, model_tier?, estimated_minutes?
Action: INSERT into tasks with status=inbox
Output: created task id + title
```

### `task-update`
```
Inputs: task_id, fields to update (any subset of: title, notes, status, priority, agent, model_tier, goal_id, owner, blocked_by, due_date)
Action: UPDATE tasks SET ... WHERE id = ?
Output: updated task
```

### `task-delete`
```
Inputs: task_id, reason?
Action: UPDATE tasks SET status='rejected', notes=concat(notes, '\n[deleted: reason]')
        (soft delete — preserve history)
Output: confirmation
```

### `task-list`
```
Inputs: status?, goal_id?, project_id?, limit? (default 20)
Action: SELECT from tasks with filters
Output: formatted task list
```

### `task-view`
```
Inputs: task_id
Action: SELECT full task row + linked goal title + project title
Output: full task detail
```

### `goal-create`
```
Inputs: title, description?, priority?, project_id?, tags?
Action: INSERT into goals
Output: created goal id + title
```

### `goal-update`
```
Inputs: goal_id, fields (title, description, status, priority, notes, tags)
Action: UPDATE goals SET ... WHERE id = ?
Output: updated goal
```

### `goal-list`
```
Inputs: status? (default: active)
Action: SELECT from goals WHERE status = ?
Output: formatted list with priority, task counts, last_worked
```

All tools are implemented as shell scripts (`implementation: shell`) calling sqlite3 directly against `~/.lobs/lobs.db`. No build step required — they're live immediately after creation.

---

## Action Classes (What the Loop Can Do Without Asking)

The goals loop is only allowed to create `inbox` tasks — it does not directly execute anything. The existing task execution loop decides when to pick them up. This is the safety boundary:

| Action | Allowed autonomously? |
|--------|----------------------|
| Create inbox task | ✅ Yes |
| Promote task to active | ✅ Yes (existing loop does this) |
| Delete/reject a task | ✅ Yes (own tasks only) |
| Edit task notes/priority | ✅ Yes |
| Create a goal | ❌ No — Rafe sets goals |
| Modify a goal | ❌ No — Rafe sets goals |
| Archive a goal | ❌ No — Rafe sets goals |
| Send Discord message | ❌ No — only when explicitly triggered |
| Merge code / push to main | ❌ No — requires review |

Lobs can manage its own task queue freely. It cannot set its own goals.

---

## Integration Points

### Nexus Dashboard
Goals appear as a new section in Nexus alongside Tasks. Each goal shows:
- Title, priority, status
- Open task count / total task count
- Last worked timestamp
- Linked tasks (expandable)

### Heartbeat
The heartbeat loop already runs every N minutes. It can check:
- Are there active goals with no open tasks and no recent work? → nudge goals loop
- Are any goals blocked (all tasks failing)? → surface alert to inbox

### Morning Briefing
The 7am briefing cron already exists. Add a goals summary: for each active goal, one line on what's in flight or what was completed overnight.

---

## Implementation Order

1. **DB migration** — add `goals` table + `goal_id` on `tasks`
2. **Task tools** — `task-create`, `task-update`, `task-delete`, `task-list`, `task-view` as dynamic tools
3. **Goal tools** — `goal-create`, `goal-update`, `goal-list` as dynamic tools
4. **GoalsWorker** — new worker in `src/workers/goals-worker.ts`, registered at boot
5. **Nexus UI** — goals panel (lower priority, can come after the loop is working)

Steps 1–3 can be done without a build. Step 4 requires a build + restart.

---

## What This Is Not

- Not a planning system. Goals don't decompose into sub-goals or dependency trees. They just generate tasks.
- Not a project management tool. PAW handles that. This is Lobs's internal work queue.
- Not autonomous goal-setting. Rafe defines the goals. Lobs executes toward them.

The value is simple: Lobs always has something real to work on, and that work is traceable back to something Rafe actually cares about.
