---
name: tasks
version: 1.0.0
description: Task management skill — create, update, list, and close tasks via the PAW API
---

## @target: skill-install [skill-install]

tasks

## @target: ~/apps/AGENTS.md [append-section]

## Task Management (tasks add-on)

Use the `tasks` skill when creating, updating, listing, or closing tasks.

Key behaviors:
- When asked to create a task, use `POST /api/tasks` with title, agent, and structured notes
- Always verify task creation succeeded by checking the returned id
- When marking tasks done, use `PATCH /api/tasks/:id` with `workState: done`
- Search active tasks before creating new ones to avoid duplicates
- Write meaningful notes using the Problem / Acceptance Criteria / Context format
