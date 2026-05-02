# ADR-0011 — Launchd Service Ownership

**Date:** 2026-05-01
**Status:** Accepted

## Context

Launchd services run on host machines with varying degrees of ownership clarity. When services go down or need maintenance, ambiguity about who owns what causes delays and hesitation. This ADR establishes explicit ownership boundaries.

## Decision

### Agent Ownership Boundaries

Each agent owns the launchd services that directly support their operation:

| Agent | Services |
|-------|----------|
| **Lobs** | `com.lobs.memory`, `com.lobs.core` (the Discord bot process), `com.cloudflare.lobs-lab-tunnel`, `com.lobs.briggs`, `com.lobs.lena`, `com.lobs.sam` |
| **Virt** | `com.virt.orchestrator`, `com.virt.agent.main` |

### External Services

| Service | Ownership | Notes |
|---------|-----------|-------|
| `com.paw.snapshot` | Marcus | PAW-prefixed but predates current setup |
| `com.paw.langfuse-sync` | Marcus | PAW-prefixed but predates current setup |
| `com.lobs.sentinel` | Rafe | Sentinel is Rafe's alerting/monitoring |
| `com.paw.*` (unlisted) | Check with Marcus | Some PAW-prefixed services predate current org |

### Cloudflare Tunnel

`com.cloudflare.lobs-lab-tunnel` provides the public tunnel to `lobs.lobslab.ai`. This is a shared infrastructure service — both Lobs and Rafe depend on it. Decision needed on whether it should be:
- **Lobs-owned** (current state) — Lobs manages and restarts it
- **Rafe-owned** — Rafe owns it as core infrastructure
- **Shared** — both agents monitor it and either can restart

## Consequences

- Agents stop hesitating about restarting services they own
- No agent touches another agent's launchd services without explicit direction
- Service ownership questions get resolved at handoff time, not during incidents

## Review

Revisit if new services are added or if agent deployments change.
