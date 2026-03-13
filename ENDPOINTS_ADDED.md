# New API Endpoints Added

Three new API endpoints have been successfully added to the Lobs plugin.

## 1. Scheduler Endpoint: `/api/scheduler`

**Purpose:** Manage OpenClaw cron jobs from the frontend.

**Endpoints:**
- `GET /api/scheduler` → Returns list of all cron jobs
  ```json
  {
    "jobs": [
      {
        "name": "heartbeat",
        "cron": "0 */2 * * *",
        "enabled": true,
        "last_run": "2026-03-12T10:00:00Z"
      }
    ]
  }
  ```

- `POST /api/scheduler/:name/toggle` → Toggles enabled state
  ```json
  {
    "success": true,
    "name": "heartbeat",
    "enabled": false
  }
  ```

- `POST /api/scheduler/:name/run` → Triggers immediate run
  ```json
  {
    "success": true,
    "name": "heartbeat",
    "message": "Job triggered successfully"
  }
  ```

**Implementation:** Uses `child_process.execSync` to call `openclaw cron` commands.

**File:** `src/api/scheduler.ts`

## 2. GitHub Feed Endpoint: `/api/github/feed`

**Purpose:** Aggregate GitHub activity across lobs-ai and paw-engineering orgs.

**Endpoint:**
- `GET /api/github/feed?limit=30` → Returns recent GitHub events and summary

**Response:**
```json
{
  "events": [
    {
      "type": "push|pr|issue|ci",
      "title": "Event title",
      "repo": "repository-name",
      "author": "username",
      "timestamp": "2026-03-12T10:00:00Z",
      "url": "https://github.com/..."
    }
  ],
  "summary": {
    "recentCommits": 15,
    "totalPRs": 5,
    "failedCI": 2
  }
}
```

**Implementation:**
- Uses `gh` CLI to query:
  - `/users/thelobsbot/received_events` (user activity)
  - `/orgs/lobs-ai/events` (org events)
  - `/orgs/paw-engineering/events` (org events)
  - `gh run list` for CI status
- Caches results for 60 seconds to avoid rate limits
- Aggregates and deduplicates events
- Sorts by timestamp descending

**File:** `src/api/github.ts`

## 3. Daily Brief Endpoint: `/api/daily-brief`

**Purpose:** Provide today's task summary and highlights for the dashboard.

**Endpoint:**
- `GET /api/daily-brief` → Returns today's brief

**Response:**
```json
{
  "date": "2026-03-12",
  "tasks": {
    "active": 5,
    "completed_today": 3,
    "blocked": 1
  },
  "calendar": [],
  "highlights": [
    "✅ Completed 3 tasks today",
    "🔥 2 high-priority tasks in progress"
  ]
}
```

**Implementation:**
- Queries tasks table for:
  - Active tasks (status='active')
  - Completed today (status='completed', updated_at >= today)
  - Blocked tasks (status IN ('blocked', 'waiting_on'))
- Generates contextual highlights based on task counts and priorities
- Calendar integration ready (currently returns empty array)

**File:** `src/api/daily-brief.ts`

## Router Registration

All three endpoints have been registered in `src/api/router.ts`:

```typescript
case "scheduler":    await handleSchedulerRequest(req, res, parts[1], parts); return true;
case "github":       await handleGitHubRequest(req, res, parts[1], parts); return true;
case "daily-brief":  await handleDailyBriefRequest(req, res, parts[1]); return true;
```

## Build Status

✅ **All endpoints compiled successfully** (`npm run build` passed with no errors)

## Testing Recommendations

1. **Scheduler:** Test with existing cron jobs
   ```bash
   curl http://localhost:4440/api/scheduler
   ```

2. **GitHub Feed:** Ensure `gh` CLI is authenticated
   ```bash
   curl http://localhost:4440/api/github/feed?limit=10
   ```

3. **Daily Brief:** Test with existing tasks in DB
   ```bash
   curl http://localhost:4440/api/daily-brief
   ```

## Notes

- All endpoints follow existing code patterns (using `json()` and `error()` helpers)
- Error handling is graceful — returns empty data rather than crashing
- TypeScript strict mode compliance verified
- No schema changes required (all endpoints read from existing tables or external APIs)
