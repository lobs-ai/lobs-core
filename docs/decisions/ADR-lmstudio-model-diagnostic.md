# ADR: LM Studio Model Availability Diagnostic

**Status:** Implemented  
**Date:** 2026-03-17  
**Updated:** 2026-03-17 — native runner path wired, two diagnostic bugs fixed; preflight command + cross-links added

## Context

When lobs-core spawns a subagent using a local model (LM Studio), it calls the LM Studio
OpenAI-compatible API with a specific model ID. If that model ID doesn't match what's
currently loaded in LM Studio, the spawn fails silently or with a cryptic error like
`"No models loaded"` — at inference time, seconds or minutes after the spawn started.

Model IDs drift as LM Studio versions change (e.g. `qwen3.5-35b` → `qwen3.5-35b-mlx-instruct`).
This causes silent routing failures that are hard to diagnose.

## Decision

Add a **pre-spawn LM Studio availability diagnostic** that:

1. Queries `GET /v1/models` before any local-model agent spawn
2. Compares the selected model ID(s) against the loaded list using fuzzy matching
3. Blocks the spawn with a structured error (including ID-drift suggestions) if the model isn't loaded
4. Fails open on diagnostic infrastructure errors (never blocks spawns due to diagnostic failure)

Also expose a standalone `lobs models` CLI command for manual diagnostics.

## Implementation

### `src/diagnostics/lmstudio.ts`

Core module with:
- `extractLocalModelRefs()` — scans all local model IDs from `config/models.ts` tiers, agents, and local block
- `fetchLoadedModels(baseUrl)` — queries `/v1/models` with timeout, returns null on network error
- `findClosestMatch(configId, loadedIds)` — fuzzy matching (exact → contains → prefix, separator-normalized)
- `runLmStudioDiagnostic()` — full report for CLI use
- `checkModelsBeforeSpawn(modelIds)` — lightweight check for pre-spawn use

### `src/orchestrator/control-loop.ts`

Pre-spawn guard inserted after model selection, before context assembly and agent execution.
**Wired in both spawn paths:**

- **`processSpawnWithRunner`** (active — `USE_NATIVE_RUNNER=true`): guard runs after `chooseModel`,
  before `assembleContext`. Blocks with `writeSpawnResult(status="failed")` on failure.
- **`processSpawnRequest`** (legacy — kept for reference): same guard pattern.

Behaviour:
- Calls `checkModelsBeforeSpawn(buildFallbackChain(model, tier, agentType), { timeoutMs: 2500 })`
- On unreachable + local primary model → blocks spawn with `lmstudio_unreachable` error
- On missing model + LM Studio reachable → blocks spawn with `lmstudio_model_not_loaded` error + suggestions
- On diagnostic network/code error → fail-open (warns, proceeds)
- On cloud model spawn → skips entirely (fast path, no fetch)

**Bug fixes applied (2026-03-17):**
1. `isLocalModelId`: cloud IDs like `claude-3-5-sonnet-20241022` (no `/`) were mistakenly treated as local.
   Fixed by adding `CLOUD_PREFIXES` guard before the bare-ID fallback.
2. `checkModelsBeforeSpawn`: used exact normalization only — missed fuzzy near-matches (e.g. `qwen3.5-35b`
   with loaded `qwen3.5-35b-mlx-instruct`). Fixed by delegating to `findClosestMatch`.

**Session startup:** run `lobs preflight` at the start of every work session before spawning
local agents. This is the consolidated entry point:

1. Phase 1 — `GET /api/health`: checks DB, memory server, and LM Studio reachability
2. Phase 2 — `runLmStudioDiagnostic()`: full model-availability scan

When health reports `lm_studio: "down"`, the response now includes a `lm_studio_diagnostic`
object with API routes and CLI hints so callers (paw-hub, Nexus, CI) know where to go next.

See [docs/runbooks/session-startup-checklist.md](../runbooks/session-startup-checklist.md)
for the full runbook including troubleshooting steps.

The `processSpawnWithRunner` per-spawn preflight still fires automatically — `lobs preflight`
is the human-facing session-start gate, not a replacement for per-spawn checks.

### `src/cli/lobs.ts`

`lobs preflight` command (new — session startup gate):
- Phase 1: `GET /api/health` — checks DB, memory server, LM Studio reachability
- Phase 2: `runLmStudioDiagnostic()` — model-availability scan
- Exits 0 (ready) or 1 (action needed)

`lobs models` command (granular — model scan only):
- Runs full `runLmStudioDiagnostic()` and formats output
- Exits 0 on ok, 1 on mismatches (CI/script-friendly)

`lobs health` command (updated):
- When `lm_studio` is down, surfaces `lobs preflight`, `lobs models`, and `GET /api/lm-studio`

### `src/api/health.ts`

Health response cross-link (new):
- When `lm_studio: "down"`, response includes `lm_studio_diagnostic` with:
  - `hint` — human-readable message
  - `api.{status,models,latency}` — API routes for programmatic callers
  - `cli` — `"lobs preflight"` for human callers

## Fuzzy Matching Strategy

Model IDs are normalized by lowercasing and stripping `[-_.\s]`, then matched in priority order:

1. **Exact** — `phi-4-mini` == `phi-4-mini`
2. **Loaded contains config** — `qwen3.5-35b-mlx-instruct` contains `qwen3.5-35b` → match
3. **Config contains loaded** — `qwen3.5-35b-mlx-instruct-q4` contains `qwen3.5-35b-mlx-instruct` → match
4. **Shared prefix ≥ 6 chars** — last-resort prefix match

This handles the primary failure mode (LM Studio appends `-mlx`, `-instruct`, `-q4_k_m` suffixes).

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| LM Studio down, local model | Block spawn, clear error + `lobs models` hint |
| LM Studio down, cloud model | Skip check, proceed normally |
| Model not loaded, suggestion exists | Block spawn, error includes `→ suggestion` |
| Model not loaded, no suggestion | Block spawn, error lists loaded models |
| Diagnostic code throws | Fail-open, warn in log, proceed |
| No local models configured | Skip check entirely |

## Trade-offs

- **+** Catches model-ID drift before any inference call
- **+** Error messages are actionable (include suggestions and `lobs models` command)
- **+** Adds ~2.5s timeout check per spawn (acceptable; spawns are already async)
- **+** Fail-open design means diagnostic bugs can't block work
- **-** Adds one extra HTTP call per local spawn
- **-** Fuzzy matching has false-positive risk (mitigated by conservative thresholds)
