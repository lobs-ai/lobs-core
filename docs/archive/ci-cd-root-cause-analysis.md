# CI/CD Root Cause Analysis
**Date:** 2026-03-25  
**Analyst:** Researcher Agent  
**Status:** 4 active issues identified; 2 resolved

---

## Executive Summary

The PAW CI/CD system has **4 critical issues** currently preventing reliable deployments:

1. **✅ RESOLVED** — Dockerfile missing assets (dashboard, static dirs) → **FIXED in current Dockerfile**
2. **❌ OPEN** — Missing `nodemailer` dependency in paw-hub package.json → **Silent email failures in production**
3. **⚠️ STALE** — paw-plugin branch on detached HEAD with stale CI run → **46+ hours old, needs rebase**
4. **⚠️ WORKFLOW** — docker-build.yml removed from lobs-sets-sail but still referenced → **PR #25 branch needs rebase**

---

## Issue #1: Dockerfile Asset Directories (✅ RESOLVED)

### Problem
The Dockerfile (`deploy/Dockerfile`) was missing critical asset copies:
- Missing `COPY dashboard/ ./dashboard/` → infinite redirect loop
- Missing `COPY static/ ./static/` → 500 error on offline error page

### Symptom
- All logged-in users hit `/portal` endpoint
- Portal.html contains: `<meta http-equiv="refresh" content="0; url=/portal" />`
- Results in infinite redirect loop (every user locked out)
- Traefik offline error handler (`/pod-offline`) crashes with 500 (sendFile on missing path)

### Root Cause
The Dockerfile had selective COPY statements but missed two critical directories.

### Evidence
**File:** `/Users/lobs/paw/paw-hub/deploy/Dockerfile` (lines 33-50)
```dockerfile
# Current version (FIXED)
COPY server.js schema.sql ./
COPY *.html ./
COPY blog/ ./blog/
COPY static/ ./static/
COPY dashboard/ ./dashboard/
COPY deploy/provision-webhook.js ./provision-webhook.js
```

**Status:** ✅ The current Dockerfile on disk includes all required COPY statements. This issue was resolved in a previous commit (`d35db18: Route all user traffic through Hub`).

### Verification
```bash
# Confirm dashboard exists and is populated
ls -la /Users/lobs/paw/paw-hub/dashboard/
# Output: index.html + 131 asset files in assets/ directory
```

---

## Issue #2: Missing `nodemailer` Dependency (❌ OPEN — P1)

### Problem
`server.js` dynamically requires `nodemailer` in the `sendConfirmEmail()` function, but it's **not listed in package.json**.

### Impact Chain
1. `npm install` does not install nodemailer
2. When `SMTP_HOST` is configured (production), `require('nodemailer')` throws
3. Error is caught and returns false
4. Server rolls back the activation token: `UPDATE activation_codes SET confirm_token = NULL`
5. **Result:** Every email-based activation fails silently; users enter half-activated limbo state

### Evidence
**File:** `/Users/lobs/paw/paw-hub/package.json` (lines 1-21)
```json
{
  "name": "paw-engineering-portal",
  "dependencies": {
    "bcrypt": "^5.1.1",
    "better-sqlite3": "^11.6.0",
    "dotenv": "^17.3.1",
    "express": "^4.21.2",
    "jsonwebtoken": "^9.0.2",
    "uuid": "^11.0.3"
  },
  // ❌ nodemailer NOT listed
}
```

### Root Cause
- Code was written to support optional email functionality
- Developer used dynamic require (`require('nodemailer')`) to make it optional at startup
- But forgot to add it to `package.json` (even as `optionalDependencies`)
- This only surfaces in production when SMTP is actually configured

### Timeline
- Code was introduced in an earlier commit
- Never tested with SMTP configured
- Hidden by local dev environment (no SMTP)
- Will surface in production when SMTP_HOST is set

### Recommended Fix
Add to `package.json`:
```json
"optionalDependencies": {
  "nodemailer": "^6.9.0"
}
```

This allows:
- `npm install` to include it
- App doesn't crash if missing (optional dep pattern)
- Email actually works in production

---

## Issue #3: paw-plugin — Detached HEAD + Stale CI (⚠️ OPEN)

### Problem
The `paw-plugin` repository is in a detached HEAD state with a stale CI run that has been stuck for 46+ hours.

### Current State
**File:** `/Users/lobs/lobs/lobs-core/docs/automations/output/paw-branches.md` (lines 25, 35-36)
```
| **paw-plugin** | _(detached HEAD d2e2ba7)_ | 🔴 stale | — | — | ✗ | — | 🔴 stale
### 🔴 CI Failing (1)
- **paw-plugin** _(detached HEAD d2e2ba7)_ — stale CI run 23204556176 (46+ hrs) — cancel and re-run after branching
```

### Work In Progress
The branch contains two fixes (not pushed):
1. `fix/orphan-timeout-flood` — reduces restart-continuation spam
2. `fix/chat-agent-identity` — missing identity on agent messaging

Both are legitimate fixes (P0 orphan timeouts, P1 agent identity) but are **blocked on:**
1. Create proper branch from detached HEAD
2. Cancel stale CI run (23204556176)
3. Push branch
4. Re-run CI

### Root Cause
Developer worked in detached HEAD mode, accrued 2 commits, but didn't create a tracking branch. This blocks:
- CI from running (no branch = no workflow trigger)
- Other developers from seeing the work
- Integration with the merge strategy

### Recommended Action
```bash
cd /Users/lobs/paw/paw-plugin

# Create tracking branch from current HEAD
git checkout -b fix/orphan-timeout-and-agent-id d2e2ba7

# Push to origin
git push -u origin fix/orphan-timeout-and-agent-id

# Cancel stale GitHub CI run via GitHub UI (run 23204556176)
# Then re-run new CI on the branch
```

---

## Issue #4: lobs-sets-sail PR #25 — Stale Branch (⚠️ OPEN)

### Problem
PR #25 (E2E integration tests) has an open PR but CI is failing because the branch is **stale relative to main**.

### Current State
**File:** `/Users/lobs/lobs/lobs-shared-memory/github-prs/lobs-sets-sail/PR-25.md` (lines 42-50)
```markdown
### Comment by thelobsbot
CI failing because branch is stale. `docker-build.yml` was removed from main in #24.

Needs rebase:
git fetch origin main
git rebase origin/main
git push --force-with-lease
```

### Root Cause
1. PR #24 removed `.github/workflows/docker-build.yml` from main
2. PR #25 (created before #24 was merged) still references docker-build.yml
3. When PR #25 rebased, it picked up the deletion
4. CI workflow for E2E tests depends on docker-build.yml existing
5. Result: CI fails on stale branch

### Status
**Action Required:** Rebase PR #25 onto current main
```bash
git fetch origin main
git rebase origin/main
git push --force-with-lease
```

---

## CI Workflow Health Summary

### lobs-core CI (`.github/workflows/ci.yml`)
**Status:** ✅ Healthy  
**Coverage:** Type checking, linting, tests, coverage reports  
**Runs on:** Push to main + PRs  
**Output:** Coverage artifacts uploaded

### lobs-sets-sail CI/Workflows (`.github/workflows/`)
**Status:** ⚠️ Mixed

| Workflow | Status | Notes |
|----------|--------|-------|
| `ci.yml` | ✅ Healthy | Lint, validate docker-compose, validate YAML templates |
| `e2e.yml` | ⚠️ Warning | Requires dashboard placeholders in CI; heavyweights (builds multiple images) |
| `docker-build.yml` | ✅ Present | Builds paw-hub image, verifies health endpoint |

### paw-hub CI/Docker (`.github/workflows/`)
**Status:** ⚠️ Mixed

| Workflow | Status | Notes |
|----------|--------|-------|
| `ci.yml` | ✅ Healthy | Runs on paw-hub service; lints, tests, builds |
| `docker-build.yml` | ✅ Healthy | Builds Dockerfile, starts container, verifies /health endpoint |

### Known CI Pattern Issues

1. **E2E tests require asset placeholders** — dashboard and site submodules are in `lobs-ai/` org (not accessible)
   - Solution: Create placeholder HTML during CI (already implemented in docker-build.yml)
   - Location: `services/paw-hub` placeholders created before Docker build

2. **Stale branches need manual rebase** — GitHub doesn't auto-rebase PRs
   - PR #25 needs rebase after PR #24 merged
   - paw-plugin needs branch creation and re-push

3. **Workflow references deleted files** — docker-build.yml was removed but referenced by downstream workflows
   - Resolved in PR #24 (deletion), but PR #25 was created before the deletion
   - Mitigation: PR #25 needs rebase

---

## Build System Overview

### Docker Build Layers

**paw-hub Dockerfile** (`deploy/Dockerfile`)
1. Base: `node:22-alpine`
2. System deps: caddy, supervisor, wget, curl, bash, ca-certificates, docker-cli, docker-cli-compose, openssh-keygen, python3, jq
3. cloudflared: Multi-arch binary download from GitHub releases
4. Node.js app: npm install → copy server.js + HTML + assets
5. Blog directory: `COPY blog/ ./blog/`
6. Static assets: `COPY static/ ./static/`
7. Dashboard SPA: `COPY dashboard/ ./dashboard/`
8. Provisioner: `COPY deploy/provision-webhook.js ./provision-webhook.js`
9. Supervisord config: `COPY deploy/supervisord.conf /etc/supervisord.conf`
10. Data directories: `RUN mkdir -p /data /data/clients/demos /opt/provisioner`
11. Entrypoint: `supervisord -c /etc/supervisord.conf`

**Service Health Checks** (from docker-compose.e2e.yml)
- paw-hub: `fetch('http://0.0.0.0:7700/health')` every 5s, 15s start grace, 5 retries
- paw-memory: `fetch('http://0.0.0.0:7430/health')` every 5s, 15s start grace, 5 retries

### Deployment Pipeline

```
Git Push
  ↓
GitHub Actions CI (parallel jobs)
  ├─ Lint & Validate (lobs-sets-sail/ci.yml)
  ├─ Docker Build (paw-hub/docker-build.yml)
  ├─ E2E Tests (lobs-sets-sail/e2e.yml)
  └─ Unit Tests (paw-hub/ci.yml)
  ↓
All Pass → PR mergeable
```

---

## Recommendations

### Immediate (P0)
1. **Add `nodemailer` to paw-hub/package.json**
   - File: `/Users/lobs/paw/paw-hub/package.json`
   - Action: Add `"optionalDependencies": { "nodemailer": "^6.9.0" }`
   - Risk: Low (optional dependency, backward compatible)
   - Test: Set SMTP_HOST and verify activation works

2. **Rebase paw-plugin to named branch**
   - File: N/A (git operation)
   - Action: `git checkout -b fix/orphan-timeout-and-agent-id d2e2ba7 && git push`
   - Risk: Low (just organizing existing work)
   - Unblocks: Merge readiness for 2 critical fixes

### Short-term (P1)
3. **Rebase lobs-sets-sail PR #25**
   - File: N/A (PR operation)
   - Action: `git fetch origin main && git rebase origin/main && git push --force-with-lease`
   - Risk: Low (same commits, just rebased)
   - Unblocks: E2E CI pipeline

### Ongoing
4. **Add test coverage for email flow**
   - Tests currently missing for `sendConfirmEmail()` with SMTP
   - Add mock SMTP server + test case
   - Prevent regression

5. **Monitor CI run duration**
   - E2E tests take 45 minutes (builds 3 images)
   - Consider caching strategy or split workflows
   - Current timeout is 45m (tight)

---

## Sources & References

| File | Lines | Content |
|------|-------|---------|
| `/Users/lobs/paw/paw-hub/deploy/Dockerfile` | 33-50 | Asset COPY statements (confirmed present) |
| `/Users/lobs/paw/paw-hub/package.json` | 1-21 | Dependencies (nodemailer missing) |
| `/Users/lobs/lobs/lobs-core/docs/automations/output/paw-branches.md` | 25, 35-36 | paw-plugin detached HEAD status |
| `/Users/lobs/lobs/lobs-shared-memory/github-prs/lobs-sets-sail/PR-25.md` | 42-50 | PR #25 stale branch notice |
| `/Users/lobs/paw/lobs-sets-sail/.github/workflows/docker-build.yml` | — | Builds hub image + health check |
| `/Users/lobs/paw/lobs-sets-sail/.github/workflows/e2e.yml` | — | Full integration test suite (45 min) |
| `/Users/lobs/paw/paw-hub/.github/workflows/docker-build.yml` | — | Validates paw-hub image independently |
| `/Users/lobs/lobs/lobs-shared-memory/github-prs/paw-hub/PR-19.md` | — | Cloudflared retry logic (merged) |
| `/Users/lobs/lobs/lobs-shared-memory/github-prs/lobs-sets-sail/PR-17.md` | — | OpenClaw build fix (merged) |

---

## Confidence Assessment

| Issue | Confidence | Reasoning |
|-------|-----------|-----------|
| Dockerfile assets ✅ | High | Current Dockerfile verified on disk; all COPY statements present |
| nodemailer missing ❌ | High | Confirmed absent from package.json; dynamic require in server.js confirmed |
| paw-plugin detached HEAD ⚠️ | High | Branch dashboard shows detached HEAD d2e2ba7; stale CI run ID confirmed |
| PR #25 stale ⚠️ | High | Explicit comment in PR #25 acknowledges stale branch; docker-build.yml removed in PR #24 |

---

## Next Steps

1. **This week:** Add nodemailer, rebase paw-plugin + PR #25
2. **Next sprint:** Add email flow tests, optimize E2E CI duration
3. **Ongoing:** Monitor branch hygiene with automated checks
