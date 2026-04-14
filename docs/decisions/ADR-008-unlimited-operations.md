# ADR-008: Unlimited Operations — Removing Cost Constraints from Agent Behavior

**Date:** 2026-04-14
**Status:** Proposed
**Decision:** Shift from cost-constrained to impact-constrained agent operations

## Context

Lobs has historically operated under per-token cost pressure. Every subagent spawn, cron job, and heartbeat cycle had a real dollar cost that shaped system behavior — conservative spawning, limited cron jobs, monitoring-only heartbeats, and a general posture of "do less to spend less."

This has changed. We now use a **MiniMax subscription** for all tiers except micro (local Qwen, free) and strong (opencode-go, per-token). The subscription covers essentially unlimited usage for standard, small, and medium tiers, which account for ~95% of all agent work.

### Current Cost Profile (Last 30 Days)

| Agent Type | Model | Runs | Tracked Cost | Actual Cost |
|------------|-------|------|-------------|-------------|
| programmer | claude-sonnet-4-6 | 174 | $296.36 | ~$0 (subscription) |
| architect | claude-opus-4-6 | 11 | $57.77 | Per-token (opencode-go) |
| researcher | claude-sonnet-4-6 | 91 | $3.60 | ~$0 (subscription) |
| writer | claude-sonnet-4-6 | 3 | $1.12 | ~$0 (subscription) |
| main | claude-haiku-4-5 | 2 | $4.76 | ~$0 (subscription) |
| programmer | qwen-3.5-9b (local) | 31 | $0.00 | $0 |
| **Total** | | **312** | **$363.61** | **~$57.77** |

The only real marginal cost is the **strong tier (Opus via opencode-go)** at ~$5.25/run. Everything else is subscription-covered.

## Decision

Remove all cost-motivated throttling. Replace the constraint "can we afford this?" with "is this valuable enough to run?" The operating model shifts from **conservative execution** to **aggressive autonomous operation**.

## Changes

### 1. Model Cost Configuration

Update `models.json` cost data to reflect subscription reality. Standard/small/medium tier models should have cost set to 0 (or near-zero) since they're subscription-covered. This ensures cost tracking and fallback logic make decisions based on actual spend, not tracked spend.

**File:** `~/.lobs/config/models.json`

### 2. Continuous Work System

The heartbeat currently monitors — it should **work**. Every heartbeat cycle (30 min) should evaluate the backlog and spawn 1-2 workers on active tasks. The system should never be idle when there's work to do.

**Mechanism:** Add a "continuous worker" concept to the heartbeat loop:
- Check for active/inbox tasks with no recent worker runs
- Spawn appropriate agent types to tackle them
- Limit concurrent workers to avoid resource contention (suggest: max 3 concurrent)
- Workers auto-terminate on completion; new ones spawn next heartbeat

**Impact:** The agent system becomes a 24/7 autonomous workforce instead of a reactive tool that only runs when explicitly prompted.

### 3. Expanded Cron Jobs

Current crons are minimal (status/planning). Add proactive operational crons:

| Cron | Frequency | Purpose |
|------|-----------|---------|
| CI runner | Every 15 min | Run build + lint + typecheck on lobs-core, report failures |
| GitHub triage | Every 30 min | Auto-label new issues, detect stale PRs, respond to unassigned issues |
| Dependency monitor | Daily | Check for security vulnerabilities, outdated packages |
| Test runner | Every 30 min | Run test suites, auto-fix simple test failures |
| Memory compaction | Daily | Clean up stale memories, compress redundant entries |
| Repo health | Daily | Check for dead code, unused deps, documentation gaps |
| Cost audit | Weekly | Verify subscription usage, flag any unexpected direct API costs |

**Implementation:** New cron entries in the scheduler. Each cron run spawns the appropriate agent type with a scoped task prompt.

### 4. Aggressive Subagent Spawning

Remove self-imposed limits on parallel work:
- **Multiple parallel investigations** — 3 research agents looking at different angles? Do it.
- **Throw agents at minor issues** — don't batch tiny fixes; spawn a programmer per fix.
- **Reviewer on every PR** — automatic review agent for any PR we create.
- **Research agents for any question** — don't cache uncertainty; spawn a researcher immediately.

The only gating factor should be: "is there enough context for this agent to succeed?" not "does this cost too much?"

### 5. Strong Tier Policy

Opencode-go (strong/Opus) is the only tier with real marginal cost (~$5.25/run). Policy:

- **Use for:** Architecture decisions, complex multi-file refactors, high-stakes reviews, debugging that Sonnet failed on
- **Don't use for:** Routine coding, research, writing, simple fixes
- **Auto-escalation:** If a standard-tier worker fails 2+ times on the same task, escalate to strong
- **Budget alert:** Track opencode-go spend; alert Rafe if it exceeds $50/week

### 6. Fallback Chain Updates

Current fallback chains route through Anthropic directly as fallback. Update to prefer MiniMax subscription models first, only falling back to direct API if MiniMax is down:

```
programmer:  minimax/claude-sonnet → anthropic/claude-sonnet (emergency only)
architect:   opencode-go/claude-opus → minimax/claude-sonnet
researcher:  minimax/claude-sonnet → anthropic/claude-sonnet (emergency only)
writer:      minimax/claude-sonnet → anthropic/claude-sonnet (emergency only)
reviewer:    minimax/claude-sonnet → anthropic/claude-sonnet (emergency only)
inbox:       minimax/claude-haiku → anthropic/claude-haiku (emergency only)
```

### 7. HEARTBEAT.md Update

Update the heartbeat instructions to reflect the new operating mode:
- Remove "check if work is needed" language — work is always needed
- Add "spawn workers for backlog items" as a primary heartbeat action
- Add monitoring for stuck/failed workers and auto-retry logic
- Keep health checks but don't let them dominate the cycle

## What Doesn't Change

- **Strong tier still costs money.** We don't throw Opus at everything. The escalation policy applies.
- **Quality over quantity.** More agents doesn't mean lower standards for what they produce. Each worker still runs validation, linting, and type checking.
- **Resource limits.** Max 3 concurrent workers prevents system overload. This is a performance constraint, not a cost constraint.
- **Rafe's time.** More autonomous work means Rafe gets results, not noise. Output goes to repos and task tracking, not Discord spam.

## Success Metrics

- **Worker runs per week:** 312/month → target 500+/month
- **Active task velocity:** Tasks completed without Rafe involvement doubles
- **Actual spend:** Stays under $75/month (only opencode-go + any emergency API calls)
- **CI/regression catches:** Issues detected within 15 min of introduction
- **Zero idle heartbeats:** Every heartbeat cycle produces at least one action

## Implementation Order

1. **Models config update** — reflect subscription costs (immediate, no code change)
2. **HEARTBEAT.md rewrite** — new operating posture (immediate, config change)
3. **Continuous worker system** — heartbeat spawns workers from backlog (code change)
4. **New cron jobs** — CI, GitHub triage, dependency monitor (code + config)
5. **Fallback chain update** — prefer minimax, direct API as emergency (config change)
6. **Strong tier escalation policy** — auto-escalation from standard (code change)
7. **Cost audit cron** — weekly spend verification (code + config)
