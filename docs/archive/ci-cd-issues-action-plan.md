# CI/CD Issues — Action Plan & Tracking

**Last Updated:** 2026-03-25 | **Investigation:** Complete | **Status:** Ready for fixes

---

## Issue Tracker

### Issue #1: Missing nodemailer
| Property | Value |
|----------|-------|
| **Severity** | P1 (Production Blocker) |
| **Status** | 🔴 UNFIXED |
| **Root Cause** | Dynamic `require('nodemailer')` but not in package.json |
| **Impact** | Email activation silently fails in production when SMTP is configured |
| **File** | `/Users/lobs/paw/paw-hub/package.json` |
| **Fix Type** | Add dependency |
| **Estimated Time** | 5 minutes |
| **Priority** | 🔥 Critical — blocks production email feature |

**What to do:**
```bash
cd /Users/lobs/paw/paw-hub
# Edit package.json, add after "dependencies":
# "optionalDependencies": { "nodemailer": "^6.9.0" }

git add package.json
git commit -m "fix: add nodemailer optional dependency for email activation"
git push

# Verify
npm install
npm ls nodemailer
```

**Verification Checklist:**
- [ ] File edited: `/Users/lobs/paw/paw-hub/package.json`
- [ ] Syntax valid (JSON linter passing)
- [ ] `npm install` succeeds
- [ ] `npm ls nodemailer` shows the package
- [ ] Commit message: "fix: add nodemailer..."
- [ ] Pushed to origin
- [ ] PR created and merged

---

### Issue #2: paw-plugin Detached HEAD
| Property | Value |
|----------|-------|
| **Severity** | P0 (Merge Blocker) |
| **Status** | 🔴 UNFIXED |
| **Root Cause** | Developer worked on detached HEAD d2e2ba7, 2 commits not on a branch |
| **Impact** | Cannot merge; stale CI run #23204556176 stuck for 46+ hours |
| **File(s)** | All of `/Users/lobs/paw/paw-plugin` |
| **Fix Type** | Git workflow (create branch, push, cancel CI, create PR) |
| **Estimated Time** | 10 minutes |
| **Priority** | 🔥🔥 Critical — blocks 2 bug fixes (orphan timeout + agent identity) |
| **Blocked Fixes** | 1. Orphan timeout flood (P0), 2. Chat agent identity (P1) |

**What to do:**

**Step 1: Verify current state**
```bash
cd /Users/lobs/paw/paw-plugin
git log --oneline -3
# Should show 2 commits ahead of main on detached HEAD
# Head should be: d2e2ba7
git status
# Should show: "HEAD detached at d2e2ba7"
```

**Step 2: Create tracking branch**
```bash
git checkout -b fix/orphan-timeout-and-agent-id d2e2ba7
# Or if already on detached HEAD:
git branch fix/orphan-timeout-and-agent-id
git checkout fix/orphan-timeout-and-agent-id
```

**Step 3: Push the branch**
```bash
git push -u origin fix/orphan-timeout-and-agent-id
# Should output: branch 'fix/orphan-timeout-and-agent-id' set up to track 'origin/fix/...'
```

**Step 4: Cancel stale CI run**
1. Go to: https://github.com/paw-engineering/paw-plugin/actions
2. Find run **#23204556176** (oldest running)
3. Click the **⋯** menu
4. Select **Cancel workflow**

**Step 5: Create PR** (GitHub UI or CLI)
```bash
# Using GitHub CLI (if installed)
gh pr create --title "fix: orphan timeout flood & chat agent identity" \
  --body "
- Fixes: Orphan tasks causing restart-continuation spam (P0)
- Fixes: Missing agent identity on chat messages (P1)
"

# OR manually: https://github.com/paw-engineering/paw-plugin/pull/new/fix/orphan-timeout-and-agent-id
```

**Step 6: Monitor CI**
- Watch: https://github.com/paw-engineering/paw-plugin/actions
- Should auto-trigger on branch push
- Expected to pass (code is already good, just needed branch structure)

**Verification Checklist:**
- [ ] Branch created: `fix/orphan-timeout-and-agent-id`
- [ ] Branch pushed to origin
- [ ] Old CI run #23204556176 cancelled
- [ ] PR created (links to the branch)
- [ ] New CI run triggered
- [ ] CI passes (watch the run)
- [ ] PR reviewed and approved
- [ ] PR merged to main

---

### Issue #3: lobs-sets-sail PR #25 Stale
| Property | Value |
|----------|-------|
| **Severity** | P1 (Integration Test Blocker) |
| **Status** | 🔴 UNFIXED |
| **Root Cause** | PR created before PR #24 merged; PR #24 deleted `docker-build.yml`, PR #25 references it |
| **Impact** | E2E tests fail with "File not found: .github/workflows/docker-build.yml" |
| **Branch** | `e2e-integration-tests` (or similar — check GitHub) |
| **Fix Type** | Git rebase |
| **Estimated Time** | 5 minutes |
| **Priority** | 🔥 High — blocks E2E test suite |

**What to do:**

**Step 1: Identify the branch**
```bash
cd /Users/lobs/paw/lobs-sets-sail
git branch -a
# Find the branch for PR #25 — likely named:
# - e2e-integration-tests
# - e2e/*
# - integration-tests
# Check GitHub PR #25 to see exact branch name
```

**Step 2: Fetch latest main**
```bash
git fetch origin main
# Downloads latest main without checking it out
```

**Step 3: Rebase onto main**
```bash
# If already on PR #25 branch:
git rebase origin/main

# If not on the branch:
git checkout [branch-name]
git rebase origin/main
```

**Step 4: Force-push (safely)**
```bash
git push --force-with-lease origin [branch-name]
# --force-with-lease is safe: only overwrites if nobody else pushed to this branch
# Output: [branch-name] ... [new-commit-hash] (forced update)
```

**Step 5: Monitor CI**
- Watch: https://github.com/paw-engineering/lobs-sets-sail/actions
- Should auto-trigger on push
- E2E tests should run
- Expected duration: 40-45 minutes

**Verification Checklist:**
- [ ] Latest main fetched
- [ ] Branch rebased onto origin/main (no merge conflicts)
- [ ] Force-pushed to origin (with --force-with-lease)
- [ ] CI triggered (watch Actions page)
- [ ] No conflicts or rebase failures
- [ ] E2E tests run successfully
- [ ] PR ready to merge

---

### Issue #4: Dockerfile Assets
| Property | Value |
|----------|-------|
| **Severity** | P0 (Production Critical) |
| **Status** | ✅ RESOLVED |
| **Root Cause** | Missing COPY statements in Dockerfile |
| **Impact** | Portal 500 errors, infinite redirects |
| **File** | `/Users/lobs/paw/paw-hub/deploy/Dockerfile` |
| **Fix Applied** | Added COPY directives for dashboard/, static/, blog/ |
| **Verified** | ✓ All assets present in current Dockerfile |

**Current State (Verified ✓):**
```dockerfile
COPY server.js schema.sql ./
COPY *.html ./
COPY blog/ ./blog/
COPY static/ ./static/
COPY dashboard/ ./dashboard/  ✓
COPY deploy/provision-webhook.js ./provision-webhook.js
```

**No action needed — already fixed.**

---

## Master Timeline

```
NOW (2026-03-25, 12:00 UTC)
  │
  ├─ 5 min  → Issue #1: Add nodemailer to package.json
  │   └─ Commit + Push
  │
  ├─ 5 min  → Issue #2: Create paw-plugin branch + push
  │   ├─ git checkout -b + git push
  │   └─ Cancel stale CI run
  │
  ├─ 5 min  → Issue #3: Rebase PR #25
  │   └─ git rebase + git push --force-with-lease
  │
  ├─ 45 min → Wait for CI (3 CI runs across 3 repos)
  │   ├─ paw-hub: docker build + health checks (~15 min)
  │   ├─ paw-plugin: tests (~10 min)
  │   └─ lobs-sets-sail: E2E tests (~40 min)
  │
  └─ 60 min → All green ✓ → Ready to deploy
```

---

## Daily Checklist

### Morning (Before Work)
- [ ] Check CI status: https://github.com/paw-engineering/lobs-sets-sail/actions
- [ ] Review branch dashboard: `/docs/automations/output/paw-branches.md`
- [ ] Check for stale PRs or runs

### When Fixing (This Session)
1. [ ] Open terminal in 3 repos
2. [ ] **Fix #1 (5 min):** nodemailer package.json
3. [ ] **Fix #2 (10 min):** paw-plugin branch
4. [ ] **Fix #3 (5 min):** PR #25 rebase
5. [ ] **Monitor (45 min):** Watch CI runs
6. [ ] **Verify (5 min):** All tests passing

### After Fixes Pass
- [ ] Check deployment readiness
- [ ] Merge all PRs
- [ ] Deploy to staging
- [ ] Verify email activation works
- [ ] Deploy to production
- [ ] Monitor production logs for errors

---

## Related Documents

- **Full Analysis:** `ci-cd-investigation-comprehensive.md` (detailed code-level investigation)
- **Executive Summary:** `ci-cd-executive-summary.md` (high-level overview)
- **Quick Reference:** `ci-cd-issues-quickref.md` (status dashboard)
- **Previous Root Cause:** `ci-cd-root-cause-analysis.md` (earlier analysis)

---

## Success Criteria

**All issues resolved when:**

- [ ] Issue #1: `npm ls nodemailer` shows package installed
- [ ] Issue #2: paw-plugin has a named branch, stale CI cancelled, PR merged
- [ ] Issue #3: PR #25 rebased, E2E tests passing
- [ ] All three CI workflows show green checkmarks
- [ ] No failing tests in any repository
- [ ] Code merged to main on all repos

**Estimated total time:** 65 minutes (20 min work + 45 min CI)

