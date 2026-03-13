# Multi-Key OAuth with Sticky Assignment

This feature allows you to configure multiple API keys per provider for load balancing and failover.

## Features

- **Sticky assignment**: Same session/task always uses the same key (maximizes prompt caching)
- **Automatic failover**: On auth/rate limit errors, sessions automatically fail over to healthy keys
- **Auto-recovery**: Rate-limited keys recover after 60s cooldown
- **Backward compatible**: Single-key usage (env vars) continues to work

## Configuration

### Option 1: Environment Variables (Comma-separated)

```bash
# Multiple keys, comma-separated (plural env var name)
export ANTHROPIC_API_KEYS="sk-ant-xxx,sk-ant-yyy,sk-ant-zzz"
export OPENAI_API_KEYS="sk-xxx,sk-yyy"
export OPENROUTER_API_KEYS="sk-or-xxx,sk-or-yyy"
```

### Option 2: JSON Config File

Create `~/.lobs/keys.json`:

```json
{
  "anthropic": {
    "keys": [
      { "key": "sk-ant-xxx", "label": "primary" },
      { "key": "sk-ant-yyy", "label": "backup" },
      { "key": "sk-ant-zzz", "label": "burst" }
    ],
    "strategy": "sticky-failover"
  },
  "openai": {
    "keys": [
      { "key": "sk-xxx", "label": "main" },
      { "key": "sk-yyy", "label": "fallback" }
    ],
    "strategy": "sticky-failover"
  }
}
```

**Note:** Environment variables take precedence over the JSON config file.

## How It Works

### Sticky Assignment

Each task/session gets assigned to a key based on a hash of the session ID:

```
sessionId → hash → keyIndex = hash % poolSize
```

Once assigned, the session **always** uses that key unless it becomes unhealthy. This maximizes prompt cache hits (Anthropic caching is per-key).

### Failover Logic

When a key fails:

1. **401/403 (Auth error)**: Key marked permanently unhealthy until manual reset
2. **429 (Rate limit)**: Key marked unhealthy for 60 seconds, then auto-recovers
3. **Other errors**: Key marked unhealthy for 60 seconds, then auto-recovers

Sessions using an unhealthy key automatically switch to the next healthy key in the pool.

### Example Scenario

```
Pool: [key-A, key-B, key-C]
Task-1 → hash(task-1) % 3 = 0 → uses key-A
Task-2 → hash(task-2) % 3 = 1 → uses key-B
Task-3 → hash(task-3) % 3 = 2 → uses key-C

# Key-B hits rate limit
Task-2 next turn → key-B unhealthy → switches to key-C
Task-2 continues on key-C until key-B recovers (60s)

# After 60s
Task-2 next turn → key-B recovered → switches back to key-B
```

## Single-Key Backward Compatibility

If no multi-key config is present, the system falls back to single-key behavior:

```bash
export ANTHROPIC_API_KEY="sk-ant-xxx"  # Works as before
```

The KeyPool is only used when multiple keys are configured.

## Implementation Details

- **Files**:
  - `src/config/keys.ts` — config types and loader
  - `src/services/key-pool.ts` — runtime key assignment and health tracking
  - `src/runner/providers.ts` — integration into auth resolution
  - `src/runner/agent-loop.ts` — passes sessionId to provider layer

- **Session ID**: Uses `taskId` from AgentContext, falling back to `runId`
- **Recovery loop**: Runs every 60 seconds to check for key recovery
- **Health tracking**: Stored in-memory (not persisted across restarts)

## Testing

```bash
# Set up multiple keys
export ANTHROPIC_API_KEYS="sk-ant-key1,sk-ant-key2"

# Run a task — check logs for key assignment
npm run start

# Logs will show:
# [KeyPool] Marked anthropic/env-1 as unhealthy (rate_limit): ...
# [KeyPool] Recovered anthropic/env-1 after rate limit cooldown
```

## Future Enhancements

- Persist health state across restarts
- Admin API to manually mark keys healthy/unhealthy
- Metrics: key usage, failover count, recovery count
- Per-key rate limit tracking (proactive failover before hitting limit)
