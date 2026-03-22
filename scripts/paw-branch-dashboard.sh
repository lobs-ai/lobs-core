#!/usr/bin/env zsh
# ============================================================
# paw-branch-dashboard.sh
# Unified PAW repo branch visibility dashboard generator.
#
# Scans PAW repos for:
#   - branches ahead of main (unmerged work)
#   - staged but uncommitted changes
#   - remote push status (pushed / local-only)
#   - CI status via gh CLI (if available)
#
# Outputs:
#   - JSON  → $OUTPUT_DIR/paw-branches.json
#   - MD    → $OUTPUT_DIR/paw-branches.md
#
# Usage:
#   ./paw-branch-dashboard.sh [--dry-run] [--no-write]
#
# Cron (hourly):
#   0 * * * * /Users/lobs/lobs/lobs-core/scripts/paw-branch-dashboard.sh >> /tmp/paw-branch-dashboard.log 2>&1
# ============================================================

# Ensure standard tools are on PATH (non-login zsh gets minimal PATH)
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:$PATH"

OUTPUT_DIR="${OUTPUT_DIR:-/Users/lobs/lobs/lobs-core/docs/automations/output}"
DRY_RUN=false
NO_WRITE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-write) NO_WRITE=true ;;
  esac
done

# ---------------------------------------------------------------------------
# Repo manifest — format: "name:/path/to/repo"
# ---------------------------------------------------------------------------
# NOTE: These are the standalone repo paths (not submodule paths inside
# lobs-sets-sail).  The researcher session (169e8d58d8c818a6, 2026-03-20)
# found that all 4 stalled branches were local-only; we now track them here
# so the cron picks them up as soon as any branch is pushed to origin.
# ---------------------------------------------------------------------------
REPOS=(
  # PAW feature repos (primary focus — the 4 branches 1-2 commits ahead)
  "paw-hub:/Users/lobs/paw/paw-hub"
  "ship-api:/Users/lobs/paw/ship-api"
  "lobs-sail:/Users/lobs/paw/lobs-sail"
  "paw-plugin:/Users/lobs/paw/paw-plugin"
  # Additional PAW repos
  "lobs-sets-sail:/Users/lobs/paw/lobs-sets-sail"
  "discord-router:/Users/lobs/paw/discord-router"
  "paw-site:/Users/lobs/paw/paw-site"
  "paw-portal:/Users/lobs/paw/paw-portal"
  "trident:/Users/lobs/paw/trident"
  # Agent workspace repos
  "lobs-core:/Users/lobs/lobs/lobs-core"
  "lobs-nexus:/Users/lobs/lobs/lobs-nexus"
)

GH_ORG="paw-engineering"

# ---------------------------------------------------------------------------
# Check gh CLI availability
# ---------------------------------------------------------------------------
GH_AVAILABLE=false
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    GH_AVAILABLE=true
  fi
fi

# ---------------------------------------------------------------------------
# emit_entry: print a JSON object to stdout, one per line
# All string escaping is delegated to python3
# ---------------------------------------------------------------------------
emit_entry() {
  # Args: name branch ahead behind pushed status pr_num pr_url pr_state ci_status \
  #       last_sha last_msg last_author last_date staged_add staged_del
  python3 - "$@" << 'PYEOF'
import sys, json

(name, branch, ahead, behind, pushed, status,
 pr_num, pr_url, pr_state, ci_status,
 last_sha, last_msg, last_author, last_date,
 staged_add, staged_del) = sys.argv[1:]

print(json.dumps({
    "repo": name,
    "branch": branch,
    "ahead": int(ahead),
    "behind": int(behind),
    "pushed": pushed == "true",
    "status": status,
    "pr_num": pr_num,
    "pr_url": pr_url,
    "pr_state": pr_state,
    "ci_status": ci_status,
    "last_sha": last_sha,
    "last_msg": last_msg,
    "last_author": last_author,
    "last_date": last_date,
    "staged_add": int(staged_add),
    "staged_del": int(staged_del),
}))
PYEOF
}

# ---------------------------------------------------------------------------
# scan_repo: scan one repo and print JSON entries to stdout
# Uses || true throughout so set +e isn't needed per-command
# ---------------------------------------------------------------------------
scan_repo() {
  local name="$1"
  local rpath="$2"

  [[ ! -d "$rpath/.git" ]] && return 0

  cd "$rpath" || return 0

  git fetch --quiet 2>/dev/null || true

  # Default branch
  local ref_head default_branch
  ref_head=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "")
  default_branch="${ref_head##*/}"
  [[ -z "$default_branch" ]] && default_branch="main"

  # Staged changes (uncommitted)
  local staged_add staged_del
  staged_add=$(git diff --cached --numstat 2>/dev/null | python3 -c "import sys; s=sum(int(l.split()[0]) for l in sys.stdin if l.split()); print(s)" 2>/dev/null || echo 0)
  staged_del=$(git diff --cached --numstat 2>/dev/null | python3 -c "import sys; s=sum(int(l.split()[1]) for l in sys.stdin if l.split()); print(s)" 2>/dev/null || echo 0)

  # Collect branch list to a temp var (avoid stdin conflict with while loop)
  local branch_list
  branch_list=$(git branch 2>/dev/null || echo "")

  while IFS= read -r raw_branch; do
    local branch
    branch="${raw_branch//\*/}"
    branch="${branch// /}"
    [[ -z "$branch" ]] && continue
    [[ "$branch" == "$default_branch" ]] && continue
    [[ "$branch" == pr-* ]] && continue

    local ahead
    ahead=$(git rev-list --count "origin/${default_branch}..${branch}" 2>/dev/null || echo "0")
    [[ "$ahead" == "0" ]] && continue

    local behind
    behind=$(git rev-list --count "${branch}..origin/${default_branch}" 2>/dev/null || echo "0")

    # Remote push status (grep -q exits 1 if not found → protect with || true)
    local pushed="false"
    if git ls-remote --heads origin "$branch" 2>/dev/null | grep -q "$branch"; then
      pushed="true"
    fi

    # Last commit metadata
    local last_sha last_msg last_author last_date
    last_sha=$(git log -1 --format="%h" "$branch" 2>/dev/null || echo "")
    last_msg=$(git log -1 --format="%s" "$branch" 2>/dev/null || echo "")
    last_author=$(git log -1 --format="%an" "$branch" 2>/dev/null || echo "")
    last_date=$(git log -1 --format="%aI" "$branch" 2>/dev/null || echo "")

    # CI / PR via gh (optional)
    local pr_num="" pr_url="" pr_state="" ci_status=""
    if [[ "$GH_AVAILABLE" == "true" ]]; then
      local pr_json
      pr_json=$(gh pr list --repo "${GH_ORG}/${name}" --head "$branch" \
        --json number,url,state,statusCheckRollup 2>/dev/null || echo "[]")
      local gh_parsed
      gh_parsed=$(python3 -c "
import json, sys
data = json.loads(sys.argv[1])
if not data:
    print('pr_num=||pr_url=||pr_state=||ci_status=')
    sys.exit()
pr = data[0]
checks = pr.get('statusCheckRollup', [])
if checks:
    states = [c.get('state','').lower() or c.get('conclusion','').lower() for c in checks]
    if all(s in ('success','neutral','skipped') for s in states if s):
        ci = 'success'
    elif any(s in ('failure','error','cancelled','timed_out') for s in states):
        ci = 'failure'
    elif any(s in ('pending','queued','in_progress','waiting') for s in states):
        ci = 'pending'
    else:
        ci = ''
else:
    ci = ''
print(f'{pr[\"number\"]}||{pr[\"url\"]}||{pr[\"state\"]}||{ci}')
" "$pr_json" 2>/dev/null || echo "||||||")
      IFS="||" read -r pr_num pr_url pr_state ci_status <<< "$gh_parsed"
    fi

    # Triage status
    local status="ahead"
    if [[ "$ci_status" == "failure" ]]; then
      status="ci-failing"
    elif [[ "$pushed" == "false" ]]; then
      status="local-only"
    elif [[ -n "$pr_num" && "$pr_state" == "OPEN" ]]; then
      status="open-pr"
    elif [[ "$pushed" == "true" && -z "$pr_num" ]]; then
      status="ready-to-pr"
    fi

    emit_entry \
      "$name" "$branch" "$ahead" "$behind" "$pushed" "$status" \
      "$pr_num" "$pr_url" "$pr_state" "$ci_status" \
      "$last_sha" "$last_msg" "$last_author" "$last_date" \
      "$staged_add" "$staged_del"

  done <<< "$branch_list"

  # Repo-level staged-only alert
  if [[ "$staged_add" != "0" || "$staged_del" != "0" ]]; then
    emit_entry \
      "$name" "__staged__" "0" "0" "false" "staged" \
      "" "" "" "" \
      "" "Uncommitted staged changes" "" "" \
      "$staged_add" "$staged_del"
  fi
}

# ---------------------------------------------------------------------------
# assemble_outputs: combine NDJSON temp file → JSON + Markdown
# ---------------------------------------------------------------------------
assemble_outputs() {
  local entries_file="$1"
  local json_out="$2"
  local md_out="$3"
  local ts="$4"
  local no_write="$5"

  python3 - "$entries_file" "$json_out" "$md_out" "$ts" "$no_write" << 'PYEOF'
import sys, json
from datetime import datetime, timezone
from collections import defaultdict

entries_file, json_out, md_out, ts, no_write = sys.argv[1:]

entries = []
with open(entries_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except Exception:
            pass

result = {
    "generated_at": ts,
    "repo_count": len(set(e["repo"] for e in entries)),
    "branch_count": sum(1 for e in entries if e["branch"] != "__staged__"),
    "staged_count": sum(1 for e in entries if e["branch"] == "__staged__"),
    "entries": entries
}

if no_write != "true":
    with open(json_out, 'w') as f:
        json.dump(result, f, indent=2)

# ---- Markdown ----
try:
    dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
    ts_display = dt.strftime('%Y-%m-%d %H:%M UTC')
except Exception:
    ts_display = ts

STATUS_EMOJI = {
    "ci-failing":  "🔴",
    "local-only":  "🟡",
    "open-pr":     "🔵",
    "ready-to-pr": "🟢",
    "staged":      "⚠️",
    "ahead":       "⚪",
}

def status_label(s):
    return STATUS_EMOJI.get(s, "⚪") + " " + s.replace("-", " ").title()

lines = []
lines.append("# PAW Branch Dashboard\n")
lines.append(f"_Generated: {ts_display} — updates hourly via cron_\n")
lines.append(
    f"**{result['branch_count']} unmerged branches** across "
    f"**{result['repo_count']} repos** | "
    f"**{result['staged_count']} repos** with staged changes\n"
)
lines.append("## Legend\n")
lines.append("| Symbol | Meaning |")
lines.append("|--------|---------|")
for k, v in STATUS_EMOJI.items():
    lines.append(f"| {v} | {k.replace('-',' ').title()} |")
lines.append("")

by_repo = defaultdict(list)
for e in entries:
    by_repo[e["repo"]].append(e)

STATUS_ORDER = {
    "ci-failing": 0, "staged": 1, "local-only": 2,
    "ready-to-pr": 3, "open-pr": 4, "ahead": 5,
}

for repo_name in sorted(by_repo.keys()):
    repo_entries = sorted(by_repo[repo_name],
                          key=lambda e: STATUS_ORDER.get(e["status"], 9))
    lines.append(f"## `{repo_name}`\n")
    lines.append("| Branch | Status | Ahead | Behind | Pushed | PR | CI | Last Commit |")
    lines.append("|--------|--------|------:|-------:|--------|----|----|-------------|")
    for e in repo_entries:
        branch = e["branch"]
        status = status_label(e["status"])
        pushed = "✅" if e["pushed"] else "❌"
        pr_link = f"[#{e['pr_num']}]({e['pr_url']})" if e.get("pr_num") else "—"
        ci = {"success": "✅", "failure": "❌", "pending": "⏳"}.get(
            e.get("ci_status", ""), "—")
        msg = (e.get("last_msg") or "")[:55]
        sha = (e.get("last_sha") or "")[:7]
        date_raw = e.get("last_date", "")
        try:
            dt2 = datetime.fromisoformat(date_raw.replace('Z', '+00:00')) if date_raw else None
            date_str = dt2.strftime("%m-%d") if dt2 else ""
        except Exception:
            date_str = ""
        last = f"`{sha}` {date_str} {msg}".strip() if sha else msg
        if branch == "__staged__":
            branch_cell = "_(staged changes)_"
            pushed = "—"; ahead_s = "—"; behind_s = "—"
        else:
            branch_cell = f"`{branch}`"
            ahead_s = str(e["ahead"]); behind_s = str(e["behind"])
        lines.append(
            f"| {branch_cell} | {status} | {ahead_s} | {behind_s} "
            f"| {pushed} | {pr_link} | {ci} | {last} |"
        )
    lines.append("")

# Quick triage
lines.append("## Quick Triage\n")
ci_failing  = [e for e in entries if e["status"] == "ci-failing"]
ready       = [e for e in entries if e["status"] == "ready-to-pr"]
local_only  = [e for e in entries if e["status"] == "local-only"]
open_prs    = [e for e in entries if e["status"] == "open-pr"]
staged_list = [e for e in entries if e["status"] == "staged"]

if not any([ci_failing, ready, local_only, open_prs, staged_list]):
    lines.append("_All clear — no unmerged branches or staged changes detected._\n")

if ci_failing:
    lines.append(f"### 🔴 CI Failing ({len(ci_failing)})")
    for e in ci_failing:
        pr_ref = f"PR #{e['pr_num']}" if e.get('pr_num') else "no PR"
        lines.append(f"- **{e['repo']}** `{e['branch']}` — {pr_ref} — {e.get('last_msg','')[:60]}")
    lines.append("")

if open_prs:
    lines.append(f"### 🔵 Open PRs ({len(open_prs)})")
    for e in open_prs:
        pr_ref = (f"[PR #{e['pr_num']}]({e['pr_url']})"
                  if e.get('pr_url') else f"PR #{e['pr_num']}")
        lines.append(f"- **{e['repo']}** `{e['branch']}` — {pr_ref} — {e.get('last_msg','')[:60]}")
    lines.append("")

if ready:
    lines.append(f"### 🟢 Ready to PR ({len(ready)})")
    for e in ready:
        lines.append(
            f"- **{e['repo']}** `{e['branch']}` "
            f"— +{e['ahead']} commits — {e.get('last_msg','')[:60]}"
        )
    lines.append("")

if local_only:
    lines.append(f"### 🟡 Local Only — Not Pushed ({len(local_only)})")
    for e in local_only:
        lines.append(
            f"- **{e['repo']}** `{e['branch']}` "
            f"— +{e['ahead']} commits — push before opening PR"
        )
    lines.append("")

if staged_list:
    lines.append(f"### ⚠️  Staged But Uncommitted ({len(staged_list)})")
    for e in staged_list:
        lines.append(
            f"- **{e['repo']}** "
            f"— +{e['staged_add']}/-{e['staged_del']} lines staged"
        )
    lines.append("")

# ---------------------------------------------------------------------------
# Merge Readiness — locked merge order for the 4 stalled PAW branches.
# Source: docs/paw-branch-merge-strategy.md (2026-03-21)
# ---------------------------------------------------------------------------
MERGE_ORDER = [
    {
        "seq": 1,
        "repo": "ship-api",
        "branch": "fix/expose-gateway-token",
        "deps": [],
        "blocker": None,
        "notes": "Push + PR first; no deps; 4-line change",
    },
    {
        "seq": 2,
        "repo": "lobs-sail",
        "branch": "feat/tool-preflight-health-check",
        "deps": [],
        "blocker": "Fix OpenClaw→Trident ref in TOOLS.md before push",
        "notes": "Docs-only; parallel with ship-api",
    },
    {
        "seq": 3,
        "repo": "paw-hub",
        "branch": "fix/auto-provision-gateway-token",
        "deps": ["ship-api"],
        "blocker": "HARD dep: ship-api must be merged AND deployed",
        "notes": "ship-client.js; end-to-end test post-merge",
    },
    {
        "seq": 4,
        "repo": "paw-plugin",
        "branch": "fix/orphan-timeout-flood  +  fix/chat-agent-identity",
        "deps": [],
        "blocker": "Detached HEAD d2e2ba7 → branch first; cancel stale CI run",
        "notes": "92 insertions; human review required",
    },
]

# Build a set of repos that are already clean (merged / no unmerged branches)
merged_repos = set(
    e["repo"] for e in entries if e["status"] == "merged"
)
# Repos with at least one branch still unmerged
unmerged_repos = set(
    e["repo"] for e in entries
    if e["branch"] != "__staged__" and e["status"] != "merged"
)

lines.append("## Merge Readiness\n")
lines.append(
    "_Locked merge order — see `docs/paw-branch-merge-strategy.md` for full checklist._\n"
)
lines.append("| # | Repo | Branch | Deps | Blocker | Status |")
lines.append("|---|------|--------|------|---------|--------|")

for mo in MERGE_ORDER:
    seq      = mo["seq"]
    repo     = mo["repo"]
    branch   = mo["branch"]
    deps     = ", ".join(mo["deps"]) if mo["deps"] else "—"
    blocker  = mo["blocker"] or "—"
    # Determine status cell from live scan data
    if repo in merged_repos and repo not in unmerged_repos:
        status_cell = "✅ Merged"
    elif repo in unmerged_repos:
        # Find the entry for more detail
        repo_entries = [e for e in entries if e["repo"] == repo and e["branch"] != "__staged__"]
        if repo_entries:
            e0 = repo_entries[0]
            s  = e0["status"]
            if s == "local-only":
                status_cell = "🟡 Local only — push needed"
            elif s == "ready-to-pr":
                status_cell = "🟢 Ready to PR"
            elif s == "open-pr":
                pr_ref = (f"[PR #{e0['pr_num']}]({e0['pr_url']})"
                          if e0.get("pr_url") else f"PR #{e0['pr_num']}")
                status_cell = f"🔵 Open {pr_ref}"
            elif s == "ci-failing":
                status_cell = "🔴 CI failing"
            else:
                status_cell = f"⚪ {s}"
        else:
            status_cell = "⚪ Not tracked / repo not found"
    else:
        status_cell = "⚪ Not yet tracked"

    lines.append(f"| {seq} | **{repo}** | `{branch}` | {deps} | {blocker} | {status_cell} |")

lines.append("")
lines.append(
    "> 📋 Full per-branch checklist: "
    "`cat ~/lobs/lobs-core/docs/paw-branch-merge-strategy.md`"
)
lines.append("")

md_content = '\n'.join(lines) + '\n'

if no_write != "true":
    with open(md_out, 'w') as f:
        f.write(md_content)
else:
    sys.stdout.write(md_content)

print(
    f"SUMMARY: {result['branch_count']} branches | "
    f"{result['staged_count']} staged repos | "
    f"{result['repo_count']} repos scanned"
)
PYEOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  local generated_at
  generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN: repos to scan ==="
    for entry in "${REPOS[@]}"; do
      echo "  ${entry%%:*}  →  ${entry##*:}"
    done
    return 0
  fi

  echo "[paw-branch-dashboard] scanning at $generated_at ..."

  local tmp_entries
  tmp_entries="$(mktemp -t "${TMPDIR:-/tmp}/paw-branch-ndjson.XXXXXX")"

  for entry in "${REPOS[@]}"; do
    local rname="${entry%%:*}"
    local rpath="${entry##*:}"
    echo "  scanning $rname ..."
    scan_repo "$rname" "$rpath" >> "$tmp_entries" 2>/dev/null || true
  done

  mkdir -p "$OUTPUT_DIR"
  local json_out="$OUTPUT_DIR/paw-branches.json"
  local md_out="$OUTPUT_DIR/paw-branches.md"

  assemble_outputs "$tmp_entries" "$json_out" "$md_out" "$generated_at" "$NO_WRITE"
  rm -f "$tmp_entries"

  if [[ "$NO_WRITE" == "true" ]]; then
    echo "[paw-branch-dashboard] done (--no-write)"
    return 0
  fi

  echo "[paw-branch-dashboard] done."
  echo "  JSON → $json_out"
  echo "  MD   → $md_out"
}

main "$@"
