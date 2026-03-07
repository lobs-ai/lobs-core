# Projects Add-on

Adds project management capabilities to OpenClaw agents — sync projects from GitHub, add tasks to projects,
publish project status updates, and archive completed work.

**Status:** ✅ stable

## What It Installs

- `~/.openclaw/skills/projects-skill/SKILL.md` — primary skill for syncing, adding tasks, publishing, and archiving
- `~/.openclaw/skills/project-manager/SKILL.md` — CLI reference skill for all `paw-project` operations
- Appends project-management behaviors to `~/apps/AGENTS.md`

## What You Can Do After Installing

- "What projects are active?"
- "Sync issues for the Portal project"
- "Add a task to the SAIL project: implement the compliance flag"
- "Publish a status update for the PAW Lite project"
- "Archive the completed EECS project"
- "Create a new project called Research 2026"

## Install

```bash
python3 ~/.openclaw/addons/ingest.py --dry-run projects
python3 ~/.openclaw/addons/ingest.py projects
```

## Files

```
projects/
  README.md              ← this file
  addon.md               ← add-on definition (installs skills + patches AGENTS.md)
  projects-skill/
    SKILL.md             ← skill installed to ~/.openclaw/skills/projects-skill/
                            covers: sync, add-task, publish, archive, list, get, create
  project-manager/
    SKILL.md             ← skill installed to ~/.openclaw/skills/project-manager/
                            covers: full paw-project CLI reference with workflows
```

## Skills Installed

### projects-skill
High-level skill covering the main project operations agents are likely to need:
- **Sync** — import GitHub issues as tasks
- **Add Task** — add a structured task to a project
- **Publish** — generate a rich markdown status report
- **Archive** — safely close out a completed project
- **List / Get** — look up projects by name or ID
- **Create** — spin up a new project

### project-manager
Detailed CLI reference for all `paw-project` subcommands with error handling, safety rules, and step-by-step workflows.
