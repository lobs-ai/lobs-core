# PAW Add-on Roadmap

**Last updated:** 2026-03-06  
**Status:** Living document — update as add-ons ship or priorities shift

---

## Overview

Add-ons are the secondary bootstrapping mechanism for PAW. Two are stable today (`tasks`, `projects`). This document covers everything on the roadmap — what each one does, why it matters, when it ships, and what it depends on.

See [ADR-addon-system.md](decisions/ADR-addon-system.md) for architecture.

---

## Stable (Already Shipped)

| Add-on | Description |
|--------|-------------|
| **tasks** | Task lifecycle management — create, update, list, close tasks via PAW API |
| **projects** | Project management — sync GitHub issues, add tasks, publish status, archive |
| **group-messaging** | Create and manage multi-person group chats across Discord and iMessage |

---

## Planned Add-ons

### Priority 1 — High (Ship Next)

These unblock the most daily workflows. Target: next sprint.

#### `inbox`

**What it does:** Triage and respond to inbox items — action-required items queued for human review. Agents surface new inbox items, mark them reviewed, and escalate or dismiss them.

**Why it's high priority:** Inbox is the human-agent handoff point. Without this add-on, agents can't surface work that needs Rafe's attention in a structured way.

**Key behaviors:**
- List open inbox items
- Mark items as reviewed or dismissed
- Escalate inbox items → create a task from an inbox item
- Filter by urgency, type, or source

**Depends on:** `tasks` (escalation creates tasks)

---

#### `meetings`

**What it does:** Process meeting transcripts, extract action items, and push them into tasks or inbox. Includes YouTube video ingestion for recorded meetings.

**Why it's high priority:** Meeting follow-through is a primary PAW use case. This is what gets sold.

**Key behaviors:**
- Submit a meeting transcript for processing
- Extract action items → auto-create tasks with owner + context
- List past meeting summaries
- Query: "what were the action items from the Monday meeting?"

**Depends on:** `tasks` (creates tasks from action items), `inbox` (surfaces unassigned action items for review)

---

### Priority 2 — Medium

Expand core agent intelligence and data access. Target: following sprint.

#### `memory`

**What it does:** Read, write, and search agent memory entries. Lets agents surface what they remember about a person, topic, or project.

**Key behaviors:**
- Write a memory entry (with tags and category)
- Search memories by keyword, tag, or recency
- View memory entries by category (people, projects, decisions, etc.)
- Mark memories stale or correct them

**Depends on:** None (standalone capability)

---

#### `chat`

**What it does:** Create and manage multi-session AI chat conversations. Useful for long-running research threads, multi-day project chats, or isolated AI sessions with different context.

**Key behaviors:**
- Create a named chat session
- Switch between active sessions
- Archive or delete sessions
- Search across session history

**Depends on:** `memory` (sessions may persist key facts into memory)

---

#### `knowledge`

**What it does:** Browse and search the shared knowledge base — documents, research, uploaded files, web clips.

**Key behaviors:**
- Search knowledge base by query
- List recent entries by type or tag
- View a knowledge entry by ID
- Add a note or web clip to the knowledge base

**Depends on:** None (standalone)

---

#### `reflections`

**What it does:** Review, approve, and reject agent self-improvement reflections. Keeps the agent's evolving behavior under human control.

**Key behaviors:**
- List pending reflections awaiting review
- Approve a reflection (agent adopts behavior change)
- Reject with a reason
- View reflection history

**Depends on:** None (standalone)

---

#### `research`

**What it does:** Submit research tasks, list research documents, and read findings. The structured research workflow — from question to delivered document.

**Key behaviors:**
- Submit a research question → spawns a researcher agent
- List research documents (completed and in progress)
- Read a research document by ID or topic
- Link research findings to a task or project

**Depends on:** `tasks` (research spawns as a task), `knowledge` (findings land in knowledge base)

---

### Priority 3 — Low

Nice to have, low urgency. Schedule after P2 is stable.

#### `calendar`

**What it does:** Create and manage scheduled events with optional cron recurrence. Schedule reminders, recurring check-ins, and time-anchored tasks.

**Key behaviors:**
- Create a calendar event (one-off or recurring via cron expression)
- List upcoming events
- Edit or cancel events
- Connect events to tasks (event triggers task creation)

**Depends on:** `tasks` (event → task linkage)

---

#### `workflows`

**What it does:** Define and trigger multi-step automated workflows. Chain agent actions across tasks, meetings, and notifications without manual orchestration.

**Key behaviors:**
- Define a workflow (trigger + action sequence)
- List active workflows
- Trigger a workflow manually or by condition
- View workflow run history

**Depends on:** `tasks`, `calendar` (workflows can schedule steps), optionally `inbox`

---

#### `youtube`

**What it does:** Ingest YouTube videos into the knowledge base. Transcribe, summarize, and tag video content so it's searchable and queryable.

**Key behaviors:**
- Ingest a YouTube URL → transcribe + summarize → save to knowledge base
- List ingested videos
- Search across video transcripts
- Extract action items from a video → tasks

**Depends on:** `knowledge` (output lands there), `tasks` (action item extraction)

---

#### `documents`

**What it does:** Manage generated reports and long-form documents. Create, version, and share structured docs produced by agents.

**Key behaviors:**
- List documents by type (report, summary, brief, etc.)
- View document by ID
- Generate a document from a template
- Export to markdown or PDF

**Depends on:** `knowledge` (documents may pull from KB), `research` (research output becomes a document)

---

#### `status`

**What it does:** Query system health, activity feed, and cost summaries. Operational visibility for Rafe and agents.

**Key behaviors:**
- System health: orchestrator, workers, gateway, DB
- Activity feed: recent agent runs, spawns, task updates
- Cost summary: session costs, monthly trends
- Alert status: any blocked tasks, orphaned workers, spawn count anomalies

**Depends on:** None (read-only observability)

---

## Dependency Map

```
tasks ──────────────────────────────────────┐
  └── inbox ──────────────────────────────── meetings
  └── calendar ─── workflows ───────────────┘
  └── research ─── knowledge ─── youtube
                              └── documents

memory ─── chat

reflections (standalone)
status (standalone)
```

Simplified: the task graph is the backbone. Most add-ons either create tasks or are triggered by tasks. Memory/chat are a separate standalone cluster. Reflections and status are independent.

---

## Delivery Order

| Wave | Add-ons | Goal |
|------|---------|------|
| Wave 1 (now) | `inbox`, `meetings` | Human-agent handoff + core use case |
| Wave 2 | `memory`, `knowledge`, `reflections` | Agent intelligence layer |
| Wave 3 | `chat`, `research` | Extended workflows |
| Wave 4 | `calendar`, `workflows`, `youtube`, `documents`, `status` | Full platform |

---

## Add-on Format Reference

Each add-on follows the standard structure. See [docs/decisions/ADR-addon-system.md](decisions/ADR-addon-system.md) for the full spec.

```
addons/<name>/
  README.md      ← human-readable description
  addon.md       ← machine-readable definition (parsed by ingest.py)
  <skill>/
    SKILL.md     ← bundled skill
```
