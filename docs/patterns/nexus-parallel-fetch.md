# Pattern: Parallel Data Fetch in Nexus Pages

**Owner:** frontend / nexus  
**Status:** Adopted  
**Since:** 2026-03-24 (formalised from Scheduler page)

---

## Problem

Dashboard and list pages need several independent API endpoints to render. A naïve implementation fetches them one after another:

```js
// ❌ Sequential waterfall — total load time = sum of all round-trips
const tasksData  = await api.myTasks();
const statsData  = await api.myTaskStats();
const completed  = await api.myTasks({ status: 'completed' });
```

Or scatters them across multiple `useEffect` calls:

```js
// ❌ Scattered effects — race-prone, independent loading spinners, no shared error state
useEffect(() => { api.dailyBrief().then(setBrief); }, []);
useEffect(() => { api.inbox().then(setInbox); },     []);
useEffect(() => { api.githubFeed().then(setFeed); }, []);
useEffect(() => { api.serviceHealth().then(setSvc); }, []);
```

Both patterns cause:
- Unnecessary load time (sequential case can be 3-4× slower)
- Partial/flickery renders as each piece of state arrives independently
- Duplicated abort/cleanup boilerplate across effects

---

## Solution

Use **`Promise.all`** to fan-out all independent requests simultaneously, then apply state updates together when everything is ready.

### Inline (use when fetch logic is simple and local to one page)

```js
const load = async (signal) => {
  setLoading(true);
  try {
    const [jobsData, modelsData, briefData] = await Promise.all([
      api.scheduler(signal),
      api.models(signal),
      api.dailyBrief(signal),
    ]);
    setJobs(jobsData?.jobs   || []);
    setConfig(modelsData?.scheduler || null);
    setBrief(briefData);
  } catch (e) {
    if (e.name !== 'AbortError') setError(e.message);
  } finally {
    setLoading(false);
  }
};
```

**Reference implementation:** `nexus/src/pages/Scheduler.jsx` — `load()` function.  
**Other good examples:** `GitHubFeed.jsx`, `LearningInsights.jsx`.

---

### Reusable hook (use when the pattern repeats or you want uniform abort/error handling)

```js
import { useParallelFetch } from '../hooks/useParallelFetch';

const { loading, error, reload } = useParallelFetch([
  { fetcher: s => api.scheduler(s),   setter: setJobs,   transform: d => d?.jobs || [] },
  { fetcher: s => api.models(s),      setter: setConfig, transform: d => d?.scheduler || null },
  { fetcher: s => api.dailyBrief(s),  setter: setBrief },
]);
```

`useParallelFetch` handles:
- `AbortController` lifecycle (cancel on unmount)
- Single shared `loading` + `error` state
- Optional `transform` per endpoint
- `reload()` function for manual refresh

**Source:** `nexus/src/hooks/useParallelFetch.js`

---

## Rules

### ✅ DO — use `Promise.all` when

| Condition | Example |
|---|---|
| Requests are independent (no result of A needed for B) | jobs + config + brief |
| All data needed before the page can render meaningfully | dashboard stats |
| You want one loading spinner for the whole view | any list page |

### ❌ DON'T — keep sequential when

| Condition | Why |
|---|---|
| Request B depends on the result of Request A | true dependency chain; must be sequential |
| One endpoint is dramatically slower (e.g. LLM call) | split it out with its own loading state so fast data renders first |
| Requests are user-action-triggered at different times | they're not related; don't bundle them |

**Example of intentional split:** In `Scheduler.jsx`, `api.schedulerIntelligence()` is fetched separately after the initial `Promise.all` because it involves an LLM summarisation step and can take 5-10s. Bundling it would block the entire page.

---

## Audit Results (2026-03-24)

| Page | Pattern Before | Pattern After |
|---|---|---|
| `Scheduler.jsx` | ✅ Already `Promise.all` (3 requests) | — (reference implementation) |
| `GitHubFeed.jsx` | ✅ Already `Promise.all` (3 requests, with AbortController) | — |
| `LearningInsights.jsx` | ✅ Already `Promise.all` (3 requests) | — |
| `MyTasks.jsx` | ⚠️ `Promise.all` for 2 of 3 — `completed` was fetched sequentially after | ✅ Fixed: all 3 in `Promise.all` |
| `Dashboard.jsx` | ❌ 4 scattered `useEffect` calls, no abort | ✅ Fixed: consolidated into `useParallelFetch` |
| `Tasks.jsx` | ✅ Already uses `usePolling` + `useApi` hooks (correct pattern for live data) | — |

---

## `useParallelFetch` API Reference

```ts
function useParallelFetch(
  specs: FetchSpec[],
  deps?: any[],
  opts?: { onDone?: (results) => void, onError?: (err) => void, abortOnUnmount?: boolean }
): { loading: boolean, error: string | null, reload: () => void }

type FetchSpec = {
  fetcher:    (signal: AbortSignal) => Promise<any>;
  setter:     (data: any) => void;
  transform?: (data: any) => any;   // applied before setter
}
```

---

## Related Patterns

- **`usePolling`** — for data that needs to refresh on an interval (worker status, task queue). Does NOT use `Promise.all` across endpoints; each polling loop is independent by design.
- **`useApi`** — single-endpoint fetch with loading/error state. Compose multiple `useApi` calls if you need independent loading indicators per section.
- **Server-side joins** — for data that is always fetched together, consider adding a combined endpoint (e.g. `GET /api/scheduler` already returns jobs + config in one response).
