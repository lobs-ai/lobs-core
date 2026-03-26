# ADR: Real-Time Action Judgment During Live Meetings

## Status: Proposed

## Context

During live voice meetings (via the RealtimeVoiceSession), Lobs hears conversation in real-time but currently lacks the ability to decide whether an action (file read, PR investigation, memory search, doc generation) should be executed **immediately** to advance the current conversation, or **queued** as a deferred action item for post-meeting processing.

Today, the system has two separate modes with no bridge between them:

1. **Voice tools (realtime-tools.ts)** — A curated set of tools (`search_memory`, `read_file`, `web_search`, `spawn_agent`, `write_note`) that execute as background tasks during voice, with results injected back into the conversation after the assistant finishes speaking. The OpenAI Realtime API model decides when to call these tools based on conversation turns.

2. **Meeting analysis (meeting-analysis.ts)** — A post-hoc batch process that runs AFTER a meeting ends, analyzing the full transcript to extract action items and create tasks/inbox items. This is purely retrospective — it never executes actions during the meeting.

The gap: during a live meeting, the conversation might benefit from Lobs looking something up, reading a file, or checking a PR *right now* — but it might also produce action items that should wait until after the meeting. There's no judgment layer to make this distinction.

## Decision

Implement a **two-layer action judgment system** that operates during live voice sessions:

### Layer 1: Real-Time Action Classifier (in the Realtime voice session)

Enhance the existing RealtimeVoiceSession system prompt (`realtime-context.ts`) with explicit **action judgment instructions** that teach the model to classify potential actions into two buckets:

- **Execute Now**: Actions that would directly answer a question being asked, resolve a dispute, provide context that changes the conversation direction, or unblock a discussion point.
- **Defer**: Actions that are "nice to have later", follow-up tasks, things to investigate after the meeting, or work items that emerged from discussion but don't need real-time results.

This leverages the existing tool infrastructure — the OpenAI Realtime model already decides when to call tools. We just need to add a `write_note` + structured deferred action pattern so the model has a clear path for "I recognize this needs doing, but not right now."

### Layer 2: Deferred Action Queue (new: `DeferredActionQueue`)

A lightweight service that:

1. Accepts deferred action items from the voice session via a new `defer_action` tool
2. Stores them in-memory during the meeting (with meeting ID association)
3. On meeting end, merges deferred items with the post-hoc meeting analysis
4. Creates tasks/inbox items from the merged set, deduplicating against items the analysis already extracted

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   RealtimeVoiceSession                          │
│                                                                 │
│  User speaks → OpenAI Realtime API → Model decides:             │
│                                                                 │
│  ┌──────────────┐     ┌────────────────┐                       │
│  │ Execute Now   │     │ Defer          │                       │
│  │               │     │                │                       │
│  │ search_memory │     │ defer_action   │                       │
│  │ read_file     │     │ (new tool)     │                       │
│  │ web_search    │     │                │                       │
│  │ spawn_agent   │     │ Stores in      │                       │
│  │               │     │ DeferredQueue  │                       │
│  └──────┬───────┘     └───────┬────────┘                       │
│         │                     │                                 │
│         ▼                     ▼                                 │
│  Background result      In-memory queue                         │
│  → inject into          (per meeting)                           │
│    conversation                                                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                         Meeting ends
                                │
                                ▼
                 ┌──────────────────────────┐
                 │  MeetingAnalysisService   │
                 │                           │
                 │  1. Analyze transcript    │
                 │  2. Extract action items  │
                 │  3. Merge with deferred   │
                 │     queue (deduplicate)   │
                 │  4. Create tasks/inbox    │
                 └──────────────────────────┘
```

### Components

#### 1. Enhanced System Prompt (realtime-context.ts)

Add action judgment guidance to the voice instructions:

```
## Action Judgment During Meetings

When you hear something that could be an action, decide:

EXECUTE NOW if:
- Someone asks a direct question you can answer with a tool ("what does that PR look like?", "what's in that file?")
- A factual dispute needs resolution ("I think we changed that last week" → search_memory)
- The discussion is blocked on information you can retrieve ("do we have a design doc for that?")
- Someone explicitly asks you to look something up

DEFER if:
- It's a task to do after the meeting ("we should refactor the auth module")
- It's a follow-up investigation ("we need to look into why CI is slow")
- It requires sustained work, not a quick lookup ("write a design doc for the new API")
- It emerged from discussion as a good idea but nobody needs the result right now
- It would take the conversation off-track to execute immediately

When deferring, use the defer_action tool with a clear description. Don't announce every deferral — just quietly log it. If someone explicitly asks you to write something down or remember something, use defer_action AND briefly acknowledge it.
```

#### 2. `defer_action` Tool (realtime-tools.ts)

New tool added to the voice tool set:

```typescript
export const deferActionTool = tool({
  name: "defer_action",
  description: "Queue an action item for after the meeting. Use this for tasks, investigations, or follow-ups that emerged from conversation but don't need immediate execution.",
  parameters: z.object({
    description: z.string().describe("Clear, actionable description of what needs to be done"),
    action_type: z.enum(["investigate", "implement", "write_doc", "review_pr", "research", "fix_bug", "other"])
      .describe("Category of the action"),
    priority: z.enum(["high", "medium", "low"]).describe("Urgency"),
    assignee: z.string().optional().describe("Who should do this (default: lobs)"),
    context: z.string().optional().describe("Brief context from the discussion that prompted this"),
  }),
  execute: async (params, runContext) => {
    // Store in DeferredActionQueue via context
    const queue = runContext?.context.deferredActionQueue;
    if (queue) {
      queue.add({
        description: params.description,
        actionType: params.action_type,
        priority: params.priority,
        assignee: params.assignee ?? "lobs",
        context: params.context,
        timestamp: Date.now(),
      });
    }
    return `Noted for after the meeting: ${params.description}`;
  },
});
```

#### 3. `DeferredActionQueue` (new file: `src/services/voice/deferred-action-queue.ts`)

```typescript
export interface DeferredAction {
  description: string;
  actionType: "investigate" | "implement" | "write_doc" | "review_pr" | "research" | "fix_bug" | "other";
  priority: "high" | "medium" | "low";
  assignee: string;
  context?: string;
  timestamp: number;
}

export class DeferredActionQueue {
  private actions: DeferredAction[] = [];
  private meetingId: string | null = null;

  setMeetingId(id: string): void { this.meetingId = id; }
  getMeetingId(): string | null { return this.meetingId; }

  add(action: DeferredAction): void {
    this.actions.push(action);
  }

  drain(): DeferredAction[] {
    const items = [...this.actions];
    this.actions = [];
    return items;
  }

  get length(): number { return this.actions.length; }
}
```

#### 4. Enhanced `MeetingAnalysisService` (meeting-analysis.ts)

Add a `mergeDeferred` method that accepts deferred actions and deduplicates against LLM-extracted action items:

```typescript
async analyzeWithDeferred(meetingId: string, deferredActions: DeferredAction[]): Promise<void> {
  // 1. Run normal analysis
  await this.analyze(meetingId);

  // 2. For each deferred action not already covered by analysis:
  //    - Create a meetingActionItem
  //    - Create a PAW task (if assignee is lobs)
  // Deduplication: skip if an existing action item for this meeting
  // has >80% token overlap with the deferred description
}
```

#### 5. VoiceSessionManager Integration (manager.ts)

Wire the queue into the session lifecycle:

- **On session start**: Create a `DeferredActionQueue` instance, pass it into the `RealtimeVoiceToolContext`
- **On session end**: Drain the queue, pass deferred actions to `MeetingAnalysisService.analyzeWithDeferred()`

### Data Flow

1. Meeting starts → `DeferredActionQueue` created, passed to `RealtimeVoiceSession` context
2. During meeting:
   - Model hears conversation
   - Direct questions → `search_memory`, `read_file`, etc. (execute now, results injected back)
   - Task ideas, follow-ups → `defer_action` (stored in queue, quick acknowledgment)
3. Meeting ends → transcript saved to DB
4. `MeetingAnalysisService.analyzeWithDeferred()` called with:
   - meetingId (for transcript-based analysis)
   - `queue.drain()` (real-time deferred items)
5. Analysis produces merged, deduplicated action items → tasks + inbox items created

## Consequences

### Positive
- **Conversation stays on track** — Lobs doesn't derail meetings by executing long-running tasks
- **Nothing gets lost** — deferred items are captured in real-time with conversation context
- **Better action items** — combining real-time intent capture with post-hoc analysis produces higher quality items than either alone
- **Minimal new infrastructure** — reuses existing tools, background result injection, and meeting analysis pipeline
- **Progressive enhancement** — the judgment is in the prompt, so it improves as models improve

### Negative
- **Judgment quality depends on model** — the OpenAI Realtime model may not always make the right execute-vs-defer call
- **No persistence during meeting** — deferred queue is in-memory; if the voice session crashes mid-meeting, deferred items are lost (mitigated: the post-hoc analysis still catches most items from transcript)
- **Deduplication is fuzzy** — comparing deferred items against LLM-extracted items requires semantic similarity, which may produce false positives/negatives

### Trade-offs
- Could have implemented this as a separate classifier service that evaluates every transcript segment, but that adds latency and complexity. The model-in-the-loop approach (prompt-guided judgment) is simpler and fast enough for voice conversation pace.
- Could persist deferred items to SQLite instead of in-memory, but the meeting session is short-lived and the post-hoc analysis is the backup. The complexity isn't worth it for v1.

## Alternatives Considered

### 1. Separate Classifier Pipeline
Run every transcript segment through a local classifier that outputs "execute/defer/ignore". Rejected because:
- Adds latency to the voice pipeline
- Requires training data for the classifier
- The Realtime model already has conversation context — a separate classifier would need it re-injected

### 2. Execute Everything, Let User Interrupt
Just execute all actions immediately and let the user say "not now" to stop them. Rejected because:
- Wastes API calls and compute on actions that weren't needed
- Creates noise — the model announcing results for things nobody asked about
- Doesn't capture deferred items at all

### 3. Defer Everything, Batch After Meeting
Never execute actions during meeting, just log everything for post-hoc processing. Rejected because:
- Misses the core value: Lobs answering questions and providing context IN the meeting
- Makes Lobs feel like a passive note-taker rather than a participant

## Implementation Plan

### Phase 1: Deferred Queue + Tool (1-2 hours)
- [ ] Create `DeferredActionQueue` class
- [ ] Create `defer_action` tool in realtime-tools.ts
- [ ] Add to `realtimeVoiceTools` array
- [ ] Pass queue through `RealtimeVoiceToolContext`

### Phase 2: Enhanced Prompt (30 min)
- [ ] Add action judgment instructions to `buildRealtimeInstructions()` in realtime-context.ts
- [ ] Include examples of execute-now vs defer scenarios

### Phase 3: Meeting End Integration (1-2 hours)
- [ ] Wire `DeferredActionQueue.drain()` into `VoiceSessionManager.leaveVoice()` or equivalent session end handler
- [ ] Add `analyzeWithDeferred()` method to `MeetingAnalysisService`
- [ ] Implement fuzzy deduplication (token overlap or simple substring matching for v1)

### Phase 4: Testing (30 min)
- [ ] Unit test for DeferredActionQueue
- [ ] Unit test for deduplication logic
- [ ] Build passes (`npm run build`)

## Open Questions

1. **Should deferred items be persisted to SQLite during the meeting?** Current design says no (in-memory only). If voice sessions prove unstable, we should add persistence.
2. **Should the user be able to review deferred items before they become tasks?** Currently they go through the same approval tier system as meeting analysis items. Could add a "review deferred items" voice command.
3. **Should we track execute-vs-defer decisions for quality analysis?** Logging which actions were executed vs deferred could help tune the prompt over time.
