# ADR-010: lobs-core v2 — Self-Contained Agent System

**Status:** Accepted  
**Date:** 2026-03-13  
**Author:** Lobs + Rafe  

## Context

lobs-core currently depends on OpenClaw for several critical capabilities:
- Chat sessions (tried to call gateway `sessions_spawn`)
- Discord communication (all messages route through OpenClaw)
- Web search (requires Brave API key we don't have)
- Single API key per provider (no redundancy, no failover)
- Orchestrator is overengineered (22 files, 7,145 lines) and fragile

The goal: make lobs-core a fully self-contained, production-grade agent system. OpenClaw remains only as the chat interface layer for Rafe.

## Decision

### 1. OAuth Key Management — Sticky Assignment + Failover

**Problem:** Single key per provider. Key dies = all workers die. No prompt caching optimization.

**Design:**
```typescript
// Config format
interface ProviderKeyConfig {
  provider: string;
  keys: Array<{
    key: string;
    label?: string;        // e.g. "primary", "backup"
    healthy: boolean;       // tracked at runtime
    lastError?: string;
    lastUsed?: number;
  }>;
  strategy: "sticky-failover";  // Only strategy we support
}
```

**How it works:**
- Each worker session gets assigned a key index at start (based on hash of session ID or sequential assignment)
- That worker uses the SAME key for its entire lifetime (maximizes Anthropic prompt caching — same key = same cache partition)
- On auth error (401/403) or rate limit (429 with long retry-after): mark key unhealthy, failover to next healthy key
- Key health recovers after cooldown period (e.g. 60s for rate limits, manual for auth failures)
- If ALL keys are unhealthy: wait and retry with exponential backoff

**Files to modify:**
- `src/runner/providers.ts` — add key pool, sticky assignment, failover logic
- `src/config/models.ts` — add key array config
- `src/orchestrator/provider-health.ts` — integrate key health tracking

### 2. Browser-Based Web Search (Playwright)

**Problem:** `web_search` requires Brave API key (not configured). `web_fetch` uses Python Scrapling (heavy, unreliable).

**Design:**
- Add `playwright` as dependency
- Single shared browser instance (launched on first use, reused)
- `web_search` → navigates to Google/DuckDuckGo, extracts results from DOM
- `web_fetch` → navigates to URL, extracts content (handles JS-rendered pages)
- Browser pool: max 2 concurrent pages, queue additional requests

```typescript
// src/services/browser.ts
class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  
  async search(query: string, count?: number): Promise<SearchResult[]>
  async fetch(url: string, maxChars?: number): Promise<FetchResult>
  async shutdown(): void
}
```

**Search implementation:**
- Navigate to `https://www.google.com/search?q=${encodeURIComponent(query)}`
- Extract: `div.g` elements → title (h3), URL (a href), snippet (div.VwiC3b or similar)
- Fallback to DuckDuckGo HTML (`https://html.duckduckgo.com/html/?q=...`) if Google blocks
- Return `{title, url, snippet}[]`

**Files to create/modify:**
- `src/services/browser.ts` — new, browser lifecycle + search/fetch
- `src/runner/tools/web.ts` — rewrite to use browser service instead of Brave API
- Remove `src/runner/tools/web_fetch.py` (Python dependency eliminated)

### 3. Orchestrator Simplification

**Problem:** 22 files, 7,145 lines. Many features are theoretical/unused. Hard to debug.

**Current → Simplified mapping:**

| Keep (simplified) | Merge into | Remove |
|---|---|---|
| control-loop.ts | — | decomposer.ts |
| worker-manager.ts | — | parallel.ts |
| model-chooser.ts | — | pipeline.ts |
| scanner.ts | — | reflection.ts |
| triage.ts | — | escalation.ts (merge into control-loop) |
| budget-guard.ts | — | artifact-check.ts (merge into quality-gate) |
| git-manager.ts | — | |
| heartbeat.ts | — | |
| quality-gate.ts (absorbs artifact-check, post-success) | — | post-success-validator.ts |
| provider-health.ts (absorbs circuit-breaker, model-health) | — | circuit-breaker.ts |
| scheduler.ts (absorbs cron) | — | cron.ts |
| review-triggers.ts | — | model-health.ts |

**Target: 12 files, ~3,500 lines.**

**control-loop.ts simplification (2,009 → ~800 lines):**
- Remove: task decomposition logic, multi-step pipeline orchestration, parallel execution coordination
- Keep: scan → pick task → assign worker → monitor → handle result
- The loop should be readable in one sitting

**Key principle:** If a feature hasn't been used in production, remove it. We can add it back when actually needed.

### 4. Discord Bot (Self-Contained)

**Problem:** All Discord messages route through OpenClaw. lobs-core can't send messages independently.

**Design:**
- Use `discord.js` library (same as OpenClaw)
- Minimal bot: connect, listen for messages in configured channels, send messages
- NOT a full chat interface (OpenClaw handles that) — this is for:
  - Worker completion notifications
  - Alert/error notifications  
  - Slash commands for task management (`/task create`, `/status`)
  - Responding to @mentions in agent-work channels

```typescript
// src/services/discord.ts
class DiscordService {
  async connect(token: string): void
  async send(channelId: string, content: string): void
  async sendEmbed(channelId: string, embed: EmbedData): void
  onMessage(handler: (msg) => void): void
  async shutdown(): void
}
```

**Config:**
```json
{
  "discord": {
    "botToken": "...",
    "guildId": "...",
    "channels": {
      "alerts": "channel-id",
      "agentWork": "channel-id",
      "completions": "channel-id"
    }
  }
}
```

**Files to create:**
- `src/services/discord.ts` — bot connection, message handling
- `src/integrations/discord.ts` — higher-level: format notifications, handle commands

### 5. Skills System

**Problem:** Workers have raw tools (exec, files, memory, web) but no structured workflows.

**Design:**
- Skill = directory with `SKILL.md` + optional `scripts/`, `templates/`
- Skills loaded at startup from `~/.lobs/skills/` and `src/skills/` (built-in)
- Skill context injected into worker prompts when task matches skill tags

```typescript
interface Skill {
  name: string;
  description: string;
  tags: string[];           // e.g. ["git", "pr", "github"]
  instructions: string;     // Content of SKILL.md
  scripts?: string[];       // Paths to helper scripts
}
```

**Built-in skills to create:**
- `git-workflow` — branching, committing, PR creation patterns
- `test-runner` — run tests, interpret failures, fix and retry
- `code-review` — structured review checklist
- `research` — web search → synthesize → memo format

**Files to create:**
- `src/services/skills.ts` — skill loader, matcher
- `src/skills/` — built-in skill directories
- Modify `src/runner/prompt-builder.ts` — inject matched skills into context

## Implementation Order

All items are independent and can be parallelized:
1. **OAuth key management** — providers.ts changes (self-contained)
2. **Browser web search** — new service + tool rewrite (self-contained)
3. **Orchestrator simplification** — refactor (touches many files but no new deps)
4. **Discord bot** — new service (self-contained)
5. **Skills system** — new service + prompt builder changes (self-contained)

## Success Criteria
- [ ] Multiple API keys with sticky assignment, automatic failover on errors
- [ ] Web search works without any API key (browser-based)
- [ ] Orchestrator is <12 files, <4,000 lines, same functionality
- [ ] Discord bot sends worker completions independently
- [ ] At least 4 built-in skills loaded and used by workers
- [ ] All existing tests pass
- [ ] Build clean, no TypeScript errors
