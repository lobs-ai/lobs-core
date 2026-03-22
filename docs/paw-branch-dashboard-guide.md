# PAW Branch Visibility Dashboard — Team Guide

_Created: 2026-03-21 | Owner: Engineering (lobs)_

## What It Is

A Markdown dashboard (`docs/automations/output/paw-branches.md`) that shows the
real-time status of every unmerged branch across all PAW repos — pushed PRs,
local-only work, CI state, and now **merge readiness for the 4 stalled feature
branches**.

The dashboard is regenerated **every hour** by a cron job running
`scripts/paw-branch-dashboard.sh` in the `lobs-core` repo.

---

## Access

### Read the dashboard (any team member)

```bash
# Latest generated snapshot (updated hourly by cron)
cat ~/lobs/lobs-core/docs/automations/output/paw-branches.md

# Or open as rendered Markdown in VS Code
code ~/lobs/lobs-core/docs/automations/output/paw-branches.md

# Or in your terminal with a Markdown pager
glow ~/lobs/lobs-core/docs/automations/output/paw-branches.md   # if glow installed
mdcat ~/lobs/lobs-core/docs/automations/output/paw-branches.md  # if mdcat installed
```

### Run on-demand (get instant update)

```bash
cd ~/lobs/lobs-core
./scripts/paw-branch-dashboard.sh

# Or dry-run (prints to stdout, does not write the file)
./scripts/paw-branch-dashboard.sh --no-write

# Print summary line only
./scripts/paw-branch-dashboard.sh --summary-only
```

### View the companion merge strategy & checklist

```bash
cat ~/lobs/lobs-core/docs/paw-branch-merge-strategy.md
```

---

## Dashboard Sections Explained

### Header stats
```
3 unmerged branches across 4 repos | 1 repo with staged changes
```
Quick health check — zero means everything is merged and clean.

### Branch table

| Column | Meaning |
|--------|---------|
| Branch | Branch name (`—` for staged-only repos) |
| Status | See legend below |
| Ahead | Commits ahead of `main` |
| Behind | Commits behind `main` (drift; > 10 = rebase soon) |
| Pushed | Whether the branch exists on `origin` |
| PR | Linked PR number if open |
| CI | Last CI run result |
| Last commit | Commit message snippet |

### Status legend

| Symbol | Status | Meaning |
|--------|--------|---------|
| ✅ | `merged` | Branch merged into main |
| 🟢 | `ready-to-pr` | Pushed to origin, no open PR yet |
| 🔵 | `open-pr` | PR is open, awaiting review / CI |
| 🔴 | `ci-failing` | CI is failing on an open PR |
| 🟡 | `local-only` | Commits exist but branch was never pushed — **most common stall** |
| ⚠️  | `staged` | Uncommitted staged changes in working tree |

### Merge Readiness table (NEW)

Shows the locked merge order for the 4 stalled PAW branches with live status from
the most recent scan. Columns:

| Column | Meaning |
|--------|---------|
| # | Merge sequence order |
| Repo | Repository name |
| Branch | Feature branch(es) |
| Deps | Other repos that must merge first |
| Blocker | Known pre-merge action required |
| Status | Live status from current scan |

---

## Common Workflows

### "Is branch X ready to merge?"

```bash
# Run on-demand and grep for the repo
./scripts/paw-branch-dashboard.sh --no-write | grep ship-api
```

### "What's blocking paw-hub?"

```bash
# Full checklist with dependency detail
grep -A 20 "paw-hub" ~/lobs/lobs-core/docs/paw-branch-merge-strategy.md
```

### "I just pushed a branch — does the dashboard see it?"

```bash
# Force a refresh
cd ~/lobs/lobs-core && ./scripts/paw-branch-dashboard.sh
# Then check
cat docs/automations/output/paw-branches.md | grep your-branch-name
```

### "The dashboard shows stale data"

The cron runs hourly. If the timestamp is > 2 hours old:

```bash
# Check cron
crontab -l | grep paw-branch

# Re-register if missing (cron line from staged-changes-check.md)
# 0 * * * * cd /Users/lobs/lobs/lobs-core && ./scripts/paw-branch-dashboard.sh >> /tmp/paw-branch-dashboard.log 2>&1
```

---

## Cron Schedule

| Job | Schedule | Script | Output |
|-----|----------|--------|--------|
| Branch dashboard | Every hour | `scripts/paw-branch-dashboard.sh` | `docs/automations/output/paw-branches.md` |
| Staged-changes check | Fridays 17:00 | `scripts/check-staged-changes.sh` | Inbox alert (type=`alert`) |

Both jobs write to stdout logs at `/tmp/paw-branch-dashboard.log` and
`/tmp/staged-changes-check.log` respectively.

---

## Stall Escalation Policy

If a branch remains in 🟡 **Local Only** status past its target week from the
merge strategy doc:

1. The Friday staged-changes cron will surface it as an inbox alert
2. Dashboard cron timestamp goes stale → visible to anyone who checks
3. **Manual escalation:** ping the branch owner directly

See `docs/paw-branch-merge-strategy.md` → "Escalation / Stall Detection" for details.

---

## Related Files

| File | Purpose |
|------|---------|
| `scripts/paw-branch-dashboard.sh` | Dashboard generator script |
| `docs/automations/output/paw-branches.md` | Live dashboard output |
| `docs/automations/output/paw-branches.json` | Machine-readable version |
| `docs/paw-branch-merge-strategy.md` | Merge order, checklists, timeline |
| `docs/automations/staged-changes-check.md` | Weekly alert automation docs |

---

_Last updated: 2026-03-21 by programmer agent_
