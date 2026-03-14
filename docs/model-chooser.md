# Model Chooser — Architecture

> Source: `src/orchestrator/model-chooser.ts`, `src/orchestrator/model-health.ts`

## What It Is

The model chooser is the component responsible for selecting which LLM a PAW worker runs on. It converts a task's **model tier** (an abstract cost/quality level) into a concrete model string, then hands off to a circuit-breaker layer that skips any unhealthy models.

This indirection exists so callers never hardcode model strings — you set a tier on a task, and the chooser handles the rest, including fallbacks when a model is flapping.

---

## Tier Definitions

| Tier | Intent | Current model(s) |
|------|--------|-----------------|
| `micro` | Cheapest; fast, simple tasks | `claude-haiku-4-5` |
| `small` | Light reasoning, write tasks | `claude-sonnet-4-6` |
| `medium` | Balanced; review-level work | `claude-sonnet-4-6` |
| `standard` | Default for most workers | `claude-sonnet-4-6` |
| `strong` | Complex reasoning; architecture | `claude-opus-4-6` → `claude-sonnet-4-6` |

> Codex models (`openai-codex/*`) are explicitly stripped from all chains — never dispatched via PAW.

---

## Per-Agent Defaults

Each agent type has a **default tier** used when the task's `model_tier` field is blank:

| Agent | Default tier |
|-------|-------------|
| `programmer` | standard |
| `researcher` | standard |
| `writer` | small |
| `architect` | strong |
| `reviewer` | medium |
| `inbox-responder` | micro |

---

## How a Task Specifies Its Tier

Tasks carry a `model_tier` column in the DB. Set it at insert time:

```bash
sqlite3 ~/.lobs/plugins/paw/paw.db \
  "INSERT INTO tasks (id, title, status, agent, model_tier, ...) \
   VALUES (lower(hex(randomblob(16))), 'My task', 'active', 'programmer', 'standard', ...);"
```

Valid values: `micro` | `small` | `medium` | `standard` | `strong`. If absent or invalid, `resolveTaskTier()` falls back to the agent's default.

---

## Resolution at Spawn Time

The orchestrator calls `chooseModel(tier, agentType)` just before spawning a worker. Priority:

1. **lobs agent config** (`~/.lobs/lobs.json` → `agents.list[agentType].model.primary`) — used for all tiers except `micro`.
2. **Tier chain** (`TIER_MODELS[tier][0]`) — used when no agent config entry exists or tier is `micro`.

If the task has been **escalated** (retry count > 0), `escalationModel()` bumps the tier one step up the ladder: `micro → small → medium → standard → strong`.

---

## Fallback Chain & Circuit Breaker

After resolving the primary model, `buildFallbackChain()` constructs an ordered list:

1. **Agent config fallbacks** (`model.fallbacks[]` from `lobs.json`) — preferred.
2. **Hardcoded `AGENT_FALLBACK_CHAINS[agentType]`** — cross-tier defaults per role.
3. **Tier-level `TIER_MODELS[tier]`** — last resort.

`chooseHealthyModel(chain, agentType)` walks the chain and returns the first model whose circuit is **closed** or **half-open**. Circuit states:

- **closed** — healthy, dispatch normally.
- **open** — skip; tripped after 3 consecutive failures. Cooldown: 30 min → 1h → 3h → 12h (exponential).
- **half-open** — probe state after cooldown expires. One success → closed; one failure → open (timer reset).

If **all models in the chain are open**, the task is left queued and retried after the cooldown expires — no degraded dispatch.

---

## Manual Override

Circuit state can be pinned via the `model_health.manual_override` column:
- `force_open` — always skip this model.
- `force_closed` — always allow, even after failures.
- `null` — normal circuit logic applies.
