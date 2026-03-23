# LM Studio Monitoring — Consolidation Learnings & Decision Log

**Epic:** `e7f7d09a` | **Commit:** `f2049a8` | **Created:** 2026-03-23  
**Owner:** programmer | **Status:** ✅ Consolidated into explicit sequencing

---

## Overview

This document captures the institutional knowledge gained during the LM Studio monitoring epic consolidation (2026-03-23). Multiple attempts were made to structure the work; one succeeded, one failed. The success factors and key decisions are captured here to prevent rework.

---

## Attempt 1 — Failed (2026-03-23T00:15:42)

**Task:** "Consolidate LM Studio monitoring into coordinated epic with explicit sequencing"  
**Status:** ❌ Failed after ~285s  
**Summary:**  

The first consolidation attempt ran but did not produce usable output artifacts. The agent correctly analyzed the gap between what was built vs. what was missing:

```
- ✅ Phase 1 (Health/Preflight): Built & wired in control-loop + CLI
- ✅ Phase 2 (Alerting): Built & tested
- ❌ Phases 3-4: Not yet implemented
```

**Root cause:** The epic structure itself did not exist at the time. The agent had context about what *should* be built but no container in which to place it. The gap analysis was accurate, but without a documented epic, there was no "task registry" or acceptance criteria anchor for future work.

**Key insight:** The consolidation must start with **documenting the epic structure first**, then populating the task registry with explicit phases, dependencies, and acceptance criteria.

---

## Attempt 2 — Succeeded (2026-03-23T00:47:44, commit `f2049a8`)

**Task:** Same consolidation task, second attempt  
**Status:** ✅ Succeeded after ~357s  
**Output:** `docs/epics/lm-studio-monitoring-epic.md` created

**What was built:**

| Component | Location | Status |
|-----------|----------|--------|
| Epic documentation | `docs/epics/lm-studio-monitoring-epic.md` | ✅ Created |
| Phase 1 task `d131a765` | Already existed, now verified | ✅ No blocker |
| Phase 2 task `971f07a8` | Defined with acceptance criteria | ✅ Ready to start |
| Phase 3 task `f2ef419a` | Defined with acceptance criteria | ✅ Blocked by 971f07a8 |
| Phase 4 task `7b22c1cc` | Defined with acceptance criteria | ✅ Blocked by f2ef419a |
| Dependency graph | Included in epic doc | ✅ Clear sequencing |
| Related artifacts table | Cross-references all code | ✅ Traceable |
| Risk/mitigation table | Pre-identified risks | ✅ Proactive |
| Task registry | All 5 tasks enumerated | ✅ Trackable |

**Key success factors:**

1. **Epic doc created first** — The container existed before the work was assigned.
2. **Explicit sequencing documented** — Each phase lists its dependency and acceptance criteria.
3. **Related artifacts table** — All code locations are cross-referenced so no "where is this?" questions arise.
4. **Task IDs assigned** — Each phase has a unique identifier for tracking and blocking enforcement.
5. **Risk table included** — Pre-identified risks (prom-client bundle size, hardcoded thresholds, `/metrics` security, Phase 1 gaps) with mitigations.

---

## What Already Exists (Verified by Phase 1)

The following artifacts were already implemented and tested before the epic consolidation:

| Artifact | Path | Tests |
|----------|------|-------|
| Pre-spawn diagnostic | `src/diagnostics/lmstudio.ts:351` (`checkModelsBeforeSpawn()`) | ✅ |
| Alert rules logic | `src/diagnostics/lm-studio-alerting.ts:evaluateAndAlert()` | ✅ 19 tests |
| Cron monitor | `src/services/lm-studio-monitor.ts:runLmStudioAlertCheck()` | ✅ |
| Cron job registration | `src/services/main.ts` (`*/5 * * * *`) | ✅ |
| Preflight (native runner) | `src/orchestrator/control-loop.ts:1460` | ✅ |
| Preflight (restart path) | `src/hooks/restart-continuation.ts:74` | ✅ |
| Unit tests — alerting | `tests/lm-studio-monitor.test.ts` | ✅ 10 tests |
| Unit tests — preflight | `tests/spawn-lmstudio-preflight.test.ts` | ✅ |

**Total:** 1944 tests passing across all code paths.

---

## Key Decisions for Phase 2–4 Teams

### Decision 1: Phase Dependency Enforcement

**Rule:** No phase may start until the previous phase's acceptance criteria are verified.

```
Phase 1 (d131a765) → Phase 2 (971f07a8) → Phase 3 (f2ef419a) → Phase 4 (7b22c1cc)
```

**Rationale:** 
- Phase 2 (tunable thresholds) must know which thresholds Phase 3 will expose.
- Phase 3 (Prometheus) must know the threshold values to export as gauges.
- Phase 4 (e2e tests) must validate the full chain from preflight → alert → metrics.

**Implementation:** Mark each task `blocked_by: <previous_task_id>` in the task system.

---

### Decision 2: Hardcoded Thresholds Must Change Before Prometheus

**Current state:** `lm-studio-alerting.ts` uses module-level constants:
- `LATENCY_WARN_MS = 1_000`
- `LATENCY_CRIT_MS = 3_000`

**Decision:** These must become environment-variable-based (`LMS_LATENCY_WARN_MS`, `LMS_LATENCY_CRIT_MS`) **before** Prometheus export.

**Rationale:** Prometheus will expose the threshold values as gauges (`lm_studio_latency_warn_threshold_ms`, `lm_studio_latency_crit_threshold_ms`). If thresholds are hardcoded, the exposed values won't match the configured values unless read at module load time from env vars.

**Implementation:** Phase 2 must:
1. Read thresholds from env vars with defaults
2. Validate at parse time (positive integers, warn < crit, fallback to defaults on error)
3. Pass resolved values through to `evaluateAndAlert()`

---

### Decision 3: `/metrics` Endpoint Security

**Decision:** Default to `127.0.0.1` restriction unless `METRICS_PUBLIC=true`.

**Rationale:** Standard Prometheus convention is unauthenticated scrape endpoint. However, lobs-core may be exposed externally. Restricting to localhost by default prevents accidental exposure while allowing opt-in for public dashboards.

**Implementation:** Add middleware that:
- Default: allow only `127.0.0.1` connections
- If `METRICS_PUBLIC=true` env var: allow all IPs
- Log access attempt with IP and authorization decision

---

### Decision 4: Phase 1 Must Be Closed Before Phase 2

**Task `d131a765` (Verify & Close Preflight Wiring)** must be completed before Phase 2 starts.

**Acceptance criteria:**
1. Read `control-loop.ts` lines ~1450–1470 and ~2215–2230
2. Confirm `checkModelsBeforeSpawn` exists in both spawn paths
3. Run `tests/spawn-lmstudio-preflight.test.ts` — all tests pass
4. Update task `d131a765` status → `completed`

**Why:** All downstream phases assume the preflight is production-wired. If not verified, Phase 2's tunable thresholds will be applied to a path that may not actually call them.

---

## Related Artifacts

| Artifact | Path |
|----------|------|
| Epic doc | `docs/epics/lm-studio-monitoring-epic.md` |
| Learnings (this doc) | `docs/epics/lm-studio-monitoring-learnings.md` |
| Preflight diagnostic | `src/diagnostics/lmstudio.ts` |
| Alert rules | `src/diagnostics/lm-studio-alerting.ts` |
| Cron monitor | `src/services/lm-studio-monitor.ts` |
| ADR | `docs/decisions/ADR-lmstudio-model-diagnostic.md` |
| Session startup runbook | `docs/runbooks/session-startup-checklist.md` |

---

## Appendix: Gap Analysis from Failed Attempt

```
- ✅ Phase 1 (Health/Preflight): Built & wired in control-loop + CLI
- ✅ Phase 2 (Alerting): Built & tested
- ❌ Phases 3-4: Not yet implemented

Observation: The code and tests existed but were not organized into an epic.
The agent could see what was built but lacked a container to document the
remaining work. Solution: Create epic doc first, then populate task registry.
```

**Lesson:** Always document the epic structure **before** assigning tasks. The epic doc serves as:
- The "source of truth" for sequencing
- The acceptance criteria anchor
- The cross-reference map for all artifacts

---

## Appendix: Code Paths to Verify for Phase 1 Closure

```typescript
// src/orchestrator/control-loop.ts:~1460
if (process.spawnMethod === 'native') {
  const result = await checkModelsBeforeSpawn(...);  // ✅ Wired
  if (!result.pass) {
    return { error: result.error || 'preflight failed' };
  }
}

// src/hooks/restart-continuation.ts:~74
if (!result.continuation) {
  const result = await checkModelsBeforeSpawn(...);  // ✅ Wired
  if (!result.pass) {
    return { error: result.error };
  }
}
```

**Action:** Read these exact lines, confirm both paths are present, run tests, close task.
