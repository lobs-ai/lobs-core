# Design: Task Worker Session Resumption

**Date:** 2026-03-23
**Status:** Proposed
**Priority:** P1 — every restart loses 100% of in-flight task worker progress
**Related:** [Orphaned Session Recovery](./orphaned-session-recovery.md), `restart-continuation.ts`, AI-10 (session checkpoint/resume)
**Scope:** `agent-loop.ts`, `session-transcript.ts`, `control-loop.ts`, `restart-continuation.ts`

---

## Problem Statement

When lobs-core restarts, all in-flight task workers lose their progress:

1. `restart-continuation.ts` marks all open `worker_runs` as failed (`orphaned on restart`)
2. Tasks reset from `running` → `active`
3. The scanner picks them up, spawns fresh workers that start from scratch
4. All LLM turns, tool outputs, and partial work are discarded

This wastes tokens, time, and money. A worker 12 turns into a 15-turn task restarts at turn 0.

**The irony:** all the data needed to resume already exists. `SessionTranscript` writes every turn's full message array to JSONL. `AgentSpec` already has `resumeMessages` and `runId` fields (added in a previous pass). They're just not wired up.

---

## Current Flow (What Happens Today)

```
restart-continuation.ts (gateway_start hook, +2s delay):
  1. UPDATE worker_runs SET ended_at=now, succeeded=0, timeout_reason='orphaned on restart'
  2. UPDATE tasks SET crash_count += 1 WHERE work_state='in_progress'
  3. UPDATE agent_status SET status='idle'
  4. UPDATE tasks SET status='active' WHERE status='running'

Scanner (next tick, ~10s later):
  → finds active tasks with work_state != 'done'
  → spawns fresh workflow run → processSpawnWithRunner
  → runAgent starts with messages=[{role:"user", content: taskPrompt}]
  → all prior progress lost
```

---

## Proposed Flow (After This Change)

```
restart-continuation.ts (gateway_start hook, +2s delay):
  1. UPDATE worker_runs SET ended_at=now, succeeded=0, timeout_reason='orphaned on restart'
  2. UPDATE tasks SET crash_count += 1 WHERE work_state='in_progress'
  3. UPDATE agent_status SET status='idle'
  4. UPDATE tasks SET status='active' WHERE status='running'
  ↑ NO CHANGE — orphaned runs are still recorded for audit/metrics

processSpawnWithRunner (when scanner re-spawns the task):
  1. Query: find the most recent worker_run for this taskId
     WHERE timeout_reason = 'orphaned on restart' AND ended_at > (now - 2h)
  2. If found: load its JSONL transcript → extract last turn's messages
  3. Compact the messages (they may be huge after many turns)
  4. Pass to runAgent as resumeMessages + runId (to append to same JSONL)

runAgent (agent-loop.ts):
  1. If spec.resumeMessages exists:
     → messages = [...spec.resumeMessages, resumeSystemMessage]
     → DON'T prepend {role:"user", content: spec.task}
  2. If spec.runId exists:
     → use it instead of generating random hex
  3. Everything else unchanged — loop continues normally
```

---

## Detailed Changes

### 1. `SessionTranscript.loadLastTurnMessages()` — New Static Method

**File:** `src/runner/session-transcript.ts`

```typescript
/**
 * Load the messages array from the last turn of a session transcript.
 * This is the full conversation history at the point of interruption.
 * Returns null if the file doesn't exist, is empty, or is corrupt.
 */
static loadLastTurnMessages(agentType: string, runId: string): LLMMessage[] | null {
  const homeDir = process.env.HOME ?? "";
  const sessionPath = `${homeDir}/.lobs/agents/${agentType}/sessions/${runId}.jsonl`;

  if (!existsSync(sessionPath)) return null;

  const content = readFileSync(sessionPath, "utf-8");
  const lines = content.trim().split("\n").filter(l => l.length > 0);

  // Walk backwards to find the last non-summary turn
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]);
      if (record.type === "summary") continue;
      if (record.messages && Array.isArray(record.messages)) {
        return record.messages as LLMMessage[];
      }
    } catch {
      continue; // skip corrupt lines
    }
  }
  return null;
}
```

**Why a dedicated method?** `load()` returns ALL turns (potentially huge). We only need the last turn's `messages` snapshot, which already contains the full accumulated conversation.

**Why not read the response too?** The last turn's `messages` field is the snapshot *before* the LLM call for that turn. We also need the assistant's response from that turn. The method should actually reconstruct the full messages by appending the response:

```typescript
static loadLastTurnMessages(agentType: string, runId: string): LLMMessage[] | null {
  // ... find last non-summary turn as above ...
  if (record.messages && record.response) {
    const messages = [...record.messages] as LLMMessage[];
    // Append the assistant's response from this turn
    messages.push({
      role: "assistant",
      content: record.response.content,
    });
    // If the response had tool_use, we also need the tool results
    // that would have been the next user message. Check the NEXT line.
    // But if this was the last turn, there are no tool results — the
    // process died before the next iteration.
    return messages;
  }
}
```

**Edge case — last turn was tool_use:** If the LLM requested tool calls and the process died before executing them, the messages will end with an assistant message containing tool_use blocks but no matching tool_result. We must handle this:

- **Option A:** Strip the trailing assistant tool_use message and resume from the user's prior state. The LLM will re-decide what tools to call.
- **Option B:** Let the resume system message explain that tool calls were interrupted and the LLM should re-plan.

**Recommendation: Option A.** Sending tool_use blocks without matching tool_results violates the Anthropic API contract and will error. Strip the trailing assistant message if it contains tool_use blocks.

```typescript
// After building messages array:
const lastMsg = messages[messages.length - 1];
if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
  const hasToolUse = lastMsg.content.some(
    (b: Record<string, unknown>) => b.type === "tool_use"
  );
  if (hasToolUse) {
    messages.pop(); // Remove incomplete tool_use turn
  }
}
```

### 2. `runAgent` — Honor `resumeMessages` and `runId`

**File:** `src/runner/agent-loop.ts`

Two changes in `runAgent()`:

**A. Use `runId` from spec:**
```typescript
// CURRENT:
const runId = spec.context?.taskId ?? randomBytes(8).toString("hex");

// NEW:
const runId = spec.runId ?? spec.context?.taskId ?? randomBytes(8).toString("hex");
```

**B. Use `resumeMessages` for initial message history:**
```typescript
// CURRENT:
const messages: LLMMessage[] = [
  { role: "user", content: spec.task },
];

// NEW:
let messages: LLMMessage[];
if (spec.resumeMessages && spec.resumeMessages.length > 0) {
  messages = [...spec.resumeMessages];
  // Inject a system-level resume notice as the last user message
  messages.push({
    role: "user",
    content: [{ type: "text", text:
      "[System] The previous session was interrupted by a process restart. " +
      "Your conversation history has been restored. Continue from where you left off. " +
      "Do NOT repeat work you've already completed — check the state of files and tests first."
    }],
  });
} else {
  messages = [{ role: "user", content: spec.task }];
}
```

**Why a user message, not a system prompt modification?** The system prompt is built separately (via `buildSmartSystemPrompt` or `buildSystemPrompt`). Injecting into it would require plumbing through the prompt builder. A user message at the end of the restored history is simpler and equally effective — the LLM sees the full history followed by "continue from where you left off."

**Why not use the `system` parameter?** System messages are cached (Anthropic prompt caching). Changing the system prompt on resume would invalidate the cache for the restored conversation, making prompt caching useless. Keeping the system prompt identical maximizes cache hits.

### 3. `processSpawnWithRunner` — Detect and Load Prior Session

**File:** `src/orchestrator/control-loop.ts`

After assembling the task prompt but *before* the `runAgent()` call, add a resumption check:

```typescript
// ── Session resumption check ──────────────────────────────────────
let resumeMessages: LLMMessage[] | undefined;
let resumeRunId: string | undefined;

if (taskId) {
  try {
    const priorRun = getRawDb().prepare(`
      SELECT id, worker_id, agent_type, started_at
      FROM worker_runs
      WHERE task_id = ?
        AND timeout_reason = 'orphaned on restart'
        AND ended_at > datetime('now', '-2 hours')
      ORDER BY started_at DESC
      LIMIT 1
    `).get(taskId) as { id: number; worker_id: string; agent_type: string; started_at: string } | undefined;

    if (priorRun) {
      // The runId used for SessionTranscript is: spec.context?.taskId ?? randomBytes(8).toString("hex")
      // In the current code, it falls through to randomBytes since taskId isn't passed via context.
      // Worker IDs are "native:{agentType}:{timestamp}" — not the JSONL filename.
      // The JSONL filename is the runId, which for task workers is taskId (if passed) or random hex.
      // We need to find the JSONL file. Since runId = context.taskId in the current code,
      // the JSONL is at ~/.lobs/agents/{agentType}/sessions/{taskId}.jsonl
      const transcriptRunId = taskId; // because runId = spec.context?.taskId in agent-loop
      
      const loaded = SessionTranscript.loadLastTurnMessages(
        priorRun.agent_type ?? req.agentType,
        transcriptRunId
      );

      if (loaded && loaded.length > 0) {
        resumeMessages = loaded;
        resumeRunId = transcriptRunId; // Reuse same runId → append to same JSONL
        log().info(
          `[NATIVE_RUNNER] Resuming task ${taskId.slice(0, 8)} from prior orphaned run ` +
          `(${loaded.length} messages, run_id=${transcriptRunId.slice(0, 8)})`
        );
      }
    }
  } catch (e) {
    log().warn(`[NATIVE_RUNNER] Session resumption check failed for task ${taskId?.slice(0, 8)}: ${e}`);
    // Fall through to fresh start — resumption is best-effort
  }
}
```

Then pass to `runAgent`:

```typescript
const result: AgentResult = await runAgent({
  task: fullPrompt,
  agent: req.agentType,
  model: runnerModel,
  cwd: repoPath,
  tools: ["exec", "read", "write", "edit", "memory_search", "memory_read", "memory_write", "spawn_agent", "run_pipeline"],
  timeout: 900,
  maxTurns: 200,
  context: { taskId, projectId },    // ← ADD: pass taskId so runId = taskId
  ...(resumeMessages ? { resumeMessages } : {}),
  ...(resumeRunId ? { runId: resumeRunId } : {}),
});
```

**Critical fix included:** The current `runAgent()` call in `processSpawnWithRunner` does NOT pass `context: { taskId }`. This means `runId = randomBytes(8).toString("hex")` — every run creates a new JSONL file with a random name, and there's no way to find it later. Passing `context: { taskId }` fixes this: the JSONL is always named `{taskId}.jsonl`, making resumption possible.

### 4. `SessionTranscript` — Handle Appending to Existing JSONL

**File:** `src/runner/session-transcript.ts`

Currently, `SessionTranscript` creates a new JSONL file via `appendFileSync`. This already works for resumption — `appendFileSync` doesn't truncate. But we should add a separator to make it clear where the resumed session begins:

```typescript
constructor(agentType: string, runId: string) {
  // ... existing code ...
  this.sessionPath = `${sessionsDir}/${runId}.jsonl`;
  this.markdownPath = `${sessionsDir}/${runId}.md`;
  
  // If the JSONL already exists, we're resuming — add a separator
  if (existsSync(this.sessionPath)) {
    const separator = JSON.stringify({
      type: "resume_marker",
      timestamp: new Date().toISOString(),
      note: "Session resumed after process restart",
    }) + "\n";
    appendFileSync(this.sessionPath, separator, "utf-8");
  }
}
```

The `load()` method should skip `resume_marker` entries (same as it skips `summary` entries):

```typescript
if (record.type !== "summary" && record.type !== "resume_marker") {
  turns.push(record as TurnRecord);
}
```

### 5. Context Compaction on Resume

**Not a separate change** — already handled. The existing `shouldCompact()` / `compactMessages()` logic in `runAgent` triggers when cumulative input tokens exceed 80% of the context window. When resuming with a large message history, this will naturally fire on the first LLM call and compact old tool outputs.

**However**, there's a subtlety: `usage.inputTokens` starts at 0 on resume, but the actual context is large. The compaction check uses cumulative `usage.inputTokens` from the response, so it'll correctly reflect the true size after the first API call. No change needed.

**Should we pre-compact before the first call?** Yes — if the prior session was already near the context limit, the first call will fail (or be very expensive) before compaction triggers. Add this in `runAgent`:

```typescript
if (spec.resumeMessages && spec.resumeMessages.length > 0) {
  // Pre-compact resumed messages to avoid exceeding context on first call
  const estimatedTokens = estimateTokens(messages);
  const contextLimit = getContextLimit(spec.model);
  if (estimatedTokens > contextLimit * 0.7) {
    const beforeCount = messages.length;
    const compacted = compactMessages(messages);
    messages.splice(0, messages.length, ...compacted);
    log().info(
      `[agent-loop] Pre-compacted resume messages: ${beforeCount} → ${messages.length} ` +
      `(est. ${estimatedTokens} tokens, limit=${contextLimit})`
    );
  }
}
```

---

## Decision: Message Compaction Strategy

**Question:** Should we use JSONL messages directly, or compact them first?

**Decision:** Use directly, but pre-compact if estimated tokens > 70% of context limit.

**Rationale:**
- Most task worker sessions are 5-20 turns. At ~1K tokens/turn, that's 5K-20K tokens — well within the 200K context window.
- Only long-running sessions (30+ turns with large tool outputs) risk context overflow.
- Pre-compaction is a safety net, not the common case.
- `compactMessages()` already preserves tool_use/tool_result pairing (critical for Anthropic API).

---

## Decision: Maximum Resumable Age

**Question:** Should there be a max age for resumable sessions?

**Decision:** 2 hours. `WHERE ended_at > datetime('now', '-2 hours')`

**Rationale:**
- Most restarts happen within seconds (deploy, crash recovery). 2 hours is generous.
- After 2 hours, the codebase may have changed significantly — resuming with stale context is more likely to cause confusion than save time.
- The 2-hour window is a SQL filter, zero cost when there's nothing to resume.
- This also prevents resuming from very old orphaned runs that were missed by cleanup.

---

## Decision: Resume Notification Message

**Question:** Should the resume inject a system message explaining the interruption?

**Decision:** Yes — as a `user` message (not system prompt modification).

**Content:**
```
[System] The previous session was interrupted by a process restart. Your conversation
history has been restored. Continue from where you left off. Do NOT repeat work you've
already completed — check the state of files and tests first.
```

**Rationale:**
- Without this, the LLM sees an abrupt end to the conversation and may not understand why it's being called again.
- "Check the state of files and tests" is critical — between the crash and resume, no code was undone, but the LLM doesn't know what tool calls completed vs. failed.
- As a user message (not system prompt change) it preserves prompt cache hits.

---

## Decision: RunId Fix

**Question:** The current `processSpawnWithRunner` doesn't pass `context.taskId`, so `runId = randomBytes(8).toString("hex")`. Should we fix this?

**Decision:** Yes — this is a prerequisite, not optional.

**Change:** Add `context: { taskId, projectId }` to the `runAgent()` call in `processSpawnWithRunner`.

**Consequence:** All future task worker JSONL files will be named `{taskId}.jsonl` instead of random hex. This enables:
- Session resumption (this feature)
- Audit: find the transcript for any task by ID
- Deduplication: multiple runs for the same task append to the same JSONL (with resume markers)

**Migration:** No migration needed. Old random-hex JSONLs remain on disk but are unreachable for resumption. The first run after this change creates `{taskId}.jsonl`.

---

## Failure Modes

### JSONL file doesn't exist
**Cause:** First run, or runId was random hex (pre-fix).
**Handling:** `loadLastTurnMessages` returns null → fresh start. No regression.

### JSONL file is corrupt (partial JSON, encoding issue)
**Cause:** Process died mid-write.
**Handling:** `loadLastTurnMessages` walks backwards through lines, skipping corrupt ones via try/catch. If no valid turn found, returns null → fresh start.

### JSONL is from an incompatible schema version
**Cause:** Code change altered TurnRecord format.
**Handling:** The method checks for `record.messages` existence. If the field is missing or has unexpected shape, it returns null. Future-proof: we could add a `version` field to each turn, but YAGNI — the format hasn't changed yet.

### Messages are too large to fit in context
**Cause:** Long session with many large tool outputs.
**Handling:** Pre-compaction (see section 5). `compactMessages` truncates old tool outputs while preserving tool_use/tool_result pairing.

### Resumed agent re-does work
**Cause:** Agent doesn't check file state before acting.
**Handling:** The resume message explicitly says "check the state of files and tests first." This is a prompt-level mitigation. For stronger guarantees, the agent could diff the repo against the session transcript, but this is over-engineering for v1.

### Multiple rapid restarts
**Cause:** Deploy loop, crash loop.
**Handling:** Each restart creates a new orphaned run and resume marker in the JSONL. The `ORDER BY started_at DESC LIMIT 1` query always picks the most recent. The crash_count mechanism will eventually auto-block the task if too many crashes accumulate.

### Task was reassigned to a different agent type between restarts
**Cause:** Manual intervention (e.g., changed from programmer to architect).
**Handling:** The query matches `task_id`, not `agent_type`. `loadLastTurnMessages` uses the prior run's `agent_type` to find the JSONL. If the agent type changed, the JSONL path is different and won't be found → fresh start. This is correct behavior.

---

## Implementation Order

### Step 1: Fix runId (prerequisite, ~5 min)
Pass `context: { taskId, projectId }` to `runAgent()` in `processSpawnWithRunner`.
This is a one-line change that makes all subsequent steps possible.

### Step 2: `loadLastTurnMessages` (~20 min)
Add the static method to `SessionTranscript`. Unit test with:
- Valid JSONL with multiple turns → returns last turn's messages
- JSONL ending with summary → skips summary, returns last turn
- JSONL with corrupt last line → falls back to second-to-last turn
- Missing file → returns null
- Last turn has tool_use without results → strips trailing assistant message

### Step 3: Wire up `runAgent` resumption (~15 min)
- Honor `spec.runId` for transcript naming
- Use `spec.resumeMessages` for initial messages + inject resume notice
- Pre-compact if estimated tokens > 70% context limit

### Step 4: Resumption check in `processSpawnWithRunner` (~20 min)
- Query for recent orphaned run
- Load transcript
- Pass `resumeMessages` and `runId` to `runAgent`

### Step 5: Resume marker in `SessionTranscript` (~10 min)
- Write `resume_marker` entry when constructor finds existing JSONL
- Skip `resume_marker` in `load()` and `loadSummary()`

### Step 6: Integration test (~30 min)
- Spawn a task worker, let it run 3-4 turns
- Kill the process (simulate restart)
- Run restart cleanup
- Re-spawn the task
- Verify: resumes from prior messages, doesn't repeat early turns, produces correct output

---

## What This Does NOT Address

1. **Resuming tool executions mid-flight** — if a tool call (e.g., `exec` running tests for 60s) was in progress when the process died, the tool result is lost. The resume strips the incomplete tool_use and the LLM re-decides what to do. This is correct — the tool may have partially completed (e.g., wrote a file), and the LLM should assess current state.

2. **Resuming `currentCwd` tracking** — the agent loop tracks CWD changes via tool side-effects. On resume, `currentCwd` resets to `spec.cwd`. If the agent had `cd`'d to a subdirectory, it will need to re-navigate. Low impact — most agents work in the repo root.

3. **Resuming `loopDetector` state** — the loop detector's ring buffer is lost. On resume, the detector starts fresh. Acceptable — a resumed session is unlikely to immediately loop on the same pattern.

4. **Deduplicating cost tracking** — the resumed run's `usage` starts at zero, but the prior run's usage is recorded in its own `worker_run` row. Total cost for a task requires summing all its `worker_runs`. This is already how cost rollups work.

---

## Trade-offs

| Decision | Pro | Con |
|----------|-----|-----|
| Resume from JSONL (not DB) | Already written, no migration | JSONL could be on a different volume, disk space |
| 2-hour max age | Prevents stale resumes | Misses edge case of long outage + large session |
| Pre-compact at 70% | Prevents first-call failure | Throws away some context that might be useful |
| Strip trailing tool_use | API-safe, simple | LLM must re-decide tool calls (wasted ~1 turn) |
| User message (not system prompt) | Preserves prompt cache | Slightly less prominent than system-level |
| Append to same JSONL | Single audit trail per task | File grows unbounded over many resume cycles |

---

## Metrics / Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| Token waste on restart | 100% of in-flight sessions | ~5% (only the last interrupted turn's tokens) |
| Time to resume | Full re-run (5-15 min) | First LLM call within 10s of re-spawn |
| Resume success rate | N/A (no resumption) | > 90% of orphaned runs should resume successfully |
| False resume rate | N/A | 0% — never resume the wrong session for a task |
