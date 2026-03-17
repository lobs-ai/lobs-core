# ADR: LM Studio Model Availability Diagnostic

**Status:** Accepted  
**Date:** 2026-03-17

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

Pre-spawn guard inserted after spawn-count check, before `sessions_spawn` HTTP call:
- Calls `checkModelsBeforeSpawn(buildFallbackChain(model, ...))`
- On unreachable + local primary model → blocks spawn with `lmstudio_unreachable` error
- On missing model + LM Studio reachable → blocks spawn with `lmstudio_model_not_loaded` error + suggestions
- On diagnostic network/code error → fail-open (warns, proceeds)
- On cloud model spawn → skips entirely (fast path)

### `src/cli/lobs.ts`

`lobs models` command:
- Runs full `runLmStudioDiagnostic()` and formats output
- Exits 0 on ok, 1 on mismatches (CI/script-friendly)

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
