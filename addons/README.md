# PAW Add-on Catalog

This folder is the **source of truth** for all PAW add-ons. Each subfolder is a self-contained
add-on that extends OpenClaw with new agent capabilities.

Add-ons are the secondary bootstrapping mechanism: optional, modular config files that
permanently extend the agent system when ingested.

## Available Add-ons

| Name | Status | Description |
|------|--------|-------------|
| [tasks](./tasks/README.md) | ✅ stable | Task management — create, update, list, and close tasks via the PAW API |
| [projects](./projects/README.md) | ✅ stable | Project management — sync, publish, archive, and add tasks to projects |

## Planned Add-ons (coming soon)

| Name | Priority | Description |
|------|----------|-------------|
| inbox | 🔴 high | Triage and respond to inbox items — action-required items for human review |
| meetings | 🔴 high | Process meeting transcripts, extract and track action items |
| memory | 🟡 medium | Read, write, and search agent memory entries |
| chat | 🟡 medium | Create and manage multi-session AI chat conversations |
| knowledge | 🟡 medium | Browse and search the shared knowledge base |
| reflections | 🟡 medium | Review, approve, and reject agent self-improvement reflections |
| research | 🟡 medium | Submit, list, and read research documents and findings |
| calendar | 🟢 low | Create and manage scheduled events with cron recurrence |
| workflows | 🟢 low | Define and trigger multi-step automated workflows |
| youtube | 🟢 low | Ingest YouTube videos into the knowledge base |
| documents | 🟢 low | Manage generated reports and long-form documents |
| status | 🟢 low | Query system health, activity feed, and cost summaries |

## How to Install an Add-on

From any agent session:
> "Install add-on tasks" or "ingest add-on tasks"

Or directly:
```bash
python3 ~/.openclaw/addons/ingest.py tasks
python3 ~/.openclaw/addons/ingest.py --list
python3 ~/.openclaw/addons/ingest.py --dry-run tasks
```

## Structure

Each add-on follows this layout:

```
<addon-name>/
  README.md              ← human-readable description (shown in catalog)
  addon.md               ← machine-readable definition (parsed by ingest.py)
  <skill-name>/
    SKILL.md             ← bundled skill (installed via skill-install action)
```

## Syncing to Runtime

The runtime location for add-ons is `~/.openclaw/addons/`. To sync from this folder:

```bash
npm run sync-addons
```

Or directly:
```bash
bin/sync-addons
```

See [docs/decisions/ADR-addon-system.md](../docs/decisions/ADR-addon-system.md) for full architecture.
