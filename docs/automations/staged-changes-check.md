# Automation: Weekly Staged-Changes Check

**Created:** 2026-03-17  
**Trigger:** Every Friday at 17:00 (before weekend)  
**Script:** `lobs-core/scripts/check-staged-changes.sh`

---

## Problem

Staged (index) changes that linger over weekends lose context and create merge-conflict
risk. The 386-line `config.json` change committed on 2026-03-17 03:01 is a concrete
example — it sat staged long enough to require a forced commit. This automation catches
that pattern before it becomes a problem.

## What It Does

1. **Scans** all agent repos for staged changes (`git diff --cached`)
2. **Counts** the lines changed (additions + deletions via `--numstat`)
3. **Flags** repos where staged lines exceed the threshold (default: **100 lines**)
4. **Writes** an inbox suggestion to today's daily memory file with:
   - Repo name, line count, approximate age (index mtime)
   - `git diff --stat` summary
   - First 200 lines of the full diff for context
   - Explicit action checklist (commit / test+commit / revert / stash)

## Repos Scanned

| Repo | Path |
|------|------|
| lobs-core | `~/lobs/lobs-core` |
| lobs-nexus | `~/lobs/lobs-nexus` |
| lobs-mobile | `~/lobs/lobs-mobile` |
| lobs-shared-memory | `~/lobs/lobs-shared-memory` |
| lobslab-infra | `~/lobs/lobslab-infra` |
| paw-hub | `~/paw/paw-hub` |
| paw-designs | `~/paw/paw-designs` |
| bot-shared | `~/paw/bot-shared` |
| lobs-sets-sail | `~/paw/lobs-sets-sail` |
| ship-api | `~/ship-api` |
| lobs-sail | `~/lobs-sail` |

## Install / Remove

```bash
# Install cron (Friday 17:00)
~/lobs/lobs-core/scripts/install-staged-check-cron.sh

# Dry-run (no memory writes, just report)
~/lobs/lobs-core/scripts/check-staged-changes.sh --dry-run

# Remove cron
~/lobs/lobs-core/scripts/install-staged-check-cron.sh --remove
```

## Cron Entry

```cron
0 17 * * 5 /Users/lobs/lobs/lobs-core/scripts/check-staged-changes.sh >> ~/.lobs/logs/staged-check.log 2>&1 # lobs-staged-check
```

## Output: Inbox Suggestion Format

When a repo is flagged, a section like this is appended to `~/.lobs/workspace/daily/YYYY-MM-DD.md`:

```markdown
## 🚨 Staged WIP Alert — `lobs-core`

**Date flagged:** 2026-03-21 17:00 PDT
**Repo:** `/Users/lobs/lobs/lobs-core`
**Staged lines:** 243 (threshold: 100)
**Approximate age:** ~3 day(s) (based on index mtime)

### Required action (before weekend)
Pick one:
- [ ] Commit
- [ ] Test + commit
- [ ] Revert
- [ ] Stash

### Staged diff stat / diff excerpt
...
```

## Threshold Tuning

The `THRESHOLD=100` variable in the script controls the line count trigger.
Adjust it if the signal-to-noise ratio needs tuning (e.g., raise to 200 for
repos with many frequent auto-generated changes).

## Log Location

All runs append to `~/.lobs/logs/staged-check.log`.

## Decision Record

See memory note: `[2026-03-17] staged-changes-check automation — pattern remains after 386-line config.json WIP commit`
