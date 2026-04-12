# PAW Scheduling Engine & Daily Planner

**Status:** Design (pre-implementation)  
**Author:** Architect agent  
**Last updated:** 2025-07

---

## Overview

The scheduling engine bridges PAW's task list and Rafe's Google Calendar. Every morning at 7am ET it reads today's free time, scores and slots open tasks into focused work blocks, creates calendar events on the Lobs calendar, and fires a Discord morning briefing.

---

## 1. Scheduling Algorithm

### 1.1 Priority Score

Each task is assigned a numeric score (higher = schedule first):

```
score = priority_weight + urgency_bonus + deadline_proximity_bonus - recency_penalty
```

| Component | Value |
|---|---|
| priority_weight — urgent | 1000 |
| priority_weight — high | 500 |
| priority_weight — medium | 200 |
| priority_weight — low | 50 |
| urgency_bonus — due today | +800 |
| urgency_bonus — due tomorrow | +400 |
| deadline_proximity_bonus — due in ≤3d | +200 |
| deadline_proximity_bonus — due in ≤7d | +100 |
| recency_penalty — started >3d ago, no progress | -50 |

Eligible tasks: `status = 'active'` AND `work_state IN ('not_started', 'in_progress')`.
Excluded: `status = 'waiting_on'` OR `blocked_by` non-empty.

### 1.2 Time Estimation Heuristics

Tasks with no `estimated_minutes` get a default based on `shape` or title keywords:

| Condition | Default |
|---|---|
| shape='spike' or title matches /research\|investigate\|explore/ | 60 min |
| shape='feature' or title matches /build\|implement\|create/ | 90 min |
| shape='fix' or title matches /fix\|bug\|patch/ | 45 min |
| shape='review' or title matches /review\|audit\|check/ | 30 min |
| shape='write' or title matches /doc\|write\|draft/ | 60 min |
| Fallback | 45 min |

Estimates are capped at 180 min per session (longer tasks get continuation blocks the next day).

### 1.3 Slot Rules

- **Minimum block size:** 30 min. Free slots < 30 min are skipped.
- **No fragmentation:** Tasks scored > 200 (medium+) require slots >= their estimate. If none exist, take best available and plan continuation.
- **Buffer between blocks:** 10 min. Next slot starts at `block_end + 10 min`.
- **Hard window:** 8:00am–11:00pm ET only.

### 1.4 Rafe's Fixed Schedule (Exclusions)

Failsafe busy blocks applied regardless of calendar state (~21 hrs/week):

```
Mon/Wed/Fri:   10:00–11:30 ET  (class)
Tue/Thu:       14:00–15:30 ET  (class)
Tue:           17:00–19:00 ET  (GSI office hours)
Thu:           16:00–18:00 ET  (esports)
Fri:           20:00–22:00 ET  (esports matches, variable)
```

---

## 2. Daily Planning Flow (7am ET)

```
Workflow name:  daily-planner
Trigger:        cron "0 7 * * *" America/Detroit
```

### Steps

**Step 1 — Fetch today's calendar**
```
ts_call: calendar.get_todays_events
args:    { days: 1 }
returns: { events: CalendarEvent[] }
```
Calls `GoogleCalendarService.fetchUpcoming(1)` on RAFE_CALENDAR_ID + LOBS_CALENDAR_ID.

**Step 2 — Compute free slots**
```
ts_call: calendar.get_free_slots
args:    { date, window_start: "08:00", window_end: "23:00", buffer_minutes: 10, min_slot_minutes: 30 }
returns: { slots: Array<{ start: string, end: string, minutes: number }> }
```
Calls `GoogleCalendarService.getFreeBusy()`, subtracts fixed schedule blocks, applies buffers. Returns sorted free windows.

**Step 3 — Score and rank tasks**
```
ts_call: scheduler.rank_tasks
args:    { date, limit: 20 }
returns: { ranked: Array<{ task_id, title, score, estimated_minutes }> }
```
Queries tasks table, applies scoring formula, returns sorted list.

**Step 4 — Slot tasks**
```
ts_call: scheduler.create_work_blocks
args:    { date, ranked_tasks, free_slots }
returns: { scheduled: Array<{ task_id, title, start, end, calendar_event_id }>, skipped: string[] }
```
Greedy first-fit: for each ranked task, find first fitting free slot, call `GoogleCalendarService.createEvent(LOBS_CALENDAR_ID, { title, startAt, endAt })`, track event ID.

**Step 5 — Update task records**
```
ts_call: scheduler.mark_scheduled
args:    { scheduled: [...] }
```
Sets `scheduled_start`, `scheduled_end`, `calendar_event_id` on each task row.

**Step 6 — Build morning briefing**
```
ts_call: scheduler.build_morning_briefing
args:    { date, scheduled, skipped, events }
returns: { message: string }
```

Example output:
```
☀️ Morning Plan — Mon Jul 14

📅 Scheduled blocks:
  09:00–10:30 → Implement OAuth token refresh
  11:30–12:15 → Review PR for lobs-server
  13:00–14:00 → Write architecture doc

⏭️ Deferred (no slot): Fix navbar bug

📌 Fixed blocks: Class 10–11:30 | GSI 17–19
```

**Step 7 — Post to Discord**
```
ts_call: messaging.send_discord
args:    { channel: "rafe-daily", message }
```

---

## 3. Replan Triggers

Replanning adjusts the remaining day only (no retroactive changes). Max 3 replans/day (counter in `orchestrator_settings` key `scheduler.replan_count.YYYY-MM-DD`).

### 3.1 Task Completed Early

**Trigger:** workflow event `task.completed` where task has `scheduled_end` in the future

```
ts_call: scheduler.replan_remaining_day
args:    { freed_slot: { start: now, end: scheduled_end } }
```
Finds next highest-scored unscheduled task that fits. Creates new calendar block. Posts brief Discord note.

### 3.2 New Urgent Task Created

**Trigger:** workflow event `task.created` where `priority = 'urgent'`

```
ts_call: scheduler.insert_urgent_task
args:    { task_id, now: ISO8601 }
```
Finds next free slot >= 30 min after now. Creates block. Posts Discord alert: `🚨 Urgent task scheduled: {title} at {start}`.

### 3.3 Calendar Conflict

**Trigger:** `calendar.sync` detects new busy period overlapping an existing work block

```
ts_call: scheduler.handle_calendar_conflict
args:    { conflict_event_id, affected_task_ids }
```
Deletes conflicted work blocks. Attempts to reschedule affected tasks into remaining free slots. Tasks that can't be rescheduled get `deferred_today = 1` and are included in next day's planning. Posts conflict summary to Discord.

---

## 4. Data Flow

### 4.1 Schema Additions (new migration)

Add to `tasks` table in `src/db/schema.ts`:
```typescript
estimatedMinutes:  integer("estimated_minutes"),
dueDate:           text("due_date"),          // YYYY-MM-DD
priority:          text("priority"),          // urgent | high | medium | low
scheduledStart:    text("scheduled_start"),   // ISO datetime
scheduledEnd:      text("scheduled_end"),     // ISO datetime
calendarEventId:   text("calendar_event_id"),
deferredToday:     integer("deferred_today", { mode: "boolean" }).default(false),
```

### 4.2 New Callables

Add to `src/workflow/callables.ts`:

```
calendar.get_todays_events       → GoogleCalendarService.fetchUpcoming
calendar.get_free_slots          → GoogleCalendarService.getFreeBusy + slot logic
scheduler.rank_tasks             → DB query + scoring formula
scheduler.create_work_blocks     → greedy fit + GoogleCalendarService.createEvent
scheduler.mark_scheduled         → DB update tasks
scheduler.build_morning_briefing → string builder
scheduler.replan_remaining_day   → partial reschedule
scheduler.insert_urgent_task     → immediate slot + event creation
scheduler.handle_calendar_conflict → conflict detection + resolution
messaging.send_discord           → Discord webhook POST
```

Core scheduling logic lives in `src/services/scheduler.ts`. Callables in `callables.ts` delegate to it.

### 4.3 Workflows (src/workflow/seeds.ts)

**New: `daily-planner`**
```
trigger: { type: "cron", cron: "0 7 * * *", timezone: "America/Detroit" }
nodes:   get_todays_events → get_free_slots → rank_tasks →
         create_work_blocks → mark_scheduled → build_morning_briefing → send_discord
```

**New: `replan-on-completion`**
```
trigger: { type: "event", event_pattern: "task.completed" }
filter:  task has scheduled_end AND now < scheduled_end
nodes:   [ replan_remaining_day ]
```

**New: `urgent-task-alert`**
```
trigger: { type: "event", event_pattern: "task.created" }
filter:  priority = "urgent"
nodes:   [ insert_urgent_task ]
```

**Update: `daily-summary`**
- After existing summary build, append "Tomorrow's preview" using `rank_tasks` for the next day.

**Update: `daily-learning`**
- After learning synthesis, check completed tasks with calendar blocks. Record actual vs estimated time in `outcome_learnings` for future estimate calibration.

### 4.4 Calendar Sync

- `GoogleCalendarService.syncToDb()` runs every 30 min (existing mechanism via `scheduledEvents`).
- Daily planner calls `getFreeBusy` directly at 7am for fresh data — does not rely on cached DB rows.

---

## 5. API Surface (Nexus)

Add to `src/api/tasks.ts`:

```
GET  /api/tasks/schedule/today
     → { date, blocks: [{ task_id, title, start, end, calendar_event_id }] }

GET  /api/tasks/schedule/week
     → { days: { [YYYY-MM-DD]: { blocks: [...], free_minutes: number } } }

POST /api/tasks/schedule/replan
     body: { reason: "manual" | "conflict" | "completion", task_id? }
     → { ok, new_blocks: [...], message }

GET  /api/tasks/:id/schedule
     → { estimated_minutes, due_date, priority, scheduled_start, scheduled_end, calendar_event_id }

PATCH /api/tasks/:id/schedule
     body: { estimated_minutes?, due_date?, priority?, scheduled_start?, scheduled_end? }
     → { ok }
```

Add to `src/api/nexus.ts`:

```
GET /api/nexus/today-plan
    → {
        date,
        total_scheduled_minutes,
        total_free_minutes,
        blocks: [...],
        next_block: { title, start, end } | null
      }
```

---

## 6. Tradeoffs

| Decision | Rationale | Tradeoff |
|---|---|---|
| Greedy first-fit scheduling | Simple, predictable, fast | Not optimal — a large low-priority task may block a shorter high-priority one |
| Fixed 7am cron (not dynamic) | Matches morning routine; reliable | Doesn't react to late-night calendar changes until next morning |
| Cap replans at 3/day | Prevents thrashing | Edge cases may leave conflicts unresolved |
| 30-min minimum block | Prevents cognitive fragmentation | Short tasks (<30 min) get rounded up |
| Estimates stored on task | Rafe can override; stable across replans | Stale if scope changes significantly |
| getFreeBusy at 7am (not cached) | Always fresh for planning | One extra API call per day (negligible) |
| Fixed schedule as hard failsafe | Prevents double-booking if calendar lags | May block time that's actually free on a given day |

---

## 7. Implementation Order

1. **Migration** — add scheduling columns to tasks in `src/db/schema.ts` + `src/db/migrate.ts`
2. **Scheduler service** — `src/services/scheduler.ts` (pure logic: scoring, slot-fitting, briefing)
3. **Callables** — wire service into `src/workflow/callables.ts`
4. **Workflow seeds** — add daily-planner + replan workflows to `src/workflow/seeds.ts`
5. **API endpoints** — `src/api/tasks.ts` + `src/api/nexus.ts`
6. **Discord callable** — `messaging.send_discord` (Discord webhook, likely env var `DISCORD_WEBHOOK_URL`)
7. **Manual test** — trigger `daily-planner` manually, verify calendar events created on Lobs calendar

---

## 8. Open Questions

- **Discord channel:** Which channel/DM for morning briefing? Assume `rafe-daily` channel; confirm.
- **Lobs calendar ID:** Is `LOBS_CALENDAR_ID` env var pre-set, or must `_discoverLobsCalendar()` run first? Recommend: run discovery on first daily-planner execution and cache.
- **Priority UX:** Does Rafe set priority in Nexus UI, or is it inferred? Recommend: Nexus UI with inferred default of `medium`.
- **Due date source:** Task-level field in PAW, or synced from GitHub issue milestone? Recommend: PAW-native field, optionally populated by GitHub sync.
