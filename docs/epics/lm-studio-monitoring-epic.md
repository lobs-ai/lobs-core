# Epic: LM Studio Monitoring — Coordinated Delivery Plan

**Status:** In Progress  
**Epic task:** `e7f7d09a` (proj-paw)  
**Created:** 2026-03-23  
**Owner:** programmer  

---

## Problem Statement

LM Studio monitoring work has been implemented in isolated bursts across multiple tasks,
resulting in:

- **Silent gaps:** `evaluateAndAlert()` existed and was tested but never called on a schedule
  (closed: commit 5179a04). Similar gaps risk recurring without an explicit sequencing contract.
- **Hardcoded thresholds:** `LATENCY_WARN_MS` and `LATENCY_CRIT_MS` are compile-time constants.
  There is no way to tune them without a code change, and no way to observe them from outside
  the process (no Prometheus / metrics export).
- **No end-to-end test:** each phase has unit tests but there is no integration test that
  exercises the full path: preflight fires → alert fires → observable metric emitted.
- **Orphaned task:** `d131a765` (Wire LM Studio health check into spawn_agent preflight) is
  marked ACTIVE but the implementation is already in `control-loop.ts` (lines 1460, 2221) and
  `restart-continuation.ts`. Needs verification + closure.

---

## What Is Already Done

| Phase | Artifact | Location | Status |
|-------|----------|----------|--------|
| Health check → preflight | `checkModelsBeforeSpawn()` | `src/diagnostics/lmstudio.ts:351` | ✅ Done |
| Preflight wired — native runner | `processSpawnWithRunner` guard | `src/orchestrator/control-loop.ts:1460` | ✅ Done |
| Preflight wired — restart path | `restart-continuation.ts:74` | `src/hooks/restart-continuation.ts` | ✅ Done |
| Cron-based alert check | `runLmStudioAlertCheck()` | `src/services/lm-studio-monitor.ts` | ✅ Done |
| Alert rules (latency + mismatch) | `evaluateAndAlert()` | `src/diagnostics/lm-studio-alerting.ts` | ✅ Done |
| Cron registration | `'lm-studio-monitor'` job | `src/services/main.ts` `*/5 * * * *` | ✅ Done |
| Unit tests — alerting | — | `tests/lm-studio-monitor.test.ts` (10 tests) | ✅ Done |
| Unit tests — preflight | — | `tests/spawn-lmstudio-preflight.test.ts` | ✅ Done |

---

## Remaining Work — Explicit Sequence

Phases **must execute in order**. Each phase depends on the previous being ✅.

---

### Phase 1 — Verify & Close Orphaned Preflight Task
**Task:** `d131a765` — Wire LM Studio health check into spawn_agent preflight  
**Dependency:** None  
**Effort:** XS (30 min)

**Acceptance criteria:**
1. Read `control-loop.ts` lines ~1450–1470 and ~2215–2230 to confirm `checkModelsBeforeSpawn` is present in both spawn paths.
2. Run `tests/spawn-lmstudio-preflight.test.ts` — all tests pass.
3. Update task `d131a765` status → `completed` with a short note confirming both paths are wired.
4. If any gap is found, patch it before closing.

**Why first:** All downstream phases assume the preflight is production-wired. Closing this
resolves ambiguity and gives the cron/alert phases a clean foundation.

---

### Phase 2 — Tunable Thresholds via Environment Variables
**New task needed** — "Make LM Studio alert thresholds tunable via env vars"  
**Depends on:** Phase 1 ✅  
**Effort:** S (1–2 hrs)

**Current state:**  
`lm-studio-alerting.ts` exports `LATENCY_WARN_MS = 1_000` and `LATENCY_CRIT_MS = 3_000`
as module-level constants. No env-var override exists.

**Acceptance criteria:**
1. `LATENCY_WARN_MS` reads from `LMS_LATENCY_WARN_MS` env var (default: 1000).
2. `LATENCY_CRIT_MS` reads from `LMS_LATENCY_CRIT_MS` env var (default: 3000).
3. Both thresholds are validated at parse time: must be positive integers, warn < crit.
   Invalid values → log a warning and fall back to defaults (never crash).
4. `runLmStudioAlertCheck()` passes the resolved thresholds through to `evaluateAndAlert()`.
5. Tests: 2 new unit tests — one verifying env-var override, one verifying invalid-value fallback.
6. Document the env vars in `docs/runbooks/session-startup-checklist.md` under a
   "Threshold Tuning" section.

**Why second:** Prometheus export (Phase 3) needs to emit the _configured_ threshold values,
not hardcoded defaults. Establishing the source-of-truth here prevents duplication.

---

### Phase 3 — Prometheus / Metrics Export
**New task needed** — "Export LM Studio monitoring metrics to Prometheus"  
**Depends on:** Phase 2 ✅  
**Effort:** M (3–5 hrs)

**Current state:** Zero Prometheus instrumentation in lobs-core. `prom-client` is not installed.

**Acceptance criteria:**
1. Install `prom-client` as a production dependency.
2. Create `src/metrics/lm-studio-metrics.ts` exposing:
   - `lm_studio_latency_ms` — Gauge, last observed latency (labels: none)
   - `lm_studio_reachable` — Gauge (0/1)
   - `lm_studio_alert_total` — Counter, incremented each time `evaluateAndAlert()` fires an alert (labels: `severity`, `rule`)
   - `lm_studio_latency_warn_threshold_ms` — Gauge, value of `LMS_LATENCY_WARN_MS` at startup
   - `lm_studio_latency_crit_threshold_ms` — Gauge, value of `LMS_LATENCY_CRIT_MS` at startup
3. `runLmStudioAlertCheck()` updates the Gauges/Counters after each cron run.
4. Register a `GET /metrics` route in `src/api/` returning `prom-client` default + custom metrics in Prometheus text format.
5. Tests: mock `prom-client` in unit tests; verify metric values update correctly after a diagnostic run.
6. `GET /metrics` is unauthenticated by default (standard Prometheus scrape convention) but
   restricted to `127.0.0.1` via middleware unless `METRICS_PUBLIC=true`.

**Why third:** Depends on tunable thresholds (Phase 2) so threshold gauges emit accurate values.
Phase 4 end-to-end tests will assert metric values after full-flow execution.

---

### Phase 4 — End-to-End Integration Test
**New task needed** — "Add end-to-end integration test for full LM Studio monitoring flow"  
**Depends on:** Phase 3 ✅  
**Effort:** S–M (2–3 hrs)

**Current state:** Unit tests cover individual components. No test exercises the full chain:
preflight guard → cron alert check → `evaluateAndAlert()` → inbox alert fired → metrics updated.

**Acceptance criteria:**
1. Create `tests/lm-studio-e2e.test.ts` (or extend `lm-studio-monitor.test.ts`).
2. Test: **happy path** — LM Studio reachable, model loaded, latency < warn threshold.
   Assert: no alerts fired, `lm_studio_reachable` = 1, `lm_studio_alert_total` = 0.
3. Test: **latency warn** — stub latency probe to return 1500ms, thresholds defaults.
   Assert: one alert fired (`severity=medium`), counter incremented.
4. Test: **latency crit** — stub latency probe to return 3500ms.
   Assert: one alert fired (`severity=high`), counter incremented.
5. Test: **unreachable with local models** — stub LM Studio as unreachable.
   Assert: alert fired (`rule=lmstudio_unreachable`), `lm_studio_reachable` = 0.
6. Test: **preflight blocks spawn** — call `checkModelsBeforeSpawn` with a model not in the
   loaded list. Assert: returns `{ pass: false }` with suggestion in `error`.
7. All tests use in-process stubs (no real network), run in `< 5s` total.
8. All 1944 + N existing tests still pass.

**Why last:** Validates that Phases 1–3 integrate correctly under a single observable flow.
Regressions in any upstream phase will fail this suite first.

---

## Dependency Graph

```
Phase 1 (Verify Preflight) ─────────────────────────────────────┐
                                                                  │
Phase 2 (Tunable Thresholds) ◄──── depends on Phase 1 ──────────┤
                                                                  │
Phase 3 (Prometheus Export) ◄───── depends on Phase 2 ──────────┤
                                                                  │
Phase 4 (E2E Test) ◄──────────────── depends on Phase 3 ─────────┘
```

No phase may be started until the previous phase's acceptance criteria are all verified.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `prom-client` adds significant bundle size | Evaluate at Phase 3; alternative: write metrics as plain text to a file and expose via `GET /metrics` without the library. |
| Hardcoded threshold change breaks existing alert tests | Phase 2 must update all tests that reference `LATENCY_WARN_MS` / `LATENCY_CRIT_MS` constants directly. |
| `/metrics` endpoint opens attack surface | Default to `127.0.0.1` restriction; document `METRICS_PUBLIC=true` override. |
| Phase 1 finds preflight gap (d131a765 legitimately open) | Fix before closing — do not mark done without patching. |

---

## Related Artifacts

| Artifact | Path |
|----------|------|
| Pre-spawn diagnostic | `src/diagnostics/lmstudio.ts` |
| Alert rules | `src/diagnostics/lm-studio-alerting.ts` |
| Cron monitor | `src/services/lm-studio-monitor.ts` |
| ADR | `docs/decisions/ADR-lmstudio-model-diagnostic.md` |
| Session startup runbook | `docs/runbooks/session-startup-checklist.md` |
| Monitor tests | `tests/lm-studio-monitor.test.ts` |
| Preflight tests | `tests/spawn-lmstudio-preflight.test.ts` |

---

## Task Registry

| # | Task ID | Title | Status |
|---|---------|-------|--------|
| 0 | `e7f7d09a` | Consolidate LM Studio monitoring into coordinated epic (this doc) | active |
| 1 | `d131a765` | Wire LM Studio health check into spawn_agent preflight | active → verify & close |
| 2 | TBD | Make LM Studio alert thresholds tunable via env vars | to create |
| 3 | TBD | Export LM Studio monitoring metrics to Prometheus | to create |
| 4 | TBD | Add end-to-end integration test for full LM Studio monitoring flow | to create |
