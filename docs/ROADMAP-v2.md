# lobs-core v2 Roadmap — Self-Contained Agent System

## Vision
lobs-core becomes a fully self-contained, production-grade agent system with zero dependency on lobs for any functionality. lobs remains the chat interface layer only.

## Priority 1: OAuth Key Management (Sticky + Failover)
**Why first:** Directly affects reliability and cost of every worker run.

- Support multiple API keys per provider (array in config)
- **Sticky assignment:** Each session/worker gets assigned a key and sticks with it (maximizes prompt caching)
- **Failover only:** Switch to next key only on auth failure (401/403/429 rate limit)
- **Key health tracking:** Track which keys are healthy, rate-limited, or dead
- Config format:
  ```json
  {
    "anthropic": {
      "keys": ["sk-ant-xxx", "sk-ant-yyy"],
      "strategy": "sticky-failover"
    }
  }
  ```

## Priority 2: Browser-Based Web Search
**Why:** Workers need web access. No API key dependency.

- Add Playwright as dependency
- Implement headless browser search (Google/DuckDuckGo)
- Extract results from DOM (titles, URLs, snippets)
- `web_search` tool uses browser, not Brave API
- `web_fetch` can also use Playwright for JS-heavy pages
- Browser instance pool (reuse across searches, don't launch per query)

## Priority 3: Orchestrator Simplification
**Why:** 22 files / 7,145 lines is overengineered. Hard to debug, hard to extend.

Current files to evaluate:
- `control-loop.ts` (2,009 lines) — **core, needs simplification**
- `worker-manager.ts` — **keep, simplify**
- `model-chooser.ts` — **keep**
- `scanner.ts` — **keep**
- `triage.ts` — **keep, simplify**
- `decomposer.ts` — probably unnecessary complexity
- `reflection.ts` — nice-to-have, not core
- `escalation.ts` — can merge into control-loop
- `parallel.ts` — rarely used?
- `pipeline.ts` — rarely used?
- `quality-gate.ts` — merge into post-success
- `post-success-validator.ts` — keep
- `review-triggers.ts` — keep
- `budget-guard.ts` — keep, simplify
- `circuit-breaker.ts` — merge into provider-health
- `model-health.ts` / `provider-health.ts` — merge into one
- `artifact-check.ts` — merge into post-success
- `cron.ts` / `scheduler.ts` — merge into one
- `heartbeat.ts` — keep
- `git-manager.ts` — keep

Target: ~8-10 files, ~3,000 lines. Same functionality, less indirection.

## Priority 4: Discord Bot
**Why:** Self-contained communication, not dependent on lobs.

- Study lobs's Discord implementation for patterns
- Implement in lobs-core directly
- Support: message send/receive, reactions, threads, embeds
- Route worker completions, alerts, etc. through own bot
- Config: bot token, guild ID, channel mappings

## Priority 5: Skills System
**Why:** Workers need structured capabilities beyond raw tools.

- Skill = directory with SKILL.md + scripts/templates
- Skills loaded at runtime, injected into worker context
- Examples: git workflow, PR creation, test runner, deploy
- Similar to lobs's skill system but simplified

## Implementation Order
1. OAuth key management (1-2 days)
2. Browser web search (1-2 days)  
3. Orchestrator simplification (3-5 days)
4. Discord bot (2-3 days)
5. Skills system (2-3 days)

## Non-Goals (for now)
- Replacing lobs for main chat (keep using it)
- Multi-user support
- Web UI auth
