# Audit: Stale API References After Gateway Decoupling

**Date:** 2026-03-17  
**Trigger:** Gateway decoupling on 2026-03-16 (OpenClaw → Trident). Post-mortem for the restart cascade noted drift was possible in other subsystems.  
**Scope:** `~/lobs/lobs-core`, `~/paw/lobs-sail/paw-plugin`, `~/paw/paw-plugin`, `~/paw/lobs-sets-sail/services/`, `~/paw/paw-hub`  
**Status:** Findings documented. Three tiers of severity identified.

---

## Background: What Changed

The 2026-03-16 decoupling replaced the **OpenClaw gateway** with **Trident** as the standalone agent runtime inside sail containers:

| Old (OpenClaw) | New (Trident) |
|---|---|
| Agent runtime lives in `openclaw-gateway` container | Agent runtime lives in `trident` container (lobs-sail) or lobs-core process |
| HTTP API: `POST /tools/invoke` with `{ tool, args, sessionKey }` | HTTP API: `GET/POST /api/paw/*` routes (tasks, agents, workers, etc.) |
| Config: `~/.openclaw/openclaw.json` (key: `gateway.port`, `gateway.auth.token`) | Config: `TRIDENT_DATA_DIR/config.json` + env vars (`TRIDENT_PORT`, `TRIDENT_AUTH_TOKEN`) |
| Sessions managed via `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_history` tools | Workers managed via `/api/paw/tasks` + orchestrator spawning `claude` subprocesses directly |
| Default port: **18789** | Default port: **4440** |

**Critical:** Trident has **no `/tools/invoke` endpoint**. It serves `/api/paw/*` (and the backward-compat alias `/paw/api/*` for paw-hub's proxy). Any code calling `/tools/invoke` against a Trident runtime will receive `404` silently.

---

## Severity Classification

| Severity | Meaning |
|---|---|
| 🔴 **Critical** | Active runtime path, calls will 404/fail silently in production |
| 🟡 **Medium** | Dead code in deployed containers, but misleads developers; causes confusion |
| 🟢 **Low / Info** | Tests, docs, or structural issues that don't cause runtime failures |

---

## 🔴 Critical: Active Runtime Failures

### 1. `paw-plugin` Workflow Callable — `inboxProcessThreads`

**File:** `~/paw/lobs-sail/paw-plugin/src/workflow/callables.ts:256`  
*(Identical in `~/paw/paw-plugin/src/workflow/callables.ts:256` and `~/paw/lobs-sets-sail/services/lobs-sail/paw-plugin/src/workflow/callables.ts:256`)*

```ts
fetch("http://127.0.0.1:" + gwPort + "/tools/invoke", {
  body: JSON.stringify({
    tool: "sessions_spawn",
    sessionKey: SINK_SESSION_KEY,
    args: { task: ..., mode: "run", ... },
  }),
});
```

**Problem:** This callable fires when the workflow engine hits an `inboxProcessThreads` step. In Trident-based sail containers, `/tools/invoke` doesn't exist — the call will 404, the promise will reject or be swallowed by the fire-and-forget pattern (no `await`), and **inbox processing will silently never happen.**

**Note on context:** `paw-plugin` runs as an OpenClaw plugin. The lobs-sail Dockerfile now packages Trident, not OpenClaw — so `paw-plugin` code in lobs-sail is _nominally_ dead code. But `~/paw/paw-plugin` is the live plugin that runs on the Lobs dev machine alongside OpenClaw, where `/tools/invoke` at port 18789 is still valid. Confirm: **is lobs-sail's `paw-plugin/` directory deployed at all, or only Trident?** If it's dead code in lobs-sail, severity drops to Medium.

---

### 2. `lobs-core` Workflow `callables.ts` — NOT affected (already updated)

`~/lobs/lobs-core/src/workflow/callables.ts` has been updated to use `executeSpawnAgent(...)` directly rather than calling `/tools/invoke`. ✅ This is the correct pattern post-decoupling.

---

### 3. `lobs-core` Services: `meeting-analysis.ts` and `youtube.ts`

**Files:**
- `~/lobs/lobs-core/src/services/meeting-analysis.ts:23`
- `~/lobs/lobs-core/src/services/youtube.ts:39,93`

Both define a local `gatewayInvoke()` helper that calls `http://127.0.0.1:${port}/tools/invoke` and reads config from `~/.openclaw/openclaw.json` via `OPENCLAW_CONFIG`.

```ts
// meeting-analysis.ts — each service defines its own duplicate gatewayCfg/gatewayInvoke
function gatewayCfg(): { port: number; token: string } {
  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${HOME}/.openclaw/openclaw.json`;
  // reads gateway.port and gateway.auth.token
}

async function gatewayInvoke(tool: string, args: Record<string, unknown>) {
  const r = await fetch(`http://127.0.0.1:${port}/tools/invoke`, ...);
}
```

**Problem (two issues):**

1. **Config path:** These still read from `openclaw.json`. If lobs-core is deployed in a Trident environment, the config key should instead be `TRIDENT_AUTH_TOKEN` / `TRIDENT_PORT` (or lobs-core's own `~/.lobs/lobs.json` `gateway.*` block). The openclaw.json path is the decoupled piece — if that file doesn't exist or has stale values, these calls will fail with "no gateway token" or connect to the wrong port.

2. **Duplication:** Three separate files (`projects.ts`, `meeting-analysis.ts`, `youtube.ts`) each define their own `gatewayCfg()` + `gatewayInvoke()` helper. These are copy-paste duplicates with slight variations. If the shared util ever gets updated, these stay stale.

**Runtime impact for lobs-core:** lobs-core runs alongside OpenClaw on the Lobs dev machine where `/tools/invoke` is valid. But if lobs-core is ever deployed standalone with Trident (per ADR-010 intent), these calls will fail.

---

### 4. `lobs-core` API: `projects.ts`, `tasks.ts`, `meetings.ts`, `youtube.ts`, `plugins.ts`

**Files with direct `/tools/invoke` calls to OpenClaw:**

| File | Line | Tool Called | Config Source |
|---|---|---|---|
| `src/api/projects.ts` | 29 | `sessions_spawn` | `getGatewayConfig()` |
| `src/api/tasks.ts` | 99 | `sessions_spawn` | local `cfg()` helper |
| `src/api/meetings.ts` | 145 | `sessions_spawn` | `getGatewayConfig()` |
| `src/api/youtube.ts` | 75, 93 | `sessions_spawn` | local helper |
| `src/api/plugins.ts` | 180 | `sessions_spawn` | `getGatewayConfig()` |

All are using the `sessions_spawn` tool — spawning a one-shot session to analyze content. These are correct for the current lobs-core + OpenClaw deployment. However:

- **`src/api/plugins.ts`** has its `callModel()` function using `sessions_spawn` for inline AI calls. If openclaw.json doesn't have a valid token, the call fails with no error propagated to the client (returns empty string).
- **`src/api/youtube.ts`** has TWO spawn calls — one for the main transcript analysis and one for the highlight reel summary. If either 404s, it logs nothing useful.

---

### 5. `lobs-core` `index.ts` — `invokeGatewayTool`

**File:** `~/lobs/lobs-core/src/index.ts:307,411`

Two usages of `invokeGatewayTool()` (defined at line ~350):

```ts
async function invokeGatewayTool(tool: string, args: Record<string, unknown>) {
  const resp = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, ...);
}
```

Used for:
1. `isSessionAliveNow(sessionKey)` — calls `sessions_list` to verify a session is live before restart-continuation
2. `sessions_send` — sends a resume message to the orchestrator session after restart

**Problem:** If `openclaw.json` is missing or the gateway token is stale, `isSessionAliveNow` returns `false` (fail-open), which causes the restart-continuation to **not send the resume prompt** to the main session — the orchestrator won't know it should pick up work after a restart. This is likely a contributor to the March 16 restart cascade where the orchestrator stalled after restarts.

---

### 6. `lobs-core` Hooks: `restart-continuation.ts` and `subagent.ts`

**Files:**
- `~/lobs/lobs-core/src/hooks/restart-continuation.ts:63` — `sessions_send`
- `~/lobs/lobs-core/src/hooks/subagent.ts:357` — `sessions_list`

Both call `/tools/invoke`. Same issue as #5 above — these are the runtime hooks that fire on gateway start. If the token is missing/stale, `sessions_send` silently fails (the hook swallows the error), and the orchestrator is never nudged to resume.

---

### 7. `lobs-core` Orchestrator: `triage.ts`

**File:** `~/lobs/lobs-core/src/orchestrator/triage.ts:55,201`

Two calls:
- Line 55: `sessions_spawn` — spawns a session to run triage analysis on a task
- Line 201: `sessions_history` — fetches worker output from session transcript

```ts
const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
  body: JSON.stringify({ tool: "sessions_history", sessionKey: ..., args: {...} }),
});
```

**Problem:** `sessions_history` is an OpenClaw-specific tool. Trident has no session history concept — workers write to stdout which is captured directly. If triage is called in a Trident environment (which it won't be currently, since lobs-core still runs with OpenClaw), this would fail and `collectWorkerOutput` would return an empty string, causing triage to produce useless results.

---

## 🟡 Medium: Dead Code in Deployed Containers (Misleading)

### 8. `lobs-sail/paw-plugin` — Entire Plugin Layer

**Directory:** `~/paw/lobs-sail/paw-plugin/src/` (and identical copy in `~/paw/lobs-sets-sail/services/lobs-sail/paw-plugin/src/`)

The lobs-sail `Dockerfile` now packages **Trident** as the runtime — `paw-plugin` code is not loaded. The entire `paw-plugin/src/` directory in lobs-sail is dead code in the deployed container. This includes:

- `src/api/chat.ts:33` — `sessions_spawn` via `/tools/invoke`
- `src/api/tasks.ts:28` — `sessions_spawn` via `/tools/invoke`
- `src/hooks/restart-continuation.ts:63` — `sessions_send` via `/tools/invoke`
- `src/hooks/subagent.ts:262` — `sessions_list` via `/tools/invoke`
- `src/util/summarizer.ts:90,303` — `sessions_spawn` via `/tools/invoke`
- `src/orchestrator/control-loop.ts:933` — `sessions_spawn` via `/tools/invoke`
- `src/orchestrator/triage.ts:55,201` — `sessions_spawn` + `sessions_history` via `/tools/invoke`
- `src/workflow/callables.ts:256` — `sessions_spawn` via `/tools/invoke`

**These are 11 call sites that will never fire** in lobs-sail containers. However, they create developer confusion: contributors reading this code won't know it's dead, and might copy the pattern into active code.

**Recommended action:** Either delete `paw-plugin/` from lobs-sail, or add a prominent `DEPRECATED.md` + comment header to `index.ts` stating it's superseded by Trident.

---

### 9. `scheduler/jobs.ts` in `paw-plugin`

**File:** `~/paw/paw-plugin/src/scheduler/jobs.ts:263`

```ts
fetch("http://127.0.0.1:" + gwPort + "/tools/invoke", { ... });
```

Same pattern as callables.ts. This is `paw-plugin` which **does** run on the Lobs dev machine alongside OpenClaw, so `/tools/invoke` at port 18789 is valid there. Not a runtime issue for the current deployment. However, if/when paw-plugin is migrated to Trident, this will break silently.

---

## 🟢 Low / Info

### 10. `discord-router` `gateway-client.js`

**File:** `~/paw/lobs-sets-sail/services/discord-router/core/gateway-client.js:24`  
**Also:** `~/paw/discord-router/core/gateway-client.js:24`

```js
const url = `${gatewayUrl}/tools/invoke`;
```

The discord-router is a **separate service** that receives a `gateway_url` from paw-hub (stored in DB). The URL it calls is whatever URL paw-hub has stored for the client — pointing to the sail container's external port.

**The issue:** paw-hub stores `gateway_url` pointing to what used to be the OpenClaw gateway (which served `/tools/invoke`). Now that sail containers run Trident (no `/tools/invoke`), any message routed through discord-router → gateway-client will get a `404`.

**This is likely a live production issue** if any Discord-connected sail is running Trident. The discord-router needs to either:
- Call Trident's chat API (`POST /api/paw/chat/sessions/:key/message`) instead
- Or have Trident add a `/tools/invoke` compatibility shim for `sessions_spawn` and `sessions_send`

**Check:** Are any Discord-connected sails currently running Trident? If so, this is 🔴 Critical.

---

### 11. Config: `openclaw.json` vs `lobs.json` vs Trident env vars

Three different config schemas are in play across the codebase:

| Location | Config File | Keys Used |
|---|---|---|
| `lobs-core` (lobs machine) | `~/.lobs/lobs.json` | `gateway.port`, `gateway.auth.token` |
| `paw-plugin` / `lobs-sail` | `~/.openclaw/openclaw.json` (`OPENCLAW_CONFIG`) | `gateway.port`, `gateway.auth.token` |
| `trident` | `$TRIDENT_DATA_DIR/config.json` | `port`, `authToken` |

`lobs-core/src/config/lobs.ts` already abstracts this into `getGatewayConfig()` which reads from `lobs.json`. But `meeting-analysis.ts`, `youtube.ts`, and `paw-plugin/src/workflow/callables.ts` each define their own inline `gatewayCfg()` that reads `openclaw.json` directly — bypassing the abstraction.

**Risk:** When `openclaw.json` is absent (Trident-only deployment), these inline helpers silently fall back to port 18789 with no token, causing every call to fail with a 401 or connection refused.

---

### 12. Tests Asserting `/tools/invoke` Endpoint

**Files:**
- `~/paw/lobs-sail/paw-plugin/tests/api/chat.test.ts:202,210`
- `~/paw/lobs-sets-sail/services/lobs-sail/paw-plugin/tests/api/chat.test.ts:202,210`
- `~/paw/paw-plugin/tests/api/chat.test.ts:202,210`

Tests assert `url === "http://127.0.0.1:19999/tools/invoke"`. These tests will pass (they're testing dead code), but they reinforce the stale mental model.

---

## Summary Table

| # | File(s) | Issue | Severity | Currently Failing? |
|---|---|---|---|---|
| 1 | `paw-plugin/src/workflow/callables.ts` | `inboxProcessThreads` calls `/tools/invoke` (fire-and-forget) | 🔴 | Only if paw-plugin is live in Trident |
| 3 | `lobs-core/src/services/meeting-analysis.ts`, `youtube.ts` | Local `gatewayCfg()` reads `openclaw.json`, not `lobs.json` abstraction | 🔴 | If openclaw.json absent |
| 4 | `lobs-core/src/api/projects.ts,tasks.ts,meetings.ts,youtube.ts,plugins.ts` | `sessions_spawn` via `/tools/invoke` | 🔴 | In Trident env only |
| 5 | `lobs-core/src/index.ts` | `invokeGatewayTool` for restart-continuation | 🟡→🔴 | If token stale/missing |
| 6 | `lobs-core/src/hooks/restart-continuation.ts`, `subagent.ts` | `sessions_send/sessions_list` via `/tools/invoke` | 🔴 | If token stale/missing |
| 7 | `lobs-core/src/orchestrator/triage.ts` | `sessions_history` (OpenClaw-only tool) | 🟡 | Not in Trident yet |
| 8 | `lobs-sail/paw-plugin/src/**` (11 sites) | Dead code in Trident container | 🟡 | No — dead code |
| 9 | `paw-plugin/src/scheduler/jobs.ts` | `/tools/invoke` inline — valid now | 🟢 | No |
| 10 | `discord-router/core/gateway-client.js` | `/tools/invoke` on Trident = 404 | 🔴 | If any Discord sail uses Trident |
| 11 | `meeting-analysis.ts`, `youtube.ts`, `callables.ts` | Bypass `getGatewayConfig()`, inline `openclaw.json` reads | 🟡 | If openclaw.json absent |
| 12 | `tests/api/chat.test.ts` | Tests assert `/tools/invoke` URL | 🟢 | No — tests pass on dead code |

---

## Recommended Actions

### Immediate (before next deploy)

1. **Verify lobs-sail Dockerfile**: Confirm `paw-plugin/` is NOT loaded at runtime in Trident containers. If confirmed dead, annotate or remove to prevent future confusion.

2. **Check discord-router → trident compatibility**: If any Discord-connected sail is on Trident, the discord-router `gateway-client.js` will silently fail. Either add a `/tools/invoke` → Trident shim, or update `gateway-client.js` to call Trident's task API.

3. **Token staleness check**: `lobs-core/src/hooks/restart-continuation.ts` and `subagent.ts` fail silently when the gateway token is absent. Add a startup warning log if `getGatewayConfig().token` is empty — this would have surfaced the March 16 issue earlier.

### Short-term

4. **Deduplicate `gatewayInvoke` helpers**: `meeting-analysis.ts`, `youtube.ts`, and `projects.ts` all define local `gatewayCfg()` + `gatewayInvoke()`. Extract to a shared util (or use the existing `getGatewayConfig()` from `config/lobs.ts`). One function to update when the API changes next time.

5. **Add `sessions_history` fallback in `triage.ts`**: The `collectWorkerOutput` function currently depends on `sessions_history`. When lobs-core eventually moves to Trident-only, this will break. Add a DB-first fallback: read from `worker_runs.output` before attempting the gateway call.

6. **Config schema unification**: The three config schemas (`lobs.json`, `openclaw.json`, Trident env) create fragility. Consider a single `LOBS_GATEWAY_URL` + `LOBS_GATEWAY_TOKEN` env var pair that all components read, regardless of runtime — making the runtime swap transparent.

### Long-term (ADR-010 completion)

7. **Migrate active spawn sites to `executeSpawnAgent`**: `lobs-core/src/api/projects.ts`, `tasks.ts`, `meetings.ts`, `youtube.ts`, `plugins.ts` all call `sessions_spawn` via HTTP. As ADR-010 progresses toward self-contained agents, these should call `executeSpawnAgent()` directly (already done in `workflow/callables.ts`).

8. **Delete or archive `paw-plugin/src/` from lobs-sail**: Once Trident is confirmed stable, the OpenClaw plugin layer in `lobs-sail/paw-plugin/src/` should be removed. It's 3,000+ lines of code that will never execute and will mislead developers.

---

## Files NOT Affected (Verified Clean)

- `lobs-core/src/workflow/callables.ts` — ✅ Uses `executeSpawnAgent()` (updated in `e4b66ad`)
- `lobs-core/src/services/reflection.ts` — ✅ No gateway calls; reflection decoupled in same commit
- `lobs-core/src/api/reflections.ts` — ✅ Pure DB reads/writes
- `lobs-core/src/orchestrator/control-loop.ts` — ✅ Still uses `/tools/invoke` intentionally (lobs-core + OpenClaw deployment)
- `paw-hub/server.js` — ✅ Proxies `/paw/api/*` → Trident's backward-compat path; no `/tools/invoke`
- `trident/src/**` — ✅ Source of truth; no self-referential gateway calls
