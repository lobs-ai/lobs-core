# Self-Hosted Chat Server: Messaging Layer + Address Book

**Date:** 2026-03-06  
**Status:** Accepted  
**Author:** architect agent  
**Related ADRs:**
- `lobs-shared-memory/docs/decisions/ADR-chat-server-as-address-book.md`
- `lobs-shared-memory/docs/decisions/ADR-peer-discovery-ux.md`

---

## Problem

Group messaging requires knowing who to message. The naive solution is a separate contacts directory — a database of names, handles, and routing info maintained independently from the messaging layer. This is unnecessary complexity.

If everyone who can receive a message is already a registered user on a shared chat server, **the server's user roster is the address book**. Enrollment = contact registration. Nothing else to maintain.

This document covers:
1. Architecture of the self-hosted chat server as identity + messaging layer
2. User discovery and connection flow
3. Integration with the OpenClaw agent
4. Comparison with Discord and Telegram

---

## Architecture

### Core Model

The chat server is the single source of truth for user identity and reachability.

```
┌─────────────────────────────────────────────────────────┐
│                   Chat Server (Conduit)                  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ User Directory│  │  Rooms/Groups │  │  Message Store│  │
│  │ (address book)│  │  (channels)   │  │  (history)    │  │
│  └──────────────┘  └──────────────┘  └───────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │ Matrix Client-Server API
          ┌────────────────┼─────────────────┐
          ▼                ▼                  ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Element      │  │ OpenClaw Bot │  │ Other clients │
  │ (user client)│  │ @openclaw:   │  │ (mobile, web) │
  │              │  │ server.local  │  │               │
  └──────────────┘  └──────────────┘  └──────────────┘
```

### What the Server Stores (and What We Don't)

| Need | Chat server field | Notes |
|------|-----------------|-------|
| Unique identifier | `@username:homeserver` | Stable, never changes |
| Display name | Profile `displayname` | Editable by user |
| Avatar | Profile `avatar_url` | Optional |
| Reachability | Server membership | If account exists → reachable |
| Group membership | Room members | Managed by server |

**Not stored in PAW DB or lobs-server:**
- User contact records
- Phone numbers / emails
- "Friend lists" or contact groups
- Sync timestamps

The only local agent-side storage is **channel metadata** (which rooms exist, what combination they represent) — and even that can be re-derived from the server.

### Technology Choice: Matrix + Conduit

**Matrix** is the protocol. **Conduit** is the homeserver implementation.

Why Conduit over Synapse:
- Lightweight Rust binary — runs on Mac mini with minimal resources
- SQLite backend — no PostgreSQL dependency
- Simple configuration — single TOML file
- Supports the full Matrix Client-Server API we need
- Federation is optional — can run fully isolated

Matrix user directory API:
```
POST /_matrix/client/v3/user_directory/search
{ "search_term": "alice", "limit": 5 }
```

This single endpoint replaces an entire contacts subsystem.

---

## User Discovery and Connection Flow

### Enrollment = Contact Registration

When a new person joins the chat server, they are automatically in the "address book." No separate step.

```
Admin generates invite link / registration token
  → New user registers account on Conduit homeserver
  → System adds them to #general room
  → Bot sends welcome DM from @openclaw:server.local:
      "Hi [name], welcome!
       Here's who's here: [member list with handles]
       DM anyone by searching their name in Element.
       Type @openclaw in any room for AI help."
  → User opens Element → People panel shows server members
  → User can DM immediately
```

**Total new-user friction: ~2 minutes from invite link to first message.**

### Name Search and Disambiguation

Users are found by name or handle via the user directory. If search returns multiple results:

```
Agent: I found 3 people named "Alex":
  1. @alex.chen:server.local (Alex Chen)
  2. @alex.r:server.local (Alex Rodriguez)
  3. @alexb:server.local (Alex Brown)
Which one? (Reply with 1, 2, or 3)
```

### Privacy Model: Opt-Out by Default

All registered users are visible by default. Rationale:
- This is a **private, invitation-only server** — everyone arrived via an explicit admin invite
- For a 10–20 person closed team, opt-in visibility creates friction without meaningful privacy gain
- Users who want privacy can set their profile to non-discoverable individually

Conduit config: `search_all_users = true`

### Discovery Surfaces

| Surface | Implementation | User action |
|---------|---------------|-------------|
| Element sidebar → People | Native Element UI | Passive |
| Element search bar | `user_directory/search` | Type a name |
| Agent directory query | `@openclaw who's here?` | Natural language |
| Admin-sent welcome DM | Bot DMs new user on join | Automated |

---

## Integration with OpenClaw Agent

### What the Agent Needs

The agent requires a `chat-server-client.ts` module (~100 lines, no database):

```typescript
// chat-server-client.ts

export const userDirectory = {
  async search(name: string): Promise<User[]> {
    // POST /_matrix/client/v3/user_directory/search
    // Returns [{userId, displayName}]
  }
};

export const room = {
  async getOrCreate(userIds: string[]): Promise<string> {
    // Deterministic room lookup by participant set, or create
    // Returns roomId
  },

  async send(roomId: string, message: string): Promise<void> {
    // POST /_matrix/client/v3/rooms/{roomId}/send/m.room.message
  }
};
```

### Agent Command Flow

When the user says `group message Alice Bob about the budget`:

```
1. Parse: ["Alice", "Bob"], message = "about the budget"
2. userDirectory.search("Alice") → @alice:server.local
3. userDirectory.search("Bob") → @bob:server.local
4. room.getOrCreate([@alice, @bob, @openclaw]) → roomId
5. room.send(roomId, "about the budget")
```

The agent **never queries a local contacts table.** All identity resolution goes to the chat server.

### Agent Commands to Implement

| Command pattern | Behavior |
|----------------|----------|
| `@openclaw who's here?` | Returns list of server members (name + handle) |
| `@openclaw find [name]` | Searches user directory, returns matches |
| `@openclaw DM [name] [message]` | Creates private room, sends message |
| `group message [name1] [name2] ...` | Group message flow (see above) |
| (join event trigger) | Auto-DM new members on join |

### Config Keys Required

```json
{
  "chatServer": {
    "url": "https://matrix.server.local",
    "botToken": "...",
    "botUserId": "@openclaw:server.local"
  }
}
```

### Integration with Existing Group Messaging Skill

The existing `group-messaging` skill in OpenClaw currently routes through Discord using `GroupChannelManager`. For Matrix, the same group-combination-to-room model applies:

```
group_channels table (existing):
  participants_key  TEXT   -- SHA256 of sorted user IDs
  platform          TEXT   -- "discord" | "matrix"
  channel_id        TEXT   -- Discord channel ID or Matrix room ID
  channel_name      TEXT
  archived          BOOLEAN
```

No schema changes needed. The platform column already supports multiple backends.

---

## Comparison: Self-Hosted vs Discord vs Telegram

### The Core Tradeoff

| Dimension | Self-Hosted (Matrix) | Discord | Telegram |
|-----------|---------------------|---------|----------|
| **Data residency** | On our servers | Discord's US servers | Telegram's servers |
| **Compliance** | HIPAA/FERPA compatible | Not compliant | Not compliant |
| **Address book** | Server = address book | Server = address book | Phone number = address book |
| **Contact registration** | Create server account | Join server | Share phone number |
| **API access** | Full Matrix API | Full Discord API | Telegram Bot API |
| **Agent integration** | Native (bot account) | Native (bot account) | Bot API |
| **User client** | Element (decent) | Discord (excellent) | Telegram (excellent) |
| **Operational burden** | We run the server | Zero | Zero |
| **Federation** | Optional (Matrix spec) | No | No |
| **Cost** | Hosting cost only | Free | Free |
| **Setup friction** | High (initial) | Low | Low |

### Where Discord Wins

Discord is **already deployed** and requires zero operational work. The native client is excellent, discovery is seamless (sidebar member list, @mention autocomplete), and the bot API is mature. For non-compliance contexts, Discord remains the primary platform.

Discord's weakness: data doesn't live with us. For HIPAA/FERPA regulated conversations (SAIL academic use cases), Discord is not an option.

### Where Telegram Fails

Telegram's address book is phone-number-based. To "find" someone on Telegram, you need their phone number — a piece of PII that requires its own management. This defeats the purpose of using the messaging layer as the address book.

Additionally:
- Telegram's bot API is more limited than Discord's
- No on-premise / self-hosted option
- Encryption is client-side optional, not end-to-end by default for groups

Telegram is **not recommended** for this use case.

### Where Self-Hosted Matrix Wins

- **Compliance contexts** (SAIL, FERPA, HIPAA) — data never leaves our infrastructure
- **Audit trails** — we control the logs
- **Integration depth** — full API access, no rate limits, no ToS restrictions
- **Long-term cost** — no per-seat pricing, no vendor lock-in
- **Federation** — can eventually federate with other Matrix servers

Matrix's weakness: initial setup overhead and Element's client UX is noticeably worse than Discord. For a 10–20 person internal team, this is manageable.

### Platform Strategy: Discord First, Matrix for Compliance

This is not either/or. The design supports both:

- **Discord:** General use, non-regulated conversations, team chat
- **Matrix:** SAIL educators, any conversation involving student data, regulated industries

The `group_channels` table already supports a `platform` column. The `chat-server-client.ts` module abstracts platform differences. The agent's group-message skill works identically on both platforms.

---

## Implementation Plan

### Phase 1 — Matrix Server Setup (infrastructure task)

- [ ] Deploy Conduit on Mac mini, configure domain + TLS
- [ ] Create bot account `@openclaw:server.local` with admin privileges
- [ ] Set `search_all_users = true` in Conduit config
- [ ] Validate: 10–20 concurrent users, resource usage acceptable

### Phase 2 — Agent Integration (programmer task)

- [ ] Write `chat-server-client.ts` with `userDirectory.search()`, `room.getOrCreate()`, `room.send()`
- [ ] Wire into existing group-message skill (replace Discord-only path with platform dispatch)
- [ ] Add Matrix platform support to `GroupChannelManager`
- [ ] Add config keys (`CHAT_SERVER_URL`, `CHAT_BOT_TOKEN`) to OpenClaw config schema

### Phase 3 — Agent Commands (programmer task)

- [ ] Implement `who's here?` command handler (query `user_directory/search`)
- [ ] Implement `find [name]` command with disambiguation
- [ ] Implement `DM [name] [message]` command
- [ ] Implement welcome DM on `m.room.member` join event

### Phase 4 — No Phase 4

No contacts table. No sync job. No separate identity store. We're done.

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Conduit resource usage under load | Low (small team) | Validate on Mac mini before opening to users |
| Matrix user directory search performance | Low | Conduit indexes users; search is fast for <100 users |
| Agent can't reach chat server | Medium (if server down) | Graceful error: "Chat server unavailable; try direct Discord" |
| Name collision / disambiguation UX | Medium | Implemented via disambiguation prompt (see above) |
| User adoption of Element over Discord | High | Discord stays for non-compliance; Element only required for regulated contexts |

---

## References

- `lobs-shared-memory/docs/decisions/ADR-chat-server-as-address-book.md`
- `lobs-shared-memory/docs/decisions/ADR-peer-discovery-ux.md`
- Matrix Client-Server API: https://spec.matrix.org/v1.8/client-server-api/
- Matrix user directory spec: https://spec.matrix.org/v1.8/client-server-api/#user-directory
- Conduit homeserver: https://conduit.rs/
- Existing group-message skill: `~/.openclaw/skills/group-messaging/SKILL.md`
