# Tasks Add-on

Adds task management capabilities to OpenClaw agents — create, update, query, and manage
PAW tasks via natural language commands.

**Status:** ✅ stable

## What It Installs

- `~/.openclaw/skills/tasks-skill/SKILL.md` — skill teaching agents how to manage tasks
- Appends task-management behaviors to `~/apps/AGENTS.md`

## What You Can Do After Installing

- "Create a task: fix the login bug, assign to programmer"
- "List my open tasks"
- "Mark task 42 as done"
- "Add a note to the authentication task"
- "What tasks are blocked?"

## Install

```bash
python3 ~/.openclaw/addons/ingest.py --dry-run tasks
python3 ~/.openclaw/addons/ingest.py tasks
```

## Files

```
tasks/
  README.md         ← this file
  addon.md          ← add-on definition
  tasks-skill/
    SKILL.md        ← skill installed to ~/.openclaw/skills/tasks-skill/
```
