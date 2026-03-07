---
name: tasks
description: Create, update, list, and close tasks via the PAW API. Use when an agent needs to manage task lifecycle: creating new tasks, updating status/notes, filtering active work, or closing completed items.
---

# Task Management

## Base URL and Auth

```
Base URL: http://127.0.0.1:18789
Token:    341c3e8015df9c77f6ed4cba1359403135994364caf7c668
Header:   Authorization: Bearer <token>
```

Always include `Content-Type: application/json` on POST/PATCH requests.

## Task Fields

| Field | Type | Values / Notes |
|-------|------|----------------|
| `title` | string | **Required on create.** Short, imperative description. |
| `status` | string | `active` \| `cancelled` |
| `workState` | string | `not_started` \| `queued` \| `in_progress` \| `blocked` \| `done` |
| `agent` | string | `programmer` \| `architect` \| `researcher` \| `writer` \| `reviewer` |
| `notes` | string | Markdown. Use for context, constraints, acceptance criteria. |
| `projectId` | string | UUID of parent project, or `null`. |
| `blockedBy` | string | UUID of blocking task, or `null`. |
| `pinned` | boolean | Pin to top of queue. |
| `modelTier` | string | `standard` \| `heavy` |
| `estimatedMinutes` | number | Optional time estimate. |

## Create a Task

```bash
curl -s -X POST http://127.0.0.1:18789/api/tasks \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Task title here",
    "agent": "programmer",
    "notes": "## Problem\n...\n\n## Acceptance Criteria\n- [ ] ...",
    "workState": "queued"
  }'
```

**Minimum required:** `title` only. Add `agent`, `notes`, and `workState` for complete tasks.

## List Tasks

```bash
# All active tasks
curl -s http://127.0.0.1:18789/api/tasks \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668"

# Filter by status or workState
curl -s "http://127.0.0.1:18789/api/tasks?status=active&workState=queued" \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668"

# Filter by agent
curl -s "http://127.0.0.1:18789/api/tasks?agent=programmer" \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668"
```

Filter query params: `status`, `workState`, `agent`, `projectId`

## Update a Task

```bash
curl -s -X PATCH http://127.0.0.1:18789/api/tasks/<task-id> \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668" \
  -H "Content-Type: application/json" \
  -d '{"workState": "done", "notes": "Updated notes here"}'
```

Only send fields you want to change. All other fields are preserved.

## Close / Cancel a Task

To mark done:
```bash
curl -s -X PATCH http://127.0.0.1:18789/api/tasks/<task-id> \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668" \
  -H "Content-Type: application/json" \
  -d '{"workState": "done"}'
```

To cancel:
```bash
curl -s -X PATCH http://127.0.0.1:18789/api/tasks/<task-id> \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668" \
  -H "Content-Type: application/json" \
  -d '{"status": "cancelled"}'
```

To hard-delete:
```bash
curl -s -X DELETE http://127.0.0.1:18789/api/tasks/<task-id> \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668"
```

Prefer `status: cancelled` or `workState: done` over hard-delete. Delete only for test/junk tasks.

## Get a Single Task

```bash
curl -s http://127.0.0.1:18789/api/tasks/<task-id> \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668"
```

## Block a Task on Another

```bash
curl -s -X PATCH http://127.0.0.1:18789/api/tasks/<task-id> \
  -H "Authorization: Bearer 341c3e8015df9c77f6ed4cba1359403135994364caf7c668" \
  -H "Content-Type: application/json" \
  -d '{"blockedBy": "<blocking-task-id>", "workState": "blocked"}'
```

## Task Notes Format

Use structured markdown in `notes` for well-formed tasks:

```markdown
## Problem
Brief description of what needs to be solved.

## Acceptance Criteria
- [ ] Criterion one
- [ ] Criterion two

## Context
Any relevant background, constraints, or links.
```

## Workflow

1. **Read before write** — always GET task before PATCHing if you're not sure of current state.
2. **Verify after mutation** — re-fetch to confirm the change landed.
3. **Don't duplicate** — search existing tasks before creating new ones.
4. **Close what's done** — set `workState: done` when acceptance criteria are met.
5. **Use notes for context** — never put important detail only in chat; write it to notes.

## Error Handling

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Bad/missing token | Check auth header |
| 404 | Task ID not found | Verify ID, may be deleted |
| 409 | Conflict/race | Re-read and retry once |
| 422 | Invalid payload | Fix field names/types |
| 5xx | Server error | Retry with backoff |

## User Commands This Skill Handles

- "create a task to..." → POST /api/tasks with structured notes
- "list my tasks" / "what tasks are active" → GET /api/tasks
- "mark task X as done" → PATCH workState: done
- "update task notes" → PATCH notes
- "cancel task X" → PATCH status: cancelled
- "show task X" → GET /api/tasks/:id
- "block task X on task Y" → PATCH blockedBy + workState: blocked
