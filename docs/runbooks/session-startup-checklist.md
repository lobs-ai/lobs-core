# Session Startup Checklist

**When to run:** At the start of every work session, before spawning any local agents.  
**One command:** `lobs preflight`

---

## Quick Start

```bash
lobs preflight
```

This runs the full two-phase check and exits `0` (ready) or `1` (action needed).

---

## What `lobs preflight` Checks

### Phase 1 — System Health

| Check | Pass | Fail action |
|-------|------|-------------|
| lobs-core reachable | `✓` | `lobs start` then retry |
| Database | `✓ ok` | Check `~/.lobs/lobs.db`, disk space |
| Memory server | `✓ ok` | Will auto-restart; warn if restarts > 3 |
| LM Studio reachable | `✓ reachable` | See [LM Studio not reachable](#lm-studio-not-reachable) |

If LM Studio is unreachable, Phase 2 is skipped and the command exits `1`.

### Phase 2 — LM Studio Model Availability

Runs [`src/diagnostics/lmstudio.ts`](../../src/diagnostics/lmstudio.ts) which:

1. Scans all local model IDs referenced in `config/models.ts` (tiers, agents, local block)
2. Calls `GET /v1/models` on LM Studio to list loaded models
3. Reports any models that are **missing** (configured but not loaded)
4. Reports any models that are **loaded but unconfigured** (informational)

**Exit `0`:** All referenced models are loaded — safe to spawn local agents.  
**Exit `1`:** One or more models missing — load them in LM Studio before spawning.

---

## Individual Commands

When you need to check a specific thing without the full preflight:

```bash
# System health only (quick, no model scan)
lobs health

# Model availability only (assumes LM Studio is up)
lobs models

# Raw API (for scripts / paw-hub)
curl http://localhost:3456/api/health
curl http://localhost:3456/api/lm-studio
curl http://localhost:3456/api/lm-studio/models
curl http://localhost:3456/api/lm-studio/latency
```

---

## Cross-Links Between Tools

```
lobs health
  └─ lm_studio: "down"?
       └─► Surfaces: lobs preflight, lobs models, GET /api/lm-studio

lobs preflight
  ├─► Phase 1: GET /api/health              (system health)
  └─► Phase 2: runLmStudioDiagnostic()      (src/diagnostics/lmstudio.ts)

GET /api/health
  └─ lm_studio: "down"?
       └─► Response includes lm_studio_diagnostic.api + .cli links

GET /api/lm-studio
  └─► Full diagnostic JSON (same data as lobs models, machine-readable)
```

---

## Troubleshooting

### lobs-core unreachable
```bash
lobs start
lobs preflight
```

### LM Studio not reachable
1. Open LM Studio app
2. Start the local server (default port 1234)
3. Load at least one model
4. `lobs preflight` — recheck

### Model missing (preflight Phase 2 fails)
1. Open LM Studio → load the missing model shown in the report
2. `lobs preflight` — confirm it now shows as loaded
3. Or update `config/models.ts` to point to a model you have loaded

### Health check shows LM Studio down but preflight passes
This can happen if health check fires between model loads.  
`lobs preflight` is authoritative — it directly queries LM Studio's `/v1/models`.

---

## For Remote Callers (paw-hub, Nexus, CI)

The API health response includes diagnostic cross-links when LM Studio is down:

```json
{
  "lm_studio": "down",
  "lm_studio_diagnostic": {
    "hint": "LM Studio appears unreachable. Run `lobs preflight` or query the diagnostic API for details.",
    "api": {
      "status":  "/api/lm-studio",
      "models":  "/api/lm-studio/models",
      "latency": "/api/lm-studio/latency"
    },
    "cli": "lobs preflight"
  }
}
```

Use `lm_studio_diagnostic.api.models` to fetch the full model report programmatically.

> **✅ spawn_agent preflight integration is complete (2026-03-17).**  
> `processSpawnWithRunner` in `control-loop.ts` calls `checkModelsBeforeSpawn()` after model  
> selection on every spawn. Local-model spawns are blocked with a structured error when  
> LM Studio is unreachable or the required model is not loaded.  
> `lobs preflight` remains the recommended session-start gate for human operators.

---

## Related Docs

- [ADR: LM Studio Model Availability Diagnostic](../decisions/ADR-lmstudio-model-diagnostic.md)
- [`src/diagnostics/lmstudio.ts`](../../src/diagnostics/lmstudio.ts) — diagnostic engine
- [`src/api/lm-studio.ts`](../../src/api/lm-studio.ts) — HTTP API handler
- [`src/api/health.ts`](../../src/api/health.ts) — health endpoint (includes cross-links when LM Studio down)
- [`src/cli/lobs.ts`](../../src/cli/lobs.ts) — `lobs preflight`, `lobs health`, `lobs models`
