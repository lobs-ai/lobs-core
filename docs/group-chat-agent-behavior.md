# Group Chat Agent Behavior Spec

**Date:** 2026-03-06  
**Status:** Accepted  
**Author:** architect agent  
**Related docs:**
- `docs/chat-server-architecture.md` — chat server and address book design
- `docs/decisions/ADR-bifurcated-memory-compliance.md` — compliance partitioning

---

## Problem

When the lobs agent is a participant in an active group chat, it needs to:

1. Continuously ingest conversation without disrupting it
2. Detect action items and intent autonomously
3. Execute tasks mid-conversation without requiring explicit commands
4. Respect privacy boundaries across participants

This spec defines the agent's behavioral model inside a live group chat — what it listens for, when it speaks, when it acts silently, and what it remembers.

---

## Core Model: Silent Observer, On-Demand Actor

The agent defaults to **silent observation**. It reads everything, acts on almost nothing autonomously, and speaks only when addressed or when a trigger threshold is crossed. The goal is to feel like a capable teammate who's paying attention — not an interrupt machine.

```
┌─────────────────────────────────────────────────────────┐
│                    Group Chat Room                       │
│                                                          │
│  Alice: Hey Bob, can you handle the billing PR review?  │
│  Bob: Sure, I'll get to it by Thursday.                  │
│  Alice: Also need someone to update the staging env.    │
│  Bob: I can do that too.                                 │
│  ...                                                     │
│                                                          │
│  [Agent: listening, building context, detecting items]  │
│                                                          │
│  Alice: @lobs what did we decide?                   │
│  Agent: You've assigned Bob: billing PR review (by      │
│         Thursday) and staging env update. Want me to    │
│         create tasks for these?                         │
└─────────────────────────────────────────────────────────┘
```

---

## Architecture: Ingestion Pipeline

### Message Stream

The agent maintains a persistent connection to the chat server (Matrix SDK or Discord bot) and receives all room events in real time.

```
Chat Server → Room Event Stream
                    │
                    ▼
           ┌─────────────────┐
           │  Event Filter   │  — drops non-message events (joins, reactions)
           └────────┬────────┘
                    │
                    ▼
           ┌─────────────────┐
           │  Context Buffer │  — rolling 50-message window per room
           └────────┬────────┘
                    │
           ┌────────┴─────────┐
           ▼                  ▼
    ┌─────────────┐   ┌──────────────┐
    │  Mention    │   │   Pattern    │
    │  Detector   │   │   Scanner    │
    └──────┬──────┘   └──────┬───────┘
           │                 │
           ▼                 ▼
    ┌─────────────────────────────┐
    │      Action Dispatcher      │
    │  (respond | log | create    │
    │   task | stay silent)       │
    └─────────────────────────────┘
```

### Context Buffer

The agent keeps a **rolling 50-message window** per room in memory. This is not stored in the compliance memory partition — it's ephemeral working context used for:
- Action item detection across multiple messages
- Summarization when asked
- Disambiguation of "@lobs" commands

Buffer is cleared on restart. Persistent conversation history lives only in the chat server's message store (not the agent's memory system). The agent can query back-history from the Matrix API on demand.

---

## When to Interject vs. Stay Silent

### Always Respond (High Confidence)

| Trigger | Response type |
|---------|--------------|
| `@lobs [anything]` in room | Direct reply |
| DM to agent directly | Direct reply |
| Name invoked: "lobs, can you..." | Direct reply |
| Explicit question directed at agent | Direct reply |

These are unambiguous invocations. The agent must respond within ~3 seconds.

### Respond After Threshold (Medium Confidence)

The agent may interject when a clear action item cluster has formed but the conversation is pausing. Conditions:
- ≥2 action items detected in last 10 messages
- No new messages for **60 seconds** (conversation lulling)
- Agent has not spoken in the last 5 minutes

Response: a soft summary + offer, not a demand.

```
Agent: Looks like there are a few things being tracked here — 
       want me to capture these as tasks? (React ✅ to confirm)
```

The agent **does not interject** if:
- The conversation is clearly still flowing (new messages < 30s apart)
- It already interjected in the last 5 minutes without response
- The items are ambiguous (unclear owner, unclear deliverable)

### Stay Silent (Default)

The agent stays silent in all other cases. This includes:
- Social conversation, jokes, check-ins
- Venting, emotional content
- Debates or disagreements without clear action items
- Items that have already been confirmed as tasks

**Silence is the safe default.** An agent that speaks too often loses trust faster than one that's too quiet.

### Never Interject

| Situation | Why |
|-----------|-----|
| Detected sensitive content (health, legal, personal) | Privacy — see model below |
| Conversation flagged as private by participants | Consent model |
| Agent's last 2 interjections were ignored | Back off, wait for direct invocation |
| Room is marked `agent_passive: true` | Explicit opt-out |

---

## Action Item Detection Rules

Action items are detected via pattern matching on the context buffer, not LLM inference on every message. LLM is only called when a pattern fires.

### Pattern Set

**Assignment patterns** — someone is being asked to do something:

```
[Person] + (will|can you|could you|please|needs to|should|is going to) + [verb phrase]
[Person]: (I'll|I will|I can|I'm going to) + [verb phrase]
"someone needs to" + [verb phrase]
```

**Deadline patterns** — a time frame is attached:

```
(by|before|due|deadline|EOD|end of week|tomorrow|Thursday) + [date/time]
```

**Confirmation patterns** — the assignment was accepted:

```
"sure", "got it", "on it", "will do", "yep", "sounds good", followed by the assigned person
```

**Question patterns** — someone needs something answered:

```
[Person] + "?" at end + addressed to specific person
→ not an action item unless that person is the agent
```

### Confidence Scoring

Each detected item gets a confidence score (0.0–1.0):

| Factor | Score adjustment |
|--------|-----------------|
| Named owner identified | +0.3 |
| Explicit deadline stated | +0.2 |
| Confirmation received | +0.2 |
| Verb is concrete (review, deploy, write, fix) | +0.1 |
| Verb is vague (look at, think about, discuss) | -0.2 |
| Item contains "maybe" or "might" | -0.2 |
| Passive construction, no clear owner | -0.3 |

**Threshold for action item creation:** ≥ 0.6  
**Threshold for silent logging (no task created):** 0.3–0.59  
**Below 0.3:** discarded

### LLM Confirmation Pass

When pattern fires at ≥ 0.3, the agent runs a single LLM call:

```
You are analyzing a group chat excerpt. Extract action items only.
An action item has: a specific task, an owner (optional), and a deadline (optional).
Do not invent owners or deadlines not present in the text.
Format: [{task, owner?, deadline?, confidence}]
If none found, return [].

Context: [last 15 messages]
```

The LLM output is merged with pattern scores. If LLM returns no items for a pattern hit, the item is discarded. If LLM adds items the pattern missed, they're added at LLM's stated confidence.

---

## Task Creation Triggers

Tasks are **never created silently without user confirmation** by default. This is non-negotiable — silent task creation would pollute the task system and erode trust.

### Standard Flow

1. Agent detects ≥1 item at confidence ≥ 0.6
2. Agent waits for conversation lull (60s) OR is directly asked
3. Agent presents items in a single, compact message:

```
Agent: Here's what I'm tracking:
  • @bob — review billing PR (by Thursday)
  • @bob — update staging env (no deadline)
  
Create tasks? React ✅ to confirm all, or reply with adjustments.
```

4. On ✅ reaction: tasks created in PAW, confirmation sent:
```
Agent: ✅ Created 2 tasks for @bob.
```

5. On no response for 5 minutes: items saved to **pending log** (not tasks), available via `@lobs what's pending?`

### Immediate Task Creation (Explicit Commands)

The agent creates tasks immediately — no confirmation needed — when:

| Command | Behavior |
|---------|----------|
| `@lobs create task: [description]` | Task created instantly |
| `@lobs assign [name]: [task]` | Task created with owner |
| `@lobs remind [name] on [date]: [thing]` | Reminder task created |
| `@lobs track this` (reply to a message) | Creates task from that message |

### Mid-Conversation Execution

For tasks that can be executed immediately (not requiring human effort), the agent acts mid-conversation when asked:

| Request | Agent behavior |
|---------|---------------|
| `@lobs look up [thing]` | Executes search, replies in-thread |
| `@lobs summarize this conversation` | Summarizes last N messages, replies |
| `@lobs schedule [event]` | Creates calendar event, confirms |
| `@lobs send [person] the notes` | Sends DM with conversation notes |

These execute **immediately**, no confirmation needed. They're information-retrieval or communication tasks, not data-mutating PAW tasks.

---

## Privacy and Consent Model

### Who Sees What

The agent is a participant in the room. Every room member can assume:
- The agent reads all messages in the room
- The agent may log action items (not full conversation text)
- The agent will not repeat conversation contents to outsiders

The agent never:
- Quotes conversation messages to people outside the room
- Stores full conversation transcripts in the memory system
- Shares action item lists across rooms without explicit command

### Per-Room Consent Model

Consent is opt-out, not opt-in — matching the design of the address book (private, invite-only server). Rationale: if you're in the room, you've been explicitly added, and the agent is a visible participant.

**Room controls:**

| Setting | Default | How to change |
|---------|---------|---------------|
| `agent_active` | `true` | `@lobs pause` to suspend |
| `agent_passive` | `false` | `@lobs go quiet` — reads but never interjects |
| `task_creation` | `true` | `@lobs no tasks` — disables auto-task-offer |
| `memory_logging` | `true` | `@lobs no memory` — disables action item log |

Settings are stored per-room in PAW DB (not in the Matrix server). They persist across sessions.

**Individual opt-out:**

Any participant can say:
```
@lobs don't track me
```

The agent will exclude that participant's messages from action item detection. It will still respond to direct `@lobs` invocations from them.

Individual opt-outs are stored as participant flags in PAW DB. They apply room-wide (opting out in one room doesn't opt out of all rooms).

### Sensitive Content Detection

Before any LLM call on a message, a lightweight keyword screen runs. If the message contains signals for:
- Health or medical information
- Legal matters
- Financial details (specific numbers, account references)
- HR or personal conflict

...the message is excluded from action item detection and the LLM call is skipped entirely. The agent does not acknowledge this — it simply stays silent. This screen runs client-side, no data leaves.

Keyword list is configurable in PAW config. Conservative defaults.

---

## State Tracking Per Room

The agent maintains lightweight per-room state in memory (ephemeral) and PAW DB (persistent):

### In Memory (ephemeral, lost on restart)

```typescript
interface RoomContext {
  roomId: string;
  messageBuffer: Message[];          // last 50 messages
  pendingItems: ActionItem[];        // detected, not yet confirmed
  lastAgentMessage: timestamp;       // throttle interjections
  consecutiveIgnored: number;        // back-off counter
}
```

### In PAW DB (persistent)

```sql
-- Room settings
group_chat_rooms (
  room_id TEXT PRIMARY KEY,
  platform TEXT,              -- 'matrix' | 'discord'
  agent_active BOOLEAN DEFAULT true,
  agent_passive BOOLEAN DEFAULT false,
  task_creation BOOLEAN DEFAULT true,
  memory_logging BOOLEAN DEFAULT true,
  created_at TIMESTAMP
)

-- Per-participant opt-outs
group_chat_participant_settings (
  room_id TEXT,
  participant_id TEXT,        -- platform-specific user ID
  exclude_from_tracking BOOLEAN DEFAULT false,
  PRIMARY KEY (room_id, participant_id)
)

-- Pending action items (confirmed → creates task; unconfirmed → stays here)
group_chat_pending_items (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  detected_at TIMESTAMP,
  description TEXT,
  assigned_to TEXT,
  deadline TEXT,
  confidence REAL,
  status TEXT  -- 'pending' | 'confirmed' | 'dismissed' | 'expired'
)
```

Pending items expire after **24 hours** if not confirmed. Expired items are soft-deleted (status = 'expired').

---

## Throttling and Back-Off

To prevent the agent from becoming annoying:

| Condition | Behavior |
|-----------|----------|
| Agent just spoke < 2 minutes ago | No autonomous interjection |
| Agent's last 2 interjections got no response | Switch to passive mode for 30 min |
| Room has been quiet for > 4 hours | Reset back-off counters |
| 5+ action items accumulating over > 30 min | Single summary (not individual alerts) |

The agent tracks `consecutiveIgnored` counter per room. At 2 ignored interjections, it goes quiet and waits for direct `@lobs` invocation. It resets when someone engages.

---

## Implementation Plan

### Phase 1 — Core Ingestion + Mention Detection (small)
- Matrix/Discord event listener with rolling message buffer
- Mention detection (`@lobs`, direct name reference)
- Room settings table + participant opt-out table
- Sensitive content keyword screen

**Acceptance:** Agent responds to `@lobs` mentions in < 3s; stays silent otherwise.

### Phase 2 — Pattern-Based Action Item Detection (medium)
- Pattern scanner on message buffer
- Confidence scoring system
- LLM confirmation call with structured output
- Pending items table

**Acceptance:** In a test conversation with clear action items, agent detects ≥ 80% of items. False positive rate < 20%.

### Phase 3 — Task Creation Flow (medium)
- Confirmation message with reaction-based approval
- Task creation from pending items → PAW task system
- Pending item expiry (24h)
- `@lobs what's pending?` query

**Acceptance:** Confirmed items become PAW tasks with correct owner/deadline. No tasks created without confirmation.

### Phase 4 — Mid-Conversation Execution (small, incremental)
- `@lobs track this` (reply handler)
- `@lobs summarize` 
- `@lobs look up [thing]`
- These extend existing skill invocation patterns

**Acceptance:** Each command executes within conversation context without leaving room.

### Phase 5 — Room Controls + Back-Off (small)
- `@lobs pause/go quiet/no tasks/no memory` commands
- Throttle and back-off counters
- `@lobs don't track me` individual opt-out

**Acceptance:** All room control commands take effect immediately and persist across agent restarts.

---

## Testing Strategy

### Conversation Simulation Tests

Use pre-recorded conversation transcripts as test fixtures. Run action item detection against them and assert expected detections.

```
fixtures/
  clear-assignments.txt      → expect: 3 items, high confidence
  vague-discussion.txt       → expect: 0 items (below threshold)
  mixed-conversation.txt     → expect: 2 items, 1 discarded
  sensitive-content.txt      → expect: 0 items (keyword screen)
  confirmed-acceptance.txt   → expect: items with owner confirmed
```

### Behavioral Tests

- `@lobs` mention → response within 3s (integration test, needs running bot)
- 2 ignored interjections → passive mode activated (state machine test)
- Expired pending items → status = 'expired' after 24h (DB test with mocked clock)
- Opt-out participant → messages excluded from detection (unit test)

### No Production Testing Until Phase 1 Complete

Don't test on live group chats until the sensitive content screen and opt-out model are in place. Phase 1 safety controls are a prerequisite for any real deployment.

---

## Tradeoffs Considered

**Silent-by-default vs. active-by-default**  
Active-by-default (agent speaks whenever it detects something) feels impressive in demos but becomes irritating in real use. Silent-by-default with a clear opt-in for autonomous behavior matches how people expect teammates to behave.

**LLM on every message vs. pattern-first**  
LLM on every message is expensive and slow. Pattern-first filtering means LLM is only called when there's a genuine signal. Downside: creative phrasing can slip past patterns. Acceptable — we'd rather miss an action item than spam the room.

**Reaction-based confirmation vs. text reply**  
Reactions (✅) are lower friction than typing a reply. Downside: not all Matrix clients show reactions prominently. Fall back to text confirmation if reaction not received in 5 min.

**Per-room vs. per-server consent**  
Per-room gives finer control and is easier to explain to users ("the agent is in this room, it's listening here"). Per-server consent is simpler to manage but less intuitive. Per-room wins.

**24h pending item expiry**  
Short enough that stale items don't accumulate; long enough that items from a Friday meeting can be confirmed Monday morning.
