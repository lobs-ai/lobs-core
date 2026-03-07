# ADR: Markdown Add-on System — Secondary Bootstrapping

**Status:** Accepted  
**Date:** 2026-03-06  
**Context:** PAW Platform Architecture meeting — key product differentiator

---

## Problem

OpenClaw bootstraps its agent configuration from a single install. But different users need
different capabilities — task management, project tracking, meeting ingestion, compliance tools,
etc. Bundling everything into the base install creates bloat and overwhelm. Doing nothing
leaves users with a generic, unconfigured assistant.

We need a **secondary bootstrapping mechanism**: optional, modular config files that can be
ingested on request and permanently extend the system — without requiring code changes or
developer involvement.

---

## Solution: The Add-on System

Add-ons are **markdown files that define patches to core system files**. Ingesting an add-on
permanently extends skills, AGENTS.md, openclaw.json, and other config files. The result is
a system that behaves differently — new agent capabilities, new CLI tools, new behaviors.

This is distinct from:
- **Primary bootstrapping** — openclaw.json, initial plugin install (one-time system setup)
- **Skills** — passive how-to documents loaded at runtime (no system modification)
- **Plugin config** — runtime settings (no permanent agent behavior change)

Add-ons sit between these: they are **config-level, on-demand, and permanent**.

---

## Architecture

```
Primary Bootstrap
────────────────
openclaw.json → PAW plugin loaded → orchestrator starts

Secondary Bootstrap (Add-on System)
────────────────────────────────────
User: "install add-on tasks"
  → addon-manager skill reads ~/.openclaw/addons/tasks/addon.md
  → ingest.py parses @target sections
  → patches applied to ~/.openclaw/skills/, ~/apps/AGENTS.md, etc.
  → registered in ~/.openclaw/addons/installed.json
  → agent now has new capabilities on next session

Source of Truth
───────────────
PAW Plugin (this repo)
  addons/
    tasks/         ← canonical definition
    projects/
    inbox/
    meetings/
    ...

Runtime Location
────────────────
~/.openclaw/addons/
  tasks/           ← copied from PAW plugin; operated by ingest.py
  projects/
  ...
  ingest.py        ← ingestion engine
  installed.json   ← registry
  README.md        ← catalog (TOC)
  addon-spec.md    ← spec for writing add-ons
```

---

## File Structure

### PAW Plugin (source of truth)

```
openclaw-plugin-paw/addons/
  README.md                  ← catalog TOC with all PAW add-ons
  <addon-name>/
    README.md                ← human-readable description (shows in catalog)
    addon.md                 ← machine-readable definition (parsed by ingest.py)
    <skill-name>/
      SKILL.md               ← bundled skill (installed via skill-install action)
```

### Runtime (~/.openclaw/addons/)

Same structure, copied from PAW plugin. The runtime location is what `ingest.py` operates on.

**Key invariant:** `~/.openclaw/addons/<name>/` is always a verbatim copy of
`openclaw-plugin-paw/addons/<name>/`. Updates to the plugin update the source; `sync-addons`
propagates to the runtime.

---

## Add-on Format (addon.md)

Each add-on is defined by a single `addon.md` file:

```markdown
---
name: tasks
version: 1.0.0
description: Task management — create, update, list, close tasks via PAW API
---

## @target: skill-install [skill-install]

tasks

## @target: ~/apps/AGENTS.md [append-section]

## Task Management (tasks add-on)

Use the `tasks` skill for all task CRUD operations...
```

### Supported Actions

| Action | What it does | Reversible via |
|--------|-------------|----------------|
| `create` | Write new file (fail if exists) | Delete file |
| `create-overwrite` | Write file, backup old if exists | Restore from `.bak` |
| `append` | Append content to end of file | Marker-based removal |
| `append-section` | Idempotent `##` section append | Marker-based removal |
| `prepend` | Prepend content to file start | Marker-based removal |
| `json-merge` | Deep-merge JSON, backup old | Restore from `.bak` |
| `skill-install` | Copy skill folder, backup old | Restore/delete skill |

---

## Reversibility Design

**Constraint:** Many operations mutate shared files (AGENTS.md, openclaw.json). True reversal
requires knowing exactly what was inserted so it can be removed.

**Approach: Marker-based reversal for text insertions**

For `append`, `append-section`, and `prepend` operations, `ingest.py` wraps inserted content
with named markers:

```
<!-- addon:tasks:begin -->
## Task Management (tasks add-on)
...content...
<!-- addon:tasks:end -->
```

The `--remove <name>` flag finds and removes all marked blocks for that add-on.

For `create` / `create-overwrite`: reversal deletes the created file (restoring backup if present).

For `json-merge`: reversal restores from the auto-generated `.json.bak` file.

For `skill-install`: reversal removes the skill directory (restoring backup if present).

### Uninstall Registry

`installed.json` gains a `removal_hints` field per add-on:

```json
{
  "tasks": {
    "installed_at": "2026-03-06T17:53:27Z",
    "version": "1.0.0",
    "ops_applied": 2,
    "removal_hints": [
      { "type": "skill-dir", "path": "~/.openclaw/skills/tasks" },
      { "type": "marked-section", "file": "~/apps/AGENTS.md", "marker": "tasks" }
    ]
  }
}
```

**Important caveat:** Reversal is best-effort. If the user manually edited the marked sections,
removal may be incomplete. Reversal should always run with `--dry-run` first.

---

## PAW Plugin as Add-on Source

PAW is the primary supplier of add-ons. Its `addons/` folder is the canonical definition of
all PAW-specific capabilities.

### Distribution Flow

```
1. Developer writes/updates addons/<name>/addon.md in this repo
2. npm run sync-addons  ← copies addons/ → ~/.openclaw/addons/
3. ingest.py <name>     ← user installs when ready
```

The `sync-addons` step happens:
- During PAW plugin install/update (future automation)
- Manually by the developer during development
- Optionally during OpenClaw gateway start (future plugin hook)

### Add-on Catalog

`~/.openclaw/addons/README.md` is the **catalog** — a human-readable TOC that lists all
available add-ons with status, description, and install command. PAW maintains this file.
When new add-ons are added to the plugin, the catalog is updated.

---

## Add-on Lifecycle

```
Planned    → add-on is documented in README.md catalog as "planned"
Available  → addon.md exists in ~/.openclaw/addons/<name>/
Installed  → ingest.py has applied patches; entry in installed.json
Removed    → ingest.py --remove applied; entry removed from installed.json
```

---

## Tradeoffs

### What We Chose
- **Single `ingest.py` engine** — one parser, all action types, no per-add-on code
- **Permanent mutations** — add-ons change system files; no runtime loading/unloading
- **Marker-based reversal** — text markers enable un-ingest without a separate state store
- **PAW as source** — the plugin repo owns add-on definitions; `~/.openclaw/addons/` is a copy

### What We Didn't Choose
- **Runtime loading** — would require plugin system changes; adds complexity
- **Database-backed state** — overkill; filesystem markers are simpler and inspectable
- **Immutable system files** — would require agents to load add-on content separately each session

### Known Limitations
- Reversal is best-effort: manual edits to marked sections may prevent clean removal
- `json-merge` reversal requires no other changes to the JSON file after install
- Add-on authors must follow the spec exactly; no schema validation today

---

## Implementation Status

| Component | Status |
|-----------|--------|
| `ingest.py` — ingestion engine | ✅ complete |
| `addon-spec.md` — spec | ✅ complete |
| `~/.openclaw/addons/README.md` — catalog | ✅ complete |
| `addon-manager` skill | ✅ complete |
| `tasks` add-on | ✅ complete |
| `projects` add-on | ✅ complete |
| `group-messaging` add-on | ✅ complete |
| `example` add-on | ✅ complete |
| `ingest.py --remove` — reversal | ❌ not yet implemented |
| PAW plugin `addons/` as source | ⚠️ partial (projects.md single-file exists) |
| `sync-addons` script | ❌ not yet implemented |
| Planned add-ons (inbox, meetings, memory, etc.) | ⚠️ scaffolded, not implemented |

---

## Implementation Plan

### Milestone 1: Reversibility (Programmer handoff)
- Add `--remove <name>` to `ingest.py`
- Add markers to all text-insertion operations
- Record `removal_hints` in `installed.json`
- Retroactively mark already-installed sections (or note they need manual cleanup)

### Milestone 2: PAW Plugin Structure (Programmer handoff)
- Restructure `openclaw-plugin-paw/addons/` to use canonical directory format
- Replace `addons/projects.md` with `addons/projects/addon.md` + bundled skills
- Add `npm run sync-addons` script

### Milestone 3: Remaining Add-ons (Programmer tasks, in progress)
- Implement planned add-ons in priority order per `~/.openclaw/addons/README.md`
- High: inbox, meetings
- Medium: memory, chat, knowledge, reflections, research
- Low: calendar, workflows, youtube, documents, status

---

## Testing Strategy

- **Dry run first**: always validate with `--dry-run` before applying
- **Idempotency**: re-installing same add-on should not duplicate content (`append-section` is idempotent)
- **Reversal round-trip**: install → remove → verify system files match pre-install state
- **Registry consistency**: `installed.json` must accurately reflect installed state
