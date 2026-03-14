# Multi-Channel Organization Model for Group Chats

**Date:** 2026-03-06  
**Status:** Accepted  
**Author:** architect agent  
**Related docs:**
- `docs/chat-server-architecture.md` — chat server and address book design
- `docs/group-chat-agent-behavior.md` — agent behavior inside live group chats
- `~/apps/lobs-server/docs/ADR-multi-channel-org-model.md` — data model and schema (authoritative)

---

## Problem

Group conversations need a stable home. When a user says "group message Alice and Bob," the system needs
to answer three questions:

1. Does a channel for this exact group already exist?
2. If yes, use it. If no, create it — with what name?
3. How do users control these channels after they exist?

The lobs-server ADR establishes the data model (`group_channels` table, `participants_key` fingerprinting).
This document specifies **how the PAW plugin exposes and manages those channels** — the naming spec,
command vocabulary, member flow, and cleanup policy.

---

## Model Overview

One persistent channel per unique set of participants. The same group always maps to the same channel.

```
{Alice, Bob}          → #alice-bob          (stable)
{Alice, Bob, Carol}   → #alice-bob-carol     (different key, different channel)
{Alice, Bob} + Carol  → new channel #alice-bob-carol + archive old (see Member Flow)
```

This is the Discord model. It eliminates channel sprawl from repeated "group message" commands and
gives conversations a home across sessions.

---

## 1. Channel Creation and Naming Spec

### Trigger

A new channel is created only when:
- The user initiates a group message (or explicitly requests a group channel), AND
- No active channel exists for the exact participant set (checked via `participants_key`)

The agent **always checks before creating.** No duplicate channels.

### Name Generation

Channel names are auto-generated from participant display names:

```
Algorithm:
  1. Take each participant's display name
  2. Lowercase, replace spaces/special chars with hyphens, strip non-ASCII
  3. Join with "-"
  4. If ≤ 3 participants: alice-bob-carol
  5. If 4+ participants: alice-bob-carol-3more  (first 3 + remaining count)
  6. Truncate to 32 chars (Discord limit) from the right, preserving first name segment
  7. If name already exists in guild: append -2, -3, ... until unique
```

**Examples:**

| Participants | Generated Name |
|---|---|
| Alice, Bob | `alice-bob` |
| Alice, Bob, Carol | `alice-bob-carol` |
| Alice, Bob, Carol, Dave, Eve | `alice-bob-carol-2more` |
| Alice O'Brien, Bob | `alice-obrien-bob` |
| Alice, Bob (second combo w/ same names) | `alice-bob-2` |

**User can rename at any time.** The rename is stored in `channel_name` but does not affect the
`participants_key`. Lookup always uses the key, never the name.

### Discord Category

Group channels are placed in a Discord category named `GROUP CHATS` (configurable via `categoryId`).
This keeps the guild sidebar organized and separates managed group channels from manual channels.

If no `categoryId` is configured, channels are created without a category.

### Matrix (Compliance Context)

On Matrix, the same naming rules apply. Room names follow the same slug format. Matrix room IDs are
stored in `group_channels.channel_id` with `platform = 'matrix'`.

---

## 2. Channel Management Commands

The agent accepts natural language. All commands below should be matched case-insensitively with
reasonable paraphrase tolerance.

### Creation and Lookup

| User says | Agent action |
|---|---|
| `group message [names] about [topic]` | Find or create channel; send message tagged to all participants |
| `start a group chat with [names]` | Find or create channel; open it without a message |
| `open our group chat with [names]` | Find existing channel; link to it (no creation if not found) |
| `create a group channel with [names]` | Explicit create, even if one exists (asks to confirm reuse) |

**Confirmation required before creation.** Always show:
```
Create #alice-bob channel in [Server Name] for Alice and Bob?
```
Wait for explicit yes before creating.

### Listing and Discovery

| User says | Agent action |
|---|---|
| `list my group chats` / `show my channels` | List all active channels where caller is a participant |
| `what group chats am I in?` | Same as above |
| `who's in [channel name]?` | Look up `participants_json` for that channel; list members |
| `find our channel with [names]` | Search `group_channels` by participant names; return match or "not found" |

**List format:**

```
Your group channels:
  • #alice-bob — Alice, Bob (last used 2 days ago)
  • #alice-bob-carol — Alice, Bob, Carol (last used today)
  • #launch-planning — Alice, Bob, Dave (renamed) — last used 5 days ago
```

Archived channels are excluded from `list` by default. Use `list all including archived` to see them.

### Renaming

| User says | Agent action |
|---|---|
| `rename our group chat to [name]` | Update `channel_name` in DB; rename Discord channel via API |
| `rename the [name] channel to [new-name]` | Same |
| `call this channel [name]` | Same (in-channel shorthand) |

Name validation:
- Lowercase, hyphens only (normalize on input)
- Max 32 chars
- Must be unique in guild (append `-2` if collision)

Confirmation: `Rename #alice-bob to #launch-planning?` → yes to proceed.

### Settings

| User says | Agent action |
|---|---|
| `@lobs pause` (in-channel) | Set `agent_active = false` for that room |
| `@lobs go quiet` (in-channel) | Set `agent_passive = true` — listens but never interjects |
| `@lobs resume` (in-channel) | Set `agent_active = true`, `agent_passive = false` |
| `@lobs no tasks` (in-channel) | Disable task creation for this channel |
| `@lobs no memory` (in-channel) | Disable action item logging for this channel |
| `@lobs don't track me` (in-channel) | Opt out individual participant from detection |

Settings persist in PAW DB (see `group_chat_rooms` schema in `group-chat-agent-behavior.md`).

---

## 3. Member Add/Remove Flow

### The Core Problem

Participant sets are immutable identifiers. `{Alice, Bob}` and `{Alice, Bob, Carol}` are different
channels. You cannot "add Carol to #alice-bob" and expect it to remain `#alice-bob` with the same key.

This is the correct model: adding a person changes the group, and the group should have a new home
that reflects its new composition. History of the smaller group remains intact in the old channel.

### Add Member Flow

When the user says **"add Carol to our group chat with Alice and Bob"**:

```
1. Resolve current channel for {Alice, Bob} → #alice-bob (channel_id = ch_123)
2. Compute new participants_key for {Alice, Bob, Carol}
3. Check if channel for {Alice, Bob, Carol} already exists
   → If yes: use existing, ask user "There's already a channel for all three. Switch to it?"
   → If no: continue
4. Generate name: #alice-bob-carol
5. Confirm: "Create #alice-bob-carol for Alice, Bob, and Carol? 
             The old #alice-bob channel will be archived."
6. On confirm:
   a. Create new channel #alice-bob-carol
   b. Archive old channel #alice-bob (archived = 1, Discord archive if supported)
   c. Send opening message in new channel:
      "Carol has been added! Continuing from #alice-bob (linked below).
       [link to #alice-bob for context]"
   d. Register new channel in group_channels
7. Return link to new channel
```

**The old channel is always archived, not deleted.** History is preserved. The link in the opening
message gives context continuity.

User can opt out of archiving the old channel:
```
"add Carol to Alice-Bob group but keep both channels"
```
→ Creates new channel, does not archive old one. Both remain active.

### Remove Member Flow

"Remove" is the inverse of add. Removing Carol from `{Alice, Bob, Carol}` produces `{Alice, Bob}`.

When the user says **"remove Carol from our group chat"**:

```
1. Resolve current channel for {Alice, Bob, Carol} → #alice-bob-carol
2. Compute new participants_key for {Alice, Bob} (Carol removed)
3. Check if channel for {Alice, Bob} already exists
   → If yes: "There's already an #alice-bob channel. Switch back to it?"
             On yes: archive #alice-bob-carol, link to existing #alice-bob
   → If no: create new #alice-bob channel (same flow as Add)
4. If creating new:
   a. Create #alice-bob
   b. Archive #alice-bob-carol
   c. Opening message: "Continuing without Carol. Previous group chat: #alice-bob-carol [link]"
5. Return link to new channel
```

**Carol is not messaged.** Remove is silent to the removed participant unless the user explicitly
asks the agent to notify them.

### Direct Add/Remove in Discord

If the platform is Discord, the agent does **not** use Discord role/permission manipulation to add or
remove access. All participants in a guild-based channel can see the channel; access control is at
the guild level, not the channel level. The `participants_json` in `group_channels` is the canonical
source of truth for group membership, independent of Discord permissions.

For compliance contexts (Matrix), Matrix room membership is the source of truth. The agent explicitly
invites/kicks users from Matrix rooms when adding/removing.

---

## 4. Archive and Cleanup Policy

### When Channels Are Archived

| Event | Archive behavior |
|---|---|
| User says "archive [channel]" | Immediate archive (archived = 1) |
| Member added/removed (default) | Old channel archived automatically |
| Manual request to reset conversation | Archive + create fresh channel for same group |
| Inactivity (configurable) | Soft archive after `inactiveDays` (default: disabled) |

**Archiving is always reversible.** `archived = 1` is a soft flag. No data is deleted.

### Inactivity-Based Auto-Archive

Disabled by default. Enable via config:

```json
{
  "channels": {
    "discord": {
      "groupChannels": {
        "archiveOnInactive": true,
        "inactiveDays": 30
      }
    }
  }
}
```

When enabled: a nightly background job checks `last_used_at`. Channels not used in `inactiveDays`
are soft-archived (`archived = 1`). Discord channel is **not** deleted — only the registry entry
is marked inactive. The Discord channel remains accessible in the guild sidebar unless manually
hidden.

A warning DM is sent to all participants 3 days before auto-archive:
```
The group channel #alice-bob hasn't been used in 27 days and will be archived in 3 days.
Say "unarchive alice-bob" to keep it active.
```

### Unarchive Flow

| User says | Agent action |
|---|---|
| `unarchive [channel]` | Set `archived = 0`; update `last_used_at` to now |
| `reopen our group chat with [names]` | Look up channel (including archived); unarchive + confirm |
| `group message [names]` (group has archived channel) | Alert user: "Your channel #alice-bob is archived. Unarchive it?" |

The agent **never silently creates a new channel** when an archived one exists for the same group.
It always surfaces the archived channel and asks.

### Permanent Deletion

The agent does not delete channels or `group_channels` rows. Deletion is a manual admin action only.

Rationale: accidental deletion is catastrophic (conversation history gone). The benefit of true deletion
over soft-archive is minimal. Keep everything, mark inactive.

Exception: in Matrix, rooms have no persistent archive concept. Archiving means leaving the Matrix
room (bot leaves the room). The `group_channels` row is retained with `archived = 1`. Recreating the
group creates a new Matrix room.

### Cleanup Command (Admin)

For admin use only:

```
@lobs admin: purge archived channels older than 90 days
```

This hard-deletes `group_channels` rows (not Discord channels) for archived entries older than the
specified window. Requires a confirmation with the count:
```
This will remove 12 archived channel records. The Discord channels themselves will not be deleted.
Confirm? (yes/no)
```

---

## State Machine: Channel Lifecycle

```
                    ┌──────────────┐
                    │   ACTIVE     │◀────────────────────────┐
                    │ archived = 0 │                          │
                    └──────┬───────┘                          │
                           │                           unarchive
               user archives                                  │
               member added/removed                           │
               inactivity (if enabled)                        │
                           │                                  │
                           ▼                                  │
                    ┌──────────────┐                          │
                    │  ARCHIVED    │──────────────────────────┘
                    │ archived = 1 │
                    └──────┬───────┘
                           │
                    admin purge only
                           │
                           ▼
                    ┌──────────────┐
                    │   DELETED    │
                    │  (row gone)  │
                    └──────────────┘
```

---

## Implementation Plan

The data model and `GroupChannelManager` are already implemented (lobs-server ADR). This plan
covers the PAW plugin side.

### Phase 1 — Command Recognition (programmer, small)

- [ ] Add channel management command patterns to `app/group_message_command.py`:
  - `rename [channel] to [name]`
  - `archive [channel]`
  - `unarchive [channel]`
  - `list my group chats`
  - `who's in [channel]`
  - `add [name] to [group]`
  - `remove [name] from [group]`
- [ ] Unit tests for each pattern

**Acceptance:** Each command pattern parses correctly from natural language input. Malformed input returns a clear error.

### Phase 2 — Add/Remove Member Flow (programmer, medium)

- [ ] Implement `add_member()` in `GroupChannelManager`:
  - Compute new `participants_key` with added member
  - Check for existing channel
  - Create new channel, archive old, send continuity message
- [ ] Implement `remove_member()` (inverse)
- [ ] Preserve user option: `keep_both=True` skips archiving old channel
- [ ] Integration tests with mocked Discord API

**Acceptance:** Adding a member creates a new channel with continuity link. Old channel is archived. Existing channel for the new set is reused if found.

### Phase 3 — Inactivity Auto-Archive (programmer, small)

- [ ] Background job: nightly scan of `last_used_at`
- [ ] Warning DM at (N-3) days
- [ ] Archive at N days
- [ ] Configurable via `archiveOnInactive` + `inactiveDays`

**Acceptance:** Test with a mocked clock: channel not used in 30 days → archived. Warning sent at day 27.

### Phase 4 — Skill + SKILL.md Update (programmer, small)

- [ ] Update `group-messaging` SKILL.md with add/remove flow and archive commands
- [ ] Add examples for rename, archive, unarchive, list, add member, remove member

**Acceptance:** SKILL.md reflects all commands in this doc. No gaps between spec and skill instructions.

---

## Tradeoffs Considered

**New channel on member change vs. adding to existing**  
Simpler alternative: just mention Carol in #alice-bob without changing the key. Problem: the `participants_key` model breaks — you'd lose idempotent lookup by participant set. The new-channel-on-add model preserves the invariant. History continuity via the link message handles UX.

**Soft archive vs. hard delete**  
Soft archive wins on every dimension: history preserved, recoverable, lower risk. The only cost is slightly messier DB over time. Admin purge handles that.

**Auto-archive on by default vs. off**  
Off by default. Active channels shouldn't disappear without a user noticing. Opt-in auto-archive for teams that want the cleanup.

**Participant access control on Discord**  
Discord guild-level access means everyone in the guild can see all group channels anyway. We track membership in `participants_json` for routing and UX purposes, not as a security control. Compliance-sensitive contexts use Matrix, where room membership is a real access control boundary.
