# CI/CD Issues — Quick Reference

## Status Dashboard

| # | Issue | Status | Severity | Fix Time | Blocker |
|---|-------|--------|----------|----------|---------|
| 1 | Dockerfile missing assets | ✅ RESOLVED | — | — | No |
| 2 | Missing nodemailer dep | ❌ OPEN | **P1** 🔴 | 5 min | No (but silent failures) |
| 3 | paw-plugin detached HEAD | ⚠️ OPEN | **P0** 🟠 | 10 min | Yes (2 critical fixes blocked) |
| 4 | PR #25 stale branch | ⚠️ OPEN | **P1** 🟠 | 5 min | Yes (E2E CI failing) |

---

## Issue #2: Missing nodemailer (P1 — Silent failures)

```
❌ BROKEN: User clicks "Activate via email" in production
├─ server.js calls sendConfirmEmail()
├─ require('nodemailer') throws (not installed)
├─ Error caught, returns false
├─ Token rolled back: UPDATE activation_codes SET confirm_token = NULL
└─ User stuck in limbo — can't activate, can retry forever

✅ FIXED: Add to package.json
{
  "optionalDependencies": {
    "nodemailer": "^6.9.0"
  }
}
```

**File:** `/Users/lobs/paw/paw-hub/package.json`

---

## Issue #3: paw-plugin Detached HEAD (P0 — Merge blocker)

```
Current state (detached HEAD d2e2ba7)
├─ 2 commits staged, not pushed
│  ├─ fix: orphan timeout flood / restart-continuation
│  └─ fix: chat-agent-identity
├─ CI run 23204556176 stuck for 46+ hrs
└─ Cannot merge because no branch

Fix (10 minutes):
$ cd /Users/lobs/paw/paw-plugin
$ git checkout -b fix/orphan-timeout-and-agent-id d2e2ba7
$ git push -u origin fix/orphan-timeout-and-agent-id
# Cancel stale run in GitHub UI
# PR will auto-trigger new CI
```

**Status:** 2 critical fixes waiting to be integrated

---

## Issue #4: lobs-sets-sail PR #25 (P1 — CI failing)

```
Problem:
├─ PR #25 created before PR #24 merged
├─ PR #24 removed .github/workflows/docker-build.yml
├─ PR #25 branch still references deleted file
└─ CI fails: "docker-build.yml not found"

Fix (5 minutes):
$ cd /Users/lobs/paw/lobs-sets-sail
$ git fetch origin main
$ git rebase origin/main
$ git push --force-with-lease
```

**Status:** E2E integration test suite blocked

---

## CI Workflow Health

```
lobs-core:
  ci.yml ...................... ✅ Healthy
  
lobs-sets-sail:
  ci.yml ...................... ✅ Healthy (lint/validate)
  docker-build.yml ............ ✅ Healthy
  e2e.yml ..................... ⚠️  Works but heavy (45 min, 3 images)
  
paw-hub:
  ci.yml ...................... ✅ Healthy
  docker-build.yml ............ ✅ Healthy
```

---

## Action Items

### This Week (1.5 hours total)
- [ ] Add nodemailer to paw-hub/package.json (5 min)
- [ ] Create paw-plugin tracking branch & push (10 min)
- [ ] Rebase lobs-sets-sail PR #25 (5 min)
- [ ] Verify all CI runs pass (45 min)

### Next Sprint
- [ ] Add email flow test coverage
- [ ] Profile & optimize E2E test duration
- [ ] Document branch hygiene rules

---

## Related PRs & Issues

| PR | Repo | Status | Notes |
|----|------|--------|-------|
| #25 | lobs-sets-sail | 🔴 CI failing | E2E tests — needs rebase |
| #24 | lobs-sets-sail | ✅ MERGED | Removed docker-build.yml |
| #17 | lobs-sets-sail | ✅ MERGED | Fixed OpenClaw build |
| #19-20 | paw-hub | ✅ MERGED | Cloudflared retry logic |

---

## Deployment Readiness

| Component | Tests | Build | Deploy | Notes |
|-----------|-------|-------|--------|-------|
| lobs-core | ✅ | ✅ | ✅ | Green across the board |
| paw-hub | ✅ | ✅ | ⏳ | Blocked on PR #25 rebase for E2E |
| lobs-sail | ✅ | ✅ | ⏳ | Blocked on paw-plugin branch merge |
| ship-api | ✅ | ✅ | ⏳ | Ready, waiting for paw-hub |

---

## Prevention

**Automated Checks to Add:**
1. Prevent commits in detached HEAD (pre-commit hook)
2. Alert on stale CI runs (> 12 hours)
3. Lint workflow files for broken file references
4. Require dependency review for optionalDependencies changes

**Documentation:**
- Branch naming convention
- PR rebase checklist
- CI troubleshooting runbook
