# Programmer Handoff: Add-on Reversibility (`ingest.py --remove`)

**From:** Architect  
**To:** Programmer  
**Initiative:** addon-system  
**Priority:** High — required for production-safe add-on installs

---

## Context

The add-on ingestion system (`~/.lobs/addons/ingest.py`) applies patches to core system
files when a user installs an add-on. Currently those patches are permanent — there's no way
to undo them without manual editing.

The architecture (see `docs/decisions/ADR-addon-system.md`) specifies marker-based reversal.
This handoff is to implement that.

---

## What Needs to Change

### 1. Add Markers on Text Insertion

Modify these three functions in `ingest.py` to wrap inserted content:

**`apply_append`**, **`apply_append_section`**, **`apply_prepend`**

Wrap content with named markers before writing:

```python
def _wrap_with_markers(addon_name: str, content: str) -> str:
    return f"<!-- addon:{addon_name}:begin -->\n{content}\n<!-- addon:{addon_name}:end -->"
```

The `addon_name` must be passed through from the caller (it's available in `ingest_addon`
and `ingest_from_file` as `meta.get("name")`).

### 2. Track `removal_hints` in `installed.json`

Each operation that modifies a file should record a hint. After applying all ops, update the
registry entry with `removal_hints`:

```json
{
  "tasks": {
    "installed_at": "2026-03-06T17:53:27Z",
    "version": "1.0.0",
    "ops_applied": 2,
    "removal_hints": [
      { "type": "skill-dir", "path": "~/.lobs/skills/tasks" },
      { "type": "marked-section", "file": "~/apps/AGENTS.md", "marker": "tasks" }
    ]
  }
}
```

Hint types:
- `skill-dir` — a skill directory installed; reversal removes it (restoring `.bak` if present)
- `marked-section` — a text block inserted with markers; reversal strips the block from the file
- `created-file` — a file created by `create`/`create-overwrite`; reversal deletes it (restoring `.bak`)
- `json-merged` — a JSON merge; reversal restores from `.json.bak`

### 3. Implement `ingest.py --remove <name>`

Add `--remove` as a CLI command:

```
python3 ~/.lobs/addons/ingest.py --remove tasks
python3 ~/.lobs/addons/ingest.py --dry-run --remove tasks
```

Logic:
1. Load `installed.json`, find entry for `<name>`. Error if not installed.
2. For each hint in `removal_hints`:
   - `skill-dir`: delete the skill dir; restore `.bak` if present
   - `marked-section`: find `<!-- addon:<name>:begin -->` ... `<!-- addon:<name>:end -->` in file and remove (including surrounding blank lines)
   - `created-file`: delete file; restore `.bak` if present
   - `json-merged`: restore from `.json.bak` if present; otherwise warn that manual cleanup needed
3. Remove entry from `installed.json`
4. Print summary

Dry-run mode: print what would be removed without doing it.

---

## Important Edge Cases

1. **Already-installed add-ons without markers** (tasks, projects, group-messaging, example)
   — `removal_hints` won't be in their registry entries. `--remove` should detect this and
   warn the user that manual cleanup is needed, then offer to just remove the registry entry.

2. **Marker regex** must handle both Unix and Windows line endings. Use:
   ```python
   pattern = re.compile(
       rf'<!-- addon:{re.escape(name)}:begin -->\n.*?<!-- addon:{re.escape(name)}:end -->\n?',
       re.DOTALL
   )
   ```

3. **Multiple blank lines after removal** — strip extra blank lines after removing a block
   to keep files clean.

4. **File not found** during removal — warn but continue (file may have been manually cleaned).

---

## Acceptance Criteria

- [ ] `ingest.py <name>` wraps all text insertions with `<!-- addon:<name>:begin/end -->` markers
- [ ] `installed.json` includes `removal_hints` array for each installed add-on (going forward)
- [ ] `ingest.py --remove <name>` removes all marked blocks and deletes/restores files per hints
- [ ] `ingest.py --dry-run --remove <name>` shows what would be removed without applying
- [ ] Re-installing an already-installed add-on (markers already present) is idempotent — `append-section` check prevents duplicates
- [ ] Add-ons installed before this change get a graceful "no removal hints, manual cleanup needed" message
- [ ] Round-trip test: install `example` add-on → `--remove example` → target files match pre-install state

---

## Files to Edit

- `~/.lobs/addons/ingest.py` — primary implementation
- `~/.lobs/addons/addon-spec.md` — document marker format and `--remove` usage

After making changes, run `bin/sync-addons` in `lobs-plugin-paw` to propagate the updated
`ingest.py` to the plugin repo source (or update it in the plugin and let sync-addons push out).

**Note:** `ingest.py` lives in `~/.lobs/addons/` at runtime. The plugin repo (`lobs-plugin-paw`)
may or may not vendor a copy — confirm where the source-of-truth copy lives before editing.

---

## Testing

```bash
# Install example add-on
python3 ~/.lobs/addons/ingest.py example

# Verify markers in AGENTS.md
grep "addon:example:begin" ~/apps/AGENTS.md

# Dry-run removal
python3 ~/.lobs/addons/ingest.py --dry-run --remove example

# Actual removal
python3 ~/.lobs/addons/ingest.py --remove example

# Verify markers gone, registry entry removed
grep "addon:example" ~/apps/AGENTS.md  # should return nothing
cat ~/.lobs/addons/installed.json | python3 -m json.tool | grep example  # should return nothing
```
