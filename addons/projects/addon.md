---
name: projects
version: 1.1.0
description: Project management — list, create, sync GitHub issues, add tasks, publish status, and archive projects via paw-project CLI
---

## @target: skill-install [skill-install]

projects-skill

## @target: skill-install [skill-install]

project-manager

## @target: ~/apps/AGENTS.md [append-section]

## Project Management Behaviors

The `paw-project` CLI is available for all project operations.

### When to use paw-project

- User asks about projects → `paw-project list`
- User wants project status/summary → `paw-project publish <id>`
- User says "add a task to project X" → `paw-project add-task <id> --title "..."`
- User wants to sync GitHub issues → `paw-project sync <id>`
- User wants to archive a project → confirm, then `paw-project archive <id>`

### Quick Reference

```
paw-project list                             # list active projects
paw-project get <id-or-title>               # get one project
paw-project create --title "..." --type kanban [--repo-path "..."] [--github-repo "owner/repo"]
paw-project add-task <project-id> --title "..." [--agent programmer] [--tier standard] [--notes "..."]
paw-project tasks <id> [--status active]    # list tasks in project
paw-project publish <id>                    # markdown status report
paw-project archive <id>                    # archive (never delete)
paw-project unarchive <id>                  # restore
paw-project sync <id>                       # sync GitHub issues → inbox tasks
```

### Rules
- Use `paw-project` for project operations, `paw-task` for individual tasks
- Sync is additive only — never removes existing tasks
- Archive requires user confirmation; never delete projects
- IDs accept full UUID, UUID prefix, or case-insensitive title substring
