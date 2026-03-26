# PAW Branch Dashboard

_Generated: 2026-03-21 12:00 UTC — updates hourly via cron_

**4 unmerged branches** across **4 repos** | **0 repos** with staged changes

## Legend

| Symbol | Status | Meaning |
|--------|--------|---------|
| ✅ | merged | Branch merged into main |
| 🟢 | ready-to-pr | Pushed, no open PR yet |
| 🔵 | open-pr | PR open, awaiting review/CI |
| 🔴 | ci-failing | CI failing on open PR |
| 🟡 | local-only | Commits exist, branch never pushed |
| ⚠️  | staged | Uncommitted staged changes |

## Branches

| Repo | Branch | Status | Ahead | Behind | Pushed | PR | CI | Last Commit |
|------|--------|--------|-------|--------|--------|----|----|-------------|
| **ship-api** | `fix/expose-gateway-token` | 🟡 local-only | 2 | 0 | ✗ | — | — | fix: expose gateway token endpoint |
| **lobs-sail** | `feat/tool-preflight-health-check` | 🟡 local-only | 1 | 0 | ✗ | — | — | docs: add tool preflight health-check |
| **paw-hub** | `fix/auto-provision-gateway-token` | 🟡 local-only | 1 | 0 | ✗ | — | — | feat: auto-provision gateway token via ship-client |
| **paw-plugin** | _(detached HEAD d2e2ba7)_ | 🟡 local-only | — | — | ✗ | — | 🔴 stale | fix: orphan timeout flood / restart-continuation |

## Quick Triage

### 🟡 Local Only — Not Pushed (4)
- **ship-api** `fix/expose-gateway-token` — +2 commits — push before opening PR
- **lobs-sail** `feat/tool-preflight-health-check` — +1 commits — push before opening PR
- **paw-hub** `fix/auto-provision-gateway-token` — +1 commits — push before opening PR
- **paw-plugin** `fix/orphan-timeout-flood` (detached HEAD `d2e2ba7`) — push before opening PR

### 🔴 CI Failing (1)
- **paw-plugin** _(detached HEAD d2e2ba7)_ — stale CI run 23204556176 (46+ hrs) — cancel and re-run after branching

## Merge Readiness

_Locked merge order — see `docs/paw-branch-merge-strategy.md` for full checklist._

| # | Repo | Branch | Deps | Blocker | Status |
|---|------|--------|------|---------|--------|
| 1 | **ship-api** | `fix/expose-gateway-token` | — | — | 🟡 Local only — push needed |
| 2 | **lobs-sail** | `feat/tool-preflight-health-check` | — | ✅ OpenClaw ref cleaned — ready to push | 🟡 Local only — push needed |
| 3 | **paw-hub** | `fix/auto-provision-gateway-token` | ship-api | HARD dep: ship-api must be merged AND deployed | 🟡 Local only — push needed |
| 4 | **paw-plugin** | `fix/orphan-timeout-flood  +  fix/chat-agent-identity` | — | Detached HEAD d2e2ba7 → branch first; cancel stale CI run | 🟡 Local only — push needed |

> 📋 Full per-branch checklist: `cat ~/lobs/lobs-core/docs/paw-branch-merge-strategy.md`

---

_Dashboard guide & team access: `docs/paw-branch-dashboard-guide.md`_
