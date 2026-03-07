---
name: project-manager
description: Manage PAW projects — list, create, sync from GitHub, add tasks, publish summaries, and archive. Use when asked about projects, project status, or project-level task management.
---

# Project Manager

## CLI Reference

All project operations go through `paw-project`:

```
paw-project list                                  # list active projects
paw-project list --archived                       # include archived
paw-project get <id-or-title>                     # show one project
paw-project create --title "..." --type kanban    # create project
paw-project update <id> --notes "..."             # update fields
paw-project add-task <project-id> --title "..."   # add task to project
paw-project tasks <id> [--status active]          # list project tasks
paw-project publish <id>                          # rich markdown summary
paw-project archive <id>                          # archive project
paw-project unarchive <id>                        # restore project
paw-project sync <id>                             # sync GitHub issues → tasks
```

IDs accept: full UUID, UUID prefix, or case-insensitive title substring.

## When to use each operation

### List / Get
Use when user asks "what projects are there?" or wants a project overview.
Always start with `paw-project list` before operating on a project by name.

### Create
Use when user asks to create or set up a new project.
- `--type`: `kanban` (default), `research`, `tracker`, `project`
- `--repo-path`: local filesystem path
- `--github-repo`: `owner/repo` format (enables `sync`)

### Add Task
Use when user says "add X to project Y" or "create a task under project Z".
Prefer `paw-project add-task` over `paw-task create` when a project context is clear.

### Publish
Use when user asks "what's the status of project X?" or requests a summary.
Output is markdown — paste directly in chat or write to a file.

### Sync
Use when project has `github_repo` set and user asks to sync issues or refresh tasks from GitHub.
Sync is **additive only** — existing tasks are not deleted or modified.
New issues are imported as `inbox` status tasks for triage.
Requires `gh` CLI authenticated (`gh auth status`).

### Archive / Unarchive
Use when user wants to close out a project or restore one.
Archived projects are hidden from `list` by default but data is preserved.

## Workflow: New Project Setup

1. `paw-project create --title "..." --type kanban --repo-path "..." --github-repo "owner/repo"`
2. Confirm creation with `paw-project get <id>`
3. Add initial tasks: `paw-project add-task <id> --title "..." --agent programmer`
4. Optionally sync GitHub: `paw-project sync <id>`

## Workflow: Project Status Report

1. `paw-project publish <id>`
2. Present the markdown output — it groups tasks by status automatically

## Workflow: Archive a Completed Project

1. Confirm all tasks are done/cancelled: `paw-project tasks <id> --status active`
2. If tasks remain, ask the user how to handle them
3. `paw-project archive <id>`
4. Confirm: `paw-project get <id>` → `archived: 1`

## Error Handling

- `Project not found` → try `paw-project list` and confirm ID/name
- `github_repo not configured` → run `paw-project update <id> --github-repo owner/repo` first
- `gh CLI error` during sync → check `gh auth status`; may need `gh auth login`

## Safety Rules

- Never archive a project without confirming with the user first
- Never delete projects — only archive
- Sync is read-only from GitHub → PAW; it does not write back to GitHub
- When adding tasks, default agent is `programmer` and tier is `standard` unless specified
