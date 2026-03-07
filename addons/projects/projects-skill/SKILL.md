---
name: projects-skill
description: Sync, publish, archive, and add tasks to PAW projects. Use when asked to manage projects — list active work, add tasks to a project, publish a status update, sync GitHub issues, or archive a completed project.
---

# Projects Skill

## CLI Reference

All project operations go through the `paw-project` CLI:

```
paw-project list                                        # list active projects
paw-project list --archived                             # include archived
paw-project get <id>                                    # show one project
paw-project create --title "..." --type kanban          # create project
paw-project update <id> [--title ...] [--notes ...]     # update project fields
paw-project add-task <project-id> --title "..."         # add task to project
paw-project tasks <id> [--status active]                # list project tasks
paw-project publish <id>                                # rich markdown status report
paw-project archive <id>                                # archive (never delete)
paw-project unarchive <id>                              # restore archived project
paw-project sync <id>                                   # sync GitHub issues → tasks
```

IDs accept: full UUID, UUID prefix, or case-insensitive title substring (e.g., `portal`, `sail`).

---

## Sync Projects from GitHub

Use when user asks to "sync issues", "import GitHub issues", or "refresh tasks from GitHub".

```bash
# Sync issues from GitHub into a project's task queue
paw-project sync <project-id>
```

**Rules:**
- Sync is **additive only** — never removes or modifies existing tasks
- New issues are imported as `inbox` / `queued` tasks for triage
- Requires `github_repo` to be set on the project
- Requires `gh` CLI authenticated: `gh auth status`

If the project has no `githubRepo` set:
```bash
paw-project update <id> --github-repo owner/repo
paw-project sync <id>
```

---

## Add Task to Project

Use when user says "add a task to project X", "create a task under Y", or "log work for project Z".

```bash
# Basic — programmer, standard tier
paw-project add-task <project-id> --title "Implement feature X"

# With agent and notes
paw-project add-task <project-id> \
  --title "Refactor auth module" \
  --agent programmer \
  --tier standard \
  --notes "## Problem\nThe auth module needs cleanup.\n\n## Acceptance Criteria\n- [ ] Tests pass"

# Researcher task
paw-project add-task <project-id> \
  --title "Research caching strategies" \
  --agent researcher \
  --tier standard
```

**Defaults:** agent = `programmer`, tier = `standard`

**Available agents:** `programmer`, `writer`, `researcher`, `reviewer`, `architect`

**Available tiers:** `micro`, `small`, `medium`, `standard`, `strong`

---

## Publish Project Status

Use when user asks "what's the status of project X?", "give me a project update", or "publish a summary".

```bash
paw-project publish <project-id>
```

Output is rich markdown grouped by task status. Present it directly in chat or write to a file.

**Workflow:**
1. Run `paw-project list` to find the project ID if needed
2. Run `paw-project publish <id>`
3. Present the full markdown output

---

## Archive a Project

Use when user says "archive project X", "close out project Y", or "mark project Z as done".

**Always confirm with the user before archiving.**

```bash
# Step 1: Check for remaining active tasks
paw-project tasks <project-id> --status active

# Step 2: If active tasks remain, ask user how to handle them
# Step 3: Archive when ready
paw-project archive <project-id>

# Step 4: Verify
paw-project get <project-id>   # → archived: true
```

To restore an archived project:
```bash
paw-project unarchive <project-id>
```

**Safety rules:**
- Never archive without user confirmation
- Never delete projects — archive only
- Check for open tasks before archiving; don't silently abandon work

---

## List and Get Projects

```bash
# List active projects
paw-project list

# Include archived
paw-project list --archived

# Get a single project (by ID, prefix, or name)
paw-project get portal
paw-project get sail
paw-project get abc1234
```

---

## Create a Project

```bash
paw-project create \
  --title "My New Project" \
  --type kanban \
  --repo-path "/Users/lobs/my-project" \
  --github-repo "owner/repo"
```

**Types:** `kanban`, `research`, `tracker`, `project`

After creating:
```bash
paw-project get <new-id>     # confirm it looks right
paw-project sync <new-id>    # optional: import existing GitHub issues
```

---

## Project Fields Reference

| Field | Notes |
|-------|-------|
| `id` | Auto-generated slug or UUID |
| `title` | Display name |
| `type` | `kanban` \| `research` \| `tracker` \| `project` |
| `notes` | Markdown description |
| `repoPath` | Local filesystem path to repo |
| `githubRepo` | `owner/repo` (required for sync) |
| `archived` | `true` when archived; hidden from default list |
| `complianceRequired` | If true, tasks inherit compliance restriction |

---

## Workflow: New Project Setup

1. `paw-project create --title "..." --type kanban`
2. Confirm: `paw-project get <id>`
3. Add initial tasks: `paw-project add-task <id> --title "..."`
4. Sync GitHub (optional): `paw-project sync <id>`

## Workflow: Weekly Status

1. `paw-project list` → pick the project
2. `paw-project publish <id>` → copy markdown output
3. Present or post the summary

## Workflow: Archive Completed Project

1. `paw-project tasks <id> --status active` → confirm no open work
2. Get user confirmation
3. `paw-project archive <id>`
4. `paw-project get <id>` → verify archived

---

## Error Handling

| Error | Fix |
|-------|-----|
| `Project not found` | Run `paw-project list` to find correct ID/name |
| `github_repo not configured` | Run `paw-project update <id> --github-repo owner/repo` |
| `gh CLI error` during sync | Check `gh auth status`; run `gh auth login` if needed |
| `No tasks found` | Project may have no tasks yet; try `paw-project add-task` |

---

## User Commands This Skill Handles

- "list projects" / "what projects are active" → `paw-project list`
- "add a task to project X" → `paw-project add-task <id>`
- "what's the status of project X" → `paw-project publish <id>`
- "sync issues for project X" → `paw-project sync <id>`
- "archive project X" → confirm, then `paw-project archive <id>`
- "restore project X" → `paw-project unarchive <id>`
- "create a new project called X" → `paw-project create --title "X"`
