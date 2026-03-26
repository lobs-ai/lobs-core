# PAW Branch Merge Strategy & Timeline

_Created: 2026-03-21 | Owner: Engineering (lobs) | Status: **Active**_

> **Reference:** Researcher session `169e8d58d8c818a6` (2026-03-20) identified all
> blockers; batch merge succeeded `2026-03-20T20:02` for three of four branches.
> This document captures the authoritative order, rationale, and per-branch checklist
> so progress can never stall silently again.

---

## TL;DR — Merge Order

```
1. ship-api     fix/expose-gateway-token        ← no deps, 4-line change, ship it
2. lobs-sail    feat/tool-preflight-health-check ← ship it (OpenClaw refs already cleaned)
3. paw-hub      fix/auto-provision-gateway-token ← HARD dep on ship-api being live
4. paw-plugin   fix/orphan-timeout-flood         ← branch detached HEAD, careful review
                fix/chat-agent-identity          ← decide: re-open PR #11 or re-submit
```

---

## Branch Detail & Dependency Map

### 1 · `ship-api` — `fix/expose-gateway-token`

| Field          | Value |
|----------------|-------|
| **Commits ahead** | 2 |
| **Files changed** | `server.js` (4 lines) |
| **Deps**       | None |
| **CI**         | ✅ Green on `main`; branch never pushed |
| **PR**         | None open (local-only at last assessment) |
| **Risk**       | 🟢 Low — env-var read + token return, self-contained |
| **Merge mode** | Squash → main |

**What it does:** Fixes `TRIDENT_AUTH_TOKEN` env var read; adds `/api/sails/:slug/token`
endpoint that returns the unmasked gateway token. Both lobs-sail and paw-hub callers need
this endpoint live before they can be deployed.

**Checklist:**
- [ ] Push branch: `cd ~/paw/ship-api && git push -u origin fix/expose-gateway-token`
- [ ] Open PR against `main` in `paw-engineering/ship-api`
- [ ] Wait for CI (expect < 2 min)
- [ ] Squash-merge
- [ ] Deploy ship-api (triggers paw-hub unblock)

---

### 2 · `lobs-sail` — `feat/tool-preflight-health-check`

| Field          | Value |
|----------------|-------|
| **Commits ahead** | 1 |
| **Files changed** | `TOOLS.md`, `AGENTS.md` (docs only) |
| **Deps**       | None (docs-only change) |
| **CI**         | ✅ Green on `main` |
| **PR**         | None open (local-only) |
| **Risk**       | 🟢 Low — documentation only |
| **Merge mode** | Squash → main |

**What it does:** Adds `TOOLS.md` + `AGENTS.md` session preflight health-check
documentation for the lobs-sail service.

**Note:** OpenClaw → Trident reference in TOOLS.md has been resolved (source code clean as of 2026-03-17 audit).

**Checklist:**
- [x] Fix stale OpenClaw reference — ✅ already cleaned
- [ ] Push: `git push -u origin feat/tool-preflight-health-check`
- [ ] Open PR; squash-merge
- [ ] Can be done in parallel with ship-api (no shared deps)

---

### 3 · `paw-hub` — `fix/auto-provision-gateway-token`

| Field          | Value |
|----------------|-------|
| **Commits ahead** | 1 |
| **Files changed** | `ship-client.js` (new file); gateway token fetch rewired |
| **Deps**       | ⛓️ **HARD**: ship-api `fix/expose-gateway-token` must be merged AND deployed |
| **CI**         | ✅ Green on `main`; branch never pushed |
| **PR**         | None open |
| **Risk**       | 🟠 Medium — calls new ship-api endpoint at runtime; end-to-end test recommended |
| **Merge mode** | Squash → main |

**What it does:** Adds `ship-client.js`; rewires gateway token provisioning to call
`ship-api /api/sails/:slug/token` instead of reading a local env var. This is the
completion of the ship-api → paw-hub token handoff.

**⚠️ Pre-merge cleanup required:**
The working tree has submodule pointer drift + `.DS_Store` files — clean before pushing.

**Checklist:**
- [ ] **Wait** for ship-api merge + deploy (prerequisite gate)
- [ ] Clean working tree: `git checkout -- . && echo ".DS_Store" >> .gitignore`
- [ ] Update submodule pointer if needed: `git submodule update --remote`
- [ ] `git status` — confirm clean
- [ ] Push: `git push -u origin fix/auto-provision-gateway-token`
- [ ] Open PR; add note: "Requires ship-api v{tag} deployed"
- [ ] Integration test: provision a sail end-to-end post-merge

---

### 4 · `paw-plugin` — Two separate issues (triage required)

| Field          | Value |
|----------------|-------|
| **Commits ahead** | Detached HEAD (no branch!) |
| **Detached commit** | `d2e2ba7` — orchestrator orphan timeout flood fix |
| **Deps**       | None external; lobs-sail consumes paw-plugin |
| **CI**         | 🔴 Stale queued run (46+ hrs) — cancel before anything else |
| **PR**         | PR #11 `fix/chat-agent-identity` — closed, not merged |
| **Risk**       | 🔴 High — core orchestrator logic (92 insertions, restart-continuation rewire) |
| **Merge mode** | Requires own PR per issue; human review mandatory |

#### Issue A — Detached HEAD commit `d2e2ba7` (orphan timeout flood fix)

**What it does:** Rewires restart-continuation logic in the orchestrator; cuts stale
threshold from 15 min → 2 min. 92 insertions — the biggest change in this batch.

**Checklist:**
- [ ] Cancel stale CI: `gh run cancel 23204556176 --repo paw-engineering/paw-plugin`
- [ ] Create branch from commit: `git checkout -b fix/orphan-timeout-flood d2e2ba7`
- [ ] Push: `git push -u origin fix/orphan-timeout-flood`
- [ ] Open PR with detailed description of restart-continuation logic change
- [ ] **Require human review** (Rafe or second senior eng) before merge
- [ ] Test in staging sail before merging to main
- [ ] After merge: bump lobs-sail's `paw-plugin` submodule pointer

#### Issue B — PR #11 `fix/chat-agent-identity` (closed, not merged)

**What it does:** Rafe approved but PR was closed without merge. Needs a decision.

**Checklist:**
- [ ] `gh pr view 11 --repo paw-engineering/paw-plugin` — read close reason
- [ ] **Decision gate:** re-open PR #11, or re-submit as fresh PR?
  - If re-open: `gh pr reopen 11 --repo paw-engineering/paw-plugin`
  - If re-submit: cherry-pick commits onto new branch from current `main`
- [ ] Do this **after** Issue A is merged (avoids compound PR review fatigue)

---

## Dependency Graph

```
ship-api (no deps)
    │
    └──► paw-hub (blocked until ship-api deploys)

lobs-sail (no deps, parallel to ship-api)

paw-plugin (no deps, but high-risk — sequence last for focus)
    │
    └──► lobs-sail (bump submodule pointer after paw-plugin merges)
```

---

## Timeline (Target)

| Week    | Action |
|---------|--------|
| 2026-W12 (now) | ① Push + merge ship-api; ② Push + merge lobs-sail (parallel) |
| 2026-W12       | ③ Push + merge paw-hub (after ship-api deployed) |
| 2026-W12/W13   | ④ Branch paw-plugin detached HEAD; open PR for review |
| 2026-W13       | ④ Merge paw-plugin after careful review; decide PR #11 |

---

## Escalation / Stall Detection

The hourly cron at `lobs-core/scripts/paw-branch-dashboard.sh` writes
`docs/automations/output/paw-branches.md`. If any branch in this document
remains in **🟡 Local Only** status after its target week, the Friday
`check-staged-changes.sh` cron will surface it as an inbox alert.

**Manual check:** `cat ~/lobs/lobs-core/docs/automations/output/paw-branches.md`

If a branch shows `local-only` status beyond its target date, ping the
branch owner directly — do not let stale work persist silently.

---

## Related Docs

| Document | Path |
|----------|------|
| Auto-merge low-risk fixes policy | `paw-hub/docs/auto-merge-low-risk-fixes.md` |
| Branch visibility dashboard (live) | `lobs-core/docs/automations/output/paw-branches.md` |
| Branch dashboard script | `lobs-core/scripts/paw-branch-dashboard.sh` |
| Staged-changes weekly check | `lobs-core/docs/automations/staged-changes-check.md` |
| Researcher assessment (2026-03-20) | `~/.lobs/agents/researcher/sessions/169e8d58d8c818a6.md` |

---

_Last updated: 2026-03-21 by programmer agent (task: document merge strategy & complete dashboard)_
