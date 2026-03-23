# LM Studio Active Tasks — Restored Descriptions & Acceptance Criteria

**Created:** 2026-03-23  
**Purpose:** Restore truncated task descriptions, assign tiers, define acceptance criteria, and link code evidence. Addresses persistent context-engine truncation of two LM Studio tasks that appeared in every programmer-agent session from 2026-03-17 onward.

---

## Task 1 — Add alerting rules for LM Studio latency/model-mismatch warnings

### Status: ✅ DONE — Commit 35dad6c (2026-03-20)

### Full restored description

> LM Studio diagnostic endpoints exist (`GET /api/lm-studio`, `GET /api/lm-studio/models`, `GET /api/lm-studio/latency`) but they only surface data — they do not fire alerts when thresholds are breached. Implement threshold-based alert rules that write inbox items when latency is high, when configured local models aren't loaded, or when LM Studio is unreachable. Alert pipeline must use the existing `inboxItems` table (`type="alert"`) — no external services (no Sentry, no DataDog). De-duplicate by alertKey so the inbox doesn't flood on repeated diagnostic calls.

**Why it was truncated:** Context engine clipped the description at `"but no alerting rules connect latency/mode..."` — the full sentence was *"connect latency/model-mismatch to the inbox alert pipeline"*.

### Tier: standard

### What "alerting rules" means operationally

Five rules implemented in `src/diagnostics/lm-studio-alerting.ts`:

| Rule | Trigger | Urgency | Alert key |
|------|---------|---------|-----------|
| `LATENCY_WARN` | `latencyMs > 1000ms` | medium | `lm-studio:latency` |
| `LATENCY_CRIT` | `latencyMs > 3000ms` | high | `lm-studio:latency` |
| `UNREACHABLE` | LM Studio down + ≥1 local model configured | high | `lm-studio:unreachable` |
| `MODEL_MISMATCH` | ≥1 configured local model not in loaded list | high | `lm-studio:model-mismatch` |
| `WARNINGS` | non-empty `warnings[]` on diagnostic response | low | `lm-studio:warnings` |

De-duplication: a new alert is only inserted when no **unread** `inboxItems` row with the same `alertKey` (stored as `triageCategory`) exists. Once the user reads the item, the rule can fire again.

### Alert pipeline wiring

- `GET /api/lm-studio` — calls `evaluateAndAlert()` after every full diagnostic; response includes an `alerts` field: `{ inserted, suppressed, fired[], skipped[] }`
- `POST /api/lm-studio/alert-check` — new endpoint designed for cron/scheduler use; runs full diagnostic + fires alerts; returns focused alert summary

### Acceptance criteria (all met)

- [x] `LATENCY_WARN` fires when `latencyMs > 1000ms`
- [x] `LATENCY_CRIT` fires when `latencyMs > 3000ms` (supersedes WARN for same check)
- [x] `UNREACHABLE` fires when LM Studio is down **and** local models are configured (not when only cloud models exist)
- [x] `MODEL_MISMATCH` fires when ≥1 configured local model ID is absent from `GET /v1/models` response
- [x] `WARNINGS` fires for any non-empty `warnings[]` on the diagnostic
- [x] No duplicate alerts: if an unread alert with the same key exists, new one is suppressed
- [x] `GET /api/lm-studio` response includes `alerts` field
- [x] `POST /api/lm-studio/alert-check` endpoint exists and returns focused summary
- [x] 19 tests in `tests/diagnostics/lm-studio-alerting.test.ts` — all passing, using real in-memory SQLite

### Code paths

| Artifact | Path |
|----------|------|
| Alert evaluation service | `src/diagnostics/lm-studio-alerting.ts` |
| API integration | `src/api/lm-studio.ts` (updated) |
| Tests | `tests/diagnostics/lm-studio-alerting.test.ts` |
| Runbook update | `docs/runbooks/session-startup-checklist.md` |
| Completion commit | `35dad6c` — `feat(alerting): wire LM Studio latency/model-mismatch alerts to inbox pipeline` |

---

## Task 2 — Wire LM Studio health check into spawn_agent preflight to close orphaned-on-restart gap

### Status: ⚠️ PARTIALLY DONE — infrastructure complete, spawn_agent integration pending

### Full restored description

> LM Studio diagnostic infrastructure is deployed (commit 98c05ba): `GET /api/lm-studio` endpoint live, `lobs preflight` CLI command added, pre-spawn model check wired into `processSpawnWithRunner`. However, there is still an **orphaned-on-restart gap**: if lobs-core restarts mid-session and a spawn is retried, the health check in `restart-continuation.ts` and `subagent.ts` silently fails when the gateway token is missing — the orchestrator is never nudged to resume after restart. The missing piece is: (1) ensure the LM Studio preflight guard fires on the **retry path** (not just the primary spawn path), and (2) gate the retry on `ship-api` deploying `fix/expose-gateway-token` which exposes the gateway token to subagents.

**Why it was truncated:** Context engine clipped at `"HIGH priority. LM Studio health check infrastructure complete (commit 98c05ba, lobs preflight + lobs"` — the full sentence continued `"...lobs models CLI commands added) but health check not yet integrated into spawn_agent preflight chain for the orphaned-on-restart gap"`.

### Tier: high

### What "wired" means operationally

"Wired" = the `checkModelsBeforeSpawn()` call runs in **all** spawn paths, including the restart-continuation retry path, not just `processSpawnWithNativeRunner`. Specifically:

1. `src/orchestrator/restart-continuation.ts` — add `checkModelsBeforeSpawn()` guard before retry execution
2. `src/orchestrator/subagent.ts` — fail loudly (not silently) when gateway token is missing, surface error to orchestrator
3. `processSpawnWithRunner` already has the guard (commit `fa1d9c0`) — this task closes the gap in the **other** paths

### What's already done (do not re-implement)

| Component | Status | Commit |
|-----------|--------|--------|
| `src/diagnostics/lmstudio.ts` — `checkModelsBeforeSpawn()` | ✅ done | `fb222d3` |
| `processSpawnWithRunner` pre-spawn guard | ✅ done | `fa1d9c0` |
| `lobs preflight` CLI (session-start gate) | ✅ done | `98c05ba` |
| `lobs models` CLI (granular model scan) | ✅ done | `98c05ba` |
| `GET /api/health` cross-link when LM Studio down | ✅ done | `98c05ba` |
| Alerting rules (`lm-studio-alerting.ts`) | ✅ done | `35dad6c` |

### Blocker

**Depends on:** `ship-api` branch `fix/expose-gateway-token` deployed. The gateway token must be accessible to subagents before the restart-continuation path can be hardened. See merge strategy: `docs/paw-branch-merge-strategy.md` — ship-api is step 1.

### Acceptance criteria (pending)

- [ ] `src/orchestrator/restart-continuation.ts` calls `checkModelsBeforeSpawn()` before retrying a spawn
- [ ] On LM Studio unreachable in retry path: spawn fails with structured `lmstudio_unreachable` error (same shape as primary path), orchestrator is notified
- [ ] On missing model in retry path: fails with `lmstudio_model_not_loaded` + suggestions
- [ ] `src/orchestrator/subagent.ts` logs a warning and surfaces error to orchestrator when gateway token is absent (not silent fail)
- [ ] `lobs preflight` exits 1 when LM Studio is unreachable (already implemented — regression test this)
- [ ] Integration test: spawn with LM Studio mocked as unreachable → retry path blocks with structured error
- [ ] `ship-api` (`fix/expose-gateway-token`) deployed before this task is picked up

### Code paths

| Artifact | Path |
|----------|------|
| Diagnostic engine | `src/diagnostics/lmstudio.ts` |
| Pre-spawn guard (done) | `src/orchestrator/control-loop.ts` |
| Restart-continuation (gap) | `src/orchestrator/restart-continuation.ts` |
| Subagent token handling (gap) | `src/orchestrator/subagent.ts` |
| ADR | `docs/decisions/ADR-lmstudio-model-diagnostic.md` |
| Runbook | `docs/runbooks/session-startup-checklist.md` |
| Infrastructure commit | `98c05ba` — `feat(lmstudio): cross-link diagnostics + health check; add session startup preflight` |

---

## Execution order

```
1. Deploy ship-api (fix/expose-gateway-token)     ← unblocks gateway token
2. Wire restart-continuation.ts + subagent.ts     ← closes orphaned-on-restart gap  [Task 2]
3. Task 1 is already DONE — close it in the task tracker
```

Task 1 (`alerting rules`) should be **closed** in the PAW task tracker — it was completed 2026-03-20 and the only remaining action is marking it done. Task 2 (`health check wiring`) is the live work item, blocked on ship-api deployment.

---

## Why descriptions were truncated

The context engine injects active task descriptions from the PAW task DB into agent session headers. Both tasks were stored in the DB with long prose descriptions. The context engine truncates at a character limit, cutting both mid-sentence. This document serves as the canonical full-text reference — link to it from the task tracker notes field.

**Cross-reference:** `docs/decisions/ADR-lmstudio-model-diagnostic.md` (implementation ADR), `docs/runbooks/session-startup-checklist.md` (operational runbook)
